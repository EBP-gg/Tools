// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const { EBP_DOMAIN } = require('../config/constants');
const { markBusy } = require('../core/activity-tracker');
const sessionService = require('./session-service');

// Cible REST : en dev on tape le serveur EBP local (http://localhost:3005),
// comme le socket — sinon prod en HTTPS. Indispensable pour tester le live :
// c'est l'appel REST `analysis-status` qui déclenche le broadcast socket, donc
// il doit viser le même serveur que celui auquel le front est connecté.
// Le jeton vient du deeplink émis par le site de prod — le serveur dev doit
// partager le secret JWT pour le valider, et sa base contenir les games
// (pour /identify).
// `EBP_TARGET=prod` force la PROD tout en restant en mode dev : indispensable
// pour tester le mode salle contre le vrai backend, puisque passer
// NODE_ENV=production ferait chercher ffmpeg/analyzer dans process.resourcesPath
// (layout d'app packagée) au lieu du repo.
const IS_DEV_MODE = process.env.NODE_ENV !== 'production';
const USE_PROD_API = !IS_DEV_MODE || process.env.EBP_TARGET === 'prod';
const API_HTTP = USE_PROD_API ? https : http;
const API_HOST = USE_PROD_API ? EBP_DOMAIN : 'localhost';
const API_PORT = USE_PROD_API ? 443 : 3005;

//#endregion

const API_BASE_PATH = '/api/tools';
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
// Téléchargement présigné : délai SANS le moindre octet reçu au-delà duquel on
// considère le transfert mort. Rien à voir avec sa durée totale, qui se compte en
// minutes pour une vidéo de salle.
const DOWNLOAD_IDLE_TIMEOUT_MS = 60 * 1000;

class NotAuthenticatedError extends Error {
    constructor(detail = '') {
        super(detail ? `NotAuthenticated: ${detail}` : 'NotAuthenticated');
        this.name = 'NotAuthenticatedError';
        this.detail = detail;
    }
}

class ApiError extends Error {
    constructor(status, body, headers = {}) {
        const LOC = headers && headers.location ? ` (location=${headers.location})` : '';
        super(`API error ${status}${LOC}: ${body}`);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
        this.headers = headers;
    }
}

/**
 * Jeton signant les appels user. Tools ne se connecte plus : le jeton vient du
 * deeplink du site, soit attaché à la vidéo traitée (`explicitToken`), soit à
 * défaut le dernier reçu. Le back accepte ce format via `Authorization: Bearer`
 * (cf. `auth.middleware.ts`).
 * @param {string|undefined} explicitToken jeton de la vidéo en cours.
 * @returns {string|null}
 */
function resolveAuthToken(explicitToken) {
    return explicitToken || sessionService.getToken();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Performs an HTTPS request and resolves with `{ status, body }`.
 */
function httpsRequest(options, bodyBuffer = null) {
    return new Promise((resolve, reject) => {
        const REQ = API_HTTP.request(options, (res) => {
            const CHUNKS = [];
            res.on('data', (c) => CHUNKS.push(c));
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    body: Buffer.concat(CHUNKS).toString('utf8'),
                    headers: res.headers
                });
            });
        });
        REQ.on('error', reject);
        if (bodyBuffer) REQ.write(bodyBuffer);
        REQ.end();
    });
}

/**
 * JSON API call with Bearer auth and retry on network/5xx errors.
 * Throws NotAuthenticatedError immediately if no valid access token.
 * Throws ApiError on non-retryable HTTP errors (4xx other than 408/429).
 * `requireAuth: false` → pas de jeton exigé (endpoints du mode salle, dont le
 * credential est la clé de salle). `authToken` → jeton de la vidéo en cours,
 * sinon repli sur le dernier jeton reçu du site. `headers` → headers
 * additionnels (ex. X-Arena-Token).
 */
