// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const os = require('os');
const path = require('node:path');
const { spawn, spawnSync } = require('child_process');
const { nativeImage } = require('electron');
const { FFMPEG_PATH } = require('../config/constants');
const StorageManager = require('../core/storage-manager');
const arenaAudioService = require('./arena-audio-service');
const arenaModeService = require('./arena-mode-service');

//#endregion

// Mode salle — brique de CAPTATION. Contrat : filme la scène « Tools Virtual
// Scene » (la fenêtre du jeu, plus webcam et images) et écrit des segments
// vidéo dans le dossier spool. Le reste du pipeline (détection loading/score
// frame, découpe, analyse, upload) ne consomme QUE ce dossier : si la source
// change demain, seule cette brique est remplacée.
//
// C'est la seule source : les écrans (ddagrab) et les caméras virtuelles (OBS)
// ont été retirés — numéro d'écran instable, écran qui disparaît, caméra
// virtuelle coupée par un autre usage d'OBS.
//
// Enregistrement en segments mkv (crash-safe : un mkv tronqué reste lisible,
// contrairement à un mp4 sans moov) de SEGMENT_SECONDS. Une game à cheval sur
// deux segments sera recollée par le pipeline (ffmpeg concat demuxer,
// stream-copy). ffmpeg est relancé automatiquement s'il meurt : PC de salle
// sans surveillance.

const SETTINGS_KEY_SPOOL = 'arenaSpoolFolder';
// Scène : webcam et images posées PAR-DESSUS le jeu, qui reste en plein cadre.
const SETTINGS_KEY_SCENE = 'arenaScene';
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
const RESTART_BASE_DELAY_MS = 5 * 1000;
// Aperçu : une seule image JPEG réécrite en boucle, pour que l'admin voie à
// distance ce qui est réellement filmé. Basse cadence et basse définition — ce
// n'est pas un flux, c'est une preuve de source.
const PREVIEW_FPS = '1';
const PREVIEW_WIDTH = 480;
// Image figée depuis une minute : fenêtre du jeu qui ne se rafraîchit plus,
// image noire… ffmpeg enregistre alors sans rien signaler. Posé sur
// la branche d'aperçu (déjà en RAM, 1 image / 2 s), il ne coûte rien ; ffmpeg
// logge `freeze_start` puis `freeze_end`, recopiés dans les logs.
const FREEZE_FILTER = 'freezedetect=d=60';
const RESTART_MAX_DELAY_MS = 60 * 1000;
// Plus aucune image encodée depuis ce délai alors que ffmpeg tourne : le graphe
// est bloqué (une webcam qui cesse d'émettre peut suffire à le figer). On tue
// ffmpeg pour laisser jouer la relance, plutôt que d'enregistrer du vide.
const STALL_MS = 30 * 1000;
// Réintégration d'une webcam écartée après une panne : on vérifie qu'elle est
// revenue, avec un délai qui double à chaque échec pour qu'une webcam prise
// par un autre logiciel ne coupe pas l'enregistrement toutes les minutes.
const WEBCAM_RETRY_BASE_MS = 60 * 1000;
const WEBCAM_RETRY_MAX_MS = 30 * 60 * 1000;
// Attente de la fenêtre du jeu : c'est le délai de démarrage d'une game après
// l'ouverture du jeu, il doit rester court (l'analyseur a besoin du début).
const GAME_POLL_MS = 3000;
// Garde-fou disque : sous ce seuil d'espace libre sur le volume du spool, la
// captation s'arrête (~2 h de marge à 4,5 Go/h) — un PC de streaming au disque
// plein ferait tomber bien plus que l'enregistrement. Elle reprend seule
// au-dessus du seuil de reprise, plus haut pour ne pas osciller.
const DISK_LOW_BYTES = 10 * 1024 ** 3;
const DISK_RESUME_BYTES = 15 * 1024 ** 3;
const DISK_CHECK_MS = 60 * 1000;

