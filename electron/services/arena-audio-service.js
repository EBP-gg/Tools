// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('node:path');
const { spawn } = require('child_process');
const { AUDIO_LOOPBACK_PATH } = require('../config/constants');

//#endregion

// Mode salle — piste AUDIO de la captation. Le son est prélevé SUR LE PROCESSUS
// du jeu par le helper natif `audio-loopback` (API Application Loopback de
// Windows, build 20348+), qui vit dans le main process et nous envoie du PCM
// brut sur sa sortie standard. On ne le transmet PAS tel quel à ffmpeg.
//
// Ce prélèvement se fait en amont de tout périphérique de sortie. Mesuré sur un
// PC de salle le 2026-09-07, le niveau ne bouge NI avec le volume master, NI au
// mute, NI avec le mélangeur par application, NI quand on change la sortie par
// défaut de Windows. Ce dernier point est ce qui a condamné le loopback du
// renderer, qui le remplissait ici auparavant : il ne captait que le
// périphérique par défaut, donc le son disparaissait dès que le jeu sortait sur
// un autre écran HDMI. Il captait de surcroît le mix système entier, ce qui
// faisait entrer le monitoring d'OBS dans les vidéos, et s'arrêtait dès que
// l'utilisateur quittait la page du mode salle.
//
// Le flux est CADENCÉ SUR L'HORLOGE MURALE : à chaque tick on écrit exactement
// ce que le temps écoulé exige, en puisant dans la file et en complétant par du
// silence si le renderer est en retard. Deux propriétés en découlent, et elles
// sont toutes les deux indispensables :
//
//   1. La piste audio ne dérive pas de la vidéo, qui est encodée en CFR. Sans
//      ça, l'écart entre l'horloge du périphérique audio et celle du système
//      désynchroniserait le son après quelques heures de captation continue.
//   2. Un hoquet du renderer (page fermée, onglet gelé, GC) ne peut jamais
//      faire caler ffmpeg. C'est vital : ffmpeg attendrait des échantillons et
//      la captation VIDÉO s'arrêterait avec lui.
//
// ffmpeg lit le flux comme un fichier, sur un tube nommé (Windows) ou une
// socket unix (dev macOS).

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BLOCK_ALIGN = CHANNELS * BYTES_PER_SAMPLE;
const BYTES_PER_SECOND = SAMPLE_RATE * BLOCK_ALIGN;
// Le tick borne le retard résiduel du son (cf. MAX_BACKLOG_BYTES). Inutile de
// descendre plus bas : sous Windows, la résolution du timer système peut être
// de ~15,6 ms, un tick de 20 ms s'espace donc parfois jusqu'à ~31 ms. Sans
// conséquence sur la cadence : `pump` écrit d'après le temps écoulé, pas
// d'après le nombre de ticks.
const TICK_MS = 20;
// Plafond de la file. Le helper produit légèrement plus vite ou moins vite
// que l'horloge système (deux horloges distinctes) : sans plafond, un excédent
// s'accumulerait indéfiniment et le son prendrait du retard sur l'image. On
// jette le plus ANCIEN, pour rester au plus près du direct.
//
// Ce plafond est AUSSI le retard du son quand le helper va plus vite : la file
// sature et y reste, chaque échantillon y patiente le plafond entier avant
// d'atteindre ffmpeg. À 1 s, les games de Rouen avaient le son 0,95 s derrière
// l'image (mesuré le 2026-10-14 contre l'enregistrement StreamLabs). On le
// garde donc au plus juste : deux ticks dans le pire espacement Windows. En
// deçà, un tick en retard fait jeter du son dont le suivant aura besoin, puis
// combler par du silence : des micro-coupures. Si les logs `pacing` montrent
// du silence en pleine game, c'est ce plafond qu'il faut remonter.
const MAX_BACKLOG_BYTES = (BYTES_PER_SECOND * 60) / 1000;
// Bilan du cadencement, pour vérifier en salle la profondeur de file réelle.
const STATS_PERIOD_MS = 60000;

const PIPE_PATH =
    process.platform === 'win32'
        ? '\\\\.\\pipe\\ebp-arena-audio'
        : path.join(os.tmpdir(), 'ebp-arena-audio.sock');

