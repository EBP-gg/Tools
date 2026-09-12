// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const os = require('os');
const path = require('node:path');
const {
    fetchPreAnalysisBatch,
    submitPreAnalysis,
    downloadPresignedUrlToFile,
    ApiError
} = require('./tools-api-client');
const { probeVideoDuration } = require('./video-service');
const {
    createFloatingWindow,
    deleteFloatingWindow,
    getMainWindow
} = require('../core/window-manager');

//#endregion

// MODE SYSTÈME — PRÉ-ANALYSE DES VIDÉOS DE SALLE.
//
// Une salle capte ses games et les envoie à EBP, mais personne ne les analyse :
// le joueur qui rentre chez lui trouve une vidéo brute, pas des statistiques. Ce
// worker comble ce trou en analysant ces vidéos sur une machine dédiée, en amont,
// pour que l'analyse l'attende déjà à la maison.
//
// Il ne tourne QUE si `TOOLS_SYSTEM_KEY` est présente dans l'environnement : c'est
// à la fois le credential et l'interrupteur. Aucune UI, aucun réglage — c'est un
// mode d'exploitation, pas une fonctionnalité utilisateur.
//
// Le pipeline est celui du watch folder, amputé de ses trois étapes fragiles :
//   - pas de `/identify` : la game est désignée par le serveur (le nom de l'objet
//     S3 porte son guid), donc aucun risque d'attacher l'analyse à la mauvaise ;
//   - pas de découpe ni d'upload : la vidéo EST une game, et elle est déjà en S3 ;
//   - pas de phase 1 : la vidéo a déjà été découpée SUR la game par le PC de salle
//     (arena-pipeline-service, marge de 1 s de part et d'autre), donc ses bornes
//     sont le fichier lui-même. La relancer ici ne ré-estimerait que du connu, et
//     mal : la loading frame est hors de la découpe, le scan à rebours tombe donc
//     dans son repli « vidéo pré-coupée ». Tout ce qu'elle apportait d'autre est
//     déjà servi par le serveur (map) ou constant (index MODES, cf. CHUNK).
// Reste la phase 2 (OCR + tracking), avec les rosters trustés fournis par le serveur.

const POLL_INTERVAL_MS = 5 * 60 * 1000;
// Games traitées de front — la machine est dédiée à ça. Un process Python par game
// (sa propre VideoCapture, son propre Tesseract) : vraie parallélisation, pas de GIL.
// Même valeur que DEEP_ANALYSIS_CONCURRENCY côté watch folder. À ne pas monter sans
// mesurer : le serveur réserve chaque game pour une heure, et des analyses simultanées
// qui dépasseraient ce délai se feraient re-servir, donc analyser en double.
const CONCURRENCY = 3;
// Au-delà, la vidéo n'est pas une game de salle plausible — on ne lance pas une
// analyse de plusieurs heures sur un fichier aberrant.
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
// Même borne que le MAX_GAME_S du pipeline de salle (12 min configurables + marge
// de pause technique) : un fichier plus long n'est pas une game découpée, c'est un
// fichier qu'on ne sait pas lire. Sans phase 1 pour le dire, c'est ce garde-fou qui
// tient — la borne en octets, elle, laisse passer près d'une heure de vidéo.
const MAX_GAME_SECONDS = 15 * 60;

// Bandes de la barre de progression PAR GAME (0-100), assemblée à partir des
// phases de `processGame`. Calées sur les durées observées : le téléchargement
// d'une game de salle prend environ un tiers du temps total, l'analyse profonde
// domine le reste.
const PROGRESS_DOWNLOAD_END = 35;

let running = false;
let timer = null;
let deps = null;

// Avancement du LOT en cours : une entrée 0-100 par game, `null` entre deux
// lots. Le worker traite CONCURRENCY games de front pour une seule fenêtre
// flottante — c'est donc lui qui agrège, et non chaque analyzer qui piloterait
// la fenêtre à tour de rôle (ils se la voleraient, et la première game terminée
// la fermerait pour les autres).
let batchProgress = null;
// Dernier pourcentage POUSSÉ à la fenêtre. Le téléchargement rappelle à chaque
// paquet reçu : sans ce garde-fou, on inonderait l'IPC pour redessiner le même
// entier.
let lastPushedPercent = -1;

/** Message de la fenêtre flottante, dérivé de l'état du lot. */
function progressNotification() {
    const VALUES = Array.from(batchProgress.values());
    const MEAN = Math.round(
        VALUES.reduce((sum, v) => sum + v, 0) / VALUES.length
    );
    return {
        percent: MEAN,
        leftRounded: true,
        infinite: false,
        icon: undefined,
        text: '.view.notification.pre_analysis',
        textParams: {
            done: VALUES.filter((v) => v >= 100).length,
            total: VALUES.length
        },
        state: 'info'
    };
}

