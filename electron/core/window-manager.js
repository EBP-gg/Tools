// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const {
    BrowserWindow,
    screen,
    app,
    Tray,
    Menu,
    nativeImage,
    nativeTheme,
    shell
} = require('electron');
const path = require('node:path');
const { setupConsoleRedirection } = require('./console-manager');
const {
    IS_DEV_MODE,
    ROOT_PATH,
    EBP_DOMAIN,
    WINDOW_WIDTH,
    WINDOW_DEV_PANEL_WIDTH,
    WINDOW_HEIGHT,
    getCurrentPort,
    PROTOCOL_NAME
} = require('../config/constants');
const watchFolderService = require('../services/watch-folder-service');
const arenaCaptureService = require('../services/arena-capture-service');
const telemetryService = require('../services/telemetry-service');
const StorageManager = require('./storage-manager');

//#endregion

/**
 * Window Manager - Handles all window creation and management.
 * This module manages the creation and configuration of both main and floating windows, including debug mode toggling, window sizing, and tray functionality.
 */

let mainWindow = null;
let floatingWindow = null;
let debugMode = false;

/**
 * Centers the main window on the primary display.
 */
function centerMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
    const [windowWidth, windowHeight] = mainWindow.getSize();

    const X =
        Math.floor((PRIMARY_DISPLAY.workAreaSize.width - windowWidth) / 2) +
        PRIMARY_DISPLAY.workArea.x;
    const Y =
        Math.floor((PRIMARY_DISPLAY.workAreaSize.height - windowHeight) / 2) +
        PRIMARY_DISPLAY.workArea.y;

    mainWindow.setPosition(X, Y);
}

/**
 * Sets the main window size based on provided dimensions or defaults.
 * @param {number|undefined} width Target width.
 * @param {number|undefined} height Target height.
 */
function setWindowSize(width, height) {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
    let targetWidth = 0;
    let targetHeight = 0;

    // Reset to default size
    if (width === undefined || height === undefined) {
        targetWidth = Math.min(
            PRIMARY_DISPLAY.workAreaSize.width,
            WINDOW_WIDTH + (debugMode ? 0 : WINDOW_DEV_PANEL_WIDTH)
        );
        targetHeight = Math.min(
            PRIMARY_DISPLAY.workAreaSize.height,
            WINDOW_HEIGHT
        );
    }
    // Full screen
    else if (width == 0 && height == 0) {
        targetWidth = PRIMARY_DISPLAY.workAreaSize.width;
        targetHeight = PRIMARY_DISPLAY.workAreaSize.height;
    } else {
        targetWidth = width;
        targetHeight = height;
    }

    mainWindow.setResizable(true);
    mainWindow.setSize(targetWidth, targetHeight);
    mainWindow.setResizable(false);

    // Center the window after resizing
    centerMainWindow();
}

/**
 * Creates and configures a floating notification window.
 * @param {number} width Window width.
 * @param {number} height Window height.
 * @param {string} data Data to pass to the notification.
 */
function createFloatingWindow(width, height, data) {
    console.log('createFloatingWindow', width, height, data);
    return new Promise((resolve) => {
        const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
        const WIDTH = Math.min(PRIMARY_DISPLAY.workAreaSize.width, width);
        const HEIGHT = Math.min(PRIMARY_DISPLAY.workAreaSize.height, height);

        if (!floatingWindow) {
            floatingWindow = new BrowserWindow({
                width: WIDTH,
                height: HEIGHT,
                contextIsolation: true,
                resizable: false,
                webPreferences: {
                    preload:
                        process.env.NODE_ENV === 'production'
                            ? MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
                            : path.join(__dirname, '..', 'preload.js')
                },
                frame: false,
                transparent: true,
                alwaysOnTop: true
            });

            // Position at the bottom right.
            floatingWindow.setBounds({
                x: PRIMARY_DISPLAY.workAreaSize.width - width,
                y: PRIMARY_DISPLAY.workAreaSize.height - height
            });
        }

        floatingWindow.setBounds({
            width: WIDTH,
            height: HEIGHT,
            x: PRIMARY_DISPLAY.workAreaSize.width - width,
            y: PRIMARY_DISPLAY.workAreaSize.height - height
        });

        floatingWindow.webContents.once('did-finish-load', () => {
            setTimeout(() => {
                resolve();
            }, 100);
        });

        const URL = `http://localhost:${IS_DEV_MODE ? '4201' : getCurrentPort()}/${StorageManager.permanentSettings['language'] ?? 'aa'}/notification?data=${encodeURIComponent(data)}`;

        floatingWindow.loadURL(URL);
    });
}