let server = null;
let client = null;
/** Paquets PCM en attente, plus l'offset de lecture du premier. */
let queue = [];
let queuedBytes = 0;
let queueHead = 0;
let writtenBytes = 0;
let pacedFrom = 0;
let timer = null;
let silenceBlock = Buffer.alloc(BYTES_PER_SECOND, 0);
let receivedBytes = 0;
/** Compteurs de la période de bilan en cours (cf. logStats). */
let statsFrom = 0;
let statsReceived = 0;
let statsDropped = 0;
let statsSilence = 0;
let statsMaxQueued = 0;
// Le son et l'image n'ont PAS la même origine : le son compte ses échantillons
// depuis le début du tube, l'image part de la première capture du jeu. Or
// ffmpeg ouvre le tube en premier, puis la webcam et la capture du jeu : armer
// le son à l'ouverture du tube le mettait en retard d'autant. Rouen, 15/10/2026 :
// première image 2,7 s après le tube avec la webcam BRIO (1,1 s sans), le son
// ~2 s derrière l'image dans les games.
//
// On ne peut pas non plus attendre l'image sans rien écrire : ffmpeg n'ouvre son
// muxer qu'une fois que CHACUN de ses flux a produit un paquet, donc il
// n'annonce sa première image qu'après avoir reçu du son — rien ne sortirait
// jamais. À la connexion, on écrit donc LEAD_MS de silence, juste de quoi
// ouvrir le muxer, puis le tube se tait jusqu'à la première image (cf.
// alignToVideo). Le son reprend alors là où en est déjà l'image : la ligne de
// progression arrive plusieurs centaines de millisecondes après la capture de
// la première image, d'après ce qu'elle annonce comme déjà encodé.
const LEAD_MS = 100;
const LEAD_BYTES = (BYTES_PER_SECOND * LEAD_MS) / 1000;
// Filet : si la première image ne s'annonce jamais (LEAD_MS insuffisant pour
// une autre version de ffmpeg…), le son part quand même et la vidéo avec lui,
// avec l'ancien décalage plutôt qu'une captation bloquée.
const ALIGN_FALLBACK_MS = 10000;
let connectedAt = 0;
let alignFallback = null;
let pacing = false;

//#region Source native

// Jeux dont on capte le son, DANS L'ORDRE. Un PC de salle n'en fait tourner
// qu'un à la fois : on prend donc simplement le premier de la liste qui est
// vivant. Ajouter un jeu — le Karting est attendu d'ici quelques mois — tient
// en une ligne ici.
//
// C'est le nom de l'EXÉCUTABLE qui fait foi, jamais le titre de fenêtre : le
// titre change en cours de partie (carte, score, écran de connexion), le nom
// d'exe ne bouge pas. Comparaison insensible à la casse.
const TARGET_EXECUTABLES = ['EBA.exe', 'After-H-EVA-PVP.exe', 'ECC.exe'];

const SUPERVISION_MS = 5000;
// Le helper publie un niveau CHAQUE SECONDE, sur l'horloge murale, même quand
// il ne reçoit aucun échantillon. C'est donc un vrai battement de cœur : passé
// ce délai sans nouvelle, il est bloqué et on le relève. On ne surveille
// délibérément PAS le pid du jeu — Windows réattribue les numéros, et le helper
// s'arrête déjà seul à la mort de sa cible (poignée de processus, cf.
// native/audio_loopback.cpp).
const HELPER_STALE_MS = 15000;
// En deçà, un helper qui s'arrête est tenu pour un échec et non pour une game
// terminée : on espace alors les tentatives, sinon un jeu impossible à capter
// ferait tourner une relance toutes les 5 s pendant des jours.
const HEALTHY_MS = 10000;
const RETRY_MAX_MS = 60000;
// Plancher du niveau exposé à l'IHM. Le helper écrit « -inf » quand il ne reçoit
// aucun échantillon, ce qu'un JSON ne sait pas transporter (-Infinity devient
// null, qu'on réserve à « aucune cible »). On ramène donc le silence à une
// valeur finie, très en dessous du seuil d'alerte de la page.
const LEVEL_FLOOR_DBFS = -100;

