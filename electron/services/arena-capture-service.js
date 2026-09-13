// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const os = require('os');
const path = require('node:path');
const { spawn, spawnSync } = require('child_process');
const { screen } = require('electron');
const { FFMPEG_PATH } = require('../config/constants');
const StorageManager = require('../core/storage-manager');
const arenaAudioService = require('./arena-audio-service');
const arenaModeService = require('./arena-mode-service');

//#endregion

// Mode salle — brique de CAPTATION. Contrat : lit un périphérique vidéo (la
// caméra virtuelle qui reçoit le flux du jeu) et écrit des segments vidéo dans
// le dossier spool. Le reste du pipeline (détection loading/score frame,
// découpe, analyse, upload) ne consomme QUE ce dossier : si la source change
// demain (enregistrement OBS local, carte de capture), seule cette brique est
// remplacée.
//
// Enregistrement en segments mkv (crash-safe : un mkv tronqué reste lisible,
// contrairement à un mp4 sans moov) de SEGMENT_SECONDS. Une game à cheval sur
// deux segments sera recollée par le pipeline (ffmpeg concat demuxer,
// stream-copy). ffmpeg est relancé automatiquement s'il meurt : PC de salle
// sans surveillance.

const SETTINGS_KEY_DEVICE = 'arenaCaptureDevice';
const SETTINGS_KEY_SPOOL = 'arenaSpoolFolder';
const SEGMENT_SECONDS = 300;
// Réglages d'encodage : à ajuster sur le matériel réel des salles (NVENC si
// GPU NVIDIA). videotoolbox = encodage matériel macOS (dev), libx264
// veryfast = fallback logiciel portable.
// Encodage WEB-READY dès la source : H.264 + GOP de 1 s (une keyframe par
// seconde, comme `cutAndEncodeGame`) pour que la découpe des games soit un
// simple stream-copy/remux mp4 — zéro réencodage, zéro CPU, zéro perte. Les
// I-frames rapprochées coûtent ~15-20 % de bitrate à qualité égale : compensé
// par le bitrate (stockage accepté).
//
// Encodeur : détecté automatiquement au premier démarrage — les PC de salle
// sont toujours des Windows mais aux configs variées (dev = Mac). Chaque
// candidat est VALIDÉ par un encodage à blanc (un GPU absent ou un driver
// cassé fait passer au suivant), libx264 (CPU) en dernier recours. Priorité
// aux encodeurs matériels : la captation tourne 24/7 sur un PC qui stream.
const ENCODER_CANDIDATES =
    process.platform === 'darwin'
        ? [
              { name: 'h264_videotoolbox', args: ['-c:v', 'h264_videotoolbox', '-b:v', '10M'] },
              { name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] }
          ]
        : [
              { name: 'h264_nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '10M'] },
              { name: 'h264_qsv', args: ['-c:v', 'h264_qsv', '-b:v', '10M'] },
              { name: 'h264_amf', args: ['-c:v', 'h264_amf', '-b:v', '10M'] },
              { name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] }
          ];

let resolvedEncoder = null;

/**
 * Premier encodeur candidat qui encode réellement (1 s de noir → null muxer).
 * Résolu une fois par session (~1-3 s au premier démarrage de la captation).
 */
function resolveEncoder() {
    if (resolvedEncoder) return resolvedEncoder;
    for (const CANDIDATE of ENCODER_CANDIDATES) {
        const RES = spawnSync(
            FFMPEG_PATH,
            [
                '-hide_banner', '-v', 'error',
                '-f', 'lavfi', '-i', 'color=black:s=1920x1080:r=30',
                '-frames:v', '30',
                ...CANDIDATE.args,
                '-f', 'null', '-'
            ],
            { encoding: 'utf8', timeout: 20000 }
        );
        if (RES.status === 0) {
            console.log(`[arena-capture] encoder: ${CANDIDATE.name}`);
            resolvedEncoder = CANDIDATE;
            return CANDIDATE;
        }
        console.log(
            `[arena-capture] encoder ${CANDIDATE.name} unavailable:`,
            (RES.stderr || '').split('\n')[0]
        );
    }
    // Tous les probes ont échoué (improbable) : libx264 en aveugle.
    resolvedEncoder = ENCODER_CANDIDATES[ENCODER_CANDIDATES.length - 1];
    return resolvedEncoder;
}
// Framerate de SORTIE (CFR). L'entrée reste au rythme imposé par le
// périphérique (avfoundation exige le mode exact, ex. 60 fps) ; on jette les
// images excédentaires à l'encodage : à bitrate égal, 30 fps = plus de qualité
// par image (meilleur OCR) et moitié moins de charge encodeur.
const OUTPUT_FPS = 30;
// Adaptateurs graphiques sondés à la recherche de sorties capturables.
const MAX_ADAPTERS = 4;
const RESTART_BASE_DELAY_MS = 5 * 1000;
const RESTART_MAX_DELAY_MS = 60 * 1000;

