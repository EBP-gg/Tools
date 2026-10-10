// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const https = require('https');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('node:path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const {
    COMPONENTS,
    COMPONENTS_DIR,
    COMPONENT_PLATFORM_KEY,
    getComponentPath,
    componentDirectory
} = require('../config/constants');
const {
    createFloatingWindow,
    deleteFloatingWindow,
    getFloatingWindow
} = require('../core/window-manager');

//#endregion

/**
 * Les composants lourds ne sont plus embarqués dans l'installeur : ils sont
 * publiés une fois pour toutes sur le stockage public, sous un nom qui contient
 * leur empreinte, et téléchargés au premier lancement.
 *
 * Le sha256 attendu vit dans components.json, donc dans l'asar signé : c'est
 * lui qui fait autorité, pas le réseau. Un binaire dont l'empreinte ne
 * correspond pas n'est jamais exécuté.
 */
const COMPONENTS_URL =
    process.env.TOOLS_COMPONENTS_URL ||
    'https://ebp-tools-releases.nbg1.your-objectstorage.com/tools/components';

// Mode salle : le PC démarre sans personne devant, parfois avant que le réseau
// soit disponible. On réessaie donc en tâche de fond plutôt que de laisser la
// captation échouer toute la soirée.
const RETRY_DELAY_MS = 60 * 1000;

const PENDING = new Map();
// Octets reçus par composant en cours de téléchargement, pour n'afficher qu'une
// seule barre de progression quand plusieurs composants descendent en parallèle.
const PROGRESS = new Map();
let retryTimer = null;
let lastPercent = -1;

//#region Functions

/**
 * Pushes the aggregated download progress to the notification HMI. The main
 * window does not exist yet at boot, so the floating window is addressed
 * directly instead of being relayed by the front-end.
 */
function sendProgress() {
    let received = 0;
    let total = 0;

    for (const ENTRY of PROGRESS.values()) {
        received += ENTRY.received;
        total += ENTRY.total;
    }

    if (total === 0) {
        return;
    }

    const PERCENT = Math.min(100, Math.round((received / total) * 100));
    if (PERCENT === lastPercent) {
        return;
    }
    lastPercent = PERCENT;

    const WINDOW = getFloatingWindow();
    if (!WINDOW || WINDOW.isDestroyed()) {
        return;
    }

    WINDOW.webContents.send('set-notification-data', {
        percent: PERCENT,
        leftRounded: true,
        // À 100 %, il reste la vérification de l'empreinte : on repasse en
        // indéterminé plutôt que de laisser la barre pleine et figée.
        infinite: PERCENT === 100,
        // Le chargeur montre l'icône OU le pourcentage, jamais les deux : on ne
        // la pose donc que lorsqu'il n'y a plus de progression à afficher.
        icon: PERCENT === 100 ? 'fa-sharp fa-solid fa-download' : undefined,
        text: '.common.downloadingComponents',
        state: 'info'
    });
}

/**
 * Manifest entry of a component for the current platform.
 * @param {string} name Component name.
 * @returns {object|undefined} Entry, or undefined if the platform ships none.
 */
function entryOf(name) {
    return COMPONENTS[name]?.[COMPONENT_PLATFORM_KEY];
}

/**
 * Is this component already installed? Le marqueur ne suffit pas : un binaire
 * peut disparaître après coup (mise en quarantaine par un antivirus, ménage
 * manuel du userData). On exige donc les deux, sinon l'app se croirait équipée
 * et le composant échouerait indéfiniment sans jamais être retéléchargé.
 * @param {string} name Component name.
 * @returns {boolean} True if the component is usable as-is.
 */
function isInstalled(name) {
    const ENTRY = entryOf(name);

    if (!ENTRY) {
        return true;
    }

    return (
        fs.existsSync(path.join(COMPONENTS_DIR, `${ENTRY.asset}.ok`)) &&
        fs.existsSync(getComponentPath(name))
    );
}

/**
 * Does this component still have to be downloaded?
 * @param {string} name Component name.
 * @returns {boolean} True if a download is needed.
 */
