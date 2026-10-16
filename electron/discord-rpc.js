// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const rpc = require('discord-rpc');
const { t } = require('./services/translate.service');
const arenaModeService = require('./services/arena-mode-service');

//#endregion

const CLIENT_ID = '1383002798882291722';
const RETRY_DELAY_MS = 15000;

let retryTimer = null;
let client = null;
let ready = false;
let stopped = false;

/**
 * Schedules a new connection attempt (Discord not launched yet, or restarted).
 */
function scheduleRetry() {
    if (retryTimer || stopped) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
    }, RETRY_DELAY_MS);
}

/**
 * Cuts the Discord link while this machine is an arena (salle) PC and stops
 * the reconnection loop. Discord clears the presence once the IPC closes.
 */
function disconnect() {
    clearTimeout(retryTimer);
    retryTimer = null;
    ready = false;
    if (!client) return;
    client.destroy().catch(() => {});
    client = null;
}

/**
 * Displays the presence in the user's current language. On an arena (salle)
 * PC, no presence at all: Tools disconnects from Discord.
 */
function setActivity() {
    if (arenaModeService.getState().registered) {
        disconnect();
        return;
    }
    if (!client) {
        connect();
        return;
    }
    if (!ready) return;
    client.setActivity({
        details: t('discordRpc.details'),
        state: 'https://ebp.gg',
        largeImageKey: 'logo',
        largeImageText: 'EBP',
        smallImageText: 'EBP',
        instance: false
    }).catch(() => {});
}

/**
 * Connects to the local Discord client. A new Client is created on each attempt
 * because discord-rpc caches its connection promise and cannot reconnect.
 */
function connect() {
    if (stopped || arenaModeService.getState().registered) return;
    const RPC = client = new rpc.Client({ transport: 'ipc' });

    RPC.on('ready', () => {
        if (RPC !== client) return;
        console.log('[DISCORD RPC] Connection successful.');
        ready = true;
        setActivity();
    });

    RPC.on('disconnected', () => {
        // Client dropped by disconnect(): nothing to restart.
        if (RPC !== client) return;
        console.log('[DISCORD RPC] Disconnected.');
        ready = false;
        scheduleRetry();
    });

    RPC.login({ clientId: CLIENT_ID }).catch(() => {
        RPC.destroy().catch(() => {});
        if (RPC === client) scheduleRetry();
    });
}

/**
 * Clears the presence when Tools quits and stops the reconnection loop.
 */
function destroy() {
    stopped = true;
    clearTimeout(retryTimer);
    if (client) client.destroy().catch(() => {});
}

connect();

module.exports = { destroy, setActivity };
