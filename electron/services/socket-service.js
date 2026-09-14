// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const { io } = require('socket.io-client');

//#endregion

const IS_DEV_MODE = process.env.NODE_ENV !== 'production';
// Même bascule que le client REST : `EBP_TARGET=prod` vise la prod sans quitter
// le mode dev (cf. tools-api-client). Les deux doivent viser le MÊME serveur,
// sinon un appel REST déclenche un broadcast socket que ce front n'écoute pas.
const USE_PROD = !IS_DEV_MODE || process.env.EBP_TARGET === 'prod';

const SOCKET = io(
    USE_PROD ? 'https://evabattleplan.com/' : 'http://localhost:3005',
    {
        reconnection: true,
        transports: ['websocket']
    }
);

SOCKET.on('connect', () => {
    console.log('[SOCKET] Connected:', SOCKET.id);
});

SOCKET.on('connect_error', (err) => {
    console.error('[SOCKET] Connection error:', err.message);
});

// Mode salle : canal temps réel du PC de salle, sur le namespace `/arena` du
// MÊME serveur. socket.io-client multiplexe les namespaces sur la connexion
// existante — pas de second lien réseau, juste un handshake supplémentaire,
// authentifié par la clé de salle et non par la session utilisateur.
//
// Ce canal n'est qu'un ACCÉLÉRATEUR : un ordre émis pendant une coupure est
// perdu sans erreur, et c'est le heartbeat qui le rattrape. Rien ici ne doit
// donc porter d'état.
const ARENA_URL = (USE_PROD ? 'https://evabattleplan.com' : 'http://localhost:3005') + '/arena';

let arenaSocket = null;

/**
 * Ouvre (ou rouvre) le canal de salle. Idempotent : rappelé au register comme
 * au boot, il ferme la connexion précédente pour ne jamais en laisser deux.
 * @param {{roomId:number, arenaId:number, token:string}} state
 * @param {{onFetch: (order: {id:string, folder:string, name:string}) => void,
 *          onList: (folder: string) => string[],
 *          onDelete: (folder: string, name: string) => {deleted:boolean, reason?:string},
 *          onFrame: () => {image: string|null, reason?: string},
 *          onUpdate: () => void}} handlers
 */
function connectArena(state, handlers) {
    disconnectArena();
    arenaSocket = io(ARENA_URL, {
        reconnection: true,
        transports: ['websocket'],
        auth: {
            roomId: state.roomId,
            arenaId: state.arenaId,
            key: state.token
        }
    });
    arenaSocket.on('connect', () =>
        console.log('[SOCKET] arena namespace connected')
    );
    // Clé révoquée, IP changée, arène inconnue : la reconnexion automatique
    // continue de réessayer, ce qui est le bon comportement — une clé
    // régénérée côté admin doit reprendre sans redémarrer Tools.
    arenaSocket.on('connect_error', (err) =>
        console.warn('[SOCKET] arena namespace refused:', err.message)
    );
    arenaSocket.on('arena_fetch', (order) => {
        if (order && order.id && order.folder && order.name) {
            handlers.onFetch(order);
        }
    });
    // Listing à la demande : l'admin veut le contenu RÉEL du dossier, pas
    // l'instantané du dernier battement. On répond par l'acquittement — le
    // serveur abandonne au bout de 2 s et sert l'instantané, donc ne jamais
    // laisser cette réponse dépendre d'une E/S lente.
    arenaSocket.on('arena_list', (data, ack) => {
        if (typeof ack !== 'function') return;
        ack({ files: handlers.onList((data && data.folder) || '') });
    });
    // Suppression demandée par un admin. Synchrone et acquittée : l'admin reçoit
    // un verdict franc — supprimé, introuvable, ou refusé — plutôt qu'un accusé
    // de réception qui ne garantit rien.
    // Mise à jour ordonnée par un admin. Pas d'acquittement : Tools arrête la
    // captation et relance l'installeur, il ne sera plus là pour répondre.
    arenaSocket.on('arena_update', () => handlers.onUpdate());
    // Image de ce qui est filmé en ce moment : lue dans le fichier d'aperçu que
    // ffmpeg réécrit en continu, donc sans toucher au périphérique (que la
    // captation tient en exclusivité).
    arenaSocket.on('arena_frame', (data, ack) => {
        if (typeof ack !== 'function') return;
        ack(handlers.onFrame());
    });
    arenaSocket.on('arena_delete', (data, ack) => {
        if (typeof ack !== 'function') return;
        ack(
            handlers.onDelete(
                (data && data.folder) || '',
                (data && data.name) || ''
            )
        );
    });
}

function disconnectArena() {
    if (arenaSocket) {
        arenaSocket.disconnect();
        arenaSocket = null;
    }
}

function emit(sessionID, path, value) {
    if (sessionID) {
        SOCKET.emit('tools_to_client', {
            sessionID: sessionID,
            path: path,
            value: value
        });
    }
}

// L'export par défaut reste la fonction `emit` : une quinzaine d'appels s'en
// servent tel quel dans server.js, le canal de salle s'y attache plutôt que de
// les faire tous réécrire.
module.exports = emit;
module.exports.connectArena = connectArena;
module.exports.disconnectArena = disconnectArena;
