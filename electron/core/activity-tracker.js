// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const childProcess = require('child_process');
const util = require('util');

/**
 * Suivi de l'occupation de l'application, pour ne jamais appliquer une mise à
 * jour au milieu d'un travail.
 *
 * L'occupation est DÉDUITE des processus enfants plutôt que déclarée à chaque
 * endroit : analyses, découpes, réencodages et téléchargements passent tous par
 * ffmpeg, l'analyzer ou yt-dlp, et ils sont lancés depuis une vingtaine
 * d'appels répartis dans `server.js`, `video-service` et les services d'arène.
 * Une déclaration oubliée à l'un d'eux ne se verrait jamais à la relecture —
 * elle couperait silencieusement l'analyse d'un utilisateur, une heure de
 * travail perdue sans le moindre message. Détourner `spawn` et `execFile` une
 * seule fois couvre les vingt appels d'aujourd'hui et ceux qu'on écrira demain.
 *
 * `markBusy` complète le dispositif pour le travail qui ne lance aucun
 * processus : les uploads d'un replay survivent au dernier ffmpeg, et eux aussi
 * doivent retenir le redémarrage.
 */

let busyCount = 0;
// Instant où le compteur est retombé à zéro ; `null` tant qu'un travail tourne.
let idleSince = Date.now();
let installed = false;

function acquire() {
    busyCount += 1;
    idleSince = null;
}

function release() {
    if (busyCount === 0) return;
    busyCount -= 1;
    if (busyCount === 0) {
        idleSince = Date.now();
    }
}

/**
 * Rend une fonction de libération qui ne compte qu'une fois, quel que soit le
 * nombre d'appels. Sans ce garde le compteur dériverait vers le négatif et
 * l'application se croirait libre alors qu'un travail continue.
 */
function releaseOnce() {
    let released = false;
    return () => {
        if (released) return;
        released = true;
        release();
    };
}

/** Rattache le compteur au cycle de vie d'un processus enfant. */
function track(child) {
    if (!child || typeof child.once !== 'function') {
        return child;
    }

    acquire();

    // `error` (binaire introuvable) et `exit` peuvent survenir tous les deux
    // pour un même processus, d'où la libération à usage unique.
    const RELEASE = releaseOnce();
    child.once('exit', RELEASE);
    child.once('error', RELEASE);

    return child;
}

/**
 * Détourne `spawn` et `execFile`.
 *
 * À appeler AVANT tout autre `require` de l'application : les modules capturent
 * ces fonctions au chargement (`const { spawn } = require('child_process')`),
 * et ceux chargés avant garderaient l'original — leurs processus seraient
 * invisibles au compteur.
 */
function install() {
    if (installed) return;
    installed = true;

    const SPAWN = childProcess.spawn;
    const EXEC_FILE = childProcess.execFile;

    childProcess.spawn = (...args) => track(SPAWN(...args));
    childProcess.execFile = (...args) => track(EXEC_FILE(...args));

    // `util.promisify(execFile)` résout `{ stdout, stderr }` grâce à cette
    // version dédiée ; sans elle, il ne résoudrait que `stdout`.
    const EXEC_FILE_ASYNC = EXEC_FILE[util.promisify.custom];
    childProcess.execFile[util.promisify.custom] = (...args) => {
        const PROMISE = EXEC_FILE_ASYNC(...args);
        track(PROMISE.child);
        return PROMISE;
    };
}

/**
 * Marque un travail qui ne lance aucun processus enfant (uploads, appels API).
 * @returns {Function} La libération, sans effet si elle est appelée deux fois.
 */
function markBusy() {
    acquire();
    return releaseOnce();
}

/**
 * Millisecondes écoulées depuis la fin du dernier travail ; 0 tant qu'un
 * travail tourne.
 */
function idleMs() {
    return idleSince === null ? 0 : Date.now() - idleSince;
}

/** Un travail est-il en cours à cet instant ? */
function isBusy() {
    return busyCount > 0;
}

/**
 * Repousse le compteur d'inactivité, pour une activité qui n'a pas de durée
 * (une fenêtre ouverte à l'écran, par exemple).
 */
function ping() {
    if (busyCount === 0) {
        idleSince = Date.now();
    }
}

module.exports = {
    install,
    markBusy,
    idleMs,
    isBusy,
    ping
};