async function apiRequest(
    method,
    apiPath,
    body,
    {
        retries = DEFAULT_RETRIES,
        baseDelayMs = DEFAULT_BASE_DELAY_MS,
        headers = {},
        requireAuth = true,
        authToken = undefined
    } = {}
) {
    const TOKEN = requireAuth ? resolveAuthToken(authToken) : null;
    if (requireAuth && !TOKEN) throw new NotAuthenticatedError();

    const PAYLOAD = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const OPTIONS = {
        hostname: API_HOST,
        port: API_PORT,
        path: API_BASE_PATH + apiPath,
        method,
        headers: {
            ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
            Accept: 'application/json',
            ...headers
        }
    };
    if (PAYLOAD) {
        OPTIONS.headers['Content-Type'] = 'application/json';
        OPTIONS.headers['Content-Length'] = PAYLOAD.length;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const RES = await httpsRequest(OPTIONS, PAYLOAD);
            if (RES.status === 401 || RES.status === 403) {
                throw new NotAuthenticatedError(
                    `${method} ${apiPath} → ${RES.status} ${RES.body || ''}`
                );
            }
            if (RES.status >= 200 && RES.status < 300) {
                try {
                    return RES.body ? JSON.parse(RES.body) : null;
                } catch (e) {
                    throw new ApiError(RES.status, RES.body, RES.headers);
                }
            }
            const RETRYABLE =
                RES.status === 408 ||
                RES.status === 429 ||
                RES.status >= 500;
            if (!RETRYABLE) {
                throw new ApiError(RES.status, RES.body, RES.headers);
            }
            lastError = new ApiError(RES.status, RES.body, RES.headers);
        } catch (err) {
            if (
                err instanceof NotAuthenticatedError ||
                err instanceof ApiError
            ) {
                if (err instanceof ApiError) {
                    const RETRYABLE =
                        err.status === 408 ||
                        err.status === 429 ||
                        err.status >= 500;
                    if (!RETRYABLE) throw err;
                    lastError = err;
                } else {
                    throw err;
                }
            } else {
                lastError = err;
            }
        }

        if (attempt < retries) {
            await sleep(baseDelayMs * Math.pow(2, attempt - 1));
        }
    }
    throw lastError;
}

/**
 * POST /api/tools/games/identify
 * Première étape : matche les segments aux games BDD (LCS sur mapID + scores
 * ±1, sessions 4h) et retourne les rosters avec K/D pour pouvoir nourrir la
 * phase 2 d'analyse approfondie avec des pseudos full-confiance.
 *
 * @param {object} payload { sourceFilename?, teamId, segments: [{ tempId, startSeconds, endSeconds, mode, mapName, blueScore, orangeScore, ... }] }
 * @returns {Promise<{ matches: Array<{tempId, gameID, hasVideo, orangePlayers: Array<{name, K, D}>, bluePlayers: Array<{name, K, D}>}>, unmatched: Array<string> }>}
 *   `hasVideo` indique qu'une vidéo est déjà attachée à la game côté serveur :
 *   le client doit alors skip découpage / réencodage / upload pour ce segment.
 */
function identifyGames(payload, authToken) {
    return apiRequest('POST', '/games/identify', payload, { authToken });
}

/**
 * POST /api/tools/games/persist-analysis
 * Seconde étape : persiste les analyses approfondies de phase 2 pour les games
 * matchées via `/identify`. Le client envoie directement les `gameID` (pas de
 * re-matching côté back). Ownership re-vérifiée par game.
 *
 * @param {object} payload { analyses: [{ gameID, payload }], teamId }
 *   `teamId` = équipe-auteur des analyses (issue du deeplink du site) — OBLIGATOIRE,
 *   le serveur refuse (403) sans lui.
 * @returns {Promise<{ persisted: Array<string>, failed: Array<{gameID, reason}> }>}
 */
function persistAnalysis(payload, authToken) {
    return apiRequest('POST', '/games/persist-analysis', payload, { authToken });
}

