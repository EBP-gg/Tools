// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const path = require('node:path');
const { app } = require('electron');
const arenaModeService = require('./arena-mode-service');
const arenaPipelineService = require('./arena-pipeline-service');
const { resolveArenaGameId } = require('./tools-api-client');

//#endregion

// Mode salle — IDENTIFICATION. Entre le pipeline (qui découpe) et l'uploader
// (qui envoie), ce service répond à une seule question par fichier : « quelle
// game EVA est-ce ? ». Il interroge EBP, seule source de référence des games,
// et inscrit la réponse DANS LE NOM DU FICHIER :
//
//   {room}_{arena}_{map}_{start}_{end}_{scores}.mp4          6 champs, à identifier
//   {room}_{arena}_{gameId}_{map}_{start}_{end}_{scores}.mp4  7 champs, identifiée
//
// L'état vit donc sur le disque, pas en mémoire : au redémarrage il n'y a rien
// à reconstruire, et un `ls games/` dit à l'œil où chaque game est bloquée. Les
// deux formes sont disjointes (un nom à 7 jetons ne peut pas matcher un motif à
// 6, et inversement) : chaque service ne voit que ce qui le concerne.
//
// Une game qu'EBP n'identifie pas reste découpée dans `games/` et sera
// re-proposée (à chaque tour la première heure, puis toutes les OLD_RETRY_MS)
// — un admin peut donc la récupérer à la main —
// mais pas indéfiniment : passé PENDING_MAX_AGE_S après sa fin, elle est
// supprimée. Sans ça, les games d'intersalle (jamais rattachées à ce terrain)
// s'accumulent sur le disque, et chaque tour les renvoie toutes au resolve, dont
// le quota par arène finirait par bloquer l'identification des games normales.
//
// Comme le poller, il tourne en permanence et vérifie lui-même à chaque tour
// que le mode salle est actif : impossible d'avoir un mode salle activé et une
// identification à l'arrêt.

const TICK_MS = 60 * 1000;
// Au-delà, une game toujours pas identifiée ne le sera plus : EBP ne la connaît
// pas pour ce terrain (intersalle, game jamais remontée).
const PENDING_MAX_AGE_S = 7 * 24 * 60 * 60;
// Une game récente est re-soumise à chaque tour : c'est le cas normal, EBP la
// connaît dans la minute. Au-delà, elle n'est re-soumise que toutes les
// OLD_RETRY_MS — sinon chaque game en souffrance (intersalle surtout) coûte un
// appel par minute, et une trentaine suffit à faire tomber le resolve en 429.
const RECENT_MAX_AGE_S = 60 * 60;
const OLD_RETRY_MS = 30 * 60 * 1000;
// Nom provisoire écrit par le pipeline : 6 champs, pas de gameId.
const PENDING_RE =
    /^(\d+)_(\d+)_([A-Za-z0-9-]+)_(\d+)_(\d+)_([^_]+)\.mp4$/;

let ticking = false;
// Dernière réponse d'EBP par fichier (ms). En mémoire seulement : un redémarrage
// re-soumet tout une fois, sans conséquence. Un fichier non atteint (tour
// interrompu par un échec réseau / 429) n'y entre pas et passe au tour suivant.
const lastAnsweredAt = new Map();

/** Insère le gameId en 3e position : nom provisoire → nom identifié. */
function buildIdentifiedName(pendingName, gameId) {
    const M = pendingName.match(PENDING_RE);
    if (!M) return null;
    const [, ROOM, ARENA, MAP, START, END, SCORES] = M;
    return `${ROOM}_${ARENA}_${gameId}_${MAP}_${START}_${END}_${SCORES}.mp4`;
}

/** Renomme la vidéo : le nom est le seul porteur d'état de la chaîne. */
function renameGame(dir, fromName, toName) {
    fs.renameSync(path.join(dir, fromName), path.join(dir, toName));
}

/**
 * Un tour : chaque game non identifiée de `games/` est soumise à EBP. Traitement
 * séquentiel (quelques fichiers, appels courts) et sans état conservé — le
 * disque porte le résultat.
 */
async function tick() {
    const STATE = arenaModeService.getState();
    const TOKEN = arenaModeService.getArenaToken();
    if (!STATE.registered || !TOKEN) return;

    const DIR = arenaPipelineService.getStatus().gamesFolder;
    let entries;
    try {
        entries = fs.readdirSync(DIR);
    } catch (_) {
        // Dossier pas encore créé (aucune game extraite) : rien à faire.
        return;
    }

    for (const NAME of entries) {
        const M = NAME.match(PENDING_RE);
        if (!M) continue;
        const END_EPOCH = parseInt(M[5], 10);
        const MAP = M[3];

        const AGE_S = Date.now() / 1000 - END_EPOCH;
        if (AGE_S > PENDING_MAX_AGE_S) {
            lastAnsweredAt.delete(NAME);
            try {
                fs.unlinkSync(path.join(DIR, NAME));
                console.log(`[arena-identify] expired, deleted — ${NAME}`);
            } catch (e) {
                console.error('[arena-identify] delete failed:', NAME, e.message);
            }
            continue;
        }

        if (
            AGE_S > RECENT_MAX_AGE_S &&
            Date.now() - (lastAnsweredAt.get(NAME) ?? 0) < OLD_RETRY_MS
        ) {
            continue;
        }

        let res;
        try {
            res = await resolveArenaGameId(
                {
                    roomId: STATE.roomId,
                    arenaId: STATE.arenaId,
                    endEpoch: END_EPOCH,
                    map: MAP
                },
                TOKEN
            );
        } catch (e) {
            // Réseau / serveur : on ne sait rien de cette game, on réessaiera.
            // Inutile d'insister sur les suivantes dans ce tour.
            console.warn('[arena-identify] resolve failed:', e.message);
            return;
        }
        lastAnsweredAt.set(NAME, Date.now());

        if (!res || res.gameId == null) {
            console.log(
                `[arena-identify] not identified yet (${res ? res.reason : 'empty response'}) — ${NAME}`
            );
            continue;
        }

        const IDENTIFIED = buildIdentifiedName(NAME, res.gameId);
        try {
            renameGame(DIR, NAME, IDENTIFIED);
            lastAnsweredAt.delete(NAME);
            console.log(`[arena-identify] ${NAME} → EVA game ${res.gameId}`);
        } catch (e) {
            console.error('[arena-identify] rename failed:', NAME, e.message);
        }
    }
}

/** Un tour à la fois : un tour lent ne doit pas se superposer au suivant. */
async function runTick() {
    if (ticking) return;
    ticking = true;
    try {
        await tick();
    } catch (e) {
        console.error('[arena-identify] tick crashed:', e.message);
    } finally {
        ticking = false;
    }
}

// Comme le poller : démarré par le simple `require`, via whenReady (les sorties
// précoces du main process n'ont ainsi rien à annuler), et jamais arrêté.
app.whenReady().then(() => {
    setInterval(runTick, TICK_MS);
    runTick();
    console.log('[arena-identify] started');
});
