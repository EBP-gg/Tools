// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const os = require('os');
const path = require('node:path');
const chokidar = require('chokidar');
const { Notification, app } = require('electron');
const StorageManager = require('../core/storage-manager');
const { markBusy } = require('../core/activity-tracker');
const { t } = require('./translate.service');
const { unlinkSync, safeMapName } = require('./global-service');
const { cutAndEncodeGame, cutCopyGame } = require('./video-service');
const {
    identifyGames,
    persistAnalysis,
    requestUploadUrl,
    confirmUpload,
    uploadFileToPresignedUrl,
    pushWatcherStatus,
    pushGameAnalysisStatus,
    reportAnalysisIssue,
    resolveAuthToken,
    NotAuthenticatedError,
    ApiError
} = require('./tools-api-client');

//#endregion

const SETTINGS_KEY_FOLDER = 'replayWatchFolder';
const SUPPORTED_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm']);
const AUTH_RETRY_INTERVAL_MS = 30 * 1000;
const MTPG_RE = /__mtpg-(\d+)/;
const MGAST_RE = /__mgast-(\d+)/;
// Scores forcés (panneau "association" côté front) : présents uniquement quand
// l'utilisateur force l'association d'une game pré-découpée. Les deux toujours
// ensemble (validés côté front + server.js avant encodage).
const FOS_RE = /__fos-(\d+)/;
const FBS_RE = /__fbs-(\d+)/;
// Équipe ciblée pour le matching serveur (/identify) : guid public de l'équipe
// choisie côté front. Présent à chaque analyse lancée depuis le site.
const TID_RE =
    /__tid-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
// Nombre de games analysées en profondeur en parallèle (un process Python par
// game). Ajuster selon les retours terrain : plus on monte, plus on sature CPU
// / mémoire (chaque process recharge tesseract, templates, ouvre sa propre
// VideoCapture). 1 = comportement séquentiel d'avant. Surchargeable par fichier
// via le suffixe `__mgast-N` (voir parseMeta).
const DEEP_ANALYSIS_CONCURRENCY = 3;

// Bandes de la barre de progression UNIFIÉE par game (0-100), assemblée à
// partir des phases du pipeline. La détection (phase 1) est par fichier et
// antérieure à l'identification des games : elle n'est pas représentée dans la
// barre (la game démarre à 0 en `queued`). La phase 2 remplit [0, ANALYZE_END],
// le réencodage [ANALYZE_END, ENCODE_END], l'upload [ENCODE_END, 100].
const PROGRESS_DETECT_END = 0; // game identifiée → départ à 0 (queued)
const PROGRESS_ANALYZE_END = 75; // phase 2 (analyse) terminée
const PROGRESS_ENCODE_END = 90; // réencodage terminé (upload en cours)

/**
 * Lit le sidecar `<video>.json` écrit par `ingestFilesForAnalysis` : games
 * ciblées par l'action groupée « Analyser » côté site (UUIDs trop longs pour le
 * nom de fichier) et jeton de session du compte qui a lancé l'analyse. Absent
 * ou illisible (dépôt manuel) → valeurs vides.
 * @returns {{gameGuids: string[], token: string|undefined}}
 */
function readSidecar(filePath) {
    try {
        const RAW = JSON.parse(fs.readFileSync(filePath + '.json', 'utf8'));
        return {
            gameGuids: Array.isArray(RAW.gameGuids)
                ? RAW.gameGuids.filter((g) => typeof g === 'string')
                : [],
            token: typeof RAW.token === 'string' ? RAW.token : undefined
        };
    } catch (_) {
        return { gameGuids: [], token: undefined };
    }
}

/**
 * Supprime le sidecar d'une vidéo. À appeler dès que la vidéo quitte le watch
 * folder (upload terminé ou déplacement vers failed/) — mais pas sur un retry
 * auth, où la vidéo reste en place et sera retraitée avec son scope.
 */
function removeSidecar(videoPath) {
    safeUnlink(videoPath + '.json');
}

/**
 * Extrait les valeurs `maxTimePerGame`, `maxGamesAtSameTime`, scores forcés et
 * `teamId` encodées dans le nom du fichier par `analyzeVideoFile` (suffixes
 * `__mtpg-N`, `__mgast-M`, `__fos-/__fbs-` et `__tid-<guid>` avant l'extension),
 * plus les `gameGuids` du sidecar JSON éventuel, et renvoie un basename
 * "propre" pour l'aval (cut filenames, sourceFilename API).
 * Si un suffixe est absent (fichier déposé manuellement), la valeur
 * correspondante est undefined → fallback sur la valeur par défaut côté Python /
 * DEEP_ANALYSIS_CONCURRENCY (et `teamId` undefined → /identify renverra 400).
 */