/**
 * POST /api/tools/arena/pre-analysis/next
 * MODE SYSTÈME : demande au serveur les prochaines vidéos de salle à pré-analyser.
 * Le worker ne choisit rien — le serveur désigne les games (celles où joue un abonné
 * Statistics Pro d'abord), présigne lui-même leur objet S3 et les réserve une heure.
 *
 * Auth par clé de service seule (X-System-Token), sans jeton utilisateur : le worker
 * tourne en continu et n'agit pour le compte de personne. Refus = 422, jamais 401/403,
 * pour ne pas être confondu avec une perte de session côté client.
 *
 * @param {number} limit 1..5
 * @param {string} systemKey
 * @returns {Promise<{games: Array<{gameId, guid, terrainId, map, playedAt, orangeScore,
 *   blueScore, orangePlayers, bluePlayers, hasPro, videoUrl}>}>}
 */
function fetchPreAnalysisBatch(limit, systemKey) {
    return apiRequest(
        'POST',
        '/arena/pre-analysis/next',
        { limit },
        { retries: 1, requireAuth: false, headers: { 'X-System-Token': systemKey } }
    );
}

/**
 * POST /api/tools/arena/pre-analysis
 * MODE SYSTÈME : dépose le payload calculé pour une game de salle. Le serveur l'écrit
 * sous l'équipe système et lève la réservation.
 *
 * 404 = la game n'a plus de vidéo de salle ; 422 = clé refusée OU analyse sans aucun
 * kill (le champ `error` distingue les deux). Ces deux cas sont définitifs : inutile
 * de réessayer.
 *
 * @param {{gameId: string, payload: object}} payload
 * @param {string} systemKey
 * @returns {Promise<{ok: true}>}
 */
function submitPreAnalysis(payload, systemKey) {
    return apiRequest('POST', '/arena/pre-analysis', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-System-Token': systemKey }
    });
}

/**
 * POST /api/tools/games/:gameID/upload-url
 * @param {string|number} gameID
 * @param {string|undefined} teamId  équipe-auteur de la vidéo (issue du deeplink du
 *   site) — OBLIGATOIRE, le serveur refuse (403) sans lui.
 * @returns {Promise<{ url, key, expiresAt }>}
 */
function requestUploadUrl(gameID, teamId, authToken) {
    return apiRequest(
        'POST',
        `/games/${encodeURIComponent(gameID)}/upload-url`,
        { teamId },
        { authToken }
    );
}

/**
 * POST /api/tools/games/:gameID/confirm-upload
 * @param {object} payload { guid, teamId } — même `teamId` que l'upload-url, pour
 *   que la vidéo atterrisse sur la même ligne d'analyse (game_id, author_team_id).
 */
function confirmUpload(gameID, payload, authToken) {
    return apiRequest(
        'POST',
        `/games/${encodeURIComponent(gameID)}/confirm-upload`,
        payload,
        { authToken }
    );
}

/**
 * POST /api/tools/arena/register
 * Mode salle : enregistre cette machine comme PC de streaming d'une arène.
 * Pas d'auth user (Tools n'ouvre plus de session) : le credential est la clé de
 * salle (T_EVA_Locations.tools_token, révocable en base, IP optionnellement
 * restreinte), validée côté serveur.
 * La clé elle-même sert de credential pour les futurs endpoints salle (header
 * `X-Arena-Token`). `arenaId` = ordinal de l'arène dans la salle (1 ou 2) ;
 * le serveur renvoie l'id du terrain réel pour le futur matching des games.
 * Erreurs : 404 salle/arène inconnue, 422 clé refusée (clé invalide, mode
 * désactivé ou mauvaise IP). Contrat : wiki/arena_mode_api.md.
 *
 * @param {{roomId:number, arenaId:number, key:string}} payload
 * @returns {Promise<{ roomName: string, terrainId: string, terrainName: string }>}
 */
function registerArena(payload) {
    return apiRequest('POST', '/arena/register', payload, {
        requireAuth: false
    });
}

