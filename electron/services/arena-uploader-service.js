// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const path = require('node:path');
const chokidar = require('chokidar');
const arenaModeService = require('./arena-mode-service');
const arenaPipelineService = require('./arena-pipeline-service');
const {
    requestArenaUploadUrl,
    requestOtherGameUploadUrl,
    confirmOtherGameUpload,
    resolveColorChaosGameId,
    confirmArenaUpload,
    uploadFileToPresignedUrl
} = require('./tools-api-client');

//#endregion

// Mode salle — UPLOADER. Consomme les games découpées par le pipeline
// (dossier `games/`) et déjà identifiées par arena-identify-service : le gameId
// EVA est dans le nom du fichier (7 champs), une game non identifiée en porte 6
// et reste invisible ici. Il n'y a donc AUCUNE gate à réévaluer.
//
// Un seul appel réseau par game : on demande une URL présignée pour ce gameId et
// on pousse le fichier. Le serveur écrit à l'emplacement DÉFINITIF des replays,
// `statistics/replays/{T_Games.guid}.mp4` — même nommage qu'une analyse locale.
// Rien à déposer ensuite : l'existence de l'objet EST la trace de l'upload, et
// le hook d'import s'en sert pour attacher la vidéo à l'équipe. Fichier +
// fichier local supprimé une fois l'upload confirmé.
//
// Les games d'un autre jeu qu'After-H (Color Chaos) suivent le même chemin, mais
// sans identification : elles n'ont pas de ligne en base côté EBP, il n'y a pas
// de gameId à leur trouver. Le pipeline les nomme `cc_…` et elles partent sur la
// route « autre jeu », dans leur propre zone S3 — le jeu voyage dans le payload,
// c'est lui qui décide de la zone.
//
// V1 : plus d'analyse phase 2 (killfeed) sur le PC de salle — les joueurs sont
// déjà connus côté serveur. Le killfeed pourra être rebranché plus tard.
//
// Résilience réseau : boucle de retry PERSISTANTE (URL fraîche à chaque
// tentative, backoff 30 s → 10 min, à l'infini). La clé S3 étant déterministe,
// un retry réécrit le même objet — aucun doublon possible. Sérialisé : une seule
// game à la fois (protection CPU).

// Nom d'une game IDENTIFIÉE (7 champs, gameId en 3e position) :
// {roomId}_{arenaId}_{gameId}_{SafeMap}_{start}_{end}_{scores}.mp4
const GAME_FILE_RE =
    /^(\d+)_(\d+)_(\d+)_([A-Za-z0-9-]+)_(\d+)_(\d+)_([^_]+)\.mp4$/;
// Game d'un autre jeu : `{préfixe}_{roomId}_{arenaId}_{startEpoch}_{endEpoch}.mp4`.
// Elle arrive ici directement, sans passer par l'identification — ces games
// n'existent pas côté EVA, il n'y a pas de gameId à leur trouver. Le préfixe est
// le seul endroit où le jeu survit à la découpe (le nom est le seul porteur
// d'état de la chaîne), d'où la table de correspondance.
//
// `zb` y reste alors que le pipeline n'en produit plus (le Zombies est identifié
// depuis le 06/09/2026) : les salles peuvent avoir des `zb_…` déjà découpés en
// attente d'upload, et les retirer d'ici les bloquerait sur le disque pour
// toujours. À supprimer quand ces reliquats seront partis.
const OTHER_GAME_FILE_RE = /^(cc|zb)_(\d+)_(\d+)_(\d+)_(\d+)\.mp4$/;
const OTHER_GAME_TYPE = {
    cc: 'color-chaos',
    zb: 'zombies'
};
const RETRY_BASE_DELAY_MS = 30 * 1000;
const RETRY_MAX_DELAY_MS = 10 * 60 * 1000;
// Re-scan périodique de games/ : rattrape les games identifiées par un simple
// renommage, que chokidar peut ne pas ré-émettre.
const RETRY_SCAN_MS = 2 * 60 * 1000;
// Au-delà, une game de failed/ ne servira plus : aucun import ne peut s'y
// rattacher passé ce délai, comme pour les games jamais identifiées.
const FAILED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let watcher = null;
let retryTimer = null;
let workerRunning = false;
let stopRequested = false;
const QUEUE = [];
let currentFile = null;
let uploadedCount = 0;
let lastError = null;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function getGamesDir() {
    return arenaPipelineService.getStatus().gamesFolder;
}

