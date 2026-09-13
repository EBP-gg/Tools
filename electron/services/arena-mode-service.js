// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const chokidar = require('chokidar');
const StorageManager = require('../core/storage-manager');
const { registerArena, sendArenaHeartbeat } = require('./tools-api-client');
const { version: TOOLS_VERSION } = require('../../package.json');

//#endregion

// Mode salle : cette machine est le PC de streaming d'une arène EVA. L'état
// vit dans les settings permanents. Contrat backend : wiki/arena_mode_api.md.
const SETTINGS_KEY = 'arenaMode';
// Battement de présence vers le backend (la page admin du site affiche
// l'arène "en ligne" si le dernier battement a moins de 15 min).
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
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
            if (!res || !res.update || !updateHandler) return;
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