/**
 * GET /api/tools/arena/locations
 * Salles activables (clé posée par un admin) avec leurs arènes — alimente les
 * listes déroulantes du formulaire mode salle. Pas d'auth user (comme le
 * register).
 * @returns {Promise<{id:string, name:string, country:string, terrains:{id:string, name:string}[]}[]>}
 */
function getArenaLocations() {
    return apiRequest('GET', '/arena/locations', null, { requireAuth: false });
}

/**
 * POST /api/tools/arena/heartbeat
 * Battement de présence du mode salle (toutes les 5 min, ou à chaque
 * changement d'état local) : la page admin du site affiche l'arène "en ligne"
 * tant que le dernier battement a moins de 15 min, et l'état remonté (version,
 * captation, spool/, games/) sert au diagnostic à distance. Authentifié par la
 * clé de salle seule (header X-Arena-Token, pas de cookie : doit fonctionner
 * même session user expirée). Pas de retry — le battement suivant rattrape un
 * échec ponctuel.
 *
 * @param {{roomId:number, arenaId:number, version:string, recording:boolean,
 *   pendingGames:string[], spool:string[]}} payload
 * @param {string} arenaToken  clé de salle stockée par arena-mode-service.
 */
function sendArenaHeartbeat(payload, arenaToken) {
    return apiRequest('POST', '/arena/heartbeat', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-Arena-Token': arenaToken }
    });
}

/**
 * POST /api/tools/arena/games/resolve
 * Demande à EBP l'identité EVA d'une game découpée localement : match sur
 * (arène du token, fin de game ±3 min) avec la map en garde-fou. EBP est la
 * source de référence des games (poller serveur, push du poller salle, imports
 * d'équipe), donc la question ne se pose qu'à lui.
 *
 * Répond toujours 200 hors erreur : `{gameId}` si identifiée, sinon
 * `{gameId: null, reason}` — une exception signifie donc « échec réseau /
 * serveur », à réessayer, jamais « pas identifiable ».
 *
 * @param {{roomId:number, arenaId:number, endEpoch:number, map:string}} payload
 * @param {string} arenaToken
 * @returns {Promise<{gameId:string|null, reason?:string}>}
 */
function resolveArenaGameId(payload, arenaToken) {
    return apiRequest('POST', '/arena/games/resolve', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-Arena-Token': arenaToken }
    });
}

/**
 * POST /api/tools/arena/color-chaos/resolve
 * Pendant du resolve After-H pour une partie Color Chaos : match sur (arène du
 * token, DÉBUT de partie ±2 min). On compare les débuts parce que c'est ce que
 * les deux côtés portent nativement — `startedAtEpoch` borne déjà le fichier
 * découpé, et EBP stocke le début de partie.
 *
 * Sans map en garde-fou (Tools ne lit pas celle d'une partie Color Chaos), la
 * fenêtre est la seule protection : elle est plus serrée que l'écart minimal
 * entre deux parties d'une même arène, et le serveur refuse dès qu'il a
 * plusieurs candidats.
 *
 * `{gameId: null, reason}` est une réponse NORMALE, pas un échec : la partie
 * peut n'être pas encore remontée en base. Seule une exception veut dire
 * « réessayer ».
 *
 * @param {{roomId:number, arenaId:number, startedAtEpoch:number}} payload
 * @param {string} arenaToken
 * @returns {Promise<{gameId:string|null, reason?:string}>}
 */
function resolveColorChaosGameId(payload, arenaToken) {
    return apiRequest('POST', '/arena/color-chaos/resolve', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-Arena-Token': arenaToken }
    });
}