let child = null;
let targetPid = 0;
let targetExe = '';
let levelDbfs = null;
let supervisor = null;
/** Dernier battement reçu du helper, et instant où il a été lancé. */
let lastBeatAt = 0;
let attachedAt = 0;
/** Énumération en cours : elle est asynchrone, on n'en lance qu'une. */
let resolving = false;
/** Échecs consécutifs, et instant avant lequel on ne retente pas. */
let failures = 0;
let retryAfter = 0;
/** null tant que la disponibilité du helper n'a pas été évaluée. */
let sourceAvailable = null;

/**
 * Le helper peut-il tourner ici ? Il est propre à Windows : il n'existe pas
 * d'équivalent de l'Application Loopback sur macOS, où le mode salle ne tourne
 * de toute façon qu'en développement.
 * @returns {boolean}
 */
function sourceSupported() {
    if (sourceAvailable === null) {
        sourceAvailable =
            process.platform === 'win32' &&
            fs.existsSync(AUDIO_LOOPBACK_PATH);
        if (process.platform === 'win32' && !sourceAvailable) {
            console.error(
                `[arena-audio] helper introuvable: ${AUDIO_LOOPBACK_PATH}`
            );
        }
    }
    return sourceAvailable;
}

/**
 * Applications visibles telles que les énumère le helper, une par ligne au
 * format `pid<TAB>titre<TAB>exe`. Les titres peuvent contenir des accents mal
 * transcodés selon la page de code ; sans importance, on ne lit que le pid et
 * l'exe, qui sont en ASCII.
 *
 * Asynchrone à dessein : entre deux parties, cette énumération tourne toutes
 * les 5 s pendant des heures, et Tools ne doit jamais bloquer le processus
 * principal du PC de streaming.
 * @returns {Promise<{pid: number, exe: string}[]>}
 */
function listApps() {
    return new Promise((resolve) => {
        let settled = false;
        const DONE = (apps) => {
            if (settled) return;
            settled = true;
            clearTimeout(GUARD);
            resolve(apps);
        };
        const PROC = spawn(AUDIO_LOOPBACK_PATH, ['--list'], {
            stdio: ['ignore', 'pipe', 'ignore']
        });
        // Une énumération qui ne rendrait jamais la main figerait la
        // supervision pour de bon : on la borne.
        const GUARD = setTimeout(() => {
            PROC.kill();
            DONE([]);
        }, 5000);
        let out = '';
        PROC.stdout.on('data', (d) => (out += d.toString()));
        PROC.on('error', () => DONE([]));
        PROC.on('close', () =>
            DONE(
                out
                    .split(/\r?\n/)
                    .map((line) => line.split('\t'))
                    .filter((parts) => parts.length >= 3)
                    .map((parts) => ({
                        pid: Number(parts[0]),
                        exe: parts[2].trim()
                    }))
                    .filter((entry) => entry.pid > 0)
            )
        );
    });
}

/**
 * Premier jeu de `TARGET_EXECUTABLES` de la liste donnée.
 * @param {{pid: number, exe: string}[]} apps
 * @returns {{pid: number, exe: string}|null}
 */
function pickTarget(apps) {
    for (const WANTED of TARGET_EXECUTABLES) {
        const FOUND = apps.find(
            (app) => app.exe.toLowerCase() === WANTED.toLowerCase()
        );
        if (FOUND) return FOUND;
    }
    return null;
}

/**
 * Jeu ciblé actuellement ouvert, s'il y en a un. Sert aussi à la captation
 * vidéo de la scène, qui filme la fenêtre de ce même jeu.
 * @returns {Promise<{pid: number, exe: string}|null>}
 */
async function findTarget() {
    if (!sourceSupported()) return null;
    return pickTarget(await listApps());
}

/**
 * Lance le helper sur un processus et branche sa sortie sur le tube.
 * @param {{pid: number, exe: string}} target
 */