function deleteFloatingWindow(haveToShowMainWindow) {
    if (floatingWindow) {
        floatingWindow.close();
        floatingWindow = undefined;
    }
    if (haveToShowMainWindow) {
        showMainWindow();
    }
}

/**
 * Creates and configures the main application window.
 */
function createWindow(updateService) {
    console.log('createWindow');
    const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
    const APP_ARGS = process.argv;

    // Check if launched via deep link (Windows)
    const HAS_DEEP_LINK = APP_ARGS.some((arg) =>
        arg.startsWith(`${PROTOCOL_NAME}://`)
    );
    const IS_STARTUP_MODE = APP_ARGS.includes('--mode=startup');

    mainWindow = new BrowserWindow({
        width: Math.min(PRIMARY_DISPLAY.workAreaSize.width, WINDOW_WIDTH),
        height: Math.min(PRIMARY_DISPLAY.workAreaSize.height, WINDOW_HEIGHT),
        // Tools est une app de barre système : la fenêtre ne s'ouvre JAMAIS
        // d'elle-même. Le lancement se signale par une notification, et l'IHM
        // ne s'ouvre que par l'entrée « Open » du menu du tray.
        show: false,
        skipTaskbar: IS_STARTUP_MODE || HAS_DEEP_LINK,
        resizable: false,
        contextIsolation: true,
        webPreferences: {
            // Le renderer produit la piste audio de la captation : Chromium
            // ralentit les fenêtres masquées, ce qui hacherait le son dès que
            // l'opérateur réduit Tools dans la barre des tâches.
            backgroundThrottling: false,
            preload: IS_DEV_MODE
                ? path.join(__dirname, '..', 'preload.js')
                : MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
        }
    });

    let language = StorageManager.permanentSettings['language'];
    if (!language) {
        language = app.getLocale();
    }

    const ROOT_URL = `http://localhost:${IS_DEV_MODE ? '4201' : getCurrentPort()}/`;
    const HOME_URL = `${ROOT_URL}${language}/`;

    // When the user clicks on the close cross, we hide the application.
    mainWindow.on('close', (event) => {
        event.preventDefault();
        hideMainWindow();
    });

    const IS_MACOS = process.platform === 'darwin';

    // macOS : l'icône du Dock n'apporte rien tant que l'IHM est fermée, et Tools
    // passe l'essentiel de sa vie fermé. On la fait donc suivre la fenêtre.
    //
    // Accroché aux ÉVÉNEMENTS de la fenêtre plutôt qu'aux appels de
    // `showMainWindow`/`hideMainWindow` : plusieurs endroits appellent `show()`
    // ou `hide()` directement (deux routes du serveur, le flux de repli des
    // mises à jour), et un autre s'écrira. Les événements les couvrent tous.
    //
    // L'affichage, lui, est AUSSI demandé par `showMainWindow` avant le `show()`
    // : réagir à l'événement suffit à faire revenir l'icône, mais trop tard pour
    // que la fenêtre passe au premier plan — mesuré, elle s'ouvrait derrière les
    // autres au deuxième aller-retour.
    //
    // Le mode « accessoire » retire aussi la barre de menus, donc les raccourcis
    // Cmd+C/V — ce qui casserait le collage d'une URL YouTube. Sans conséquence
    // ici : la barre revient avec l'icône, avant que la fenêtre s'affiche.
    if (IS_MACOS) {
        mainWindow.on('show', () => setDockVisibility(true));
        mainWindow.on('hide', () => setDockVisibility(false));
        // La fenêtre naît masquée : l'icône ne doit pas apparaître au lancement.
        setDockVisibility(false);
    }

    function getTrayIcon() {
        const STATUS = watchFolderService.getStatus();
        let suffix = '';
        // La captation passe devant : sur un PC de salle c'est l'état qui
        // compte, et le watch-folder n'y sert pas. Vert FIXE et non clignotant
        // — la captation est l'état nominal (8 h par jour), pas une alerte ;
        // un clignotement permanent finirait par ne plus être vu.
        if (arenaCaptureService.getStatus().running) {
            suffix = '-recording';
        } else if (STATUS.processing.length > 0) {
            suffix = '-analyzing';
        } else if (STATUS.failed.length > 0) {
            suffix = '-error';
        }
        // macOS: always load the black variant and mark it as a template
        // image — the system handles inversion for dark mode and Liquid Glass.
        // Other platforms: pick the variant that contrasts with the taskbar.
        const COLOR = IS_MACOS
            ? 'dark'
            : nativeTheme.shouldUseDarkColors
              ? 'light'
              : 'dark';
        const IMAGE = nativeImage.createFromPath(
            path.join(
                ROOT_PATH,
                'assets',
                'favicon',
                `favicon-${COLOR}${suffix}.png`
            )
        );
        if (IS_MACOS) {
            IMAGE.setTemplateImage(true);
        }
        return IMAGE;
    }

    const TRAY = new Tray(getTrayIcon());

    function buildReplaysSubmenu(status) {
        const ROOT = watchFolderService.getWatchFolder();
        const FAILED_DIR = path.join(ROOT, 'failed');
        const SECTIONS = [
            { title: 'In progress', items: status.processing, folder: ROOT },
            { title: 'Queued', items: status.queued, folder: ROOT },
            { title: 'Failed', items: status.failed, folder: FAILED_DIR }
        ];
        const MENU = [];
        for (const SECTION of SECTIONS) {
            MENU.push({
                label: `${SECTION.title} (${SECTION.items.length})`,
                click: () => {
                    watchFolderService.ensureFolders();
                    shell.openPath(SECTION.folder);
                }
            });
            if (SECTION.items.length === 0) {
                MENU.push({ label: '   —', enabled: false });
            } else {
                for (const ITEM of SECTION.items.slice(0, 20)) {
                    MENU.push({
                        label: `   ${ITEM.name}`,
                        click: () => shell.showItemInFolder(ITEM.path)
                    });
                }
                if (SECTION.items.length > 20) {
                    MENU.push({
                        label: `   … and ${SECTION.items.length - 20} more`,
                        enabled: false
                    });
                }
            }
            MENU.push({ type: 'separator' });
        }
        MENU.pop();
        return MENU;
    }

    function buildContextMenu() {
        const STATUS = watchFolderService.getStatus();
        return Menu.buildFromTemplate([
            {
                label: 'Open',
                icon: nativeImage
                    .createFromPath(
                        path.join(
                            ROOT_PATH,
                            'assets',
                            'context-menu',
                            'circle.png'
                        )
                    )
                    .resize({ width: 12, height: 12 }),
                click: () => showMainWindow()
            },
            {
                label: 'Restart',
                icon: nativeImage
                    .createFromPath(
                        path.join(
                            ROOT_PATH,
                            'assets',
                            'context-menu',
                            'arrow-circle-left.png'
                        )
                    )
                    .resize({ width: 12, height: 12 }),
                submenu: [
                    {
                        label: 'Confirm restart',
                        click: () => {
                            // Une mise à jour téléchargée attend ? Il faut
                            // passer par Squirrel. `app.relaunch()` relancerait
                            // `process.execPath`, c'est-à-dire l'exécutable
                            // VERSIONNÉ de l'installation courante
                            // (app-1.8.83/ebp-tools.exe) — donc l'ancienne
                            // version, en laissant croire que la mise à jour a
                            // échoué. Seul le lanceur, à la racine, bascule sur
                            // la version la plus récente.
                            if (updateService.pendingVersion) {
                                updateService.applyPendingUpdate();
                                return;
                            }

                            app.relaunch();
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.destroy();
                            }
                            app.quit();
                        }
                    }
                ]
            },
            {
                label: 'Quit',
                icon: nativeImage
                    .createFromPath(
                        path.join(
                            ROOT_PATH,
                            'assets',
                            'context-menu',
                            'power.png'
                        )
                    )
                    .resize({ width: 12, height: 12 }),
                submenu: [
                    {
                        label: 'Confirm quit',
                        click: () => {
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.destroy();
                            }
                            app.quit();
                        }
                    }
                ]
            },
            {
                label: 'Settings',
                icon: nativeImage
                    .createFromPath(
                        path.join(
                            ROOT_PATH,
                            'assets',
                            'context-menu',
                            'gear.png'
                        )
                    )
                    .resize({ width: 12, height: 12 }),
                submenu: [
                    {
                        label: 'Send anonymous usage data',
                        type: 'checkbox',
                        checked: telemetryService.isEnabled(),
                        click: (item) => {
                            telemetryService.setEnabled(item.checked);
                            TRAY.setContextMenu(buildContextMenu());
                        }
                    }
                ]
            },
            {
                // Quand une version attend, l'entrée cesse de proposer une
                // vérification pour proposer l'application — c'est la seule
                // trace visible qu'une mise à jour est prête.
                label: updateService.pendingVersion
                    ? `Restart to apply ${updateService.pendingVersion}`
                    : `Check for update (${updateService.localVersion})`,
                icon: nativeImage
                    .createFromPath(
                        path.join(ROOT_PATH, 'assets', 'context-menu', 'up.png')
                    )
                    .resize({ width: 12, height: 12 }),
                click: () => {
                    if (updateService.pendingVersion) {
                        updateService.applyPendingUpdate();
                        return;
                    }
                    updateService.autoUpdate(false);
                }
            },
            {
                label: `Replay analysis (${STATUS.processing.length}, ${STATUS.queued.length}, ${STATUS.failed.length})`,
                submenu: buildReplaysSubmenu(STATUS)
            }
        ]);
    }

    /**
     * Infobulle : rappelle depuis quand la salle enregistre, l'information la
     * plus utile au staff qui survole l'icône (l'icône seule dit « ça rec »,
     * pas « depuis quand »).
     */
    function buildTrayTooltip() {
        const CAPTURE = arenaCaptureService.getStatus();
        if (!CAPTURE.running || !CAPTURE.startedAt) {
            return 'EBP - Tools';
        }
        const SINCE = new Date(CAPTURE.startedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
        return `EBP - Tools - Recording since ${SINCE}`;
    }

    TRAY.setToolTip(buildTrayTooltip());
    TRAY.setContextMenu(buildContextMenu());
    setInterval(() => {
        TRAY.setContextMenu(buildContextMenu());
        TRAY.setImage(getTrayIcon());
        TRAY.setToolTip(buildTrayTooltip());
    }, 3000);

    if (!IS_MACOS) {
        nativeTheme.on('updated', () => {
            TRAY.setImage(getTrayIcon());
        });
    }

    // Double-click on the icon to reopen the window.
    TRAY.on('double-click', () => {
        showMainWindow();
        mainWindow.setSkipTaskbar(false);
    });

    mainWindow.webContents.on('did-navigate', async (event, url) => {
        if (url.startsWith(ROOT_URL)) {
        } else {
            console.log(`Main window > did-navigate : ${url} - ${HOME_URL}`);
        }
    });

    const langRootPattern = new RegExp(
        `^https://${EBP_DOMAIN.replace(/\./g, '\\.')}/[a-z]{2}/?$`
    );
    mainWindow.webContents.on('did-navigate-in-page', async (event, url) => {
        if (langRootPattern.test(url)) {
            mainWindow.loadURL(HOME_URL);
        }
    });

    // Hides the menu bar displayed in the top left corner on Windows.
    mainWindow.setMenuBarVisibility(false);

    // Setup console log redirection to frontend
    setupConsoleRedirection(mainWindow);

    // Plus de connexion : l'identité vient des deeplinks du site (cf.
    // session-service), donc l'application s'ouvre directement.
    mainWindow.loadURL(HOME_URL);
}

