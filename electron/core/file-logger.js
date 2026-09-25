// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

/**
 * Copie de la console du main process dans un fichier par jour, sur disque.
 *
 * Sans elle, les logs ne vivaient que dans la console de l'interface (500
 * lignes en mémoire) : une game perdue en salle ne laissait AUCUNE trace, et
 * l'on ne pouvait plus dire après coup si elle avait été enregistrée ou non.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('node:path');
const util = require('util');

const RETENTION_DAYS = 7;
// Garde-fou disque : une boucle d'erreurs ne doit pas remplir le PC de salle.
const MAX_BYTES_PER_DAY = 50 * 1024 * 1024;
const LEVELS = ['log', 'error', 'warn', 'info', 'debug'];

let logDir = null;
let currentDay = null;
let stream = null;
let bytesToday = 0;

function localDay(date) {
    const PAD = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${PAD(date.getMonth() + 1)}-${PAD(date.getDate())}`;
}

/** Supprime les fichiers de log plus vieux que la rétention. */
function purgeOldLogs() {
    const LIMIT = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
    for (const NAME of fs.readdirSync(logDir)) {
        if (!/^tools-\d{4}-\d{2}-\d{2}\.log$/.test(NAME)) continue;
        const FILE = path.join(logDir, NAME);
        if (fs.statSync(FILE).mtimeMs < LIMIT) fs.unlinkSync(FILE);
    }
}

/** Ouvre le fichier du jour, en changeant de fichier à minuit. */
function getStream(now) {
    const DAY = localDay(now);
    if (DAY !== currentDay) {
        if (stream) stream.end();
        currentDay = DAY;
        const FILE = path.join(logDir, `tools-${DAY}.log`);
        bytesToday = fs.existsSync(FILE) ? fs.statSync(FILE).size : 0;
        stream = fs.createWriteStream(FILE, { flags: 'a' });
        stream.on('error', () => {});
        purgeOldLogs();
    }
    return stream;
}

function write(level, args) {
    try {
        const NOW = new Date();
        const OUT = getStream(NOW);
        if (bytesToday > MAX_BYTES_PER_DAY) return;
        // Les vignettes d'écran (data:image en base64) pèsent des centaines de Ko.
        const MESSAGE = util
            .format(...args)
            .replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, 'data:image/...');
        // Heure locale, comme les noms des fichiers et des segments rec_*.mkv.
        const LINE = `${NOW.toLocaleString('sv-SE')} [${level}] ${MESSAGE}\n`;
        bytesToday += Buffer.byteLength(LINE);
        OUT.write(LINE);
    } catch (_) {
        // Un log ne doit jamais faire tomber l'application.
    }
}

/**
 * À appeler le plus tôt possible au démarrage : ce qui est loggé avant n'est
 * pas écrit sur disque.
 */
function install() {
    try {
        logDir = getLogDir();
        fs.mkdirSync(logDir, { recursive: true });
    } catch (_) {
        return;
    }
    for (const LEVEL of LEVELS) {
        const ORIGINAL = console[LEVEL];
        console[LEVEL] = (...args) => {
            ORIGINAL(...args);
            write(LEVEL, args);
        };
    }
    console.log(`[file-logger] logs écrits dans ${logDir}`);
}

/** Dossier des logs, pour que l'interface puisse l'ouvrir. */
function getLogDir() {
    return path.join(app.getPath('userData'), 'logs');
}

module.exports = { install, getLogDir };
