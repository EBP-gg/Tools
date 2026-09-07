// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const os = require('os');
const path = require('node:path');
const fs = require('fs');
const { default: getPort } = require('get-port');
const { app } = require('electron');
const COMPONENTS = require('./components.json');

/**
 * Application constants and configuration values
 * @module constants
 */

//#region Functions

/**
 * Dossier d'extraction d'un composant archivé, dérivé du nom de son asset : le
 * dépôt distant et le disque local restent ainsi le miroir l'un de l'autre.
 * @param {string} asset Asset file name.
 * @returns {string} Directory name, without the archive extension.
 */
function componentDirectory(asset) {
    return asset.replace(/\.zip$/, '');
}

/**
 * Get the path to a component downloaded at runtime (see component-service).
 * The path is derivable before the file exists: only its presence is
 * conditional, so the call sites keep using a plain constant.
 *
 * Un composant dont l'entrée porte `exec` est une archive : son exécutable vit
 * à l'intérieur du dossier extrait. Sans `exec`, l'asset EST l'exécutable.
 * @param {string} name Component name, as keyed in components.json.
 * @returns {string} Path to the component's executable.
 */
function getComponentPath(name) {
    const ENTRY = COMPONENTS[name]?.[COMPONENT_PLATFORM_KEY];

    if (!ENTRY) {
        throw new Error(
            `No "${name}" component published for ${COMPONENT_PLATFORM_KEY}`
        );
    }

    if (ENTRY.exec) {
        return path.join(
            COMPONENTS_DIR,
            componentDirectory(ENTRY.asset),
            ENTRY.exec
        );
    }

    return path.join(COMPONENTS_DIR, ENTRY.asset);
}

/**
 * Comment lancer l'analyseur : un exécutable seul en temps normal, ou
 * « interpréteur + script » quand on veut faire tourner les SOURCES du dépôt.
 *
 * En développement, `TOOLS_ANALYZER_PYTHON` — chemin d'un interpréteur, absolu
 * ou relatif à la racine du dépôt — court-circuite le composant téléchargé et
 * lance `python/analyze_video.py` directement. De quoi voir une modification de
 * détection dans l'IHM sans reconstruire un bundle de 325 Mo à chaque essai :
 *
 *   TOOLS_ANALYZER_PYTHON=python/.venv/bin/python3 npm start
 *
 * Deux différences à garder en tête avec le composant gelé : il embarque
 * tesserocr là où un venv retombe sur pytesseract et sur le tesseract du
 * système. Une modification qui touche à l'OCR se valide donc sur le BINAIRE,
 * jamais seulement ici.
 *
 * Hors mode dev la variable est ignorée : un build publié ne doit pas dépendre
 * d'un python installé sur la machine du joueur.
 * @returns {{command: string, prefixArgs: string[], cwd: string}}
 */
function getAnalyzerSpawn() {
    const OVERRIDE = IS_DEV_MODE ? process.env.TOOLS_ANALYZER_PYTHON : '';

    if (OVERRIDE) {
        // ROOT_PATH vaut le dossier `electron/` en dev : la racine du dépôt est
        // son parent, et c'est elle qui sert de repère au chemin donné.
        const REPOSITORY = path.dirname(ROOT_PATH);
        const SCRIPT = path.join(REPOSITORY, 'python', 'analyze_video.py');
        return {
            command: path.resolve(REPOSITORY, OVERRIDE),
            prefixArgs: [SCRIPT],
            cwd: path.dirname(SCRIPT)
        };
    }

    return {
        command: ANALYZER_PATH,
        prefixArgs: [],
        cwd: path.dirname(ANALYZER_PATH)
    };
}

//#endregion

const EBP_DOMAIN = 'evabattleplan.com';

// Dépôt GitHub interrogé pour les mises à jour. En production la valeur est
// figée à la construction par webpack (cf. webpack.main.config.js) ; en dev,
// la variable d'environnement est lue au lancement. Défaut : la production.
const UPDATE_REPOSITORY =
    process.env.TOOLS_UPDATE_REPOSITORY || 'EBP-gg/Tools';


const IS_DEV_MODE = process.env.NODE_ENV !== 'production';
const ROOT_PATH = IS_DEV_MODE ? path.dirname(__dirname) : process.resourcesPath;
const OS_PLATFORM = os.platform();