let ffmpegProcess = null;
let stopRequested = false;
let restartTimer = null;
let restartDelayMs = RESTART_BASE_DELAY_MS;
let startedAt = null;
let lastError = null;
// Dernières lignes stderr de ffmpeg : en cas d'échec au démarrage (device
// invalide, framerate non supporté…), c'est le seul diagnostic utile.
let stderrTail = [];
// Première image reçue de la source. Tant qu'elle n'est pas arrivée, RIEN
// n'est enregistré.
let videoStarted = false;
// Webcam de la scène écartée après une panne de ffmpeg : l'enregistrement
// continue sans elle jusqu'à ce qu'elle réapparaisse (cf. scheduleWebcamRetry).
let webcamSuspended = false;
let webcamRetryTimer = null;
let webcamRetryDelayMs = WEBCAM_RETRY_BASE_MS;
// Captation armée, en attente de la fenêtre du jeu : ffmpeg ne tourne pas. Le
// jeton invalide une attente en cours quand la captation est arrêtée ou
// relancée.
let waitingGame = false;
let gameWaitTimer = null;
let gameWaitToken = 0;
// Exécutable du jeu filmé par la scène : ffmpeg ne cible que lui, et un
// changement de jeu (After-H ↔ Color Chaos) relance la captation.
let sceneTargetExe = null;
// Nettoyage des captations orphelines : une fois par session suffit.
let orphansChecked = false;
// Abonnement Arena de la salle inactif (le serveur répond 402) : plus rien n'est
// filmé — une salle qui ne paie plus n'a plus de mode salle, et les vidéos
// laissées sur le disque serviraient sans payer. Verrou posé dans startCapture,
// seul point d'entrée de toutes les relances (bouton, scène, jeu, panne).
let suspended = false;
// La captation est voulue : posé par tout démarrage (même bloqué par la
// suspension), levé par tout arrêt. Plus fiable que de déduire l'intention de
// l'état de ffmpeg, qui passe par des instants creux (jeu fermé, fenêtre
// cherchée) : c'est ce drapeau qui décide de la reprise au retour de
// l'abonnement. Un arrêt manuel pendant la suspension l'annule donc.
let captureWanted = false;
// Espace libre du volume du spool sous DISK_LOW_BYTES : captation arrêtée, comme
// pour `suspended`, et reprise au-dessus de DISK_RESUME_BYTES.
let diskLow = false;
let diskFreeBytes = null;

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

/**
 * Fichier d'aperçu, à la racine de EBP-Tools-Arena — surtout pas dans spool/ ni
 * games/, que le pipeline et l'uploader scrutent.
 */
function getPreviewPath() {
    return path.join(path.dirname(getSpoolFolder()), 'preview.jpg');
}

/**
 * Liste les périphériques vidéo via ffmpeg (avfoundation sur macOS, dshow sur
 * Windows). ffmpeg sort la liste sur stderr et se termine en erreur : c'est le
 * comportement attendu, on parse quoi qu'il arrive.
 * Sépare les écrans (avfoundation les expose comme des caméras, macOS
 * seulement) des webcams.
 * @returns {{screens: object[], webcams: object[]}}  id = index avfoundation ou chemin dshow.
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
    // Webcams de la scène : toutes les caméras, physiques comprises. Leur
    // aperçu passe par l'image assemblée par ffmpeg, donc leur exclusivité
    // sous Windows n'est plus un obstacle.
    const WEBCAMS = DEVICES.filter((d) => !IS_SCREEN.test(d.name)).map(
        (d) => ({ id: d.id, name: d.name, kind: 'webcam' })
    );
    return { screens: SCREENS, webcams: WEBCAMS };
}

/** Webcams posables dans la scène. */
function listWebcams() {
    return listCaptureDevices().webcams;
}

/**
 * Éléments à poser sur le jeu pour ce démarrage, dans l'ordre d'empilement :
 * la webcam (sauf si elle est écartée), puis les images. Une image dont le
 * fichier a disparu est ignorée : elle ne doit pas empêcher d'enregistrer.
 */
function sceneOverlays() {
    const SCENE = getScene();
    const ITEMS = [];
    if (SCENE.webcam && !webcamSuspended) {
        let id = SCENE.webcam.id;
        // macOS (dev) : les index avfoundation ne sont pas stables (cf.
        // startCapture), on re-résout par le nom.
        if (process.platform === 'darwin') {
            const MATCH = listCaptureDevices().webcams.find(
                (d) => d.name === SCENE.webcam.name
            );
            id = MATCH ? MATCH.id : null;
        }
        if (id) {
            ITEMS.push({ ...SCENE.webcam, id, kind: 'webcam' });
        } else {
            console.warn(
                `[arena-capture] webcam "${SCENE.webcam.name}" introuvable — ignorée`
            );
        }
    }
    for (const IMAGE of SCENE.images) {
        const FILE = path.join(getSceneFolder(), IMAGE.file);
        if (fs.existsSync(FILE)) {
            ITEMS.push({ ...IMAGE, path: FILE, kind: 'image' });
        } else {
            console.warn(`[arena-capture] image de scène absente : ${FILE}`);
        }
    }
    return ITEMS;
}

