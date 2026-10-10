// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const path = require('node:path');
const {
    startArenaMultipartUpload,
    requestArenaPartUrls,
    completeArenaMultipartUpload,
    uploadFileToPresignedUrl,
    ApiError
} = require('./tools-api-client');

//#endregion

// Mode salle — envoi d'un replay PAR MORCEAUX (multipart S3, routes
// /arena/uploads/* du serveur). En un seul PUT, chaque coupure de plus de 60 s
// faisait repartir de zéro un fichier de plusieurs centaines de Mo : Rouen,
// 2026-10-10, 12 min 40 pour un envoi de 4 min. Ici, seul le morceau en cours est
// perdu.
//
// L'avancement (identifiant d'envoi, ETag de chaque morceau passé) est écrit sur
// le disque après chaque morceau, dans un fichier JSON à côté de games/ : un
// redémarrage de Tools ou du PC reprend l'envoi là où il s'était arrêté. Un
// fichier vidéo modifié entre-temps (taille ou date) invalide cet état.
//
// Le serveur abandonne un envoi ouvert depuis plus de 24 h : le morceau suivant
// répond alors 404, ou la finalisation 409. L'état est effacé et l'erreur levée
// est une erreur ordinaire : la boucle de l'uploader recommence l'envoi entier.

// Morceaux présignés par appel (plafond du serveur : 100).
const URL_BATCH = 100;
// Durée d'usage d'un lot d'URLs, comptée sur l'horloge locale : le serveur les
// signe pour 30 min, la marge couvre l'envoi d'un morceau commencé juste avant.
const URL_MAX_AGE_MS = 20 * 60 * 1000;

function getStateFile(stateDir, filePath) {
    return path.join(stateDir, `${path.basename(filePath)}.json`);
}

/** État d'un envoi en cours pour CE fichier, ou null (absent, illisible, fichier changé). */
function readState(stateFile, stat) {
    try {
        const STATE = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (
            STATE &&
            typeof STATE.uploadId === 'string' &&
            STATE.size === stat.size &&
            STATE.mtimeMs === stat.mtimeMs &&
            STATE.partSize > 0 &&
            STATE.partCount > 0 &&
            STATE.etags &&
            typeof STATE.etags === 'object'
        ) {
            return STATE;
        }
    } catch (_) {
        // Absent ou illisible : l'envoi repart de zéro.
    }
    return null;
}

/** Écriture atomique : un arrêt brutal ne laisse jamais un JSON tronqué. */
function writeState(stateFile, state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const TMP = `${stateFile}.tmp`;
    fs.writeFileSync(TMP, JSON.stringify(state));
    fs.renameSync(TMP, stateFile);
}

/** Oublie l'envoi en cours d'un fichier (envoyé, abandonné ou perdu). */
function clearUploadState(stateDir, filePath) {
    try {
        fs.unlinkSync(getStateFile(stateDir, filePath));
    } catch (_) {
        // Déjà absent.
    }
}

/**
 * Supprime les états dont la vidéo n'est plus dans games/ (envoyée, déplacée
 * dans failed/, purgée) : rien ne les relirait plus.
 */
function purgeUploadStates(stateDir, gamesDir) {
    let entries;
    try {
        entries = fs.readdirSync(stateDir);
    } catch (_) {
        return;
    }
    for (const NAME of entries) {
        const VIDEO = NAME.replace(/\.json(\.tmp)?$/, '');
        if (fs.existsSync(path.join(gamesDir, VIDEO))) continue;
        try {
            fs.unlinkSync(path.join(stateDir, NAME));
        } catch (_) {
            // Le passage suivant réessaiera.
        }
    }
}

/**
 * Envoie un replay par morceaux, en reprenant un envoi déjà entamé.
 *
 * @param {string} filePath vidéo dans games/
 * @param {{gameId:string}|{gameType:string, startedAtEpoch:number}} target gameId EVA (After-H) ou jeu + début
 * @param {{roomId:number, arenaId:number}} ids
 * @param {string} token clé de salle
 * @param {{stateDir:string, shouldStop:() => boolean, onProgress?:() => void}} options
 *   `onProgress` est appelé à chaque morceau envoyé.
 * @returns {Promise<{partCount:number, resumedFrom:number}>}
 */
async function uploadArenaReplayMultipart(filePath, target, ids, token, options) {
    const { stateDir, shouldStop, onProgress } = options;
    const STAT = fs.statSync(filePath);
    const STATE_FILE = getStateFile(stateDir, filePath);
    const BASE = { ...ids, ...target };

    let state = readState(STATE_FILE, STAT);
    if (!state) {
        const STARTED = await startArenaMultipartUpload({ ...BASE, size: STAT.size }, token);
        state = {
            uploadId: STARTED.uploadId,
            size: STAT.size,
            mtimeMs: STAT.mtimeMs,
            partSize: STARTED.partSize,
            partCount: STARTED.partCount,
            etags: {}
        };
        writeState(STATE_FILE, state);
    }
    const RESUMED_FROM = Object.keys(state.etags).length;
    if (RESUMED_FROM > 0) {
        console.log(
            `[arena-uploader] reprise de l'envoi : ${RESUMED_FROM}/${state.partCount} morceaux déjà passés`
        );
    }

    let urls = new Map();
    let urlsFetchedAt = 0;
    for (let n = 1; n <= state.partCount; n++) {
        if (state.etags[n]) continue;
        if (shouldStop()) throw new Error('uploader stopped');

        if (!urls.has(n) || Date.now() - urlsFetchedAt > URL_MAX_AGE_MS) {
            const MISSING = [];
            for (let m = n; m <= state.partCount && MISSING.length < URL_BATCH; m++) {
                if (!state.etags[m]) MISSING.push(m);
            }
            const RES = await requestArenaPartUrls(
                { ...BASE, uploadId: state.uploadId, partNumbers: MISSING },
                token
            );
            urls = new Map(RES.urls.map((u) => [u.partNumber, u.url]));
            urlsFetchedAt = Date.now();
        }

        const START = (n - 1) * state.partSize;
        let result;
        try {
            result = await uploadFileToPresignedUrl(urls.get(n), filePath, {
                start: START,
                length: Math.min(state.partSize, state.size - START)
            });
        } catch (e) {
            // 404 = l'envoi n'existe plus côté stockage (abandonné par le serveur).
            if (e instanceof ApiError && e.status === 404) {
                clearUploadState(stateDir, filePath);
                throw new Error('multipart upload lost, restarting');
            }
            // 403 = URL refusée (expirée) : à redemander, pas un refus de la game.
            if (e instanceof ApiError && e.status === 403) {
                throw new Error('part URL refused (403)');
            }
            throw e;
        }
        if (!result.etag) throw new Error(`part ${n} uploaded without ETag`);
        state.etags[n] = result.etag;
        writeState(STATE_FILE, state);
        if (onProgress) onProgress();
    }

    try {
        await completeArenaMultipartUpload(
            {
                ...BASE,
                uploadId: state.uploadId,
                parts: Object.entries(state.etags).map(([n, etag]) => ({
                    partNumber: Number(n),
                    etag
                }))
            },
            token
        );
    } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
            clearUploadState(stateDir, filePath);
            throw new Error('multipart upload lost at completion, restarting');
        }
        throw e;
    }
    clearUploadState(stateDir, filePath);
    return { partCount: state.partCount, resumedFrom: RESUMED_FROM };
}

module.exports = { uploadArenaReplayMultipart, clearUploadState, purgeUploadStates };