/** Ouvre la fenêtre flottante sur un lot qui démarre (toutes les games à 0). */
function startBatchProgress(games) {
    batchProgress = new Map(games.map((g) => [String(g.gameId), 0]));
    lastPushedPercent = 0;
    createFloatingWindow(
        500,
        150,
        JSON.stringify(progressNotification())
    ).catch((e) =>
        console.warn('[system-worker] fenêtre de progression indisponible', e)
    );
}

/**
 * Avancement d'une game. Les mises à jour transitent par la fenêtre PRINCIPALE,
 * qui les relaie à la flottante (BroadcastChannel) : sans elle, pas d'affichage.
 * @param {string|number} gameId
 * @param {number} percent 0-100, borné.
 */
function setGameProgress(gameId, percent) {
    if (!batchProgress) return;
    const KEY = String(gameId);
    if (!batchProgress.has(KEY)) return;
    batchProgress.set(KEY, Math.max(0, Math.min(100, Math.round(percent))));

    const DATA = progressNotification();
    if (DATA.percent === lastPushedPercent) return;
    lastPushedPercent = DATA.percent;

    const WINDOW = getMainWindow();
    if (WINDOW && !WINDOW.isDestroyed()) {
        WINDOW.webContents.send('set-notification-data', DATA);
    }
}

/** Ferme la fenêtre à la fin d'un lot. Idempotent : appelable sans lot en vol. */
function endBatchProgress() {
    if (!batchProgress) return;
    batchProgress = null;
    deleteFloatingWindow(false);
}

/** Dossier de travail des vidéos rapatriées, vidé au fil de l'eau. */
function workDir() {
    const DIR = path.join(os.tmpdir(), 'ebp-pre-analysis');
    fs.mkdirSync(DIR, { recursive: true });
    return DIR;
}

/**
 * Vide le dossier de travail au démarrage. Un run interrompu (Ctrl+C, crash) ne passe
 * pas par le nettoyage de fin et laisse derrière lui un `.part` de plusieurs centaines
 * de Mo, qu'aucun tour suivant ne réclamera.
 */
function purgeWorkDir() {
    const DIR = workDir();
    for (const NAME of fs.readdirSync(DIR)) {
        removeQuietly(path.join(DIR, NAME));
    }
}

function removeQuietly(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch (_) {
        /* déjà parti */
    }
}

/**
 * Analyse une game servie par le serveur et remonte son payload.
 * @returns {Promise<boolean>} true si l'analyse a été acceptée par le serveur.
 */