let ffmpegProcess = null;
let stopRequested = false;
let restartTimer = null;
let restartDelayMs = RESTART_BASE_DELAY_MS;
let startedAt = null;
let lastError = null;
// Dernières lignes stderr de ffmpeg : en cas d'échec au démarrage (device
// invalide, framerate non supporté…), c'est le seul diagnostic utile.
let stderrTail = [];
// Mode imposé par le périphérique (avfoundation exige un framerate/taille
// EXACTEMENT supportés — ex. OBS Virtual Camera = 1920x1080@60 uniquement).
// Détecté en parsant le "Supported modes:" que ffmpeg logge quand le mode
// demandé est refusé, puis réessayé aussitôt. Réinitialisé au changement de
// périphérique.
let detectedMode = null;
// Résolution refusée : l'analyseur travaille en coordonnées 1920×1080
// absolues, donc la captation exige une source 1080p — pas d'upscale filet de
// sécurité (décision Antoine), on refuse et on affiche l'erreur. Ce flag
// bloque le redémarrage automatique : relancer en boucle sur une source 720p
// ne la transformera pas en 1080p.
let resolutionRejected = false;
// Première image reçue de la source. Tant qu'elle n'est pas arrivée, RIEN
// n'est enregistré : ddagrab ne produit une image que lorsque l'écran change,
// et sur un écran figé l'attente peut durer des dizaines de secondes.
let videoStarted = false;

/**
 * Extrait les modes supportés ("1920x1080@[15.000000 60.000000]fps") du stderr
 * d'un ffmpeg qui a refusé le mode demandé, et renvoie le mode 1920×1080 s'il
 * existe (fps = max de la plage), sinon le premier de la liste (que le caller
 * rejettera : la captation exige du 1080p). Null si aucun mode listé.
 */
function parseSupportedMode(lines) {
    const MODES = [];
    for (const LINE of lines) {
        const RE = /(\d{3,4})x(\d{3,4})@\[([\d. ]+)\]/g;
        let m;
        while ((m = RE.exec(LINE)) !== null) {
            const FPS_LIST = m[3].trim().split(/\s+/).map(parseFloat);
            MODES.push({
                width: parseInt(m[1], 10),
                height: parseInt(m[2], 10),
                fps: Math.round(Math.max(...FPS_LIST))
            });
        }
    }
    if (MODES.length === 0) return null;
    return (
        MODES.find((x) => x.width === 1920 && x.height === 1080) || MODES[0]
    );
}

function getSpoolFolder() {
    return StorageManager.getPermanentSettingsValue(
        SETTINGS_KEY_SPOOL,
        path.join(os.homedir(), 'EBP-Tools-Arena', 'spool')
    );
}

/**
 * Change l'emplacement du spool (déplacement du dossier EBP-Tools-Arena par
 * l'utilisateur). L'appelant (server.js) est responsable d'avoir arrêté la
 * captation et déplacé les fichiers AVANT.
 */
function setSpoolFolder(spoolPath) {
    StorageManager.setPermanentSettingsValue(SETTINGS_KEY_SPOOL, spoolPath);
}

function getDevice() {
    return StorageManager.getPermanentSettingsValue(SETTINGS_KEY_DEVICE);
}

function setDevice(device) {
    // La vignette est une donnée d'affichage volumineuse et périssable : elle
    // reste en mémoire, elle n'a rien à faire dans les réglages permanents.
    const { thumbnail, ...STORED } = device || {};
    if (thumbnail && typeof STORED.outputIndex === 'number') {
        screenThumbnails[`${STORED.adapter || 0}-${STORED.outputIndex}`] =
            thumbnail;
    }
    StorageManager.setPermanentSettingsValue(SETTINGS_KEY_DEVICE, STORED);
}

/** Dernière image captée par sortie ddagrab, pour l'aperçu (mémoire seule). */
let screenThumbnails = {};

/**
 * Liste les périphériques vidéo via ffmpeg (avfoundation sur macOS, dshow sur
 * Windows). ffmpeg sort la liste sur stderr et se termine en erreur : c'est le
 * comportement attendu, on parse quoi qu'il arrive.
 * Sépare les écrans (avfoundation les expose comme des caméras) des caméras
 * virtuelles.
 * @returns {{screens: object[], cameras: object[]}}  id = index avfoundation ou chemin dshow.
 */