// Flux de mise à jour de ce build. Dérivé du même dépôt que les mises à jour et
// publié par le CI sous ce même chemin : le banc d'essai et la production ont
// donc des flux distincts, sans qu'aucune valeur ne soit à tenir à jour à la
// main de part et d'autre.
//
// Les deux plateformes ne consomment pas la même chose : Squirrel.Windows lit
// un DOSSIER (il y cherche RELEASES lui-même), Squirrel.Mac lit le manifeste
// JSON directement. Ce dernier est de plus propre à l'ARCHITECTURE — servir une
// app Apple Silicon à un Mac Intel produirait un binaire qui ne démarre pas.
const UPDATE_FEED_BASE = `https://storage.ebp.gg/public/tools/updates/${UPDATE_REPOSITORY}`;
const UPDATE_FEED_URL =
    OS_PLATFORM === 'darwin'
        ? `${UPDATE_FEED_BASE}/darwin-${process.arch}/RELEASES.json`
        : `${UPDATE_FEED_BASE}/${OS_PLATFORM}`;
// Clé de plateforme des composants téléchargés : macOS publie un binaire par
// architecture, les autres plateformes un seul.
const COMPONENT_PLATFORM_KEY =
    OS_PLATFORM === 'darwin' ? `darwin-${process.arch}` : OS_PLATFORM;
const COMPONENTS_DIR = path.join(app.getPath('userData'), 'components');
const FFMPEG_PATH = getComponentPath('ffmpeg');
const ANALYZER_PATH = getComponentPath('analyzer');
// Helper de capture audio par processus (mode salle, Windows). Contrairement à
// ffmpeg et à l'analyzer il n'est PAS un composant téléchargé : 176 Ko livrés
// avec l'app coûtent moins cher qu'un job CI MSVC et qu'un script de
// publication à généraliser. Il est donc versionné dans `binaries/`, et copié
// dans les ressources par `extraResource` (cf. forge.config.js).
const AUDIO_LOOPBACK_PATH = IS_DEV_MODE
    ? path.join(
          path.dirname(ROOT_PATH),
          'binaries',
          'audio-loopback',
          'win32.exe'
      )
    : path.join(ROOT_PATH, 'audio-loopback', 'win32.exe');
const PERMANENT_SETTINGS_PATH = path.join(
    app.getPath('userData'),
    'settings.json'
);
const TEMPORARY_SETTINGS_PATH = path.join(ROOT_PATH, 'temporary_settings.json');
const BROWSER_PATH = path.join(ROOT_PATH, 'browser');
const PROTOCOL_NAME = 'tools';

//#region Window Constants

const WINDOW_WIDTH = 900;
const WINDOW_HEIGHT = 800;
const WINDOW_DEV_PANEL_WIDTH = 540;

//#endregion

//#region Video Processing Constants

const DEFAULT_VIDEO_WIDTH = 1920;
const DEFAULT_VIDEO_HEIGHT = 1080;

//#endregion

//#region Port Management

let PORT = null;

/**
 * Initialize and return an available port
 * @returns {Promise<number>} Available port number
 */
async function initializePort() {
    if (PORT === null) {
        // `host` confine la SONDE de disponibilité à la boucle locale. Sans lui,
        // get-port ouvre un socket d'écoute sur « toutes interfaces » puis sur
        // chaque adresse réseau de la machine pour tester le port — ce qui
        // déclenche l'alerte du pare-feu Windows au premier lancement, alors
        // même que le serveur Express qui suivra est déjà lié à 127.0.0.1.
        //
        // L'IHM n'a aucune raison d'être joignable depuis le réseau : elle est
        // servie à l'application elle-même, sur cette machine, et rien d'autre.
        PORT = await getPort({ host: '127.0.0.1' });
    }
    return PORT;
}

/**
 * Get the current port (may be null if not initialized)
 * @returns {number|null} Current port number or null
 */
function getCurrentPort() {
    return PORT;
}

//#endregion

//#region Export

module.exports = {
    EBP_DOMAIN,
    UPDATE_REPOSITORY,
    UPDATE_FEED_URL,

    IS_DEV_MODE,
    ROOT_PATH,

    FFMPEG_PATH,
    ANALYZER_PATH,
    AUDIO_LOOPBACK_PATH,
    getAnalyzerSpawn,

    COMPONENTS,
    COMPONENTS_DIR,
    COMPONENT_PLATFORM_KEY,
    getComponentPath,
    componentDirectory,

    PERMANENT_SETTINGS_PATH,
    TEMPORARY_SETTINGS_PATH,
    BROWSER_PATH,
    PROTOCOL_NAME,

    initializePort,
    getCurrentPort,

    WINDOW_WIDTH,
    WINDOW_HEIGHT,
    WINDOW_DEV_PANEL_WIDTH,

    DEFAULT_VIDEO_WIDTH,
    DEFAULT_VIDEO_HEIGHT
};

//#endregion