async function processGame(game, systemKey) {
    const VIDEO_PATH = path.join(workDir(), `${game.guid}_${game.terrainId}.mp4`);
    try {
        console.log(`[system-worker] ${game.gameId} — téléchargement (${game.map || 'map inconnue'})`);
        await downloadPresignedUrlToFile(
            game.videoUrl,
            VIDEO_PATH,
            3,
            (ratio) => setGameProgress(game.gameId, ratio * PROGRESS_DOWNLOAD_END)
        );
        const SIZE = fs.statSync(VIDEO_PATH).size;
        if (SIZE === 0 || SIZE > MAX_VIDEO_BYTES) {
            console.warn(`[system-worker] ${game.gameId} : taille inattendue (${SIZE} o), ignorée`);
            return false;
        }

        // Bornes de la game = le fichier entier (cf. en-tête : il a été découpé sur
        // la game par le PC de salle). Seule la durée reste à lire, et elle sert
        // autant de garde-fou que de borne de fin.
        const DURATION = await probeVideoDuration(VIDEO_PATH);
        if (!(DURATION > 0) || DURATION > MAX_GAME_SECONDS) {
            console.warn(`[system-worker] ${game.gameId} : durée inattendue (${Math.round(DURATION)} s), ignorée`);
            return false;
        }
        console.log(
            `[system-worker] ${game.gameId} — analyse en cours (${Math.round(DURATION)} s de vidéo)`
        );

        // Phase 2 — OCR + tracking. Le serveur fournit ce que le chemin client obtient
        // de /identify : rosters trustés (fuzzy match des pseudos du killfeed) et
        // scores officiels (bornes hautes de l'OCR in-game).
        const CHUNK = {
            startSeconds: 0,
            endSeconds: Math.floor(DURATION),
            gameID: String(game.gameId),
            // Index dans MODES (géométrie du HUD After-H), qui n'a qu'une entrée —
            // et le serveur ne sert que des games After-H. Constant, donc.
            mode: 0,
            // La map vient de la base EVA, pas d'un OCR : c'est elle qui fait
            // autorité. Elle décide côté Python de la règle de reconstruction des
            // scores (Outlaw = Hardpoint, le reste = Domination).
            map: game.map || '',
            orangeScore: game.orangeScore,
            blueScore: game.blueScore,
            orangePlayers: game.orangePlayers || [],
            bluePlayers: game.bluePlayers || []
        };
        // Pleine priorité : machine dédiée à la pré-analyse, rien à ménager ici.
        const RESULTS = await deps.runChunkAnalyzer(
            VIDEO_PATH,
            null,
            [CHUNK],
            {},
            (p) =>
                setGameProgress(
                    game.gameId,
                    PROGRESS_DOWNLOAD_END +
                        ((100 - PROGRESS_DOWNLOAD_END) * p.percent) / 100
                )
        );
        if (RESULTS && RESULTS.error) {
            console.warn(`[system-worker] ${game.gameId} : phase 2 en échec — ${RESULTS.error}`);
            return false;
        }
        const ENTRY = (RESULTS.results || []).find((r) => String(r.gameID) === String(game.gameId));
        if (!ENTRY || ENTRY.payload === undefined) {
            console.warn(`[system-worker] ${game.gameId} : aucun payload produit`);
            return false;
        }

        await submitPreAnalysis({ gameId: String(game.gameId), payload: ENTRY.payload }, systemKey);
        console.log(
            `[system-worker] ${game.gameId} analysée (${game.map || 'map inconnue'}${game.hasPro ? ', abonné Statistics Pro' : ''})`
        );
        return true;
    } catch (e) {
        // 404 (vidéo disparue) et 422 (clé refusée, ou analyse sans kill) sont
        // définitifs : le serveur ne changera pas d'avis, on log et on passe.
        if (e instanceof ApiError && (e.status === 404 || e.status === 422)) {
            console.warn(`[system-worker] ${game.gameId} refusée par le serveur : ${e.body}`);
            return false;
        }
        console.error(`[system-worker] ${game.gameId} : échec`, e);
        return false;
    } finally {
        // Quelle qu'en soit l'issue, la game ne progressera plus : on la marque
        // terminée, sinon le lot n'atteindrait jamais 100 % après un échec.
        setGameProgress(game.gameId, 100);
        removeQuietly(VIDEO_PATH);
        removeQuietly(VIDEO_PATH + '.part');
    }
}

/**
 * Un tour de boucle : demande un lot de games, les traite de front, et enchaîne tant
 * que le serveur en donne. File vide → on repasse dans POLL_INTERVAL_MS.
 *
 * Le lot suivant n'est demandé qu'une fois le précédent entièrement terminé : le
 * serveur ne réserve donc jamais plus de CONCURRENCY games à la fois, et une game
 * lente ne fait pas gonfler le nombre de réservations en vol.
 */
async function tick(systemKey) {
    if (running) return;
    running = true;
    try {
        let batch = await fetchPreAnalysisBatch(CONCURRENCY, systemKey);
        while (batch && Array.isArray(batch.games) && batch.games.length > 0) {
            startBatchProgress(batch.games);
            // processGame absorbe ses propres erreurs (retourne false) : aucun rejet
            // à craindre ici, une game ratée n'emporte pas les autres du lot.
            await Promise.all(batch.games.map((g) => processGame(g, systemKey)));
            endBatchProgress();
            batch = await fetchPreAnalysisBatch(CONCURRENCY, systemKey);
        }
    } catch (e) {
        if (e instanceof ApiError && e.status === 422) {
            console.error('[system-worker] clé système refusée par le serveur — worker arrêté');
            stop();
            return;
        }
        console.error('[system-worker] tour en échec', e);
    } finally {
        // Un échec en plein lot (clé refusée, réseau coupé) laisserait sinon la
        // fenêtre affichée sur un pourcentage figé.
        endBatchProgress();
        running = false;
    }
}

/**
 * Démarre le worker si la clé système est configurée. No-op sinon : c'est le cas
 * normal sur toutes les installations de Tools sauf la machine dédiée.
 * @param {object} d { runChunkAnalyzer } — même runner de phase 2 que le watch folder.
 */
function start(d) {
    const KEY = (process.env.TOOLS_SYSTEM_KEY || '').trim();
    if (!KEY) return;
    if (!d || !d.runChunkAnalyzer) {
        throw new Error('system-worker-service.start: missing runChunkAnalyzer dep');
    }
    deps = d;
    purgeWorkDir();
    console.log('[system-worker] mode système actif — pré-analyse des vidéos de salle');
    tick(KEY);
    timer = setInterval(() => tick(KEY), POLL_INTERVAL_MS);
}

function stop() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    endBatchProgress();
}

module.exports = { start, stop };
