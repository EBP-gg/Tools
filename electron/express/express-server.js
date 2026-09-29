// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const {
    IS_DEV_MODE,
    BROWSER_PATH,
    initializePort
} = require('../config/constants');

//#endregion

/**
 * Jeton tiré au lancement et connu du seul renderer (il le reçoit par IPC).
 * Le serveur n'écoute que sur 127.0.0.1, mais cela n'exclut ni les autres
 * processus locaux ni les autres comptes de la machine : sans ce jeton, tout
 * ce qui peut ouvrir une socket sur le port lirait n'importe quel fichier.
 */
const SERVER_TOKEN = crypto.randomBytes(32).toString('hex');

/**
 * Jetons limités à UN fichier, pour les pages hors renderer (le site, qui lit
 * la vidéo choisie via un deeplink). Le jeton global ne doit pas quitter le
 * renderer : il transiterait par le relais socket de l'API et ouvrirait au
 * site tous les fichiers du compte, settings.json compris. Clé = chemin exact.
 */
const FILE_GRANTS = new Map();

/** Compare deux jetons en temps constant, sans fuir leur longueur. */
function tokensMatch(candidate, expected) {
    if (typeof candidate !== 'string' || typeof expected !== 'string') {
        return false;
    }
    const A = Buffer.from(candidate);
    const B = Buffer.from(expected);
    return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/** Jeton global, ou jeton accordé pour ce chemin précis. */
function isValidToken(candidate, filePath) {
    return (
        tokensMatch(candidate, SERVER_TOKEN) ||
        tokensMatch(candidate, FILE_GRANTS.get(filePath))
    );
}

/**
 * Autorise la lecture de ce seul fichier via /file, jusqu'à la fermeture de
 * Tools (le lecteur vidéo refait des requêtes Range tant qu'il est ouvert).
 * À réserver aux fichiers choisis par l'utilisateur dans le sélecteur natif.
 * @param {string} filePath Chemin absolu du fichier.
 * @returns {string} Le jeton à passer en `token` avec ce `path`.
 */
function grantFileAccess(filePath) {
    let token = FILE_GRANTS.get(filePath);
    if (!token) {
        token = crypto.randomBytes(32).toString('hex');
        FILE_GRANTS.set(filePath, token);
    }
    return token;
}

/**
 * Sets up and configures the Express server for serving the Angular frontend.
 * @returns {Promise<number>} The port number the server is listening on.
 */
async function setupExpressServer() {
    const PORT = await initializePort();

    return new Promise((resolve) => {
        const APP = express();

        // Configure Express environment
        if (IS_DEV_MODE) {
            APP.set('env', 'development');
        } else {
            APP.use(express.static(BROWSER_PATH));
        }

        // File serving endpoint - allows frontend to access local files
        APP.get('/file', (req, res) => {
            // Un nom d'hôte tiers résolu vers 127.0.0.1 (DNS rebinding) permet à
            // une page web d'atteindre ce port : n'accepter que les hôtes locaux.
            const HOST = (req.headers.host ?? '').split(':')[0];
            if (HOST !== 'localhost' && HOST !== '127.0.0.1') {
                return res.status(403).send('Forbidden');
            }
            const FILE_PATH = req.query.path;
            if (!FILE_PATH || typeof FILE_PATH !== 'string') {
                return res.status(400).send('Missing path');
            }
            if (!isValidToken(req.query.token, FILE_PATH)) {
                return res.status(403).send('Forbidden');
            }
            res.sendFile(FILE_PATH);
        });

        // Catch-all route handler
        APP.use((req, res, next) => {
            // In development, redirect to Angular dev server
            if (process.env.NODE_ENV !== 'production') {
                return res.redirect('http://localhost:4201');
            }

            // In production, serve the Angular index.html
            const INDEX_FILE = path.join(BROWSER_PATH, 'index.html');
            res.sendFile(INDEX_FILE, (err) => {
                if (err) {
                    console.error('[EXPRESS] Error serving index.html:', err);
                    res.status(500).send('Server error');
                }
            });
        });

        // Start the server
        APP.listen(PORT, '127.0.0.1', () => {
            console.log(`[EXPRESS] Listening on http://localhost:${PORT}.`);
            resolve(PORT);
        });
    });
}

module.exports = {
    setupExpressServer,
    SERVER_TOKEN,
    grantFileAccess
};