/**
 * Entrées et filtergraph de la scène : la fenêtre du jeu en plein cadre, puis
 * chaque élément redimensionné et posé par `overlay`.
 *
 * Le jeu est filmé PAR SA FENÊTRE (Windows Graphics Capture), repérée par le
 * nom de son exécutable comme le son (cf. arena-audio-service) : ni numéro
 * d'écran à deviner, ni écran qui disparaît. La fenêtre est ramenée en 1080p
 * par la capture elle-même. `max_framerate=60` : plafonnée à 30, la capture
 * sautait des images (13 % de doublons mesurés en salle, ~0 à 60).
 *
 * L'assemblage se fait en RAM, quelle que soit la carte graphique : les
 * filtres GPU diffèrent d'un constructeur à l'autre, `overlay` marche partout.
 * Aucun device n'est passé à l'encodeur : c'est ce qui faisait refuser à NVENC
 * les images redescendues en RAM. Montage validé en salle avec NVENC comme
 * avec libx264.
 *
 * @param {number} firstInput Index de la première entrée ajoutée ici (le son,
 *   s'il existe, est l'entrée 0).
 */
function sceneArgs(overlays, firstInput) {
    const IS_MAC = process.platform === 'darwin';
    const ARGS = [];
    const CHAINS = [];
    let input = firstInput;
    if (IS_MAC) {
        // Dev : pas de capture de fenêtre, le premier écran tient lieu de jeu
        // (déformé s'il n'est pas en 16/9, comme le chemin écran macOS).
        const SCREEN = listCaptureDevices().screens[0];
        ARGS.push(
            '-f', 'avfoundation',
            '-framerate', String(OUTPUT_FPS),
            '-i', `${SCREEN ? SCREEN.id : 0}:none`
        );
        CHAINS.push(`[${input++}:v]scale=1920:1080[s0]`);
    } else {
        // Le jeu repéré au démarrage (cf. waitForGame) ; à défaut, n'importe
        // lequel des jeux connus — un seul tourne à la fois.
        const EXES = (
            sceneTargetExe ? [sceneTargetExe] : arenaAudioService.TARGET_EXECUTABLES
        )
            .map((exe) => exe.replace(/\.exe$/i, ''))
            .join('|');
        CHAINS.push(
            `gfxcapture=window_exe='(?i)${EXES}':max_framerate=60:capture_cursor=0:width=1920:height=1080:resize_mode=scale_aspect,hwdownload,format=bgra[s0]`
        );
    }
    overlays.forEach((item, i) => {
        if (item.kind === 'webcam') {
            ARGS.push(
                ...(IS_MAC
                    ? ['-f', 'avfoundation', '-framerate', '30', '-i', `${item.id}:none`]
                    : ['-f', 'dshow', '-rtbufsize', '256M', '-i', `video=${item.id}`])
            );
        } else {
            // Une seule image décodée : `overlay` répète la dernière image
            // d'une entrée terminée (eof_action=repeat), inutile de la boucler.
            ARGS.push('-i', item.path);
        }
        CHAINS.push(
            `[${input++}:v]scale=${item.width}:${item.height}[o${i}]`,
            `[s${i}][o${i}]overlay=${item.x}:${item.y}[s${i + 1}]`
        );
    });
    // Seconde branche : l'aperçu (cf. buildFfmpegArgs).
    CHAINS.push(
        `[s${overlays.length}]format=yuv420p,split=2[v][p]`,
        `[p]fps=${PREVIEW_FPS},scale=${PREVIEW_WIDTH}:-1,${FREEZE_FILTER}[pv]`
    );
    return [...ARGS, '-filter_complex', CHAINS.join(';'), '-map', '[v]'];
}

/**
 * @param {object[]} overlays  Éléments de la scène (cf. sceneOverlays).
 */