function listCaptureDevices() {
    const IS_MAC = process.platform === 'darwin';
    const ARGS = IS_MAC
        ? ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']
        : ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'];
    const RES = spawnSync(FFMPEG_PATH, ARGS, { encoding: 'utf8' });
    const OUT = (RES.stderr || '') + (RES.stdout || '');
    const DEVICES = [];
    if (IS_MAC) {
        // Bloc "AVFoundation video devices:" → lignes `[N] Nom`, jusqu'au bloc audio.
        let inVideoBlock = false;
        for (const LINE of OUT.split('\n')) {
            if (/AVFoundation video devices/.test(LINE)) {
                inVideoBlock = true;
                continue;
            }
            if (/AVFoundation audio devices/.test(LINE)) break;
            const M = inVideoBlock && LINE.match(/\[(\d+)\]\s+(.+)$/);
            if (M) DEVICES.push({ id: M[1], name: M[2].trim() });
        }
    } else {
        // Lignes `"Nom" (video)` suivies d'une ligne `Alternative name "@device_pnp_…"`.
        // Deux caméras du même modèle ont un nom IDENTIQUE mais un chemin
        // (alternative name) UNIQUE → on l'utilise comme id pour les
        // distinguer (dropdown sans clés dupliquées, sélection, adressage
        // ffmpeg de la bonne caméra). Fallback sur le nom si le chemin manque.
        const LINES = OUT.split('\n');
        for (let i = 0; i < LINES.length; i++) {
            const M = LINES[i].match(/"([^"]+)"\s+\((video)\)/);
            if (!M) continue;
            const NAME = M[1];
            const ALT = (LINES[i + 1] || '').match(
                /Alternative name\s+"([^"]+)"/
            );
            DEVICES.push({ id: ALT ? ALT[1] : NAME, name: NAME });
        }
    }
    // avfoundation expose les écrans comme des périphériques vidéo : ils sont
    // sortis de la liste des caméras et rejoignent les écrans (dev macOS).
    const IS_SCREEN = /capture screen/i;
    const SCREENS = IS_MAC
        ? DEVICES.filter((d) => IS_SCREEN.test(d.name)).map((d) => ({
              id: d.id,
              name: d.name,
              kind: 'screen'
          }))
        : [];
    // Le pipeline salle ne capte QUE des caméras VIRTUELLES (le flux du jeu via
    // OBS Virtual Camera & co) : la source doit être un rendu 1080p, pas une
    // webcam physique. Les webcams physiques sont de toute façon exclusives
    // sous Windows (impossible à prévisualiser pendant qu'on les enregistre),
    // donc on les retire de la liste. Filtre par nom — à étendre si d'autres
    // logiciels de caméra virtuelle sont utilisés en salle.
    const IS_VIRTUAL = /virtual|obs|vcam|streamlabs|xsplit|manycam|\bndi\b/i;
    const CAMERAS = DEVICES.filter(
        (d) => !IS_SCREEN.test(d.name) && IS_VIRTUAL.test(d.name)
    ).map((d) => ({ id: d.id, name: d.name, kind: 'camera' }));
    return { screens: SCREENS, cameras: CAMERAS };
}

/**
 * Sélecteur d'adaptateur graphique pour ddagrab. L'adaptateur 0 garde la forme
 * courte, celle qui est éprouvée en captation.
 */
function hwDeviceArg(adapter) {
    return adapter ? `d3d11va:${adapter}` : 'd3d11va';
}

/**
 * Capture une image sur une sortie ddagrab donnée.
 *
 * C'est la seule façon FIABLE de savoir ce qu'un index de sortie désigne.
 * L'index DXGI ne suit ni l'ordre des écrans rapporté par Electron, ni la
 * numérotation des paramètres d'affichage Windows, ni celle des sources
 * Chromium : les trois hypothèses ont été démenties l'une après l'autre sur un
 * poste à trois écrans. On ne le déduit donc plus, on le constate — et c'est
 * l'image renvoyée ici qui sert d'étiquette dans le sélecteur.
 *
 * @returns {Promise<{outputIndex: number, width: number, height: number, thumbnail: string|null}|null>}
 */