/**
 * Affiche ou masque l'icône du Dock. Sans effet hors macOS.
 *
 * `app.dock.hide()` ne convient PAS : il fonctionne au lancement, mais une fois
 * l'icône affichée macOS refuse de repasser l'application en « accessoire » par
 * ce chemin et l'appel reste silencieusement sans effet. Mesuré : après un
 * aller-retour, `app.dock.isVisible()` répondait toujours `true`, deux secondes
 * plus tard comme après `app.hide()`. `setActivationPolicy` bascule, lui, dans
 * les deux sens.
 */
function setDockVisibility(visible) {
    if (process.platform !== 'darwin') return;
    app.setActivationPolicy(visible ? 'regular' : 'accessory');
}

function hideMainWindow() {
    if (getMainWindow() && !getMainWindow().isDestroyed()) {
        getMainWindow()?.hide();
    }
}

function showMainWindow() {
    if (getMainWindow() && !getMainWindow().isDestroyed()) {
        // AVANT l'affichage : une app « accessoire » ne prend pas le premier
        // plan, et la fenêtre s'ouvrirait derrière celles des autres.
        setDockVisibility(true);
        getMainWindow().show();
        getMainWindow().focus();
    }
}

/**
 * Toggles the debug mode on/off. When enabled, closes DevTools and adjusts window size.
 * When disabled, opens DevTools and expands window width to accommodate the dev panel.
 */
