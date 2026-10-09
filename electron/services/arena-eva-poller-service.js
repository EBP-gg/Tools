// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const https = require('https');
const { app } = require('electron');
const arenaModeService = require('./arena-mode-service');
const { ingestArenaGames } = require('./tools-api-client');

//#endregion

// Mode salle — POLLER EVA. Tâche de fond démarrée au boot et qui tourne
// TOUJOURS : à chaque tour elle vérifie que le mode salle est actif et ne fait
// rien sinon. Aucun cycle start/stop à tenir en phase avec register /
// unregister — impossible d'avoir un mode salle activé et un poller à l'arrêt.
// Quand le mode est actif : interroge l'API GraphQL publique d'EVA (api.eva.gg,
// PAS d'auth) pour récupérer les 10 dernières parties finies sur notre arène, et
// les POUSSE telles quelles au serveur EvaBattlePlan (`/arena/games/ingest`).
// C'est tout ce que fait ce service.
//
// EvaBattlePlan est la SOURCE DE RÉFÉRENCE des games. Ce push le rend simplement
// réactif (les games de la salle sont connues dans les 90 s).
// Aucun état de matching ne vit ici : pas de pile locale, pas de
// gameId consommé — c'est au serveur qu'on demandera l'identité d'une game.
//
// L'endpoint EVA est public : on recopie les headers `eva-client-app-name:
// spa-tv` / origin / referer de la TV EVA pour passer pour un client légitime.

const EVA_HOST = 'api.eva.gg';
const EVA_PATH = '/graphql';
// Cadence calée sur celle de la TV EVA (90 s) : jamais plus agressif.
const POLL_INTERVAL_MS = 90 * 1000;
const POLL_BACKOFF_MAX_MS = 15 * 60 * 1000;
const FETCH_LIMIT = 10;

// Requête COMPLÈTE : elle doit rester IDENTIQUE à celle utilisée côté serveur,
// car ce sont ces nœuds bruts que le serveur normalise. Ne pas retirer `rank`
// (stats joueur) ni la branche `colorChaos` : le serveur en a besoin.
// ⚠️ Attention aux espaces en fin de fragment : deux champs collés ("winnerTeamColor" +
// "teams") font rejeter la requête ENTIÈRE par EVA, games After-H comprises.
const GQL_QUERY =
    'query($terrainIds:[Int!],$limit:Int){' +
    'listLastGamesAtLocation(terrainIds:$terrainIds,limit:$limit){' +
    'gameId gameType endedAt terrainId battleArena{' +
    'data{duration teamOne{name score}teamTwo{name score}}' +
    'players{id userId data{niceName team rank outcome score kills deaths assists inflictedDamage firedAccuracy}}' +
    'map{id name identifier maxPlayerCount}mode{id identifier category}' +
    'terrain{id location{id name department identifier country language}}}' +
    'colorChaos{gameId terrainId locationId map durationSeconds endedAt winnerTeamColor ' +
    'teams{color score totalPaintedSurface players{rank userId name score paintedSurface ' +
    'heals frags breaks isMvpHeals isMvpFrags isMvpPaintedSurface}}}}}';

// Seul état du service : la cadence courante (allongée par le backoff).
let pollDelayMs = POLL_INTERVAL_MS;

/**
 * POST GraphQL à api.eva.gg. Résout avec le tableau `listLastGamesAtLocation`
 * (nœuds BRUTS, non normalisés), rejette sur erreur réseau / HTTP non-2xx /
 * GraphQL errors.
 */
function fetchGames(terrainId) {
    const BODY = JSON.stringify({
        operationName: null,
        variables: { terrainIds: [terrainId], limit: FETCH_LIMIT },
        query: GQL_QUERY
    });
    const OPTIONS = {
        hostname: EVA_HOST,
        port: 443,
        path: EVA_PATH,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(BODY),
            Accept: '*/*',
            'eva-client-app-name': 'spa-tv',
            Origin: 'https://tv.eva.gg',
            Referer: 'https://tv.eva.gg/'
        }
    };
    return new Promise((resolve, reject) => {
        const REQ = https.request(OPTIONS, (res) => {
            const CHUNKS = [];
            res.on('data', (c) => CHUNKS.push(c));
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`EVA HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    const JSON_RES = JSON.parse(Buffer.concat(CHUNKS).toString('utf8'));
                    if (JSON_RES.errors) {
                        reject(new Error('EVA GraphQL error'));
                        return;
                    }
                    resolve(JSON_RES.data?.listLastGamesAtLocation || []);
                } catch (e) {
                    reject(e);
                }
            });
        });
        REQ.on('error', reject);
        REQ.write(BODY);
        REQ.end();
    });
}

/**
 * Un tour : lecture des 10 dernières games de l'arène et push au serveur, tel
 * quel. Aucun filtrage ici — ni doublon, ni tri des nœuds (colorChaos, arène
 * étrangère) : c'est au serveur de trancher (opération idempotente).
 *
 * Un échec du PUSH ne fait pas reculer la cadence EVA : le tour suivant (90 s)
 * réessaie. Un échec du FETCH remonte au planificateur, qui applique le backoff.
 */
async function pollOnce() {
    const STATE = arenaModeService.getState();
    if (!STATE.registered || STATE.arenaId == null) return;
    const GAMES = await fetchGames(STATE.arenaId);

    const TOKEN = arenaModeService.getArenaToken();
    if (!TOKEN || GAMES.length === 0) return;

    try {
        await ingestArenaGames(
            { roomId: STATE.roomId, arenaId: STATE.arenaId, games: GAMES },
            TOKEN
        );
    } catch (e) {
        console.warn('[arena-eva-poller] ingest push failed:', e.message);
        return;
    }
    console.log(`[arena-eva-poller] pushed ${GAMES.length} game(s) to EBP`);
}

function scheduleNext(delayMs) {
    setTimeout(async () => {
        try {
            await pollOnce();
            pollDelayMs = POLL_INTERVAL_MS;
        } catch (e) {
            console.warn('[arena-eva-poller] poll failed:', e.message);
            // Backoff progressif si l'API répond mal / nous bloque.
            pollDelayMs = Math.min(pollDelayMs * 2, POLL_BACKOFF_MAX_MS);
        }
        scheduleNext(pollDelayMs);
    }, delayMs);
}

// Le service se démarre LUI-MÊME : il suffit de le `require` (aucun export,
// aucun appel à placer — donc rien à oublier). La boucle vit ensuite aussi
// longtemps que le process, il n'y a rien à arrêter : chaque tour vérifie
// lui-même que le mode salle est actif (`pollOnce`) et ne fait rien sinon.
// Accroché à `whenReady` et pas au chargement du module : les sorties précoces
// du main process (installation Squirrel, seconde instance) appellent `app.quit()`
// sans interrompre les `require` — whenReady, lui, ne se résoudra jamais sur ces
// instances, donc elles ne pollent pas.
app.whenReady().then(() => {
    // Premier tour immédiat, puis cadence.
    scheduleNext(0);
    console.log('[arena-eva-poller] started');
});