function parseMeta(filePath) {
    const EXT = path.extname(filePath);
    const BASE = path.basename(filePath, EXT);
    const MTPG = BASE.match(MTPG_RE);
    const MGAST = BASE.match(MGAST_RE);
    const FOS = BASE.match(FOS_RE);
    const FBS = BASE.match(FBS_RE);
    const TID = BASE.match(TID_RE);
    const SIDECAR = readSidecar(filePath);
    if (!MTPG && !MGAST && !FOS && !FBS && !TID) {
        return {
            cleanBasename: BASE,
            maxTimePerGame: undefined,
            maxGamesAtSameTime: undefined,
            forcedOrangeScore: undefined,
            forcedBlueScore: undefined,
            teamId: undefined,
            gameGuids: SIDECAR.gameGuids,
            token: SIDECAR.token
        };
    }
    const FIRST_IDX = Math.min(
        MTPG ? MTPG.index : Infinity,
        MGAST ? MGAST.index : Infinity,
        FOS ? FOS.index : Infinity,
        FBS ? FBS.index : Infinity,
        TID ? TID.index : Infinity
    );
    return {
        cleanBasename: BASE.slice(0, FIRST_IDX),
        maxTimePerGame: MTPG ? parseInt(MTPG[1], 10) : undefined,
        maxGamesAtSameTime: MGAST ? parseInt(MGAST[1], 10) : undefined,
        forcedOrangeScore: FOS ? parseInt(FOS[1], 10) : undefined,
        forcedBlueScore: FBS ? parseInt(FBS[1], 10) : undefined,
        // Gardé en string : c'est l'ID transmis tel quel au serveur (/identify).
        teamId: TID ? TID[1] : undefined,
        gameGuids: SIDECAR.gameGuids,
        token: SIDECAR.token
    };
}

let watcher = null;
let workerRunning = false;
let stopRequested = false;
const QUEUE = [];
let CURRENT_PATH = null;

function getDefaultFolder() {
    return path.join(os.homedir(), 'EBP-Tools-Replays');
}

function getWatchFolder() {
    return StorageManager.getPermanentSettingsValue(
        SETTINGS_KEY_FOLDER,
        getDefaultFolder()
    );
}

function ensureSubfolders(root) {
    for (const sub of ['failed', '.tmp']) {
        const P = path.join(root, sub);
        if (!fs.existsSync(P)) fs.mkdirSync(P, { recursive: true });
    }
}

function getFallbackFolder() {
    return path.join(app.getPath('userData'), 'EBP-Tools-Replays');
}

function tryEnsure(root) {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    ensureSubfolders(root);
}

/**
 * Ensures the watch root and its subfolders exist on disk. Idempotent and
 * cheap — call from `start()` or before opening any of these folders from
 * the tray menu so users always land on a real folder.
 *
 * On Windows, the default location under the user profile can be blocked by
 * Controlled Folder Access / antivirus (EPERM/EACCES). In that case we fall
 * back to `%APPDATA%\<app>\Replays`, persist it as the new setting, and
 * notify the user so the relocation is visible.
 */
function ensureFolders() {
    const ROOT = getWatchFolder();
    try {
        tryEnsure(ROOT);
    } catch (e) {
        if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
        const FALLBACK = getFallbackFolder();
        if (FALLBACK === ROOT) throw e;
        console.warn(
            `[watch-folder] cannot use ${ROOT} (${e.code}), falling back to ${FALLBACK}`
        );
        tryEnsure(FALLBACK);
        StorageManager.setPermanentSettingsValue(SETTINGS_KEY_FOLDER, FALLBACK);
    }
}

function isSupportedVideo(filePath) {
    const EXT = path.extname(filePath).toLowerCase();
    return SUPPORTED_EXT.has(EXT);
}

function isInsideWatchRoot(filePath, root) {
    const REL = path.relative(root, filePath);
    if (REL.startsWith('..') || path.isAbsolute(REL)) return false;
    const FIRST_SEG = REL.split(path.sep)[0];
    return !['failed', '.tmp'].includes(FIRST_SEG);
}

//#region In-memory queue
//
// Pas de persistance : au boot, chokidar (`ignoreInitial: false`) re-scanne
// le dossier surveillé et ré-émet `add` pour chaque fichier présent, ce qui
// reconstruit la queue à l'identique. La purge de `.tmp/` au boot garantit
// qu'on repart d'un état propre.

function enqueue(filePath) {
    if (QUEUE.includes(filePath)) return;
    QUEUE.push(filePath);
}

function dequeue(filePath) {
    const I = QUEUE.indexOf(filePath);
    if (I !== -1) QUEUE.splice(I, 1);
}

function peekNext() {
    return QUEUE[0] ?? null;
}

//#endregion

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function mapWithLimit(items, limit, fn) {
    const RESULTS = new Array(items.length);
    let next = 0;
    const WORKERS = Array.from(
        { length: Math.min(Math.max(1, limit), items.length) },
        async () => {
            while (true) {
                const IDX = next++;
                if (IDX >= items.length) return;
                RESULTS[IDX] = await fn(items[IDX], IDX);
            }
        }
    );
    await Promise.all(WORKERS);
    return RESULTS;
}