function probeScreenOutput(adapter, outputIndex) {
    return new Promise((resolve) => {
        const OUT = path.join(
            os.tmpdir(),
            `ebp-arena-screen-${adapter}-${outputIndex}.jpg`
        );
        const PROC = spawn(FFMPEG_PATH, [
            '-hide_banner', '-y',
            '-init_hw_device', hwDeviceArg(adapter),
            '-filter_complex',
            `ddagrab=output_idx=${outputIndex}:framerate=30,hwdownload,format=bgra,format=yuv420p[v]`,
            '-map', '[v]',
            '-frames:v', '1',
            '-q:v', '20',
            OUT
        ]);
        let stderr = '';
        const TIMEOUT = setTimeout(() => PROC.kill(), 10000);
        PROC.stderr.on('data', (d) => (stderr += d.toString()));
        PROC.on('error', () => {
            clearTimeout(TIMEOUT);
            resolve(null);
        });
        PROC.on('close', (code) => {
            clearTimeout(TIMEOUT);
            if (code !== 0 || !fs.existsSync(OUT)) {
                // Sans ce log, une sortie manquante dans la liste est
                // inexplicable : c'est ici que ffmpeg dit pourquoi.
                console.log(
                    `[arena-capture] probe adapter ${adapter} output ${outputIndex} failed: ${(stderr.trim().split('\n').pop() || '').trim()}`
                );
                resolve(null);
                return;
            }
            // Aucune entrée `-i` sur ce graphe : la seule ligne « Video: » est
            // celle de la sortie, donc ses dimensions sont bien celles de
            // l'écran capturé.
            const MATCH = /Video:[^\n]*?(\d{3,5})x(\d{3,5})/.exec(stderr);
            let thumbnail = null;
            try {
                thumbnail = `data:image/jpeg;base64,${fs
                    .readFileSync(OUT)
                    .toString('base64')}`;
                fs.unlinkSync(OUT);
            } catch (e) {
                console.error('[arena-capture] thumbnail read failed:', e.message);
            }
            resolve({
                adapter,
                outputIndex,
                width: MATCH ? Number(MATCH[1]) : 0,
                height: MATCH ? Number(MATCH[2]) : 0,
                thumbnail
            });
        });
    });
}

/**
 * Écrans capturables sous Windows : une entrée par sortie ddagrab réellement
 * exploitable, avec l'image qui montre ce qu'elle contient. Les sondes sont
 * lancées en parallèle pour ne pas figer l'interface.
 * @returns {Promise<object[]>}
 */
async function listWindowsScreens() {
    const EXPECTED = Math.max(1, screen.getAllDisplays().length);
    // Balayage séquentiel (adaptateur, sortie). Les sorties d'un adaptateur
    // sont contiguës : au premier échec on passe à l'adaptateur suivant. Deux
    // écrans peuvent très bien être sur la carte graphique et un troisième sur
    // la sortie de la carte mère — ils ne partagent alors aucune numérotation.
    const PROBES = [];
    for (let adapter = 0; adapter < MAX_ADAPTERS; adapter++) {
        for (let output = 0; output < EXPECTED; output++) {
            const PROBE = await probeScreenOutput(adapter, output);
            if (!PROBE) break;
            PROBES.push(PROBE);
        }
        if (PROBES.length >= EXPECTED) break;
    }
    if (PROBES.length < EXPECTED) {
        console.log(
            `[arena-capture] ${PROBES.length} sortie(s) captable(s) pour ${EXPECTED} écran(s)`
        );
    }
    screenThumbnails = {};
    return PROBES.map((probe, position) => {
        screenThumbnails[`${probe.adapter}-${probe.outputIndex}`] =
            probe.thumbnail;
        return {
            // Numérotation volontairement distincte de celle de Windows :
            // elle ne correspond pas, et prétendre le contraire a déjà coûté
            // assez cher. C'est la vignette qui identifie l'écran.
            id: `ddagrab-${probe.adapter}-${probe.outputIndex}`,
            name: `Sortie ${position + 1} (${probe.width}×${probe.height})`,
            kind: 'screen',
            adapter: probe.adapter,
            outputIndex: probe.outputIndex,
            width: probe.width,
            height: probe.height,
            thumbnail: probe.thumbnail
        };
    });
}

/**
 * Sources sélectionnables : écrans d'abord (la cible du mode salle depuis
 * qu'on capte le logiciel de jeu directement), caméras virtuelles ensuite
 * (montages existants encore en service).
 */
async function listVideoDevices() {
    const { screens, cameras } = listCaptureDevices();
    const SCREENS =
        process.platform === 'darwin' ? screens : await listWindowsScreens();
    return [...SCREENS, ...cameras];
}