/**
 * POST /api/tools/arena/games/upload-url
 * URL présignée PUT vers `statistics/replays/{guid}.mp4` : l'emplacement ET le
 * nommage définitifs d'un replay, identiques à ceux d'une analyse locale. On
 * envoie le `gameId` EVA (celui que `resolveArenaGameId` a donné) et c'est le
 * SERVEUR qui en déduit le guid — Tools ne nomme jamais l'objet. Il n'y a rien
 * à déposer ensuite : l'existence de l'objet est la trace de l'upload.
 *
 * Auth par clé de salle seule (X-Arena-Token). Pas de retry interne :
 * l'uploader gère sa propre boucle persistante en re-demandant une URL fraîche
 * à chaque tentative — la clé étant déterministe, un retry réécrit le même objet.
 *
 * @param {{roomId:number, arenaId:number, gameId:string}} payload
 * @param {string} arenaToken
 * @returns {Promise<{url:string, key:string, guid:string, expiresAt:number}>}
 */
function requestArenaUploadUrl(payload, arenaToken) {
    return apiRequest('POST', '/arena/games/upload-url', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-Arena-Token': arenaToken }
    });
}

/**
 * POST /api/tools/arena/other/upload-url
 * URL présignée PUT pour un replay d'un jeu AUTRE qu'After-H (Color Chaos,
 * Zombies, …). Aucun de ces jeux n'a de game en base côté EBP : pas de gameId à
 * envoyer, donc une route distincte de `/arena/games/upload-url`.
 * Comme partout, c'est le SERVEUR qui compose la clé — Tools ne fait que
 * fournir le jeu et l'epoch de DÉBUT de game, celui qui borne déjà le fichier
 * découpé. Clé déterministe → un retry réécrit le même objet.
 *
 * Auth par clé de salle seule (X-Arena-Token).
 *
 * @param {{roomId:number, arenaId:number, gameType:string, startedAtEpoch:number}} payload
 * @param {string} arenaToken
 * @returns {Promise<{url:string, key:string, expiresAt:number}>}
 */
function requestOtherGameUploadUrl(payload, arenaToken) {
    return apiRequest('POST', '/arena/other/upload-url', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-Arena-Token': arenaToken }
    });
}

/**
 * POST /api/tools/arena/other/confirm-upload
 * Le serveur vérifie l'objet en S3 puis l'indexe, ce qui le rend visible dans
 * l'Espace Arena. Contrairement à l'After-H, cette confirmation n'est PAS
 * best-effort : aucune game en base ne permettrait de rattraper l'oubli, et
 * rien ne réconcilie ce préfixe — un replay non confirmé resterait invisible.
 * L'appelant la rejoue donc avec l'upload.
 *
 * @param {{roomId:number, arenaId:number, gameType:string, startedAtEpoch:number}} payload
 * @param {string} arenaToken
 * @returns {Promise<void>}
 */
function confirmOtherGameUpload(payload, arenaToken) {
    return apiRequest('POST', '/arena/other/confirm-upload', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-Arena-Token': arenaToken }
    });
}

/**
 * POST /api/tools/arena/games/confirm-upload
 * Confirme au serveur que le PUT du replay a réussi : le serveur VÉRIFIE l'objet
 * en S3 puis indexe la vidéo (T_Terrain_Videos), ce qui rend requêtable « quelles
 * games ont une vidéo de salle » sans interroger S3. À appeler APRÈS un PUT réussi,
 * avec le même `gameId` EVA que `requestArenaUploadUrl`. Best-effort : un échec
 * n'invalide pas l'upload (la réconciliation serveur rattrape).
 *
 * @param {{roomId:number, arenaId:number, gameId:string}} payload
 * @param {string} arenaToken
 * @returns {Promise<void>}
 */
function confirmArenaUpload(payload, arenaToken) {
    return apiRequest('POST', '/arena/games/confirm-upload', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-Arena-Token': arenaToken }
    });
}

/**
 * POST /api/tools/arena/games/ingest
 * Mode salle : pousse vers EBP les nœuds bruts `listLastGamesAtLocation` des
 * nouvelles games vues par le poller, pour qu'EBP les upsert dans sa BDD
 * (T_Games) sans attendre son propre poll ni un import d'équipe. Auth clé de
 * salle (X-Arena-Token). Best-effort : le poller serveur d'EBP reste le filet.
 *
 * @param {{roomId:number, arenaId:number, games:object[]}} payload
 * @param {string} arenaToken
 * @returns {Promise<{upserted:number}>}
 */
