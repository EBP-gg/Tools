// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const path = require('node:path');
const chokidar = require('chokidar');
const StorageManager = require('../core/storage-manager');
const {
    registerArena,
    sendArenaHeartbeat,
    requestArenaFileUploadUrl,
    reportArenaFileResult,
    uploadFileToPresignedUrl
} = require('./tools-api-client');
const { connectArena, disconnectArena } = require('./socket-service');
const { version: TOOLS_VERSION } = require('../../package.json');

//#endregion

// Mode salle : cette machine est le PC de streaming d'une arène EVA. L'état
// vit dans les settings permanents. Contrat backend : wiki/arena_mode_api.md.
const SETTINGS_KEY = 'arenaMode';
// Filet de sécurité, plus un battement de présence : c'est la connexion au
// namespace /arena qui dit à l'admin qu'une salle est en ligne, et tout
// changement d'état déclenche déjà un battement immédiat. Le périodique ne sert
// donc plus qu'à deux choses, dont aucune n'exige 5 minutes : prouver que
// l'APPLICATION vit — un socket ouvert ne prouve que la connexion, l'analyseur
// et ffmpeg tournant dans des processus enfants peuvent être morts pendant que
// la boucle d'événements répond encore — et réconcilier l'état affiché si un
// battement s'est perdu.
const HEARTBEAT_INTERVAL_MS = 20 * 60 * 1000;
// Cooldown entre deux tentatives de mise à jour ordonnées par le serveur :
// le flag reste posé côté back tant que la version n'a pas changé, sans ce
// garde on relancerait un installeur défaillant à chaque battement.
const UPDATE_ATTEMPT_COOLDOWN_MS = 45 * 60 * 1000;
// Battement déclenché par un changement (captation, spool, games) : on laisse
// retomber la rafale (ffmpeg qui ferme un segment pendant que le pipeline en
// consomme trois) avant de lire les dossiers et d'envoyer UN battement.
const CHANGE_DEBOUNCE_MS = 2000;
// Garde-fou sur les listes de fichiers remontées : une salle dont le pipeline
// décroche accumule les segments (~12/h), inutile d'en pousser des milliers en
// base à chaque battement. Les noms au-delà sont tronqués (les plus anciens
// d'abord, ce sont les plus parlants).
const MAX_LISTED_FILES = 200;

let heartbeatTimer = null;
let changeTimer = null;
let watchers = [];
let lastUpdateAttemptAt = 0;
// Fournisseur de l'état local remonté dans le battement (posé par server.js) :
// évite un require croisé, arena-pipeline-service requérant déjà ce module.
let statusProvider = null;
// Fichier en cours de remontée, `null` si aucun. Sert à deux choses : un seul
// ordre à la fois (sans ce verrou, un ordre lent serait relancé en parallèle de
// lui-même, les battements étant déclenchés par les changements de fichier), et
// refuser la suppression d'un fichier qu'on est en train d'envoyer.
let fetchingFile = null;
// Callback d'exécution d'une mise à jour ordonnée par l'admin (posé par
// server.js : stop captation propre puis UpdateService.forceUpdate()).
let updateHandler = null;

function setUpdateHandler(handler) {
    updateHandler = handler;
}

/**
 * Pose la source de l'état local remonté par le battement.
 * @param {() => {recording: boolean, spoolFolder: string, gamesFolder: string}} provider
 */
function setStatusProvider(provider) {
    statusProvider = provider;
}

/**
 * Noms des fichiers d'un dossier (fichiers seuls, triés, tronqués à
 * MAX_LISTED_FILES). Dossier absent ou illisible → liste vide : le battement
 * ne doit jamais échouer sur une lecture disque.
 * @returns {string[]}
 */
function listFiles(dir) {
    if (!dir) return [];
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => e.name)
            .sort()
            .slice(0, MAX_LISTED_FILES);
    } catch (_) {
        return [];
    }
}

/**
 * État local remonté au backend : captation en cours, games en attente de
 * traitement/upload et segments encore dans le spool.
 */