function buildFfmpegArgs(device) {
    const IS_MAC = process.platform === 'darwin';
    const SPOOL = getSpoolFolder();
    const IS_SCREEN = device.kind === 'screen';
    // Pas d'audio : ni la caméra virtuelle ni ddagrab n'en transportent. Le son
    // fera l'objet d'une entrée séparée (capture par processus).
    const ENCODER = resolveEncoder();
    // Le son n'existe que sur le chemin écran de Windows : le loopback est une
    // API Windows, et le chemin caméra est transitoire (montages existants) —
    // on ne touche pas à sa ligne de commande, qui fonctionne.
    const WITH_AUDIO = IS_SCREEN && process.platform === 'win32';
    // Entrée audio EN PREMIER : la vidéo du chemin écran vient d'un
    // filtergraph sans `-i`, donc le tube est l'entrée 0 et `-map 0:a` est
    // stable quel que soit l'encodeur retenu.
    const AUDIO_INPUT = WITH_AUDIO
        ? [
              '-f', 's16le',
              '-ar', String(arenaAudioService.SAMPLE_RATE),
              '-ac', String(arenaAudioService.CHANNELS),
              '-i', arenaAudioService.getPipePath()
          ]
        : [];
    const AUDIO_OUTPUT = WITH_AUDIO
        ? ['-map', '0:a', '-c:a', 'aac', '-b:a', '128k']
        : [];
    let inputArgs;
    // Images matérielles : `-pix_fmt` n'a pas de sens dessus, c'est l'encodeur
    // qui convertit. Renseigné par les branches logicielles uniquement.
    let pixFmtArgs = ['-pix_fmt', 'yuv420p'];
    if (IS_SCREEN && !IS_MAC && ENCODER.name === 'h264_nvenc') {
        // Chemin ZÉRO-COPIE : les images restent sur le GPU de ddagrab jusqu'à
        // NVENC, sans jamais passer en RAM.
        //
        // Ce n'est pas qu'une optimisation, c'est le seul montage qui marche :
        // avec `hwdownload`, ffmpeg passe quand même le device D3D11 à
        // l'encodeur, qui ouvre sa session dessus puis tente d'allouer des
        // tampons système — NVENC refuse (CreateInputBuffer, invalid param).
        const FILTERS = [
            `ddagrab=output_idx=${device.outputIndex || 0}:framerate=${OUTPUT_FPS}`
        ];
        if (device.width !== 1920 || device.height !== 1080) {
            // Redimensionnement sur GPU : redescendre en RAM pour un scale
            // logiciel ramènerait le problème ci-dessus.
            FILTERS.push('hwmap=derive_device=cuda', 'scale_cuda=1920:1080');
        }
        inputArgs = [
            '-init_hw_device', hwDeviceArg(device.adapter),
            '-filter_complex', `${FILTERS.join(',')}[v]`,
            '-map', '[v]'
        ];
        pixFmtArgs = [];
    } else if (IS_SCREEN && !IS_MAC) {
        // Windows sans NVENC (QSV, AMF, libx264). ddagrab est une SOURCE de
        // filtergraph, pas un format d'entrée — il n'y a donc aucun `-i`, et
        // c'est `-filter_complex` qui produit le flux.
        //
        // `hwdownload` ramène les images en RAM pour un encodeur logiciel.
        // Coût réel (BGRA 1080p30 ≈ 240 Mo/s sur le bus), mais sans
        // alternative pour ces encodeurs. Chemin NON TESTÉ : les PC de salle
        // rencontrés jusqu'ici sont tous en NVENC.
        const FILTERS = [
            `ddagrab=output_idx=${device.outputIndex || 0}:framerate=${OUTPUT_FPS}`,
            'hwdownload',
            'format=bgra'
        ];
        // L'analyseur travaille en coordonnées 1920×1080 absolues. Un écran
        // plus grand est réduit ; un écran plus petit est refusé en amont
        // (startCapture) — pas d'upscale, décision Antoine.
        if (device.width !== 1920 || device.height !== 1080) {
            FILTERS.push('scale=1920:1080');
        }
        // `format=bgra` est imposé par hwdownload (format des textures) ; la
        // conversion vers l'espace attendu par l'encodeur est explicite pour
        // ne pas dépendre de l'auto-insertion de ffmpeg.
        FILTERS.push('format=yuv420p');
        inputArgs = [
            '-init_hw_device', 'd3d11va=dda',
            '-filter_hw_device', 'dda',
            '-filter_complex', `${FILTERS.join(',')}[v]`,
            '-map', '[v]'
        ];
    } else if (IS_SCREEN) {
        // macOS (dev) : avfoundation expose les écrans comme des
        // périphériques. Pas de contrôle de format ici — sur un écran qui
        // n'est pas en 16/9 (les portables Apple sont en 16/10), l'image sera
        // déformée. Acceptable pour du dev, refusé sous Windows.
        inputArgs = [
            '-f', 'avfoundation',
            '-framerate', String(OUTPUT_FPS),
            '-i', `${device.id}:none`,
            '-vf', 'scale=1920:1080'
        ];
    } else if (IS_MAC) {
        inputArgs = [
            '-f', 'avfoundation',
            '-framerate', String(detectedMode ? detectedMode.fps : 30),
            ...(detectedMode
                ? ['-video_size', `${detectedMode.width}x${detectedMode.height}`]
                : []),
            '-i', `${device.id}:none`
        ];
    } else {
        inputArgs = [
            '-f', 'dshow',
            '-rtbufsize', '512M',
            '-i', `video=${device.id}`
        ];
    }
    const ENCODER_ARGS = ENCODER.args;
    // Sortie en CFR : les caméras (surtout virtuelles) livrent des timestamps
    // irréguliers qui, sans ça, produisent un temps média ≠ temps réel (fps
    // annoncés délirants, frames dupliquées) — ce qui fausse la durée des
    // segments (le muxer segmente sur le temps média) et tout le mapping
    // temporel du pipeline.
    return [
        '-hide_banner',
        // Progression toutes les 100 ms au lieu de 500 : c'est cette ligne qui
        // signale la première image, et donc l'instant où le son doit
        // commencer. Sa période est l'imprécision résiduelle de la synchro.
        ...(WITH_AUDIO ? ['-stats_period', '0.1'] : []),
        ...AUDIO_INPUT,
        ...inputArgs,
        ...AUDIO_OUTPUT,
        ...ENCODER_ARGS,
        '-fps_mode', 'cfr',
        '-r', String(OUTPUT_FPS),
        // GOP = 1 s (cf. ENCODER_ARGS) : keyframe à chaque seconde pour un
        // seek fluide côté web ET une découpe stream-copy précise à ±1 s.
        '-g', String(OUTPUT_FPS),
        ...pixFmtArgs,
        '-f', 'segment',
        '-segment_time', String(SEGMENT_SECONDS),
        '-reset_timestamps', '1',
        '-strftime', '1',
        path.join(SPOOL, 'rec_%Y%m%d-%H%M%S.mkv')
    ];
}