function ingestArenaGames(payload, arenaToken) {
    return apiRequest('POST', '/arena/games/ingest', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-Arena-Token': arenaToken }
    });
}

/**
 * POST /api/tools/watcher/status
 * Push de l'état complet du watcher (queued/processing/failed). Le serveur
 * stamp `updatedAt` lui-même et broadcast aux sockets du user.
 *
 * Tolérant aux échecs : appelé à chaque transition du worker, on ne veut
 * surtout pas faire planter la pipeline si le back est momentanément down
 * ou si le user n'est pas (encore) authentifié.
 *
 * @param {{queued:Array<{name,path}>, processing:Array<{name,path}>, failed:Array<{name,path}>}} status
 */
async function pushWatcherStatus(status, authToken) {
    try {
        await apiRequest('POST', '/watcher/status', status, {
            retries: 1,
            authToken
        });
    } catch (e) {
        if (e instanceof NotAuthenticatedError) return;
        console.warn('[tools-api] pushWatcherStatus failed:', e.message);
    }
}

/**
 * POST /api/tools/games/:gameID/analysis-status
 * Push de l'état de progression d'UNE game (phase + percent sur l'échelle
 * unifiée 0-100). Le serveur persiste l'état et le broadcast aux sockets du
 * user (affichage live sur la ligne de la game côté site).
 *
 * Tolérant aux échecs comme `pushWatcherStatus` : appelé en continu pendant
 * la pipeline, il ne doit jamais la faire planter (back down / non authentifié).
 *
 * @param {string|number} gameID  vrai ID DB de la game (games matchées).
 * @param {{phase:'queued'|'analyzing'|'processing'|'done'|'failed', percent:number, teamId?:string}} status
 *   `teamId` = équipe de destination choisie dans Tools (informatif côté back).
 */
async function pushGameAnalysisStatus(gameID, status, authToken) {
    try {
        await apiRequest(
            'POST',
            `/games/${encodeURIComponent(gameID)}/analysis-status`,
            status,
            { retries: 1, authToken }
        );
    } catch (e) {
        if (e instanceof NotAuthenticatedError) return;
        console.warn('[tools-api] pushGameAnalysisStatus failed:', e.message);
    }
}

/**
 * POST /api/tools/games/analysis-issue
 * Remonte un problème d'analyse AU NIVEAU FICHIER (sans game), ex. "aucune game
 * détectée" — cas où /identify n'est jamais appelé. Tolérant aux échecs (comme
 * pushGameAnalysisStatus) pour ne pas perturber le worker.
 *
 * @param {{sourceFilename:string, teamId:string, reason:'no_games'}} payload
 */
async function reportAnalysisIssue(payload, authToken) {
    try {
        await apiRequest('POST', '/games/analysis-issue', payload, {
            retries: 1,
            authToken
        });
    } catch (e) {
        if (e instanceof NotAuthenticatedError) return;
        console.warn('[tools-api] reportAnalysisIssue failed:', e.message);
    }
}

/**
 * POST /api/tools/telemetry
 * Télémétrie technique de Tools (version installée, issue des mises à jour).
 * Pas d'auth : Tools n'ouvre pas de session, et l'événement doit remonter même
 * pour un utilisateur qui n'a jamais ouvert de deeplink. Le serveur limite donc
 * le débit par IP.
 *
 * Tolérant aux échecs, comme `pushWatcherStatus` : la télémétrie ne doit
 * pouvoir casser aucun flux.
 *
 * @param {{installId:string, version:string, platform:string, arch:string,
 *   event:string, detail?:object}} payload
 */