function buildFfmpegArgs(overlays) {
    const SPOOL = getSpoolFolder();
    const ENCODER = resolveEncoder();
    // Le son n'existe que sous Windows : le loopback par processus est une API
    // Windows (macOS ne sert qu'au développement).
    const WITH_AUDIO = process.platform === 'win32';
    // Entrée audio EN PREMIER : la vidéo vient d'un filtergraph, donc le tube
    // est l'entrée 0 et `-map 0:a` est stable quel que soit l'encodeur retenu.
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
    // Sortie en CFR : la capture de fenêtre et les webcams livrent des
    // timestamps irréguliers qui, sans ça, produisent un temps média ≠ temps
    // réel — ce qui fausse la durée des segments (le muxer segmente sur le
    // temps média) et tout le mapping temporel du pipeline.
    return [
        '-hide_banner',
        // Progression toutes les 100 ms au lieu de 500 : c'est cette ligne qui
        // signale la première image, et donc l'instant où le son doit
        // commencer. Sa période est l'imprécision résiduelle de la synchro.
        ...(WITH_AUDIO ? ['-stats_period', '0.1'] : []),
        ...AUDIO_INPUT,
        ...sceneArgs(overlays, WITH_AUDIO ? 1 : 0),
        ...AUDIO_OUTPUT,
        ...ENCODER.args,
        '-fps_mode', 'cfr',
        '-r', String(OUTPUT_FPS),
        // GOP = 1 s (cf. ENCODER_ARGS) : keyframe à chaque seconde pour un
        // seek fluide côté web ET une découpe stream-copy précise à ±1 s.
        '-g', String(OUTPUT_FPS),
        '-pix_fmt', 'yuv420p',
        '-f', 'segment',
        '-segment_time', String(SEGMENT_SECONDS),
        '-reset_timestamps', '1',
        '-strftime', '1',
        path.join(SPOOL, 'rec_%Y%m%d-%H%M%S.mkv'),
        // Seconde sortie : une image unique réécrite en boucle (`-update 1`),
        // le label [pv] du filtergraph. C'est l'aperçu de l'éditeur de scène et
        // de l'admin à distance.
        '-map', '[pv]',
        '-f', 'image2',
        '-update', '1',
        '-y',
        getPreviewPath()
    ];
}

/**
 * Tue les captations laissées par un Tools mort (plantage, Ctrl-C en dev) :
 * plus personne ne les arrêtera, elles remplissent le spool et une a déjà
 * atteint 95 Go de mémoire. Seules celles dont le parent est mort sont visées,
 * pour épargner la captation d'une autre instance vivante (dev + prod).
 * @param {string} spool Dossier où écrivent nos captations.
 */
function killOrphanCaptures(spool) {
    const MARKER = path.join(spool, 'rec_');
    let procs;
    if (process.platform === 'win32') {
        const RES = spawnSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                "Get-CimInstance Win32_Process -Filter \"Name LIKE 'ffmpeg%'\" | " +
                    'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
            ],
            { encoding: 'utf8', timeout: 15000, windowsHide: true }
        );
        try {
            procs = [].concat(JSON.parse(RES.stdout || '[]')).map((p) => ({
                pid: p.ProcessId,
                ppid: p.ParentProcessId,
                cmd: p.CommandLine || ''
            }));
        } catch (_) {
            console.warn('[arena-capture] liste des processus illisible — orphelins non vérifiés');
            return;
        }
    } else {
        const RES = spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], {
            encoding: 'utf8'
        });
        procs = (RES.stdout || '')
            .split('\n')
            .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
            .filter(Boolean)
            .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
    }

    // Unix rattache l'orphelin à launchd/init (PID 1) ; Windows garde le PID
    // d'un parent qui n'existe plus.
    const PARENT_ALIVE = (ppid) => {
        if (ppid === 1) return false;
        try {
            process.kill(ppid, 0);
            return true;
        } catch (e) {
            return e.code === 'EPERM';
        }
    };
    for (const P of procs) {
        if (!P.cmd.includes(FFMPEG_PATH) || !P.cmd.includes(MARKER)) continue;
        if (PARENT_ALIVE(P.ppid)) continue;
        // SIGKILL : un orphelin bloqué ignore 'q' comme SIGINT, et le mkv
        // tronqué reste lisible.
        try {
            process.kill(P.pid, 'SIGKILL');
            console.warn(`[arena-capture] captation orpheline tuée (pid ${P.pid})`);
        } catch (e) {
            console.warn(`[arena-capture] orpheline ${P.pid} non tuée : ${e.message}`);
        }
    }
}

/**
 * Démarre la captation. Sous Windows, elle attend d'abord que le jeu soit
 * ouvert (cf. waitForGame), puis ffmpeg filme sa fenêtre. No-op si déjà en
 * cours.
 * @param {boolean} gameFound Vrai quand waitForGame vient de trouver le jeu.
 */