/**
 * Démarre la captation sur le périphérique configuré. No-op si déjà en cours
 * ou si aucun périphérique n'est configuré.
 */
function startCapture() {
    if (ffmpegProcess) return getStatus();
    const DEVICE = getDevice();
    if (!DEVICE || !DEVICE.id) {
        lastError = 'no_device';
        return getStatus();
    }

    const SPOOL = getSpoolFolder();
    if (!fs.existsSync(SPOOL)) fs.mkdirSync(SPOOL, { recursive: true });

    stopRequested = false;
    lastError = null;
    stderrTail = [];
    resolutionRejected = false;
    videoStarted = false;

    // Les index avfoundation ne sont PAS stables (un iPhone en continuité ou
    // une webcam débranchée décale tout) : on re-résout l'index par le NOM à
    // chaque démarrage. Windows/dshow adresse déjà par nom, rien à faire.
    let resolvedDevice = DEVICE;
    if (process.platform === 'darwin') {
        const { screens, cameras } = listCaptureDevices();
        const MATCH = [...screens, ...cameras].find(
            (d) => d.name === DEVICE.name
        );
        if (!MATCH) {
            lastError = `device_not_found: ${DEVICE.name}`;
            console.error('[arena-capture]', lastError);
            return getStatus();
        }
        resolvedDevice = MATCH;
    } else if (
        DEVICE.kind === 'screen' &&
        (typeof DEVICE.outputIndex !== 'number' ||
            typeof DEVICE.adapter !== 'number')
    ) {
        // Source enregistrée par une version antérieure : son index de sortie
        // était déduit d'une autre énumération, donc faux. Démarrer dessus
        // enregistrerait un autre écran en silence — on refuse et on demande
        // une nouvelle sélection.
        lastError = `screen_stale: ${DEVICE.name} — rafraîchissez la liste des sources`;
        console.error('[arena-capture]', lastError);
        return getStatus();
    }

    // Pas d'upscale (décision Antoine) : un écran plus petit que 1080p ne peut
    // pas alimenter l'analyseur, qui raisonne en coordonnées 1920×1080.
    // Le format doit aussi être du 16/9 : réduire un écran 16/10 vers 1080p
    // déformerait l'image, et l'ajouter en letterbox décalerait toutes les
    // coordonnées de l'analyseur. Les deux cassent l'analyse en silence, donc
    // on refuse plutôt que de produire des vidéos inexploitables.
    if (resolvedDevice.kind === 'screen' && resolvedDevice.width) {
        const { width: WIDTH, height: HEIGHT } = resolvedDevice;
        if (WIDTH < 1920 || HEIGHT < 1080) {
            resolutionRejected = true;
            lastError = `not_1080p: écran ${WIDTH}x${HEIGHT} (1920x1080 minimum requis)`;
        } else if (Math.abs(WIDTH / HEIGHT - 16 / 9) > 0.01) {
            resolutionRejected = true;
            lastError = `not_16_9: écran ${WIDTH}x${HEIGHT} (format 16/9 requis)`;
        }
        if (resolutionRejected) {
            console.error('[arena-capture]', lastError);
            return getStatus();
        }
    }

    // Le tube doit écouter AVANT que ffmpeg tente de l'ouvrir.
    if (resolvedDevice.kind === 'screen' && process.platform === 'win32') {
        arenaAudioService.start();
    }

    const ARGS = buildFfmpegArgs(resolvedDevice);
    console.log(`[arena-capture] starting: ${FFMPEG_PATH} ${ARGS.join(' ')}`);
    const PROC = spawn(FFMPEG_PATH, ARGS, { stdio: ['pipe', 'ignore', 'pipe'] });
    ffmpegProcess = PROC;
    startedAt = Date.now();
    // La captation vient de passer active : battement anticipé vers le backend.
    arenaModeService.notifyChange();

    let resolutionChecked = false;
    // La première image ne commande PLUS l'envoi du son : ffmpeg n'ouvre son
    // muxer qu'une fois que chacun de ses flux a produit un paquet, donc il
    // n'annonce jamais d'image tant qu'il n'a pas reçu de son (cf.
    // arena-audio-service). Elle ne sert plus qu'à l'affichage et au
    // diagnostic.
    let firstFrameSeen = false;
    PROC.stderr.on('data', (d) => {
        const LINE = d.toString().trim();
        if (!LINE) return;
        const IS_PROGRESS = /^frame=/.test(LINE);
        // La progression sort dix fois par seconde : la laisser entrer dans le
        // tail noierait le diagnostic qu'on y cherche en cas de mort.
        if (!IS_PROGRESS) {
            stderrTail.push(LINE);
            if (stderrTail.length > 20) stderrTail.shift();
        }
        // Première image encodée : l'enregistrement produit réellement de la
        // vidéo, l'interface cesse d'annoncer l'attente.
        if (!firstFrameSeen && IS_PROGRESS) {
            const FRAME = /frame=\s*(\d+)/.exec(LINE);
            if (FRAME && Number(FRAME[1]) > 0) {
                firstFrameSeen = true;
                videoStarted = true;
                // Le son démarre, lui, à l'ouverture du tube : ce délai majore
                // donc le décalage résiduel de la piste audio. À comparer au
                // décalage constaté dans le fichier.
                console.log(
                    `[arena-capture] first frame after ${Date.now() - startedAt}ms`
                );
            }
        }
        // Contrôle strict 1080p sur la première ligne de stream vidéo (l'input
        // apparaît avant l'output dans le banner ffmpeg) : source ≠ 1920×1080
        // → arrêt immédiat avec erreur, sans redémarrage automatique. Sans
        // objet pour un écran : sa définition est validée avant le démarrage,
        // et la mise à l'échelle vers 1080p est délibérée.
        if (!resolutionChecked && resolvedDevice.kind !== 'screen') {
            const M = LINE.match(/Video:.*?(\d{3,4})x(\d{3,4})/);
            if (M) {
                resolutionChecked = true;
                if (M[1] !== '1920' || M[2] !== '1080') {
                    resolutionRejected = true;
                    lastError = `not_1080p: source ${M[1]}x${M[2]} (1920x1080 requis)`;
                    console.error('[arena-capture]', lastError);
                    PROC.kill('SIGINT');
                }
            }
        }
    });

    PROC.on('error', (e) => {
        console.error('[arena-capture] spawn error:', e.message);
        lastError = e.message;
    });

    PROC.on('close', (code) => {
        if (ffmpegProcess !== PROC) return;
        ffmpegProcess = null;
        startedAt = null;
        // Idem à l'arrêt. Un redémarrage automatique (erreur ffmpeg) fait
        // clignoter l'état : l'amortissement du battement l'absorbe.
        arenaModeService.notifyChange();
        if (stopRequested) {
            console.log('[arena-capture] stopped');
            return;
        }
        // Source refusée (≠ 1080p) : pas de redémarrage automatique — l'erreur
        // reste affichée jusqu'à ce que la source soit corrigée et la captation
        // relancée manuellement.
        if (resolutionRejected) return;
        // Mode refusé par le périphérique : ffmpeg vient de logger la liste des
        // modes supportés → on adopte le premier S'IL est en 1080p et on
        // relance immédiatement (une seule fois par mode pour ne pas boucler).
        // Un périphérique qui ne propose pas de 1080p est refusé net.
        const SUPPORTED = parseSupportedMode(stderrTail);
        if (SUPPORTED && (SUPPORTED.width !== 1920 || SUPPORTED.height !== 1080)) {
            resolutionRejected = true;
            lastError = `not_1080p: le périphérique propose ${SUPPORTED.width}x${SUPPORTED.height} (1920x1080 requis)`;
            console.error('[arena-capture]', lastError);
            return;
        }
        if (
            SUPPORTED &&
            (!detectedMode || detectedMode.fps !== SUPPORTED.fps)
        ) {
            detectedMode = SUPPORTED;
            console.log(
                `[arena-capture] device imposes ${SUPPORTED.width}x${SUPPORTED.height}@${SUPPORTED.fps} — restarting with it`
            );
            startCapture();
            return;
        }
        // Mort inattendue (device débranché, erreur d'encodage…) : on garde le
        // diagnostic et on relance avec backoff — la captation d'une salle ne
        // doit jamais rester morte en silence.
        lastError = stderrTail.slice(-3).join(' | ') || `ffmpeg exited (${code})`;
        // Le tail COMPLET dans la console : sur un échec de filtergraph, les 3
        // dernières lignes ne sont que la cascade, la cause est plus haut.
        console.error(
            `[arena-capture] ffmpeg died (code ${code}), restart in ${restartDelayMs / 1000}s —\n${stderrTail.join('\n')}`
        );
        restartTimer = setTimeout(() => {
            restartTimer = null;
            restartDelayMs = Math.min(restartDelayMs * 2, RESTART_MAX_DELAY_MS);
            startCapture();
        }, restartDelayMs);
    });

    // Un run sain depuis > 2 min réarme le backoff.
    setTimeout(() => {
        if (ffmpegProcess === PROC) restartDelayMs = RESTART_BASE_DELAY_MS;
    }, 2 * 60 * 1000);

    return getStatus();
}