async function moveTo(srcPath, destDir, retries = 5, delayMs = 2000) {
    if (!fs.existsSync(srcPath)) return;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const DEST = path.join(destDir, path.basename(srcPath));
    for (let i = 0; i <= retries; i++) {
        try {
            fs.renameSync(srcPath, DEST);
            return DEST;
        } catch (e) {
            // Windows: file still held by Python subprocess or AV/Search Indexer
            if (e.code === 'EBUSY' && i < retries) {
                console.log(`[watch-folder] EBUSY on rename, retry ${i + 1}/${retries} in ${delayMs}ms`);
                await sleep(delayMs);
            } else {
                throw e;
            }
        }
    }
}

function safeUnlink(filePath) {
    try {
        if (fs.existsSync(filePath)) unlinkSync(filePath);
    } catch (e) {
        console.error('[watch-folder] unlink error', filePath, e.message);
    }
}

function notifyQueueEmpty(processedCount) {
    if (!Notification.isSupported()) return;
    try {
        new Notification({
            title: 'EBP - Tools',
            body: `${processedCount === 1 ? 'Replay' : `${processedCount} replays`} processed — queue is empty.`
        }).show();
    } catch (e) {
        console.error('[watch-folder] notification error', e.message);
    }
}

/**
 * Push l'état courant au backend (qui broadcast aux sockets du user). Appelé
 * à chaque transition du worker — fire-and-forget : `pushWatcherStatus`
 * swallow toute erreur réseau / auth pour ne pas perturber la pipeline.
 */
function notifyStatusChange() {
    pushWatcherStatus(getStatus());
}

/**
 * Push fire-and-forget de l'état de progression d'UNE game au backend (qui
 * persiste + broadcast aux clients du user). `pushGameAnalysisStatus` swallow
 * toute erreur réseau/auth, donc on n'await pas : la pipeline n'est jamais
 * ralentie ni interrompue par le reporting.
 * @param {string|number} gameID  vrai ID DB (games matchées uniquement).
 * @param {'queued'|'analyzing'|'processing'|'done'|'failed'} phase
 * @param {number} percent  0-100 sur l'échelle unifiée.
 * @param {string|undefined} teamId  équipe de DESTINATION choisie dans Tools
 *   (suffixe `__tid-<guid>`) — permet à un chef qui coache une autre équipe de cibler
 *   la bonne. Transmise au backend ; `undefined` (dépôt manuel) → null en base.
 * @param {string|undefined} token  jeton du compte qui a lancé cette analyse.
 */
function reportGameStatus(gameID, phase, percent, teamId, token) {
    console.log(
        `[watch-folder] game ${gameID} → ${phase} ${percent}%`
    );
    pushGameAnalysisStatus(gameID, { phase, percent, teamId }, token);
}

/**
 * Builds the segments payload for /games/identify from analyzer-detected games.
 * Pas de champ `analysis` ici : la phase 2 n'a pas encore tourné quand on appelle
 * identify (l'idée justement c'est de récupérer les rosters AVANT phase 2 pour
 * pouvoir les injecter dans l'OCR du killfeed).
 */
function toIdentifySegments(games, forcedScores) {
    // Scores forcés (game pré-découpée + association forcée) : ils remplacent les
    // scores OCR. Le caller ne les passe que lorsqu'une seule game est détectée
    // (sinon `null`), donc l'override ne s'applique de fait qu'à cette game.
    const FORCED =
        forcedScores &&
        forcedScores.orange !== undefined &&
        forcedScores.blue !== undefined;
    return games.map((g, i) => ({
        tempId: `temp-${i}`,
        startSeconds: g.start,
        endSeconds: g.end,
        mode: g.mode,
        mapName: g.map,
        mapImage: g.mapImage,
        blueScore: FORCED
            ? forcedScores.blue
            : g.blueTeam
              ? g.blueTeam.score
              : null,
        orangeScore: FORCED
            ? forcedScores.orange
            : g.orangeTeam
              ? g.orangeTeam.score
              : null,
        blueTeam: g.blueTeam,
        orangeTeam: g.orangeTeam
    }));
}

/**
 * Processes a single video: detect → identify → analyze chunks (with rosters) →
 * persist analyses → cut → upload. Throws NotAuthenticatedError if auth lost
 * mid-pipeline (caller pauses).
 */