function startCapture(gameFound = false) {
    captureWanted = true;
    checkDisk();
    if (suspended || diskLow) return getStatus();
    if (ffmpegProcess) return getStatus();

    const SPOOL = getSpoolFolder();
    if (!fs.existsSync(SPOOL)) fs.mkdirSync(SPOOL, { recursive: true });

    if (!orphansChecked) {
        orphansChecked = true;
        killOrphanCaptures(SPOOL);
    }

    stopRequested = false;
    lastError = null;
    stderrTail = [];
    videoStarted = false;

    // Rien à filmer tant que le jeu n'est pas ouvert : la captation est armée
    // et ffmpeg démarre dès que sa fenêtre apparaît. Sur macOS (dev), le jeu
    // n'est pas détectable et l'écran le remplace : on démarre tout de suite.
    const WAITS_FOR_GAME = process.platform === 'win32';
    if (WAITS_FOR_GAME && !gameFound) {
        waitForGame();
        return getStatus();
    }

    // Le tube doit écouter AVANT que ffmpeg tente de l'ouvrir.
    if (process.platform === 'win32') {
        arenaAudioService.start();
    }

    const OVERLAYS = sceneOverlays();
    const WITH_WEBCAM = OVERLAYS.some((o) => o.kind === 'webcam');
    const ARGS = buildFfmpegArgs(OVERLAYS);
    console.log(`[arena-capture] starting: ${FFMPEG_PATH} ${ARGS.join(' ')}`);
    const PROC = spawn(FFMPEG_PATH, ARGS, { stdio: ['pipe', 'ignore', 'pipe'] });
    ffmpegProcess = PROC;
    startedAt = Date.now();
    // La captation vient de passer active : battement anticipé vers le backend.
    arenaModeService.notifyChange();

    // La première image ne commande PLUS l'envoi du son : ffmpeg n'ouvre son
    // muxer qu'une fois que chacun de ses flux a produit un paquet, donc il
    // n'annonce jamais d'image tant qu'il n'a pas reçu de son (cf.
    // arena-audio-service). Elle ne sert plus qu'à l'affichage et au
    // diagnostic.
    let firstFrameSeen = false;
    let lastFrame = 0;
    let lastFrameAt = Date.now();
    const STALL_TIMER = setInterval(() => {
        if (ffmpegProcess !== PROC) {
            clearInterval(STALL_TIMER);
            return;
        }
        if (videoStarted && Date.now() - lastFrameAt > STALL_MS) {
            clearInterval(STALL_TIMER);
            console.error(
                `[arena-capture] plus aucune image depuis ${STALL_MS / 1000}s — ffmpeg arrêté pour être relancé`
            );
            PROC.kill();
        }
    }, 5000);
    // Scène : le jeu filmé peut changer en cours de route (After-H ↔ Color
    // Chaos). Selon la façon dont la capture de fenêtre réagit à la fermeture,
    // ffmpeg s'arrêterait seul ou attendrait 30 s des images qui ne viennent
    // plus — soit le début de la game suivante, dont l'analyseur a besoin. On
    // surveille donc le jeu ouvert et on relance dès qu'il n'est plus le même.
    const GAME_TIMER = WAITS_FOR_GAME
        ? setInterval(() => {
              arenaAudioService.findTarget().then((target) => {
                  if (ffmpegProcess !== PROC || stopRequested) return;
                  if (
                      target &&
                      target.exe.toLowerCase() === String(sceneTargetExe).toLowerCase()
                  ) {
                      return;
                  }
                  clearInterval(GAME_TIMER);
                  console.log(
                      `[arena-capture] jeu changé (${sceneTargetExe} → ${target ? target.exe : 'aucun'}) — relance`
                  );
                  restartCapture();
                  // Une capture restée accrochée à la fenêtre fermée pourrait
                  // ne pas finaliser sur 'q'.
                  setTimeout(() => {
                      if (!PROC.killed && PROC.exitCode === null) PROC.kill();
                  }, 5000);
              });
          }, GAME_POLL_MS)
        : null;
    PROC.stderr.on('data', (d) => {
        const LINE = d.toString().trim();
        if (!LINE) return;
        const IS_PROGRESS = /^frame=/.test(LINE);
        if (IS_PROGRESS) {
            const FRAME = /frame=\s*(\d+)/.exec(LINE);
            if (FRAME && Number(FRAME[1]) !== lastFrame) {
                lastFrame = Number(FRAME[1]);
                lastFrameAt = Date.now();
            }
        }
        for (const FREEZE of LINE.match(/freeze_(start|end): [\d.]+/g) || []) {
            console.warn(`[arena-capture] image figée — ${FREEZE}`);
        }
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
    });

    PROC.on('error', (e) => {
        console.error('[arena-capture] spawn error:', e.message);
        lastError = e.message;
    });

    PROC.on('close', (code) => {
        clearInterval(STALL_TIMER);
        clearInterval(GAME_TIMER);
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
        // ffmpeg s'arrête aussi quand le jeu se ferme (passage
        // d'After-H à Color Chaos, plantage). Ce n'est pas une panne : on se
        // remet en attente de sa fenêtre, sans backoff ni fusible.
        if (!WAITS_FOR_GAME) {
            handleDeath(code);
            return;
        }
        arenaAudioService.findTarget().then((target) => {
            if (stopRequested || ffmpegProcess || restartTimer) return;
            // Le jeu filmé est toujours là : vraie panne.
            if (
                target &&
                target.exe.toLowerCase() === String(sceneTargetExe).toLowerCase()
            ) {
                handleDeath(code);
                return;
            }
            // Jeu fermé ou remplacé par l'autre : on repart sur sa fenêtre,
            // tout de suite s'il est déjà ouvert.
            console.log(
                `[arena-capture] jeu fermé ou changé (code ${code}) — reprise sur ${target ? target.exe : 'la prochaine fenêtre'}`
            );
            startCapture();
        });
    });

    /** Mort inattendue de ffmpeg : relance adaptée à la cause probable. */
    function handleDeath(code) {
        // Webcam de la scène : la source la plus fragile (débranchée, prise
        // par un autre logiciel), et optionnelle. Sa perte ne doit jamais
        // coûter l'enregistrement du jeu : on relance aussitôt sans elle, et
        // on la réintègre quand elle réapparaît.
        if (WITH_WEBCAM) {
            webcamSuspended = true;
            console.warn(
                `[arena-capture] ffmpeg died (code ${code}) avec la webcam — relance sans elle —\n${stderrTail.join('\n')}`
            );
            scheduleWebcamRetry();
            startCapture();
            return;
        }
        // Mort inattendue (fenêtre inaccessible, erreur d'encodage…) : on garde le
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
    }

    // Un run sain depuis > 2 min réarme le backoff.
    setTimeout(() => {
        if (ffmpegProcess !== PROC) return;
        restartDelayMs = RESTART_BASE_DELAY_MS;
        if (WITH_WEBCAM) webcamRetryDelayMs = WEBCAM_RETRY_BASE_MS;
    }, 2 * 60 * 1000);

    return getStatus();
}