function collectLocalState() {
    if (!statusProvider) return { recording: false, pendingGames: [], spool: [] };
    const STATUS = statusProvider();
    return {
        recording: !!STATUS.recording,
        pendingGames: listFiles(STATUS.gamesFolder),
        spool: listFiles(STATUS.spoolFolder)
    };
}

/**
 * Envoie un battement si le mode salle est actif. Fire-and-forget : un échec
 * ponctuel (réseau, backend down) est loggé et rattrapé au battement suivant.
 * Monte la version de Tools, l'état de la captation et le contenu de spool/ et
 * games/ (debug à distance) ; si la réponse porte un ordre de mise à jour, il
 * est exécuté IMMÉDIATEMENT (décision Antoine : l'admin coordonne avec la
 * salle par téléphone, pas de garde-fou côté Tools).
 */
function sendHeartbeat() {
    const STATE = StorageManager.getPermanentSettingsValue(SETTINGS_KEY);
    if (!STATE || !STATE.token) return;
    sendArenaHeartbeat(
        {
            roomId: STATE.roomId,
            arenaId: STATE.arenaId,
            version: TOOLS_VERSION,
            ...collectLocalState()
        },
        STATE.token
    )
        .then((res) => {
            if (!res) return;
            if (res.fetch) handleFetchOrder(res.fetch, STATE);
            if (!res.update || !updateHandler) return;
            if (Date.now() - lastUpdateAttemptAt < UPDATE_ATTEMPT_COOLDOWN_MS) {
                return;
            }
            lastUpdateAttemptAt = Date.now();
            console.log('[arena-mode] update ordered by server — updating now');
            updateHandler();
        })
        .catch((e) =>
            console.warn('[arena-mode] heartbeat failed:', e.message)
        );
}

/**
 * Chemin du dossier désigné par un ordre ou une demande de listing. Seuls ces
 * deux noms existent : le serveur ne peut pas désigner un dossier arbitraire.
 * @returns {string|null}
 */
function folderPath(folder) {
    if (!statusProvider) return null;
    const STATUS = statusProvider();
    if (folder === 'spool') return STATUS.spoolFolder;
    if (folder === 'games') return STATUS.gamesFolder;
    return null;
}

/**
 * Honore un ordre de remontée : un admin réclame un fichier de spool/ ou games/,
 * que le serveur ne peut pas venir chercher (le PC de salle n'est joignable par
 * personne). Le fichier part vers une zone S3 temporaire d'où l'admin le
 * télécharge.
 *
 * Le nom reçu est cherché dans le `readdir` du dossier plutôt que joint au
 * chemin : le serveur ne désigne jamais un fichier du disque, il ne peut que
 * nommer quelque chose que la salle a elle-même annoncé. Un nom inconnu (segment
 * déjà consommé par le pipeline, game partie à l'upload) clôt l'ordre côté
 * serveur au lieu de le laisser revenir indéfiniment.
 *
 * Best-effort : toute erreur laisse l'ordre `pending`, et le battement suivant
 * le représente.
 */
function handleFetchOrder(order, state) {
    if (fetchingFile) return;
    const DIR = folderPath(order.folder);
    if (!DIR) return;

    fetchingFile = order.name;
    const PAYLOAD = {
        roomId: state.roomId,
        arenaId: state.arenaId,
        requestId: order.id
    };
    Promise.resolve()
        .then(async () => {
            if (!listFiles(DIR).includes(order.name)) {
                console.log(
                    `[arena-mode] fetch ${order.folder}/${order.name}: file is gone`
                );
                await reportArenaFileResult(
                    { ...PAYLOAD, available: false },
                    state.token
                );
                return;
            }
            console.log(
                `[arena-mode] fetch ${order.folder}/${order.name}: uploading`
            );
            const RES = await requestArenaFileUploadUrl(PAYLOAD, state.token);
            await uploadFileToPresignedUrl(RES.url, path.join(DIR, order.name), {
                contentType: 'application/octet-stream'
            });
            await reportArenaFileResult(
                { ...PAYLOAD, available: true },
                state.token
            );
            console.log(`[arena-mode] fetch ${order.name}: done`);
        })
        .catch((e) =>
            console.warn('[arena-mode] fetch order failed:', e.message)
        )
        .finally(() => {
            fetchingFile = null;
        });
}