async function processVideo(videoPath, deps) {
    const ROOT = getWatchFolder();
    const TMP_DIR = path.join(ROOT, '.tmp');
    const FAILED_DIR = path.join(ROOT, 'failed');
    ensureSubfolders(ROOT);

    const META = parseMeta(videoPath);
    const SETTINGS =
        META.maxTimePerGame !== undefined
            ? { maxTimePerGame: META.maxTimePerGame }
            : {};

    console.log('[watch-folder] processing', videoPath);

    // Phase 1: detect games. `showFloatingProgress=true` → floating window de
    // progression (identification des games), puisque le flux watch-folder est
    // headless et n'a pas d'UI front pour suivre l'avancement.
    const DETECT = await deps.runAnalyzer(videoPath, null, SETTINGS, true);
    if (DETECT.type === 'error') {
        throw new Error(`Analyzer failed: ${DETECT.message}`);
    }
    // Les games d'un autre jeu qu'After-H (Color Chaos, Zombies) sont détectées mais
    // s'arrêtent ici : toute la suite du pipeline (identify → phase 2 → upload)
    // les rattache à une game EVA, or EBP ne stocke que l'After-H — il n'y a
    // rien à quoi les associer. Elles seraient donc matchées de travers, ou pas
    // du tout. On les compte et on les laisse.
    const DETECTED = DETECT.games || [];
    const GAMES = DETECTED.filter(
        (g) => (g.gameType ?? 'after-h') === 'after-h'
    );
    if (DETECTED.length !== GAMES.length) {
        console.log(
            `[watch-folder] ${DETECTED.length - GAMES.length} game(s) hors After-H ignorée(s) (non exposées par game-histories)`
        );
    }
    if (GAMES.length === 0) {
        const DEST = await moveTo(videoPath, FAILED_DIR);
        removeSidecar(videoPath);
        console.log('[watch-folder] no games detected →', DEST);
        // Remonte le problème au site (ligne sans gameID) — sauf dépôt manuel
        // sans équipe ciblée (pas de teamId → on ne sait pas où l'afficher).
        if (META.teamId) {
            reportAnalysisIssue(
                {
                    sourceFilename: META.cleanBasename + path.extname(videoPath),
                    teamId: META.teamId,
                    reason: 'no_games'
                },
                META.token
            );
        }
        return;
    }

    // Scores forcés : valables uniquement sur une game pré-découpée isolée. Si
    // la détection en trouve plusieurs, on ne peut pas savoir à laquelle les
    // attribuer → on ignore le forçage et on retombe sur l'association OCR.
    const FORCED_SCORES =
        META.forcedOrangeScore !== undefined &&
        META.forcedBlueScore !== undefined;
    if (FORCED_SCORES && GAMES.length !== 1) {
        console.log(
            `[watch-folder] forced scores ignorés : ${GAMES.length} games détectées (1 attendue)`
        );
    }

    // Identify : on demande au back les rosters trustés AVANT la phase 2 pour
    // pouvoir les passer en argument à l'analyse approfondie (utile au fuzzy
    // match du killfeed OCR).
    const IDENTIFY_PAYLOAD = {
        sourceFilename: META.cleanBasename + path.extname(videoPath),
        teamId: META.teamId,
        // Scope éventuel (action groupée « Analyser ») : le serveur ne matche
        // que ces games.
        ...(META.gameGuids.length > 0 && { gameGuids: META.gameGuids }),
        segments: toIdentifySegments(
            GAMES,
            FORCED_SCORES && GAMES.length === 1
                ? { orange: META.forcedOrangeScore, blue: META.forcedBlueScore }
                : null
        )
    };
    console.log(
        '[watch-folder] identify payload:',
        JSON.stringify(IDENTIFY_PAYLOAD, null, 2)
    );
    const IDENTIFY_RES = await identifyGames(IDENTIFY_PAYLOAD, META.token);
    console.log(
        '[watch-folder] identify response:',
        JSON.stringify(IDENTIFY_RES, null, 2)
    );
    const MATCHES = IDENTIFY_RES.matches || [];
    if (MATCHES.length === 0) {
        const DEST = await moveTo(videoPath, FAILED_DIR);
        removeSidecar(videoPath);
        console.log(
            '[watch-folder] no identify match → skip analyse/encodage,',
            DEST
        );
        return;
    }
    const MATCH_BY_TEMP = new Map(
        MATCHES.map((m) => [
            m.tempId,
            {
                gameID: m.gameID,
                hasVideo: !!m.hasVideo,
                orangePlayers: m.orangePlayers || [],
                bluePlayers: m.bluePlayers || []
            }
        ])
    );

    // Toutes les games matchées passent en "identifiée / en attente" : le site
    // affiche un loader sur leur ligne jusqu'au démarrage de leur phase 2.
    // Set des vrais IDs DB pour filtrer les ticks de progression (les games
    // non matchées n'ont pas de ligne côté site → on les ignore).
    const MATCHED_GAME_IDS = new Set(MATCHES.map((m) => String(m.gameID)));
    for (const ID of MATCHED_GAME_IDS) {
        reportGameStatus(ID, 'queued', PROGRESS_DETECT_END, META.teamId, META.token);
    }

    // Phase 2: deep analysis sur les seules games identifiées par /identify.
    // Lancer l'OCR + player_tracking sur les unmatched serait du calcul perdu
    // (pas de ligne côté site, pas de persist) — elles restent gérées en
    // phase 4 (découpe stream-copy → failed/). On injecte les rosters de
    // l'identify dans chaque chunk — Python s'en sert comme liste de pseudos
    // trustés pour le fuzzy match du killfeed OCR.
    const CHUNKS = GAMES.map((g, i) => ({ g, M: MATCH_BY_TEMP.get(`temp-${i}`) }))
        .filter(({ M }) => M && M.gameID != null)
        .map(({ g, M }) => ({
            startSeconds: g.start,
            endSeconds: g.end,
            // gameID transmis à l'analyseur = vrai ID DB renvoyé par /identify
            // (Python le réémet tel quel dans les logs de progression par game
            // et dans les résultats).
            gameID: String(M.gameID),
            mode: g.mode,
            // Nom de map (ex. "Outlaw", "Helios Station") — Python s'en sert
            // pour appliquer la règle Domination/Hardpoint sur points_timeline
            // (Outlaw = Hardpoint, le reste = Domination).
            map: g.map || '',
            orangePlayers: M.orangePlayers,
            bluePlayers: M.bluePlayers
        }));
    // Un process Python par game, plafonné à CONCURRENCY en vol. Chaque process
    // est totalement indépendant (sa propre VideoCapture, son propre OCR) —
    // vraie parallélisation, pas de GIL. Si l'un crashe (`error`), on remonte
    // la première erreur rencontrée — semantics identiques au cas séquentiel
    // d'avant.
    const CONCURRENCY = META.maxGamesAtSameTime ?? DEEP_ANALYSIS_CONCURRENCY;
    const DEEP_T0 = Date.now();
    const CHUNK_RESULTS = await mapWithLimit(CHUNKS, CONCURRENCY, (chunk) =>
        deps.runChunkAnalyzer(videoPath, null, [chunk], SETTINGS, (p) => {
            // p.gameID = vrai ID DB (matché) ou tempId (unmatched, pas de ligne
            // côté site → ignoré). p.percent = 0-100 de la phase 2 de la game,
            // remappé sur la bande [DETECT_END, ANALYZE_END] de la barre unifiée.
            if (!MATCHED_GAME_IDS.has(String(p.gameID))) return;
            const UNIFIED =
                PROGRESS_DETECT_END +
                Math.round(
                    ((PROGRESS_ANALYZE_END - PROGRESS_DETECT_END) * p.percent) /
                        100
                );
            reportGameStatus(p.gameID, 'analyzing', UNIFIED, META.teamId, META.token);
        })
    );
    const DEEP_ELAPSED_S = ((Date.now() - DEEP_T0) / 1000).toFixed(1);
    console.log(
        `[watch-folder] deep analysis for ${path.basename(videoPath)}: ${DEEP_ELAPSED_S}s (${CHUNKS.length} games, concurrency=${CONCURRENCY})`
    );
    const FIRST_ERROR = CHUNK_RESULTS.find((r) => r && r.error);
    if (FIRST_ERROR) {
        throw new Error(`Chunk analyzer failed: ${FIRST_ERROR.error}`);
    }
    // Indexé par la clé renvoyée par l'analyseur = le champ `gameID` injecté
    // dans le chunk (vrai ID DB si matché, sinon tempId).
    const ANALYSIS_BY_KEY = {};
    for (const RES of CHUNK_RESULTS) {
        for (const r of RES.results || []) {
            ANALYSIS_BY_KEY[r.gameID] = { payload: r.payload };
        }
    }
    console.log(ANALYSIS_BY_KEY);

    // Persist : on remonte au back les analyses approfondies pour les games
    // matchées par identify (les unmatched n'ont pas de gameID, on skip).
    const ANALYSES_TO_PERSIST = [];
    for (const M of MATCHES) {
        const A = ANALYSIS_BY_KEY[String(M.gameID)];
        if (!A || A.payload === undefined) continue;
        ANALYSES_TO_PERSIST.push({ gameID: M.gameID, payload: A.payload });
    }
    // Games dont l'analyse a réellement été persistée : seules celles-là passent
    // en phase encodage/upload. Une game refusée par le serveur ou sans payload
    // ne doit PAS voir sa vidéo uploadée.
    let PERSISTED_IDS = new Set();
    if (ANALYSES_TO_PERSIST.length > 0) {
        const PERSIST_RES = await persistAnalysis(
            {
                analyses: ANALYSES_TO_PERSIST,
                teamId: META.teamId
            },
            META.token
        );
        PERSISTED_IDS = new Set(
            (PERSIST_RES.persisted || []).map((id) => String(id))
        );
        if (PERSIST_RES.failed && PERSIST_RES.failed.length > 0) {
            console.log(
                '[watch-folder] persist-analysis partial failures:',
                PERSIST_RES.failed
            );
        }
    }
    // Matchées mais non persistées (refus serveur ou payload manquant) : statut
    // "failed" tout de suite, sinon le loader du site resterait bloqué — ces
    // games ne passeront pas par la phase upload qui émet normalement le statut.
    for (const ID of MATCHED_GAME_IDS) {
        if (!PERSISTED_IDS.has(ID)) {
            reportGameStatus(ID, 'failed', PROGRESS_ANALYZE_END, META.teamId, META.token);
        }
    }

    // Phases 4 & 5 pipelinées : on réencode les games séquentiellement (libx264
    // software est CPU-bound — paralléliser les encodages thrasherait le CPU),
    // mais on lance l'upload de chaque game dès que son réencodage est terminé,
    // en arrière-plan. Les uploads (réseau) chevauchent ainsi les réencodages
    // suivants tout en restant sérialisés entre eux (1 à la fois) pour ne pas
    // saturer la bande passante.
    const VIDEO_BASENAME = META.cleanBasename;

    // Upload d'un cut : URL présignée → PUT → confirm. Gère lui-même ses erreurs
    // (déplacement vers failed/, 409 déjà uploadé). Seul NotAuthenticatedError
    // est propagé pour interrompre le pipeline.
    const uploadCut = async (CUT) => {
        const M = MATCH_BY_TEMP.get(CUT.tempId);
        const GAME_ID = M ? M.gameID : null;
        if (!GAME_ID) {
            const DEST = await moveTo(CUT.file, FAILED_DIR);
            console.log('[watch-folder] unmatched →', DEST);
            return;
        }
        // Analyse non persistée (refus serveur ou payload manquant) : pas
        // d'upload — la vidéo pourrait s'attacher à la mauvaise game (fuite).
        // Statut "failed" déjà émis après le persist.
        if (!PERSISTED_IDS.has(String(GAME_ID))) {
            const DEST = await moveTo(CUT.file, FAILED_DIR);
            console.log(
                `[watch-folder] analysis not persisted for game ${GAME_ID} → skip upload,`,
                DEST
            );
            return;
        }
        try {
            // Upload en cours : le site garde un loader (étape "processing").
            reportGameStatus(GAME_ID, 'processing', PROGRESS_ENCODE_END, META.teamId, META.token);
            const UPLOAD = await requestUploadUrl(GAME_ID, META.teamId, META.token);
            // Progression de l'upload (0-100% du fichier) remappée sur la bande
            // [ENCODE_END, 100] de la barre unifiée, dédup par palier.
            let lastUnified = -1;
            await uploadFileToPresignedUrl(UPLOAD.url, CUT.file, {
                onProgress: (pct) => {
                    const UNIFIED =
                        PROGRESS_ENCODE_END +
                        Math.round(((100 - PROGRESS_ENCODE_END) * pct) / 100);
                    if (UNIFIED === lastUnified) return;
                    lastUnified = UNIFIED;
                    reportGameStatus(GAME_ID, 'processing', UNIFIED, META.teamId, META.token);
                }
            });
            await confirmUpload(
                GAME_ID,
                {
                    guid: UPLOAD.guid,
                    teamId: META.teamId
                },
                META.token
            );
            safeUnlink(CUT.file);
            // Tout est bon : le loader disparaît, le site charge l'analyse.
            reportGameStatus(GAME_ID, 'done', 100, META.teamId, META.token);
            console.log(
                `[watch-folder] uploaded game ${GAME_ID} (tempId=${CUT.tempId})`
            );
        } catch (e) {
            if (e instanceof NotAuthenticatedError) throw e;
            // Filet de sécurité serveur : la game a déjà une vidéo (race ou flag
            // hasVideo manqué). On ne re-upload pas, on jette le cut local.
            if (e instanceof ApiError && e.status === 409) {
                reportGameStatus(GAME_ID, 'done', 100, META.teamId, META.token);
                console.log(
                    `[watch-folder] skipped upload for game ${GAME_ID} — already uploaded (409)`
                );
                safeUnlink(CUT.file);
                return;
            }
            console.error(
                `[watch-folder] upload failed for game ${GAME_ID}:`,
                e.message
            );
            reportGameStatus(GAME_ID, 'failed', PROGRESS_ENCODE_END, META.teamId, META.token);
            const DEST = await moveTo(CUT.file, FAILED_DIR);
            console.log('[watch-folder] failed →', DEST);
        }
    };

    // Chaîne d'uploads sérialisée : chaque cut s'upload après le précédent, mais
    // en arrière-plan des réencodages suivants. On capture la première erreur
    // d'auth pour la repropager après avoir attendu la fin de la chaîne.
    let uploadChain = Promise.resolve();
    let pendingAuthError = null;
    const enqueueUpload = (CUT) => {
        uploadChain = uploadChain.then(() => {
            if (pendingAuthError) return;
            return uploadCut(CUT).catch((e) => {
                if (e instanceof NotAuthenticatedError) {
                    if (!pendingAuthError) pendingAuthError = e;
                } else {
                    throw e;
                }
            });
        });
    };

    for (let i = 0; i < GAMES.length; i++) {
        // Auth perdue pendant un upload en arrière-plan : on arrête de réencoder,
        // les games restantes seront retraitées au prochain passage.
        if (pendingAuthError) break;
        const G = GAMES[i];
        const TEMP_ID = `temp-${i}`;
        const M = MATCH_BY_TEMP.get(TEMP_ID);
        if (M && M.hasVideo) {
            // Vidéo déjà présente côté serveur : pas d'encodage/upload → la game
            // est terminée dès la persistance de son analyse. "done" seulement si
            // l'analyse a bien été persistée — sinon on laisse le statut "failed"
            // émis après le persist.
            if (PERSISTED_IDS.has(String(M.gameID))) {
                reportGameStatus(M.gameID, 'done', 100, META.teamId, META.token);
            }
            console.log(
                `[watch-folder] skipped cut/upload for game ${M.gameID} (tempId=${TEMP_ID}) — video already uploaded`
            );
            continue;
        }
        const SAFE_MAP = safeMapName(G.map);
        const BLUE_SCORE = G.blueTeam ? G.blueTeam.score : '?';
        const ORANGE_SCORE = G.orangeTeam ? G.orangeTeam.score : '?';
        const OUT = path.join(
            TMP_DIR,
            `${VIDEO_BASENAME}___${SAFE_MAP}-${ORANGE_SCORE}-${BLUE_SCORE}__${i}-${Date.now()}.mp4`
        );
        // Seules les games persistées vont jusqu'à l'upload : les autres
        // (unmatched OU analyse refusée) partent en stream-copy vers failed/.
        const WILL_UPLOAD =
            M && M.gameID != null && PERSISTED_IDS.has(String(M.gameID));
        // Réencodage : le site affiche un loader (étape "processing").
        if (WILL_UPLOAD) {
            reportGameStatus(M.gameID, 'processing', PROGRESS_ANALYZE_END, META.teamId, META.token);
        }
        try {
            // Games identifiées → réencodage libx264 (keyframe/s pour le lecteur
            // web). Games non identifiées ou non persistées → stream-copy rapide
            // (elles partent dans failed/, pas besoin de payer un réencodage
            // software).
            if (WILL_UPLOAD) {
                // Progression du réencodage (0-100% du segment) remappée sur la
                // bande [ANALYZE_END, ENCODE_END] de la barre unifiée. On ne
                // ré-émet que sur changement de palier pour éviter de spammer le
                // site (ffmpeg crache une ligne time= très fréquemment).
                let lastUnified = -1;
                await cutAndEncodeGame(videoPath, OUT, G.start, G.end, (pct) => {
                    const UNIFIED =
                        PROGRESS_ANALYZE_END +
                        Math.round(
                            ((PROGRESS_ENCODE_END - PROGRESS_ANALYZE_END) * pct) /
                                100
                        );
                    if (UNIFIED === lastUnified) return;
                    lastUnified = UNIFIED;
                    reportGameStatus(M.gameID, 'processing', UNIFIED, META.teamId, META.token);
                });
            } else {
                await cutCopyGame(videoPath, OUT, G.start, G.end);
            }
            // Réencodage terminé → on enchaîne l'upload sans l'attendre : le
            // réencodage de la game suivante démarre immédiatement.
            enqueueUpload({ tempId: TEMP_ID, file: OUT, game: G, index: i });
        } catch (e) {
            console.error(
                `[watch-folder] cut failed for game ${i} of ${videoPath}:`,
                e.message
            );
            if (M && M.gameID != null) {
                reportGameStatus(M.gameID, 'failed', PROGRESS_ANALYZE_END, META.teamId, META.token);
            }
        }
    }

    // On attend la fin de tous les uploads en arrière-plan avant de supprimer la
    // source. Si l'auth a été perdue, on repropage pour déclencher le retry.
    await uploadChain;
    if (pendingAuthError) throw pendingAuthError;

    // Phase 6: source video deleted only once every cut has been uploaded or
    // moved to failed/. If we crash mid-pipeline, the source is still there
    // and chokidar re-enqueues it at next boot for a full retry.
    safeUnlink(videoPath);
    removeSidecar(videoPath);
}