function getFailedDir() {
    return path.join(path.dirname(getGamesDir()), 'failed');
}

/** Déplace la game vers failed/ (fichier inexploitable). */
function moveToFailed(filePath) {
    const FAILED = getFailedDir();
    if (!fs.existsSync(FAILED)) fs.mkdirSync(FAILED, { recursive: true });
    try {
        fs.renameSync(filePath, path.join(FAILED, path.basename(filePath)));
    } catch (e) {
        console.error('[arena-uploader] move to failed failed:', filePath, e.message);
    }
}

/** Supprime les fichiers de failed/ plus vieux que FAILED_MAX_AGE_MS. */
function purgeFailed() {
    const FAILED = getFailedDir();
    let entries;
    try {
        entries = fs.readdirSync(FAILED);
    } catch (_) {
        return;
    }
    for (const NAME of entries) {
        const FILE = path.join(FAILED, NAME);
        try {
            const STAT = fs.statSync(FILE);
            if (!STAT.isFile() || Date.now() - STAT.mtimeMs < FAILED_MAX_AGE_MS) continue;
            fs.unlinkSync(FILE);
            console.log(`[arena-uploader] failed/ expired, deleted — ${NAME}`);
        } catch (e) {
            console.error('[arena-uploader] failed/ purge failed:', NAME, e.message);
        }
    }
}

/** Nombre de fichiers dans failed/ (0 si le dossier n'existe pas). */
function countFailed() {
    try {
        return fs.readdirSync(getFailedDir()).length;
    } catch (_) {
        return 0;
    }
}

/**
 * Une game prête à partir : After-H déjà identifiée (7 champs, gameId en 3e
 * position) ou game d'un autre jeu. Une game After-H pas encore identifiée porte
 * un nom à 6 champs et reste donc invisible pour l'uploader.
 */
function isUploadable(name) {
    return GAME_FILE_RE.test(name) || OTHER_GAME_FILE_RE.test(name);
}

/** La vidéo est en place côté S3 : on libère le disque de la salle. */
function cleanup(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch (e) {
        console.error('[arena-uploader] cleanup failed:', filePath, e.message);
    }
}

/**
 * Boucle de retry persistante. `attempt` doit faire l'aller-retour COMPLET
 * (URL fraîche + PUT) : c'est ce qui rend le retry sûr, l'URL présignée d'une
 * tentative ratée pouvant avoir expiré.
 */
async function withPersistentRetry(attempt) {
    let delay = RETRY_BASE_DELAY_MS;
    for (;;) {
        if (stopRequested) throw new Error('uploader stopped');
        try {
            return await attempt();
        } catch (e) {
            lastError = e.message;
            console.warn(
                `[arena-uploader] upload failed (${e.message}), retry in ${delay / 1000}s`
            );
            await sleep(delay);
            delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
        }
    }
}

/**
 * Upload S3 avec retry persistant. On envoie le `gameId` EVA : c'est le serveur
 * qui en déduit la clé (`statistics/replays/{T_Games.guid}.mp4`), Tools ne nomme
 * jamais l'objet. Clé déterministe → un retry réécrit le même objet.
 */
function uploadWithPersistentRetry(filePath, gameId, ids, token) {
    return withPersistentRetry(async () => {
        const UPLOAD = await requestArenaUploadUrl(
            { roomId: ids.roomId, arenaId: ids.arenaId, gameId },
            token
        );
        await uploadFileToPresignedUrl(UPLOAD.url, filePath, {
            contentType: 'video/mp4'
        });
        // Confirme l'upload : le serveur vérifie l'objet en S3 puis indexe la
        // vidéo (T_Terrain_Videos). Best-effort — l'objet est déjà en S3, la
        // réconciliation serveur rattrape un échec de confirmation.
        try {
            await confirmArenaUpload(
                { roomId: ids.roomId, arenaId: ids.arenaId, gameId },
                token
            );
        } catch (e) {
            console.warn(`[arena-uploader] confirm-upload failed (${e.message}), serveur réconciliera`);
        }
        return UPLOAD.guid;
    });
}