function switchDebugMode() {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    debugMode = !debugMode;

    // Opens/closes DevTools
    if (debugMode) {
        mainWindow.webContents.closeDevTools();
    } else {
        mainWindow.webContents.openDevTools();
    }

    // Set window width
    const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
    mainWindow.setResizable(true);
    const DESIRED_WIDTH =
        WINDOW_WIDTH + (!debugMode ? WINDOW_DEV_PANEL_WIDTH : 0);
    mainWindow.setSize(
        Math.min(PRIMARY_DISPLAY.workAreaSize.width, DESIRED_WIDTH),
        Math.min(PRIMARY_DISPLAY.workAreaSize.height, WINDOW_HEIGHT)
    );
    mainWindow.setResizable(false);

    // Center the window after resizing
    centerMainWindow();
}

/**
 * Gets the current main window instance
 * @returns {BrowserWindow|null} The main window instance
 */
function getMainWindow() {
    return mainWindow;
}

/**
 * Gets the current floating window instance. Used to push progress to the
 * notification HMI when the main window does not exist yet (component
 * download at boot).
 * @returns {BrowserWindow|undefined} The floating window instance
 */
function getFloatingWindow() {
    return floatingWindow;
}

/**
 * Sets the debug mode state
 * @param {boolean} mode Debug mode state to set
 */
function setDebugMode(mode) {
    debugMode = mode;
}

module.exports = {
    setWindowSize,
    createFloatingWindow,
    deleteFloatingWindow,
    createWindow,
    switchDebugMode,
    getMainWindow,
    getFloatingWindow,
    setDebugMode,
    hideMainWindow,
    showMainWindow
};