/**
 * Arrête proprement la captation ('q' sur stdin → ffmpeg finalise le segment
 * en cours), et annule tout redémarrage programmé.
 */
function stopCapture() {
    stopRequested = true;
    captureWanted = false;
    arenaAudioService.stop();
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    restartDelayMs = RESTART_BASE_DELAY_MS;
    // Arrêt voulu (ou changement de source/scène) : la webcam retente sa chance
    // au prochain démarrage.
    webcamSuspended = false;
    if (webcamRetryTimer) {
        clearTimeout(webcamRetryTimer);
        webcamRetryTimer = null;
    }
    webcamRetryDelayMs = WEBCAM_RETRY_BASE_MS;
    gameWaitToken++;
    waitingGame = false;
    clearTimeout(gameWaitTimer);
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
 * Attend que le jeu soit ouvert (même détection que le son), puis démarre
 * ffmpeg sur sa fenêtre.
 */
function waitForGame() {
    if (waitingGame) return;
    waitingGame = true;
    const TOKEN = ++gameWaitToken;
    let logged = false;
    const CHECK = () => {
        arenaAudioService.findTarget().then((target) => {
            if (TOKEN !== gameWaitToken) return;
            if (stopRequested || ffmpegProcess) {
                waitingGame = false;
                return;
            }
            if (!target) {
                if (!logged) {
                    console.log('[arena-capture] en attente de la fenêtre du jeu');
                    logged = true;
                }
                gameWaitTimer = setTimeout(CHECK, GAME_POLL_MS);
                return;
            }
            waitingGame = false;
            sceneTargetExe = target.exe;
            console.log(`[arena-capture] jeu ouvert (${target.exe}) — démarrage`);
            startCapture(true);
        });
    };
    CHECK();
}

/** Relance ffmpeg sur la configuration courante, une fois l'actuel arrêté. */
function restartCapture() {
    const OLD = ffmpegProcess;
    stopCapture();
    if (OLD) {
        OLD.on('close', () => startCapture());
    } else {
        startCapture();
    }
}

/**
 * Réintègre la webcam écartée dès qu'elle réapparaît dans la liste des
 * périphériques. Si elle échoue encore, ffmpeg la réécarte et le délai double.
 */
function scheduleWebcamRetry() {
    if (webcamRetryTimer) return;
    webcamRetryTimer = setTimeout(() => {
        webcamRetryTimer = null;
        const WEBCAM = getScene().webcam;
        if (!webcamSuspended || !WEBCAM || stopRequested) return;
        // Entre deux relances : on repassera plus tard.
        if (!ffmpegProcess) {
            scheduleWebcamRetry();
            return;
        }
        const FOUND = listWebcams().some((d) =>
            process.platform === 'darwin'
                ? d.name === WEBCAM.name
                : d.id === WEBCAM.id
        );
        if (!FOUND) {
            scheduleWebcamRetry();
            return;
        }
        const DELAY = Math.min(webcamRetryDelayMs * 2, WEBCAM_RETRY_MAX_MS);
        console.log(
            `[arena-capture] webcam "${WEBCAM.name}" de retour — relance avec elle`
        );
        restartCapture();
        // Posé APRÈS restartCapture, dont l'arrêt remet le délai à sa base.
        webcamRetryDelayMs = DELAY;
    }, webcamRetryDelayMs);
}

/** Images de la scène : à côté de spool/, déplacées avec EBP-Tools-Arena. */
function getSceneFolder() {
    return path.join(path.dirname(getSpoolFolder()), 'scene');
}

/**
 * Scène enregistrée. Coordonnées en pixels du cadre 1920×1080 ; les images ne
 * gardent que leur nom de fichier, pour survivre au déplacement du dossier.
 * @returns {{webcam: object|null, images: object[]}}
 */
function getScene() {
    const SCENE = StorageManager.getPermanentSettingsValue(SETTINGS_KEY_SCENE);
    return {
        webcam: (SCENE && SCENE.webcam) || null,
        images: (SCENE && SCENE.images) || []
    };
}

/**
 * Position et taille bornées au cadre. Dimensions paires : les formats 4:2:0
 * n'acceptent pas les tailles impaires.
 */
function sanitizeGeometry(item) {
    const CLAMP = (n, min, max) => Math.min(Math.max(n, min), max);
    const EVEN = (n) => Math.round((Number(n) || 0) / 2) * 2;
    const WIDTH = CLAMP(EVEN(item.width), 2, 1920);
    const HEIGHT = CLAMP(EVEN(item.height), 2, 1080);
    return {
        x: CLAMP(Math.round(Number(item.x) || 0), 0, 1920 - WIDTH),
        y: CLAMP(Math.round(Number(item.y) || 0), 0, 1080 - HEIGHT),
        width: WIDTH,
        height: HEIGHT
    };
}

/**
 * Enregistre la scène et l'applique : une captation en cours est relancée
 * dessus (coupure d'une seconde environ, absorbée par la tolérance du
 * pipeline entre segments).
 */
function setScene(scene) {
    const CLEAN = {
        webcam:
            scene && scene.webcam && scene.webcam.id
                ? {
                      id: String(scene.webcam.id),
                      name: String(scene.webcam.name || ''),
                      ...sanitizeGeometry(scene.webcam)
                  }
                : null,
        images: (scene && Array.isArray(scene.images) ? scene.images : [])
            .filter((i) => i && typeof i.file === 'string')
            // basename : le renderer ne choisit pas où l'on lit sur le disque.
            .map((i) => ({ file: path.basename(i.file), ...sanitizeGeometry(i) }))
    };
    StorageManager.setPermanentSettingsValue(SETTINGS_KEY_SCENE, CLEAN);
    console.log(
        `[arena-capture] scène : ${CLEAN.webcam ? `webcam "${CLEAN.webcam.name}"` : 'sans webcam'}, ${CLEAN.images.length} image(s)`
    );
    // Les images ajoutées puis retirées ne servent plus à rien.
    const DIR = getSceneFolder();
    if (fs.existsSync(DIR)) {
        const KEEP = new Set(CLEAN.images.map((i) => i.file));
        for (const NAME of fs.readdirSync(DIR)) {
            if (!KEEP.has(NAME)) fs.unlinkSync(path.join(DIR, NAME));
        }
    }
    if (ffmpegProcess || waitingGame) {
        restartCapture();
    } else {
        webcamSuspended = false;
    }
    return getStatus();
}

/** Vignette d'une image pour l'éditeur (PNG : la transparence est conservée). */
function imageThumbnail(image) {
    return image
        .resize({ width: Math.min(PREVIEW_WIDTH, image.getSize().width) })
        .toDataURL();
}

/**
 * Copie une image choisie par l'utilisateur dans le dossier de la scène. Elle
 * n'entre dans la scène qu'à l'application (setScene).
 * @returns {{file: string, width: number, height: number, url: string}|null}
 */
function addSceneImage(sourcePath) {
    const IMAGE = nativeImage.createFromPath(sourcePath);
    if (IMAGE.isEmpty()) return null;
    const DIR = getSceneFolder();
    fs.mkdirSync(DIR, { recursive: true });
    const FILE = `${Date.now()}-${path.basename(sourcePath).replace(/[^\w.-]/g, '_')}`;
    fs.copyFileSync(sourcePath, path.join(DIR, FILE));
    const { width, height } = IMAGE.getSize();
    return { file: FILE, width, height, url: imageThumbnail(IMAGE) };
}

/** Scène + vignette de chaque image, pour l'éditeur. */
function getSceneView() {
    const SCENE = getScene();
    const IMAGE_URLS = {};
    for (const IMAGE of SCENE.images) {
        const DATA = nativeImage.createFromPath(
            path.join(getSceneFolder(), IMAGE.file)
        );
        if (!DATA.isEmpty()) IMAGE_URLS[IMAGE.file] = imageThumbnail(DATA);
    }
    return { ...SCENE, imageUrls: IMAGE_URLS };
}

/**
 * Suspend la captation tant que l'abonnement Arena de la salle est inactif, et
 * la reprend à son retour si elle était voulue. Idempotent : appelé à chaque
 * battement.
 * @param {boolean} value
 */
function setSuspended(value) {
    if (value === suspended) return;
    if (value) {
        console.warn('[arena-capture] abonnement Arena inactif — captation suspendue');
    } else {
        console.log('[arena-capture] abonnement Arena actif — fin de la suspension');
    }
    setBlocked(() => {
        suspended = value;
    });
}

/**
 * Mesure l'espace libre du volume du spool et pose ou lève le garde-fou disque.
 * Appelé périodiquement et à chaque démarrage de la captation.
 */
function checkDisk() {
    const SPOOL = getSpoolFolder();
    try {
        // Le spool peut ne pas encore exister : on mesure alors son parent.
        const TARGET = fs.existsSync(SPOOL) ? SPOOL : path.dirname(SPOOL);
        const STATS = fs.statfsSync(TARGET);
        diskFreeBytes = STATS.bavail * STATS.bsize;
    } catch (e) {
        console.error('[arena-capture] disk check failed:', e.message);
        return;
    }
    const GB = (diskFreeBytes / 1024 ** 3).toFixed(1);
    if (!diskLow && diskFreeBytes < DISK_LOW_BYTES) {
        console.warn(`[arena-capture] disque presque plein (${GB} Go libres) — captation suspendue`);
        setBlocked(() => {
            diskLow = true;
        });
    } else if (diskLow && diskFreeBytes > DISK_RESUME_BYTES) {
        console.log(`[arena-capture] espace disque revenu (${GB} Go libres) — fin de la suspension`);
        setBlocked(() => {
            diskLow = false;
        });
    }
}

/**
 * Applique un changement de l'une des causes de blocage (abonnement, disque) :
 * arrête la captation quand la première apparaît, la reprend quand la dernière
 * disparaît, si elle était voulue.
 * @param {() => void} update Modifie `suspended` ou `diskLow`.
 */
function setBlocked(update) {
    const WAS_BLOCKED = suspended || diskLow;
    update();
    const IS_BLOCKED = suspended || diskLow;
    if (WAS_BLOCKED === IS_BLOCKED) return;
    if (IS_BLOCKED) {
        const WANTED = captureWanted;
        stopCapture();
        captureWanted = WANTED;
        return;
    }
    if (!captureWanted) return;
    // L'ffmpeg arrêté par la suspension peut encore finaliser son segment :
    // startCapture n'en lancerait pas un second, on reprend à sa fermeture.
    if (ffmpegProcess) {
        ffmpegProcess.once('close', () => startCapture());
    } else {
        startCapture();
    }
}

/**
 * À appeler au boot : reprend la captation quand le mode salle est actif
 * (l'appelant vérifie ce point).
 */
function autoStart() {
    startCapture();
}

function getStatus() {
    return {
        // ffmpeg écrit réellement : le pipeline s'en sert pour savoir si le
        // dernier segment est encore ouvert.
        running: !!ffmpegProcess,
        // Armée, en attente de la fenêtre du jeu : rien n'est écrit, mais la
        // captation n'est pas arrêtée pour autant.
        waitingGame,
        // Le renderer n'envoie du PCM que si le tube attend réellement du son.
        audio: arenaAudioService.getStatus(),
        videoStarted,
        // Webcam de la scène écartée après une panne : enregistrement sans elle.
        webcamSuspended,
        // Abonnement Arena inactif : rien n'est filmé, cf. setSuspended.
        suspended,
        // Disque presque plein : rien n'est filmé, cf. checkDisk.
        diskLow,
        diskFreeBytes,
        encoder: resolvedEncoder ? resolvedEncoder.name : null,
        startedAt,
        lastError,
        spoolFolder: getSpoolFolder(),
        segmentSeconds: SEGMENT_SECONDS,
        previewPath: getPreviewPath()
    };
}

// Le garde-fou ne concerne que le mode salle : hors captation voulue, l'espace
// disque d'un utilisateur ordinaire ne nous regarde pas.
setInterval(() => {
    if (captureWanted) checkDisk();
}, DISK_CHECK_MS).unref();

module.exports = {
    listWebcams,
    startCapture,
    stopCapture,
    autoStart,
    setSuspended,
    getStatus,
    setSpoolFolder,
    getSceneView,
    setScene,
    addSceneImage
};