/**
 * Idem pour une game d'un autre jeu : le serveur compose la clé à partir du jeu
 * et de l'epoch de début de game.
 *
 * La confirmation est DANS la tentative, pas en best-effort comme pour
 * l'After-H : elle est ce qui rend le replay visible dans l'Espace Arena (rien
 * ne réconcilie ce préfixe, il n'y a pas de game en base pour rattraper). Si
 * elle échoue, on rejoue tout — le PUT réécrit le même objet, la clé étant
 * déterministe.
 *
 * Le Color Chaos, lui, a désormais ses parties stockées côté EBP : on demande
 * son identité EVA pour l'attacher au replay, sans quoi l'Espace Arena n'aurait
 * qu'une vidéo nue là où la map, les scores des camps et les joueurs sont en
 * base. La résolution se fait APRÈS l'envoi, juste avant la confirmation :
 * c'est le moment le plus tardif, donc celui qui laisse le plus de temps à la
 * partie pour remonter (le poller de salle pousse toutes les 90 s, le poller
 * serveur ne repasse que toutes les ~25 min).
 */
function uploadOtherGameWithPersistentRetry(filePath, gameType, startedAtEpoch, ids, token) {
    const PAYLOAD = {
        roomId: ids.roomId,
        arenaId: ids.arenaId,
        gameType,
        startedAtEpoch
    };
    return withPersistentRetry(async () => {
        const UPLOAD = await requestOtherGameUploadUrl(PAYLOAD, token);
        await uploadFileToPresignedUrl(UPLOAD.url, filePath, {
            contentType: 'video/mp4'
        });
        const EVA_GAME_ID =
            gameType === 'color-chaos'
                ? await resolveColorChaosGameIdSafely(PAYLOAD, token)
                : null;
        await confirmOtherGameUpload(
            EVA_GAME_ID ? { ...PAYLOAD, evaGameId: EVA_GAME_ID } : PAYLOAD,
            token
        );
        return UPLOAD.key;
    });
}

/**
 * Identité EVA d'une partie Color Chaos, ou `null` si elle n'est pas établie.
 *
 * Ne propage JAMAIS : le lien est un bonus, il ne doit pas coûter la
 * publication du replay. Un serveur en échec ferait rejouer tout l'envoi par le
 * retry persistant, pour une donnée facultative — et un refus de résolution
 * (`gameId: null`, partie pas encore remontée ou deux candidates) est une
 * réponse normale, pas une erreur. La confirmation partira sans guid, et un
 * éventuel retry retentera la résolution.
 */
async function resolveColorChaosGameIdSafely(payload, token) {
    try {
        const RES = await resolveColorChaosGameId(
            {
                roomId: payload.roomId,
                arenaId: payload.arenaId,
                startedAtEpoch: payload.startedAtEpoch
            },
            token
        );
        if (!RES || !RES.gameId) {
            console.log(
                `[arena-uploader] Color Chaos non identifié (${(RES && RES.reason) || 'inconnu'})`
            );
            return null;
        }
        return RES.gameId;
    } catch (e) {
        console.warn(`[arena-uploader] resolve Color Chaos échoué : ${e.message}`);
        return null;
    }
}

/**
 * Traite une game identifiée. Renvoie 'done' | 'failed'.
 * @returns {Promise<'done'|'failed'>}
 */
