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
 * Displays the presence in the user's current language, with a dedicated
 * text when this machine is registered as an arena (salle) PC.
 */
function setActivity() {
    if (!ready) return;
    client.setActivity({
        details: t(
            arenaModeService.getState().registered
                ? 'discordRpc.arenaDetails'
                : 'discordRpc.details'
        ),
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
    const RPC = client = new rpc.Client({ transport: 'ipc' });

    RPC.on('ready', () => {
        console.log('[DISCORD RPC] Connection successful.');
        ready = true;
        setActivity();
    });

    RPC.on('disconnected', () => {
        console.log('[DISCORD RPC] Disconnected.');
        ready = false;
        scheduleRetry();
    });

    RPC.login({ clientId: CLIENT_ID }).catch(() => {
        RPC.destroy().catch(() => {});
        scheduleRetry();
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