/**
 * Arrête proprement la captation ('q' sur stdin → ffmpeg finalise le segment
 * en cours), et annule tout redémarrage programmé.
 */
function stopCapture() {
    stopRequested = true;
    arenaAudioService.stop();
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    restartDelayMs = RESTART_BASE_DELAY_MS;
    if (ffmpegProcess) {
        try {
            ffmpegProcess.stdin.write('q');
        } catch (_) {
            ffmpegProcess.kill('SIGINT');
        }
    }
    return getStatus();
}

/**
 * Sélectionne le périphérique. Ne démarre PAS la captation de lui-même : le
 * simple choix d'une source ne sert qu'à la prévisualisation. En revanche, si
 * une captation est déjà en cours, on bascule dessus sans interruption voulue
 * par l'utilisateur.
 * @param {{id: string, name: string}} device
 */
function setDeviceAndRestart(device) {
    setDevice(device);
    detectedMode = null;
    if (ffmpegProcess) {
        // Redémarrage sur le nouveau périphérique une fois l'ancien arrêté.
        const OLD = ffmpegProcess;
        stopCapture();
        OLD.on('close', () => startCapture());
    }
    return getStatus();
}

/**
 * À appeler au boot : reprend la captation si un périphérique est configuré et
 * que le mode salle est actif (l'appelant vérifie ce dernier point).
 */