function needsDownload(name) {
    return entryOf(name) ? !isInstalled(name) : false;
}

/**
 * Downloads, verifies and installs a component. The marker file is written
 * last: an interrupted install is retried at the next launch.
 * @param {string} name Component name.
 */
async function install(name) {
    const ENTRY = entryOf(name);

    // Rien à télécharger sur cette plateforme.
    if (!ENTRY) {
        return;
    }

    if (isInstalled(name)) {
        return;
    }

    fs.mkdirSync(COMPONENTS_DIR, { recursive: true });

    const MARKER = path.join(COMPONENTS_DIR, `${ENTRY.asset}.ok`);
    const TEMPORARY = path.join(COMPONENTS_DIR, `${ENTRY.asset}.part`);
    console.log(`[components] downloading ${ENTRY.asset}`);

    try {
        await download(
            `${COMPONENTS_URL}/${name}/${ENTRY.asset}`,
            TEMPORARY,
            (received, total) => {
                PROGRESS.set(name, { received, total });
                sendProgress();
            }
        );

        // L'empreinte est vérifiée AVANT toute extraction : on ne déballe
        // jamais une archive dont on ne sait pas d'où elle vient.
        const SHA256 = await sha256Of(TEMPORARY);
        if (SHA256 !== ENTRY.sha256) {
            throw new Error(
                `checksum mismatch for ${ENTRY.asset} (got ${SHA256})`
            );
        }

        if (ENTRY.exec) {
            await installArchive(ENTRY, TEMPORARY);
        } else {
            fs.chmodSync(TEMPORARY, 0o755);
            fs.renameSync(TEMPORARY, path.join(COMPONENTS_DIR, ENTRY.asset));
        }

        fs.writeFileSync(MARKER, ENTRY.sha256);
        console.log(`[components] installed ${ENTRY.asset}`);
    } catch (error) {
        fs.rmSync(TEMPORARY, { force: true });
        throw error;
    } finally {
        PROGRESS.delete(name);
    }
}

/**
 * Déballe une archive vérifiée dans son dossier définitif. L'extraction se fait
 * à côté puis le dossier est renommé d'un bloc : une extraction interrompue ne
 * laisse jamais un bundle à moitié déballé que l'app prendrait pour valide.
 * @param {object} entry Manifest entry of the component.
 * @param {string} archivePath Path of the verified archive.
 */
async function installArchive(entry, archivePath) {
    const DIRECTORY = path.join(
        COMPONENTS_DIR,
        componentDirectory(entry.asset)
    );
    const TEMPORARY_DIRECTORY = `${DIRECTORY}.part`;

    fs.rmSync(TEMPORARY_DIRECTORY, { recursive: true, force: true });
    fs.mkdirSync(TEMPORARY_DIRECTORY, { recursive: true });

    try {
        await extract(archivePath, TEMPORARY_DIRECTORY);
        fs.rmSync(DIRECTORY, { recursive: true, force: true });
        fs.renameSync(TEMPORARY_DIRECTORY, DIRECTORY);
    } catch (error) {
        fs.rmSync(TEMPORARY_DIRECTORY, { recursive: true, force: true });
        throw error;
    }

    // L'archive ne sert plus à rien une fois déballée, et elle pèse son poids.
    fs.rmSync(archivePath, { force: true });
    // Le bit d'exécution ne survit pas à tous les outils d'archivage.
    fs.chmodSync(path.join(DIRECTORY, entry.exec), 0o755);
}

/**
 * Décompresse une archive zip. Même patron que deno-service : bsdtar lit le zip
 * sur macOS comme sur Windows, unzip est la voie sûre sous Linux.
 * @param {string} archivePath Archive to extract.
 * @param {string} destination Directory to extract into.
 * @returns {Promise<void>} Resolves once extracted.
 */
function extract(archivePath, destination) {
    const [COMMAND, ARGS] =
        os.platform() === 'linux'
            ? ['unzip', ['-o', '-q', archivePath, '-d', destination]]
            : ['tar', ['-xf', archivePath, '-C', destination]];

    return new Promise((resolve, reject) => {
        execFile(COMMAND, ARGS, (error) =>
            error ? reject(error) : resolve()
        );
    });
}

