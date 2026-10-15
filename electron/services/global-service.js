// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const path = require('node:path');

//#endregion

/**
 * Safely deletes a file/folder if it exists, with Unicode normalization for proper file path handling.
 * @param path The file/folder path to delete.
 */
function unlinkSync(path) {
    const NORMALIZED_CUT_PATH = path.normalize('NFC');
    if (fs.existsSync(NORMALIZED_CUT_PATH)) {
        const STAT = fs.statSync(NORMALIZED_CUT_PATH);
        if (STAT.isDirectory()) {
            fs.rmSync(NORMALIZED_CUT_PATH, { recursive: true });
        } else {
            fs.unlinkSync(NORMALIZED_CUT_PATH);
        }
    }
}

/**
 * Sanitizes a map name for use in a filename: non-alphanumerics collapsed to
 * dashes, trimmed. Shared by the watch-folder cuts and the arena pipeline
 * (S3 filename convention: no underscores inside values).
 * @param {string} mapName Raw map name ('' or nullish → 'unknown').
 */
function safeMapName(mapName) {
    return (mapName || 'unknown')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Passe un process enfant en priorité BELOW_NORMAL (cross-platform via
 * os.setPriority ; BELOW_NORMAL_PRIORITY_CLASS sous Windows). Utilisé par le
 * mode salle : sur le PC de streaming d'une salle, les traitements ne doivent
 * JAMAIS faire ramer les logiciels de prod — l'OS leur donne les cycles
 * restants, ils s'allongent seulement quand la machine est occupée. À noter :
 * ne baisse que la priorité CPU, pas les I/O disque.
 * @param {import('child_process').ChildProcess} child Process fraîchement spawn.
 * @param {string} label Préfixe de log en cas d'échec.
 */
function lowerProcessPriority(child, label) {
    try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch (e) {
        console.warn(`[${label}] setPriority failed:`, e.message);
    }
}

// Process enfants à tuer quand Tools quitte (cf. `killTrackedChildren`).
const TRACKED_CHILDREN = new Set();

/**
 * Inscrit un process enfant pour qu'il soit tué quand Tools quitte. Sans ça,
 * l'analyzer survit à Tools, orphelin, et garde son fichier ouvert : à Rouen le
 * 15/10/2026, le work/window.mkv qu'il lisait a bloqué tous les rounds du
 * pipeline suivant (EBUSY à sa suppression).
 * @param {import('child_process').ChildProcess} child Process fraîchement spawn.
 */
function trackChild(child) {
    TRACKED_CHILDREN.add(child);
    const UNTRACK = () => TRACKED_CHILDREN.delete(child);
    child.once('exit', UNTRACK);
    child.once('error', UNTRACK);
}

/**
 * Tue les process inscrits par `trackChild`, synchrone (appelé au `will-quit`).
 * Sous Windows, l'arbre entier : l'analyzer (exe PyInstaller) a son propre
 * process enfant, et lance lui-même ffmpeg.
 */
function killTrackedChildren() {
    for (const CHILD of TRACKED_CHILDREN) {
        if (!CHILD.pid || CHILD.exitCode !== null) continue;
        try {
            if (process.platform === 'win32') {
                spawnSync('taskkill', ['/PID', String(CHILD.pid), '/T', '/F'], {
                    windowsHide: true,
                    timeout: 5000
                });
            } else {
                CHILD.kill('SIGKILL');
            }
        } catch (e) {
            console.warn(`[quit] process ${CHILD.pid} non tué : ${e.message}`);
        }
    }
    TRACKED_CHILDREN.clear();
}

/**
 * Tue les process laissés par un Tools arrêté brutalement (plantage, fin de
 * tâche) : `killTrackedChildren` n'a alors pas tourné. Seuls ceux dont le parent
 * est mort sont visés, pour épargner ceux d'une autre instance vivante (dev +
 * prod). Synchrone : à appeler au démarrage, avant de relancer les nouveaux.
 * Même principe que `killOrphanCaptures` (arena-capture-service).
 * @param {string[]} names Débuts de nom d'exécutable (filtre Windows).
 * @param {(cmd: string) => boolean} isOurs Reconnaît nos process à leur ligne de commande.
 * @param {string} label Préfixe de log.
 */
function killOrphanProcesses(names, isOurs, label) {
    let procs;
    if (process.platform === 'win32') {
        const FILTER = names.map((n) => `Name LIKE '${n}%'`).join(' OR ');
        const RES = spawnSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `Get-CimInstance Win32_Process -Filter "${FILTER}" | ` +
                    'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
            ],
            { encoding: 'utf8', timeout: 15000, windowsHide: true }
        );
        try {
            procs = [].concat(JSON.parse(RES.stdout || '[]')).map((p) => ({
                pid: p.ProcessId,
                ppid: p.ParentProcessId,
                cmd: p.CommandLine || ''
            }));
        } catch (_) {
            console.warn(`[${label}] liste des processus illisible — orphelins non vérifiés`);
            return;
        }
    } else {
        const RES = spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], {
            encoding: 'utf8'
        });
        procs = (RES.stdout || '')
            .split('\n')
            .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
            .filter(Boolean)
            .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
    }

    // Unix rattache l'orphelin à launchd/init (PID 1) ; Windows garde le PID
    // d'un parent qui n'existe plus.
    const PARENT_ALIVE = (ppid) => {
        if (ppid === 1) return false;
        try {
            process.kill(ppid, 0);
            return true;
        } catch (e) {
            return e.code === 'EPERM';
        }
    };
    for (const P of procs) {
        if (!isOurs(P.cmd) || PARENT_ALIVE(P.ppid)) continue;
        try {
            // Windows : l'arbre entier, cf. killTrackedChildren.
            if (process.platform === 'win32') {
                spawnSync('taskkill', ['/PID', String(P.pid), '/T', '/F'], {
                    windowsHide: true,
                    timeout: 5000
                });
            } else {
                process.kill(P.pid, 'SIGKILL');
            }
            console.warn(`[${label}] process orphelin tué (pid ${P.pid}) : ${P.cmd}`);
        } catch (e) {
            console.warn(`[${label}] orphelin ${P.pid} non tué : ${e.message}`);
        }
    }
}

module.exports = {
    unlinkSync,
    safeMapName,
    lowerProcessPriority,
    trackChild,
    killTrackedChildren,
    killOrphanProcesses
};