async function workerLoop(deps) {
    if (workerRunning) return;
    workerRunning = true;
    let processedInSession = 0;
    try {
        while (!stopRequested) {
            const NEXT = peekNext();
            if (!NEXT) {
                if (processedInSession > 0) {
                    notifyQueueEmpty(processedInSession);
                }
                notifyStatusChange();
                workerRunning = false;
                return;
            }
            if (!fs.existsSync(NEXT)) {
                dequeue(NEXT);
                notifyStatusChange();
                continue;
            }
            // Sans jeton (ni sur la vidéo, ni en repli), aucun appel API ne
            // passera : on attend qu'une analyse lancée depuis le site en
            // apporte un, plutôt que de faire échouer la vidéo.
            if (!resolveAuthToken(readSidecar(NEXT).token)) {
                console.log(`[watch-folder] ${t('watchFolder.notAuthenticated')}`);
                await sleep(AUTH_RETRY_INTERVAL_MS);
                continue;
            }
            CURRENT_PATH = NEXT;
            // Les uploads d'un replay se poursuivent après le dernier ffmpeg :
            // le comptage des processus enfants les manquerait, et une mise à
            // jour pourrait s'appliquer pendant l'envoi d'une vidéo.
            const RELEASE_BUSY = markBusy();
            notifyStatusChange();
            try {
                await processVideo(NEXT, deps);
                dequeue(NEXT);
                processedInSession++;
            } catch (e) {
                if (e instanceof NotAuthenticatedError) {
                    console.log(
                        '[watch-folder] auth lost mid-pipeline, will retry —',
                        e.detail || e.message
                    );
                    // L'item reste en tête de queue, sera retry après pause.
                    await sleep(AUTH_RETRY_INTERVAL_MS);
                } else {
                    console.error(
                        `[watch-folder] processing failed for ${NEXT}:`,
                        e.message
                    );
                    const ROOT = getWatchFolder();
                    const FAILED_DIR = path.join(ROOT, 'failed');
                    if (fs.existsSync(NEXT)) {
                        try {
                            await moveTo(NEXT, FAILED_DIR);
                        } catch (mvErr) {
                            console.error(
                                '[watch-folder] move-to-failed error:',
                                mvErr.message
                            );
                        }
                    }
                    removeSidecar(NEXT);
                    dequeue(NEXT);
                    processedInSession++;
                }
            } finally {
                RELEASE_BUSY();
                CURRENT_PATH = null;
                notifyStatusChange();
            }
        }
    } finally {
        workerRunning = false;
    }
}