async function sendTelemetry(payload) {
    try {
        // Le jeton du site est joint QUAND il existe, sans être exigé : il fait
        // marquer l'événement « de confiance » côté serveur, seul sous-ensemble
        // non falsifiable d'un endpoint ouvert. Un poste sans jeton doit
        // continuer de remonter ses événements, simplement non authentifiés.
        const TOKEN = resolveAuthToken();
        await apiRequest('POST', '/telemetry', payload, {
            retries: 1,
            requireAuth: false,
            headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
        });
    } catch (e) {
        console.warn('[tools-api] sendTelemetry failed:', e.message);
    }
}

/**
 * Télécharge un objet depuis une URL présignée vers `filePath` (GET), en suivant les
 * redirections. Pendant de `uploadFileToPresignedUrl`, pour le worker de pré-analyse
 * qui doit rapatrier la vidéo de salle avant de l'analyser.
 *
 * Écrit dans un fichier `.part` renommé à la fin : un téléchargement interrompu ne
 * laisse jamais un mp4 tronqué que l'analyseur prendrait pour une vidéo valide.
 * Pas de retry interne — la boucle du worker relancera la game au prochain tour.
 *
 * `onProgress` reçoit l'avancement en 0-1, à chaque paquet reçu — donc très
 * souvent : c'est à l'appelant de lisser s'il affiche quelque chose. Muet quand
 * la taille n'est pas annoncée : mieux vaut aucune progression qu'une fausse.
 */
function downloadPresignedUrlToFile(
    presignedUrl,
    filePath,
    redirectsLeft = 3,
    onProgress
) {
    const URL_OBJ = new URL(presignedUrl);
    const PART_PATH = filePath + '.part';
    const CLIENT = URL_OBJ.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        };
        const REQ = CLIENT.get(
            {
                hostname: URL_OBJ.hostname,
                port: URL_OBJ.port || (URL_OBJ.protocol === 'http:' ? 80 : 443),
                path: URL_OBJ.pathname + URL_OBJ.search
            },
            (res) => {
                if (
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location &&
                    redirectsLeft > 0
                ) {
                    res.resume();
                    settled = true;
                    downloadPresignedUrlToFile(
                        res.headers.location,
                        filePath,
                        redirectsLeft - 1,
                        onProgress
                    ).then(resolve, reject);
                    return;
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    fail(new ApiError(res.statusCode, 'download failed', res.headers));
                    return;
                }
                // Taille annoncée : sans elle on ne peut pas distinguer un transfert
                // complet d'un flux coupé au milieu.
                const EXPECTED = Number(res.headers['content-length'] || 0);
                let received = 0;
                res.on('data', (c) => {
                    received += c.length;
                    if (onProgress && EXPECTED > 0) {
                        try {
                            onProgress(received / EXPECTED);
                        } catch (_) {}
                    }
                });
                // Une coupure de socket n'émet pas toujours 'error' : sans ce garde-fou,
                // la promesse resterait pendante et le worker attendrait indéfiniment.
                res.on('aborted', () => fail(new Error('download aborted by remote')));
                const OUT = fs.createWriteStream(PART_PATH);
                res.pipe(OUT);
                OUT.on('finish', () => {
                    OUT.close(() => {
                        if (settled) return;
                        if (EXPECTED > 0 && received !== EXPECTED) {
                            fail(
                                new Error(
                                    `download incomplete: ${received}/${EXPECTED} bytes`
                                )
                            );
                            return;
                        }
                        settled = true;
                        try {
                            fs.renameSync(PART_PATH, filePath);
                            resolve(filePath);
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                OUT.on('error', fail);
            }
        );
        // Inactivité, pas durée totale : une vidéo de salle pèse plusieurs centaines de
        // Mo, le transfert peut être long — c'est l'absence de données qui trahit un
        // téléchargement mort.
        REQ.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
            REQ.destroy(new Error('download stalled'));
        });
        REQ.on('error', fail);
    });
}

/**
 * Uploads a local file via HTTP PUT to a presigned URL with retry on
 * network/5xx errors. Resolves on 2xx, throws otherwise.
 */