/**
 * Dernière image captée, telle que ffmpeg la réécrit en continu pendant la
 * captation. Rien n'est encodé ici : on relit un fichier, le périphérique
 * restant tenu en exclusivité par la captation.
 *
 * @returns {{image: string|null, reason?: string}} JPEG en base64, ou la raison
 *   de l'absence : captation arrêtée, aperçu coupé par son fusible, ou fichier
 *   pas encore écrit (les premières secondes d'une captation).
 */
function readPreviewFrame() {
    if (!statusProvider) return { image: null, reason: 'unavailable' };
    const STATUS = statusProvider();
    if (!STATUS.recording) return { image: null, reason: 'not_recording' };
    if (!STATUS.previewPath) return { image: null, reason: 'preview_disabled' };
    try {
        return { image: fs.readFileSync(STATUS.previewPath).toString('base64') };
    } catch (_) {
        return { image: null, reason: 'no_frame_yet' };
    }
}

/**
 * Supprime un fichier de spool/ ou games/ à la demande d'un admin. Destructif et
 * sans retour possible : les deux gardes comptent.
 *
 * Le nom est cherché dans le `readdir` du dossier, jamais joint au chemin — le
 * serveur ne désigne pas un fichier du disque, il ne peut que nommer ce que la
 * salle a elle-même annoncé. Et un fichier en cours de remontée est refusé :
 * l'effacer sous les pieds du transfert le casserait.
 *
 * La disparition du fichier réveille le watcher, donc un battement : les
 * compteurs de la page admin se remettent à jour tout seuls.
 *
 * @returns {{deleted: boolean, reason?: string}}
 */
function deleteFile(folder, name) {
    const DIR = folderPath(folder);
    if (!DIR) return { deleted: false, reason: 'unknown_folder' };
    if (name === fetchingFile) return { deleted: false, reason: 'uploading' };
    if (!listFiles(DIR).includes(name)) {
        return { deleted: false, reason: 'not_found' };
    }
    try {
        fs.unlinkSync(path.join(DIR, name));
        console.log(`[arena-mode] deleted ${folder}/${name}`);
        return { deleted: true };
    } catch (e) {
        console.error('[arena-mode] delete failed:', name, e.message);
        return { deleted: false, reason: 'error' };
    }
}

/**
 * Envoie un battement et repart pour 5 min : tout battement réarme le cycle,
 * qu'il soit périodique ou déclenché par un changement. La salle envoie donc
 * un battement toutes les 5 min OU à chaque changement d'état, jamais les deux
 * coup sur coup.
 */
function beat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(beat, HEARTBEAT_INTERVAL_MS);
    sendHeartbeat();
}

/**
 * Signale un changement d'état local (captation démarrée/arrêtée, fichier
 * ajouté ou supprimé dans spool/ ou games/) : battement anticipé, après une
 * fenêtre d'amortissement pour ne pas en envoyer un par fichier. No-op si le
 * mode salle n'est pas actif.
 */
function notifyChange() {
    if (!heartbeatTimer) return;
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
        changeTimer = null;
        beat();
    }, CHANGE_DEBOUNCE_MS);
}

/**
 * Surveille spool/ et games/ pour battre à chaque ajout/suppression. Les
 * dossiers sont créés s'ils manquent : au boot, la captation et le pipeline ne
 * les ont pas encore créés et chokidar ne rattrape pas un dossier absent.
 */
