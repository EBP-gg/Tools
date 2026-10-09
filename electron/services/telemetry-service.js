// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const crypto = require('crypto');
const os = require('os');
const { app } = require('electron');
const StorageManager = require('../core/storage-manager');
const { IS_DEV_MODE } = require('../config/constants');
const { sendTelemetry } = require('./tools-api-client');
const { version: TOOLS_VERSION } = require('../../package.json');

//#endregion

/**
 * Télémétrie technique minimale : quelle version tourne, et les mises à jour
 * aboutissent-elles. Sans elle, une version publiée avec un updater défaillant
 * bloquerait des postes sans que rien ne le signale — et il n'existe aucun
 * correctif à distance pour ce cas.
 *
 * Rien de personnel n'est envoyé : un identifiant d'installation tiré au sort,
 * la version de Tools, la plateforme, l'architecture et la version de l'OS.
 * Désactivable depuis le menu du tray (Settings), auquel cas plus rien ne part.
 */
const ENABLED_KEY = 'telemetryEnabled';
const INSTALL_ID_KEY = 'telemetryInstallId';
// Dernier échec de mise à jour, remonté par le battement de salle. Persistant :
// l'événement de télémétrie peut se perdre (réseau, limite de débit), le
// battement le représente tant que la mise à jour n'a pas abouti.
const UPDATE_HEALTH_KEY = 'updateHealth';

/**
 * Version du système, pas seulement sa famille : distinguer Windows 10 de
 * Windows 11, ou une version de macOS d'une autre, est ce qui permet de relier
 * un échec de mise à jour à un environnement précis.
 *
 * `process.getSystemVersion` est fourni par Electron et donne la version réelle
 * du système (« 10.0.22631 », « 15.5 ») ; hors Electron on retombe sur la
 * version du noyau, seule disponible.
 * @returns {string} OS version.
 */
function getOsVersion() {
    return typeof process.getSystemVersion === 'function'
        ? process.getSystemVersion()
        : os.release();
}

//#region Functions

/**
 * Is telemetry enabled? Activée par défaut, coupée dès que l'utilisateur a
 * explicitement décoché le réglage.
 * @returns {boolean} True if events may be sent.
 */
function isEnabled() {
    return StorageManager.getPermanentSettingsValue(ENABLED_KEY, true) !== false;
}

/**
 * Enables or disables telemetry.
 * @param {boolean} enabled Desired state.
 */
function setEnabled(enabled) {
    StorageManager.setPermanentSettingsValue(ENABLED_KEY, enabled === true);
    console.log(`[telemetry] ${enabled === true ? 'enabled' : 'disabled'}`);
}

/**
 * Identifiant d'installation, tiré au sort au premier envoi et conservé
 * ensuite. Il ne permet que de distinguer deux postes : sans lui, une même
 * version signalée mille fois serait indiscernable de mille postes.
 * @returns {string} Random installation identifier.
 */
function getInstallId() {
    let id = StorageManager.getPermanentSettingsValue(INSTALL_ID_KEY);

    if (!id) {
        id = crypto.randomUUID();
        StorageManager.setPermanentSettingsValue(INSTALL_ID_KEY, id);
    }

    return id;
}

/**
 * Sends one event. Tirer-et-oublier : ne bloque jamais l'appelant et n'échoue
 * jamais vers lui — la télémétrie ne doit pouvoir casser aucun autre flux.
 * @param {string} event Event name.
 * @param {object} [detail] Optional details (reason of a failure, versions...).
 */
function send(event, detail) {
    if (!isEnabled()) {
        return;
    }

    // Une build de développement n'a pas à peser sur les statistiques du parc.
    // Le défaut n'est pas théorique : des bancs d'essai simulant un échec de
    // mise à jour ont remonté de vrais événements en production, chacun avec un
    // identifiant neuf, et ont faussé la répartition des versions — une dizaine
    // d'installations fantômes pour deux postes réels. `npm start` produisait le
    // même effet, en plus discret.
    //
    // Même garde que `autoUpdate`, et pour la même raison : ce qui tourne hors
    // d'une installation ne doit rien émettre vers la production.
    if (IS_DEV_MODE) {
        return;
    }

    sendTelemetry({
        installId: getInstallId(),
        version: TOOLS_VERSION,
        platform: os.platform(),
        arch: process.arch,
        osVersion: getOsVersion(),
        // `process.arch` est l'architecture de la BUILD, pas de la machine :
        // sans ce drapeau, une build x64 installée par erreur sur un Mac Apple
        // Silicon est indiscernable d'un vrai Intel.
        translated: app.runningUnderARM64Translation === true,
        event,
        ...(detail ? { detail } : {})
    });
}

/**
 * Reports that the app has started. Ce seul événement remplace un battement
 * périodique : un poste bloqué sur une vieille version la signale à chaque
 * lancement, sans rien faire tourner en continu.
 */
function reportLaunch() {
    send('launch');
}

/**
 * Reports a step of the update flow.
 * @param {'update_available'|'update_started'|'update_failed'} event Step.
 * @param {object} [detail] Target version, failure reason...
 */
function reportUpdate(event, detail) {
    // Noté même télémétrie coupée : il ne part que par le battement de salle,
    // canal authentifié que l'utilisateur ne peut pas désactiver.
    if (event === 'update_failed') recordUpdateFailure(detail);
    send(event, detail);
}

/**
 * Mémorise un échec de mise à jour, en comptant les échecs successifs depuis
 * la version courante.
 * @param {{target?: string, reason?: string}} [detail]
 */
function recordUpdateFailure(detail) {
    const PREVIOUS = getUpdateHealth();
    StorageManager.setPermanentSettingsValue(UPDATE_HEALTH_KEY, {
        from: TOOLS_VERSION,
        target: (detail && detail.target) || null,
        reason: (detail && detail.reason) || null,
        at: Date.now(),
        failures: (PREVIOUS ? PREVIOUS.failures : 0) + 1
    });
}

/**
 * Dernier échec de mise à jour, ou null. Un échec noté sous une autre version
 * est oublié : la version a changé depuis, la mise à jour a donc fini par
 * passer.
 * @returns {{from: string, target: string|null, reason: string|null,
 *   at: number, failures: number}|null}
 */
function getUpdateHealth() {
    const HEALTH = StorageManager.getPermanentSettingsValue(UPDATE_HEALTH_KEY);
    if (!HEALTH) return null;
    if (HEALTH.from !== TOOLS_VERSION) {
        StorageManager.setPermanentSettingsValue(UPDATE_HEALTH_KEY, null);
        return null;
    }
    return HEALTH;
}

//#endregion

module.exports = {
    isEnabled,
    setEnabled,
    reportLaunch,
    reportUpdate,
    getUpdateHealth
};