function attach(target) {
    const PROC = spawn(AUDIO_LOOPBACK_PATH, [String(target.pid)], {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child = PROC;
    targetPid = target.pid;
    targetExe = target.exe;
    attachedAt = Date.now();
    lastBeatAt = attachedAt;

    PROC.stdout.on('data', writeChunk);

    // Le helper écrit une ligne de niveau par seconde. C'est la mesure de CE
    // QUI EST ENREGISTRÉ, et c'est elle qui alimente le VU-mètre de la page —
    // l'ancien VU-mètre mesurait le mix système, donc il pouvait afficher du
    // son alors que la piste était muette.
    let pending = '';
    PROC.stderr.on('data', (d) => {
        pending += d.toString();
        const LINES = pending.split(/\r?\n/);
        pending = LINES.pop();
        for (const LINE of LINES) {
            const LEVEL = /\[level\]\s+(-?[\d.]+|-inf)/.exec(LINE);
            if (LEVEL) {
                lastBeatAt = Date.now();
                levelDbfs =
                    LEVEL[1] === '-inf'
                        ? LEVEL_FLOOR_DBFS
                        : Math.max(LEVEL_FLOOR_DBFS, Number(LEVEL[1]));
            } else if (LINE.trim()) {
                console.log(`[arena-audio] helper: ${LINE.trim()}`);
            }
        }
    });

    PROC.on('error', (e) => {
        console.error('[arena-audio] helper spawn failed:', e.message);
        if (child === PROC) detach();
    });
    PROC.on('exit', (code) => {
        if (child !== PROC) return;
        const LIVED = Date.now() - attachedAt;
        const EXE = targetExe;
        child = null;
        targetPid = 0;
        targetExe = '';
        levelDbfs = null;

        // Sortie normale : le jeu s'est fermé et le helper l'a suivi. C'est
        // l'événement le plus fréquent d'une journée en salle, il n'a rien
        // d'anormal et le tour suivant se raccrochera au jeu d'après.
        if (LIVED >= HEALTHY_MS) {
            failures = 0;
            console.log(`[arena-audio] capture of ${EXE} ended`);
            return;
        }
        failures += 1;
        retryAfter =
            Date.now() +
            Math.min(RETRY_MAX_MS, SUPERVISION_MS * 2 ** failures);
        // Tools tourne en continu : une cible impossible à capter ne doit pas
        // écrire des dizaines de milliers de lignes par jour dans les logs.
        if (failures <= 3 || failures % 20 === 0) {
            console.error(
                `[arena-audio] ${EXE} exited after ${LIVED} ms ` +
                    `(code ${code}, échec ${failures})`
            );
        }
    });

    console.log(
        `[arena-audio] capturing ${target.exe} (pid ${target.pid})`
    );
}

/** Détache le helper courant, sans toucher au tube. */
function detach() {
    if (child) {
        const PROC = child;
        child = null;
        PROC.kill();
    }
    targetPid = 0;
    targetExe = '';
    levelDbfs = null;
}

/**
 * Un tour de supervision : garder le helper accroché à un jeu vivant.
 *
 * Tools tourne en continu, les jeux se ferment et se relancent à longueur de
 * journée ; cette boucle est donc le seul état à maintenir, et elle ne doit
 * jamais rester coincée. Deux façons de perdre un helper, deux réponses :
 * il s'arrête de lui-même à la mort de sa cible (cas normal, traité par son
 * `exit`), ou il se bloque sans mourir — auquel cas son battement s'interrompt
 * et on le relève ici.
 *
 * Entre deux jeux, l'absence d'échantillons est sans danger : le tube comble
 * en silence (cf. `pump`) et ffmpeg n'est jamais bloqué.
 */
function superviseOnce() {
    if (child) {
        if (Date.now() - lastBeatAt < HELPER_STALE_MS) return;
        console.error(`[arena-audio] helper stalled on ${targetExe}`);
        detach();
    }
    if (resolving || Date.now() < retryAfter) return;
    resolving = true;
    listApps()
        .then((apps) => {
            // L'énumération est asynchrone : un helper a pu s'accrocher
            // entre-temps, on ne le remplace pas.
            if (child) return;
            const TARGET = pickTarget(apps);
            if (TARGET) attach(TARGET);
        })
        .finally(() => {
            resolving = false;
        });
}

function startSource() {
    // Sans source, le tube n'écrit que du silence : la captation vidéo
    // continue, ce qui est le comportement voulu en développement.
    if (!sourceSupported() || supervisor) return;
    superviseOnce();
    supervisor = setInterval(superviseOnce, SUPERVISION_MS);
}

function stopSource() {
    if (supervisor) {
        clearInterval(supervisor);
        supervisor = null;
    }
    // Un arrêt volontaire n'est pas un échec : la captation suivante ne doit
    // pas hériter du backoff accumulé avant celui-ci.
    failures = 0;
    retryAfter = 0;
    detach();
}

//#endregion

/**
 * Ouvre le tube. ffmpeg s'y connecte ensuite comme un lecteur de fichier ; le
 * serveur reste à l'écoute pour qu'un redémarrage de ffmpeg se reconnecte seul.
 */
function start() {
    if (server) return PIPE_PATH;
    if (process.platform !== 'win32' && fs.existsSync(PIPE_PATH)) {
        fs.unlinkSync(PIPE_PATH);
    }
    server = net.createServer((socket) => {
        // Un seul consommateur : si ffmpeg s'était mal terminé, on abandonne
        // l'ancienne socket au profit de la nouvelle.
        if (client) client.destroy();
        client = socket;
        // Chaque connexion est un NOUVEAU run de ffmpeg, avec sa propre
        // origine temporelle : on réancre ici, sinon `pacedFrom` reste celui du
        // run précédent et le premier tick déverse d'un coup tout le temps
        // écoulé depuis — soit plusieurs secondes de son collées au début.
        resetPacing();
        pacing = false;
        connectedAt = Date.now();
        socket.write(Buffer.alloc(LEAD_BYTES, 0));
        writtenBytes = LEAD_BYTES;
        clearTimeout(alignFallback);
        alignFallback = setTimeout(() => {
            if (client !== socket || pacing) return;
            console.warn(
                `[arena-audio] aucune image après ${ALIGN_FALLBACK_MS} ms — son démarré sans calage sur l'image`
            );
            alignToVideo();
        }, ALIGN_FALLBACK_MS);
        console.log('[arena-audio] ffmpeg connected — sound waits for the first frame');
        socket.on('error', () => {});
        socket.on('close', () => {
            if (client === socket) client = null;
        });
    });
    server.on('error', (e) => {
        console.error('[arena-audio] pipe error:', e.message);
    });
    server.listen(PIPE_PATH);
    timer = setInterval(pump, TICK_MS);
    startSource();
    console.log(`[arena-audio] listening on ${PIPE_PATH}`);
    return PIPE_PATH;
}

/**
 * Première image de la captation : le son reprend ici, au temps où en est déjà
 * la vidéo (le trou est comblé par du silence au tick suivant). Une seule fois
 * par connexion de ffmpeg.
 * @param {number} videoMs Durée de vidéo déjà encodée.
 */
function alignToVideo(videoMs = 0) {
    if (!client || pacing) return;
    clearTimeout(alignFallback);
    alignFallback = null;
    pacedFrom = Date.now() - Math.max(videoMs, LEAD_MS);
    writtenBytes = LEAD_BYTES;
    pacing = true;
    console.log(
        `[arena-audio] son calé sur la première image (${Math.round(videoMs)} ms de vidéo), ${Date.now() - connectedAt} ms après la connexion de ffmpeg`
    );
}

function resetPacing() {
    pacedFrom = Date.now();
    writtenBytes = 0;
    queue = [];
    queuedBytes = 0;
    queueHead = 0;
    resetStats();
}

function resetStats() {
    statsFrom = Date.now();
    statsReceived = 0;
    statsDropped = 0;
    statsSilence = 0;
    statsMaxQueued = 0;
}

/**
 * Une ligne par période : profondeur de file (= retard du son sur l'image),
 * son jeté parce que le helper va trop vite, silence comblé parce qu'il va
 * trop lentement ou qu'aucun jeu ne tourne.
 */
function logStats() {
    const MS = (bytes) => Math.round((bytes / BYTES_PER_SECOND) * 1000);
    console.log(
        `[arena-audio] pacing over ${Date.now() - statsFrom} ms: ` +
            `received ${MS(statsReceived)} ms, queue ${MS(queuedBytes)} ms ` +
            `(max ${MS(statsMaxQueued)} ms), dropped ${MS(statsDropped)} ms, ` +
            `silence ${MS(statsSilence)} ms`
    );
    resetStats();
}

function stop() {
    stopSource();
    clearTimeout(alignFallback);
    alignFallback = null;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    if (client) {
        client.destroy();
        client = null;
    }
    if (server) {
        server.close();
        server = null;
    }
    resetPacing();
    pacing = false;
    receivedBytes = 0;
    console.log('[arena-audio] stopped');
}

/**
 * PCM reçu du renderer (s16le, 48 kHz, stéréo entrelacé).
 * @param {Buffer|Uint8Array} chunk
 */
function writeChunk(chunk) {
    if (!server || !chunk || !chunk.length) return;
    receivedBytes += chunk.length;
    statsReceived += chunk.length;
    queue.push(Buffer.from(chunk));
    queuedBytes += chunk.length;
    statsMaxQueued = Math.max(statsMaxQueued, queuedBytes);
    while (queuedBytes > MAX_BACKLOG_BYTES && queue.length > 1) {
        const DROPPED = queue.shift();
        queuedBytes -= DROPPED.length - queueHead;
        statsDropped += DROPPED.length - queueHead;
        queueHead = 0;
    }
}

/** Écrit ce que le temps écoulé exige, en complétant par du silence. */
function pump() {
    if (!client || !pacing) return;
    if (Date.now() - statsFrom >= STATS_PERIOD_MS) logStats();
    const ELAPSED_MS = Date.now() - pacedFrom;
    const TARGET =
        Math.floor((ELAPSED_MS / 1000) * BYTES_PER_SECOND / BLOCK_ALIGN) *
        BLOCK_ALIGN;
    let need = TARGET - writtenBytes;
    if (need <= 0) return;

    while (need > 0 && queue.length) {
        const HEAD = queue[0];
        const AVAILABLE = HEAD.length - queueHead;
        const TAKE = Math.min(AVAILABLE, need);
        client.write(HEAD.subarray(queueHead, queueHead + TAKE));
        queueHead += TAKE;
        queuedBytes -= TAKE;
        writtenBytes += TAKE;
        need -= TAKE;
        if (queueHead >= HEAD.length) {
            queue.shift();
            queueHead = 0;
        }
    }
    if (need > 0) {
        if (silenceBlock.length < need) silenceBlock = Buffer.alloc(need, 0);
        client.write(silenceBlock.subarray(0, need));
        writtenBytes += need;
        statsSilence += need;
    }
}

function getPipePath() {
    return PIPE_PATH;
}

/**
 * Niveau du son ENREGISTRÉ, pour le VU-mètre de la page mode salle. Réponse
 * volontairement minuscule : elle est demandée chaque seconde, là où le statut
 * de captation complet transporte la vignette de l'écran capté.
 * @returns {{available: boolean, targetExecutable: string|null,
 *            levelDbfs: number|null}}
 */
function getLevel() {
    return {
        available: sourceSupported(),
        targetExecutable: targetExe || null,
        levelDbfs
    };
}

/**
 * Diagnostic, et source du VU-mètre de la page mode salle. `levelDbfs` est le
 * niveau du flux RÉELLEMENT enregistré ; il vaut null quand aucun jeu ne tourne,
 * ce que l'IHM doit distinguer d'un jeu silencieux (`LEVEL_FLOOR_DBFS`).
 */
function getStatus() {
    return {
        running: !!server,
        connected: !!client,
        receivedBytes,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        targetExecutable: targetExe || null,
        targetPid: targetPid || null,
        levelDbfs
    };
}

module.exports = {
    TARGET_EXECUTABLES,
    findTarget,
    start,
    stop,
    alignToVideo,
    getPipePath,
    getLevel,
    getStatus,
    SAMPLE_RATE,
    CHANNELS
};
