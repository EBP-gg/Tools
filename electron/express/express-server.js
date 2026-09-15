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

/** Compare deux jetons en temps constant, sans fuir leur longueur. */
function isValidToken(candidate) {
    if (typeof candidate !== 'string') {
        return false;
    }
    const A = Buffer.from(candidate);
    const B = Buffer.from(SERVER_TOKEN);
    return A.length === B.length && crypto.timingSafeEqual(A, B);
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
            if (!isValidToken(req.query.token)) {
                return res.status(403).send('Forbidden');
            }
            const FILE_PATH = req.query.path;
            if (!FILE_PATH || typeof FILE_PATH !== 'string') {
                return res.status(400).send('Missing path');
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
    SERVER_TOKEN
};