async function uploadFileToPresignedUrl(
    presignedUrl,
    filePath,
    {
        retries = DEFAULT_RETRIES,
        baseDelayMs = DEFAULT_BASE_DELAY_MS,
        contentType = 'video/mp4',
        onProgress /* (percent: 0-100) => void, optionnel */
    } = {}
) {
    const URL_OBJ = new URL(presignedUrl);
    const SIZE = fs.statSync(filePath).size;

    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        // Un transfert de plusieurs centaines de Mo ne lance aucun processus
        // enfant : il est invisible au compteur d'occupation, qui les déduit.
        // Sans ce marquage Tools se croit libre pendant l'envoi d'un replay et
        // peut se redémarrer au milieu — l'envoi repartirait alors de zéro.
        //
        // Les attentes entre tentatives sont couvertes elles aussi, mais elles
        // sont ici bornées à 1 s puis 2 s. La relance persistante du mode salle
        // (30 s à 10 min, sans limite de tentatives) est en dehors de cette
        // fonction : une salle privée de réseau ne reste donc jamais marquée
        // occupée, et continue de recevoir ses mises à jour.
        const RELEASE_BUSY = markBusy();
        try {
            const STATUS = await new Promise((resolve, reject) => {
                const REQ = https.request(
                    {
                        hostname: URL_OBJ.hostname,
                        port: URL_OBJ.port || 443,
                        path: URL_OBJ.pathname + URL_OBJ.search,
                        method: 'PUT',
                        headers: {
                            'Content-Type': contentType,
                            'Content-Length': SIZE
                        }
                    },
                    (res) => {
                        const CHUNKS = [];
                        res.on('data', (c) => CHUNKS.push(c));
                        res.on('end', () => {
                            const BODY =
                                Buffer.concat(CHUNKS).toString('utf8');
                            if (
                                res.statusCode >= 200 &&
                                res.statusCode < 300
                            ) {
                                resolve(res.statusCode);
                            } else {
                                reject(new ApiError(res.statusCode, BODY));
                            }
                        });
                    }
                );
                REQ.on('error', reject);
                const STREAM = fs.createReadStream(filePath);
                STREAM.on('error', reject);
                // Compte les octets envoyés (le stream est paced par la
                // backpressure de la requête PUT, donc ~= débit réseau réel).
                if (onProgress && SIZE > 0) {
                    let uploaded = 0;
                    STREAM.on('data', (c) => {
                        uploaded += c.length;
                        onProgress(
                            Math.min(100, Math.ceil((uploaded / SIZE) * 100))
                        );
                    });
                }
                STREAM.pipe(REQ);
            });
            return STATUS;
        } catch (err) {
            const RETRYABLE =
                !(err instanceof ApiError) ||
                err.status === 408 ||
                err.status === 429 ||
                err.status >= 500;
            if (!RETRYABLE) throw err;
            lastError = err;
            if (attempt < retries) {
                await sleep(baseDelayMs * Math.pow(2, attempt - 1));
            }
        } finally {
            RELEASE_BUSY();
        }
    }
    throw lastError;
}

module.exports = {
    identifyGames,
    registerArena,
    getArenaLocations,
    sendArenaHeartbeat,
    requestArenaUploadUrl,
    requestOtherGameUploadUrl,
    confirmOtherGameUpload,
    confirmArenaUpload,
    ingestArenaGames,
    resolveArenaGameId,
    resolveColorChaosGameId,
    persistAnalysis,
    fetchPreAnalysisBatch,
    submitPreAnalysis,
    requestUploadUrl,
    confirmUpload,
    uploadFileToPresignedUrl,
    downloadPresignedUrlToFile,
    pushWatcherStatus,
    pushGameAnalysisStatus,
    sendTelemetry,
    reportAnalysisIssue,
    resolveAuthToken,
    NotAuthenticatedError,
    ApiError
};