function startWatchers() {
    if (!statusProvider) return;
    const STATUS = statusProvider();
    for (const DIR of [STATUS.spoolFolder, STATUS.gamesFolder]) {
        if (!DIR) continue;
        try {
            if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
        } catch (e) {
            console.warn('[arena-mode] mkdir failed:', DIR, e.message);
            continue;
        }
        // Les segments sont écrits en continu par ffmpeg : pas d'attente de
        // stabilité, on ne remonte que des NOMS (relus au moment du battement).
        const WATCHER = chokidar.watch(DIR, {
            persistent: true,
            ignoreInitial: true,
            depth: 0,
            awaitWriteFinish: false
        });
        WATCHER.on('add', notifyChange);
        WATCHER.on('unlink', notifyChange);
        WATCHER.on('error', (e) =>
            console.error('[arena-mode] watcher error', e)
        );
        watchers.push(WATCHER);
    }
}

/**
 * Démarre le battement périodique (immédiat + toutes les 5 min) et la
 * surveillance des dossiers. No-op si le mode salle n'est pas actif. À appeler
 * au boot de l'app et après un register réussi. Idempotent.
 */
function startHeartbeat() {
    stopHeartbeat();
    const STATE = StorageManager.getPermanentSettingsValue(SETTINGS_KEY);
    if (!STATE || !STATE.token) return;
    startWatchers();
    // Canal temps réel : un ordre admin arrive alors en quelques secondes au
    // lieu d'attendre le battement. Le battement le porte toujours — c'est lui
    // qui rattrape tout ordre émis pendant une coupure.
    connectArena(STATE, {
        onFetch: (order) => handleFetchOrder(order, STATE),
        onList: (folder) => listFiles(folderPath(folder)),
        onDelete: deleteFile,
        onFrame: readPreviewFrame
    });
    beat();
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (changeTimer) {
        clearTimeout(changeTimer);
        changeTimer = null;
    }
    for (const WATCHER of watchers) WATCHER.close();
    watchers = [];
    disconnectArena();
}

/**
 * @returns {{registered: boolean, roomId?: number, arenaId?: number, roomName?: string, terrainId?: string, terrainName?: string}}
 *   La clé (token) n'est jamais exposée au renderer — elle reste côté main process.
 */
function getState() {
    const STATE = StorageManager.getPermanentSettingsValue(SETTINGS_KEY);
    if (!STATE || !STATE.token) return { registered: false };
    return {
        registered: true,
        roomId: STATE.roomId,
        arenaId: STATE.arenaId,
        roomName: STATE.roomName,
        terrainId: STATE.terrainId,
        terrainName: STATE.terrainName
    };
}

/**
 * Token d'arène pour les futurs endpoints salle (header `X-Arena-Token`).
 * @returns {string|null}
 */
function getArenaToken() {
    const STATE = StorageManager.getPermanentSettingsValue(SETTINGS_KEY);
    return STATE && STATE.token ? STATE.token : null;
}

/**
 * Valide la clé de salle auprès du backend et la persiste : c'est elle qui
 * servira de credential (header `X-Arena-Token`) sur les endpoints salle.
 * @param {{roomId:number, arenaId:number, key:string}} payload
 * @returns {Promise<{registered: true, roomId: number, arenaId: number, roomName: string}>}
 * @throws NotAuthenticatedError / ApiError (404 salle/arène inconnue, 422 clé
 *   refusée — clé invalide, mode désactivé ou mauvaise IP) — remontées telles
 *   quelles au caller (server.js) qui les transforme en erreur i18n.
 */
async function register({ roomId, arenaId, key }) {
    const RES = await registerArena({ roomId, arenaId, key });
    StorageManager.setPermanentSettingsValue(SETTINGS_KEY, {
        roomId,
        arenaId,
        roomName: RES.roomName,
        terrainId: RES.terrainId,
        terrainName: RES.terrainName,
        token: key,
        registeredAt: Date.now()
    });
    startHeartbeat();
    return getState();
}

/**
 * Désenregistre localement (le token reste révocable côté serveur).
 */
function unregister() {
    stopHeartbeat();
    const SETTINGS = StorageManager.permanentSettings;
    delete SETTINGS[SETTINGS_KEY];
    StorageManager.permanentSettings = SETTINGS;
    return getState();
}

module.exports = {
    getState,
    getArenaToken,
    register,
    unregister,
    startHeartbeat,
    setUpdateHandler,
    setStatusProvider,
    notifyChange
};