/**
 * Ensures a component is installed. Memoized: concurrent callers share the
 * same download, and a resolved component costs one `existsSync`.
 * @param {string} name Component name.
 * @returns {Promise<void>} Resolves once the component is usable.
 */
function ensure(name) {
    if (!PENDING.has(name)) {
        PENDING.set(
            name,
            install(name).catch((error) => {
                PENDING.delete(name);
                throw error;
            })
        );
    }

    return PENDING.get(name);
}

/**
 * Ensures every component of the manifest is installed, showing the floating
 * progress window if anything has to be downloaded.
 * @returns {Promise<void>} Resolves once all components are usable.
 */
async function ensureAll() {
    const NAMES = Object.keys(COMPONENTS);
    const DOWNLOADING = NAMES.some(needsDownload);
    lastPercent = -1;

    if (DOWNLOADING) {
        // Volontairement pas attendu : si la page de notification ne se charge
        // pas, la promesse ne se résout jamais et le démarrage resterait bloqué.
        createFloatingWindow(
            450,
            150,
            JSON.stringify({
                percent: 0,
                leftRounded: true,
                infinite: true,
                icon: 'fa-sharp fa-solid fa-download',
                text: '.common.downloadingComponents',
                state: 'info'
            })
        ).catch((error) =>
            console.error('[components] progress window failed', error)
        );
    }

    try {
        await Promise.all(NAMES.map(ensure));
    } finally {
        if (DOWNLOADING) {
            deleteFloatingWindow(false);
        }
    }
}

/**
 * Retries the missing components every minute, silently, until they are all
 * installed. Used when the first attempt failed at boot (machine started
 * before the network was up).
 */
function retryInBackground() {
    if (retryTimer) {
        return;
    }

    retryTimer = setInterval(() => {
        Promise.all(Object.keys(COMPONENTS).map(ensure))
            .then(() => {
                clearInterval(retryTimer);
                retryTimer = null;
                console.log('[components] all components installed');
            })
            .catch(() => {});
    }, RETRY_DELAY_MS);
}

/**
 * Downloads a file, following the redirects the storage may serve.
 * @param {string} url URL of the file to download.
 * @param {string} destination Path to write the file to.
 * @param {Function} onProgress Called with (received, total) as bytes arrive.
 * @returns {Promise<void>} Resolves once the file is fully written.
 */
function download(url, destination, onProgress) {
    // Le protocole décide du client : indispensable pour pointer un serveur
    // local en test (TOOLS_COMPONENTS_URL), la production restant en HTTPS.
    const CLIENT = url.startsWith('http://') ? http : https;

    return new Promise((resolve, reject) => {
        CLIENT
            .get(url, (res) => {
                if (
                    (res.statusCode === 301 || res.statusCode === 302) &&
                    res.headers.location
                ) {
                    res.resume();
                    return download(
                        res.headers.location,
                        destination,
                        onProgress
                    ).then(resolve, reject);
                }

                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
                }

                const TOTAL = Number.parseInt(res.headers['content-length'], 10);
                let received = 0;

                res.on('data', (chunk) => {
                    received += chunk.length;
                    if (TOTAL) {
                        onProgress(received, TOTAL);
                    }
                });

                const FILE = fs.createWriteStream(destination);
                res.pipe(FILE);
                FILE.on('error', reject);
                FILE.on('finish', () => FILE.close(() => resolve()));
            })
            .on('error', reject);
    });
}

/**
 * Computes the SHA-256 of a file.
 * @param {string} filePath Path of the file to hash.
 * @returns {Promise<string>} Hexadecimal digest.
 */
function sha256Of(filePath) {
    return new Promise((resolve, reject) => {
        const HASH = crypto.createHash('sha256');
        const STREAM = fs.createReadStream(filePath);

        STREAM.on('data', (chunk) => HASH.update(chunk));
        STREAM.on('error', reject);
        STREAM.on('end', () => resolve(HASH.digest('hex')));
    });
}

//#endregion

module.exports = {
    ensure,
    ensureAll,
    retryInBackground
};