async function processGame(filePath) {
    const STATE = arenaModeService.getState();
    const TOKEN = arenaModeService.getArenaToken();
    if (!STATE.registered || !TOKEN) {
        throw new Error('arena mode not registered');
    }
    const IDS = { roomId: STATE.roomId, arenaId: STATE.arenaId };
    const NAME = path.basename(filePath);

    const OTHER = NAME.match(OTHER_GAME_FILE_RE);
    if (OTHER) {
        const GAME_TYPE = OTHER_GAME_TYPE[OTHER[1]];
        const STARTED_AT = parseInt(OTHER[4], 10);
        console.log(`[arena-uploader] processing ${NAME} (${GAME_TYPE})`);
        const KEY = await uploadOtherGameWithPersistentRetry(
            filePath,
            GAME_TYPE,
            STARTED_AT,
            IDS,
            TOKEN
        );
        console.log(`[arena-uploader] uploaded as ${KEY}`);
        cleanup(filePath);
        uploadedCount++;
        lastError = null;
        console.log('[arena-uploader] done', NAME);
        return 'done';
    }

    if (!GAME_FILE_RE.test(NAME)) {
        console.warn('[arena-uploader] unparseable name →', NAME);
        moveToFailed(filePath);
        return 'failed';
    }

    // gameId EVA, 3e champ du nom (posé par le service d'identification).
    const GAME_ID = NAME.match(GAME_FILE_RE)[3];
    console.log(`[arena-uploader] processing ${NAME} (EVA game ${GAME_ID})`);

    const GUID = await uploadWithPersistentRetry(filePath, GAME_ID, IDS, TOKEN);
    console.log(`[arena-uploader] uploaded as ${GUID}.mp4`);
    cleanup(filePath);
    uploadedCount++;
    lastError = null;
    console.log('[arena-uploader] done', NAME);
    return 'done';
}

async function workerLoop() {
    if (workerRunning) return;
    workerRunning = true;
    try {
        while (!stopRequested && QUEUE.length > 0) {
            const NEXT = QUEUE[0];
            if (!fs.existsSync(NEXT)) {
                QUEUE.shift();
                continue;
            }
            currentFile = NEXT;
            try {
                await processGame(NEXT);
                QUEUE.shift();
            } catch (e) {
                console.error(
                    '[arena-uploader] processing failed for',
                    NEXT,
                    e.message
                );
                lastError = e.message;
                QUEUE.shift();
            } finally {
                currentFile = null;
            }
        }
    } finally {
        workerRunning = false;
    }
}

function enqueue(filePath) {
    if (QUEUE.includes(filePath) || filePath === currentFile) return;
    QUEUE.push(filePath);
    workerLoop().catch((e) =>
        console.error('[arena-uploader] worker crashed', e)
    );
}

/**
 * Re-scan de games/ : ré-enfile les games identifiées (hors sous-dossiers), et
 * purge failed/ au passage.
 */
function rescanGames() {
    purgeFailed();
    const DIR = getGamesDir();
    let entries;
    try {
        entries = fs.readdirSync(DIR);
    } catch (_) {
        return;
    }
    for (const NAME of entries) {
        if (isUploadable(NAME)) enqueue(path.join(DIR, NAME));
    }
}

/**
 * Démarre l'uploader sur `games/`. Re-scan initial (chokidar ignoreInitial:
 * false) + re-scan périodique pour les games déférées.
 */
function start() {
    if (watcher) return;
    stopRequested = false;

    const GAMES_DIR = getGamesDir();
    if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });

    watcher = chokidar.watch(GAMES_DIR, {
        persistent: true,
        ignoreInitial: false,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 }
    });
    watcher.on('add', (p) => {
        if (isUploadable(path.basename(p))) enqueue(p);
    });
    watcher.on('error', (e) =>
        console.error('[arena-uploader] watcher error', e)
    );
    retryTimer = setInterval(rescanGames, RETRY_SCAN_MS);

    console.log('[arena-uploader] watching', GAMES_DIR);
}

function stop() {
    stopRequested = true;
    if (watcher) {
        watcher.close();
        watcher = null;
    }
    if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
    }
}

function getStatus() {
    return {
        active: !!watcher,
        queued: QUEUE.length,
        currentFile: currentFile ? path.basename(currentFile) : null,
        uploadedCount,
        failedCount: countFailed(),
        lastError
    };
}

module.exports = { start, stop, getStatus };