/**
 * Starts the watch-folder service.
 * @param {object} deps { runAnalyzer, runChunkAnalyzer } — analyzer runners.
 */
function start(deps) {
    if (watcher) return;
    if (!deps || !deps.runAnalyzer || !deps.runChunkAnalyzer) {
        throw new Error(
            'watch-folder-service.start: missing runAnalyzer/runChunkAnalyzer deps'
        );
    }

    ensureFolders();
    const ROOT = getWatchFolder();

    // Purge any orphan .tmp/ files left by a previous crashed run — the pipeline
    // restarts from scratch on retry, so leftovers are guaranteed to be unused.
    const TMP_DIR = path.join(ROOT, '.tmp');
    if (fs.existsSync(TMP_DIR)) {
        fs.rmSync(TMP_DIR, { recursive: true, force: true });
        fs.mkdirSync(TMP_DIR, { recursive: true });
    }

    stopRequested = false;
    watcher = chokidar.watch(ROOT, {
        ignored: (p) => {
            if (p === ROOT) return false;
            return !isInsideWatchRoot(p, ROOT);
        },
        persistent: true,
        ignoreInitial: false,
        depth: 0,
        awaitWriteFinish: {
            stabilityThreshold: 4000,
            pollInterval: 500
        }
    });

    const onAdd = (p) => {
        if (!isSupportedVideo(p)) return;
        if (!isInsideWatchRoot(p, ROOT)) return;
        console.log('[watch-folder] enqueue', p);
        enqueue(p);
        notifyStatusChange();
        workerLoop(deps).catch((e) =>
            console.error('[watch-folder] worker crashed', e)
        );
    };

    watcher.on('add', onAdd);
    watcher.on('error', (e) =>
        console.error('[watch-folder] watcher error', e)
    );

    // Kick off the worker in case there are leftover items from a previous run.
    workerLoop(deps).catch((e) =>
        console.error('[watch-folder] worker crashed', e)
    );

    console.log('[watch-folder] watching', ROOT);
}

function stop() {
    stopRequested = true;
    if (watcher) {
        watcher.close();
        watcher = null;
    }
}

/**
 * @returns {{
 *   queued: { name: string, path: string }[],
 *   processing: { name: string, path: string }[],
 *   failed: { name: string, path: string }[]
 * }}
 */
function getStatus() {
    const toItem = (p) => ({ name: path.basename(p), path: p });
    const QUEUED = QUEUE.filter((p) => p !== CURRENT_PATH).map(toItem);
    const PROCESSING = CURRENT_PATH ? [toItem(CURRENT_PATH)] : [];

    const FAILED = [];
    try {
        const FAILED_DIR = path.join(getWatchFolder(), 'failed');
        if (fs.existsSync(FAILED_DIR)) {
            for (const f of fs.readdirSync(FAILED_DIR)) {
                if (isSupportedVideo(f)) {
                    FAILED.push({ name: f, path: path.join(FAILED_DIR, f) });
                }
            }
        }
    } catch (_) {}

    return { queued: QUEUED, processing: PROCESSING, failed: FAILED };
}

module.exports = {
    start,
    stop,
    getWatchFolder,
    getDefaultFolder,
    getStatus,
    ensureFolders
};