function autoStart() {
    if (getDevice()) startCapture();
}

function getStatus() {
    const DEVICE = getDevice();
    return {
        running: !!ffmpegProcess,
        deviceId: DEVICE ? DEVICE.id : null,
        deviceName: DEVICE ? DEVICE.name : null,
        // L'aperçu du renderer n'ouvre pas une source écran comme une caméra.
        deviceKind: DEVICE ? DEVICE.kind || 'camera' : null,
        // Vignette de la sortie choisie : pour un écran, l'aperçu est cette
        // image — captée par ddagrab, donc fidèle à ce qui est enregistré.
        deviceThumbnail:
            DEVICE && DEVICE.kind === 'screen'
                ? screenThumbnails[`${DEVICE.adapter || 0}-${DEVICE.outputIndex}`] ||
                  null
                : null,
        // Le renderer n'envoie du PCM que si le tube attend réellement du son.
        audio: arenaAudioService.getStatus(),
        videoStarted,
        encoder: resolvedEncoder ? resolvedEncoder.name : null,
        startedAt,
        lastError,
        spoolFolder: getSpoolFolder(),
        segmentSeconds: SEGMENT_SECONDS
    };
}

module.exports = {
    listVideoDevices,
    startCapture,
    stopCapture,
    setDeviceAndRestart,
    autoStart,
    getStatus,
    setSpoolFolder
};
