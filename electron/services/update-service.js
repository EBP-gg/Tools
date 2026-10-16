// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const https = require('https');
const fs = require('fs');
const os = require('os');
const { version } = require('../../package.json');
const { app, dialog, autoUpdater: NATIVE } = require('electron');
const path = require('node:path');
const { spawn } = require('child_process');
const {
    getMainWindow,
    createFloatingWindow,
    deleteFloatingWindow,
    getFloatingWindow
} = require('../core/window-manager');
const {
    IS_DEV_MODE,
    UPDATE_REPOSITORY,
    UPDATE_FEED_URL
} = require('../config/constants');
const telemetryService = require('./telemetry-service');
const arenaModeService = require('./arena-mode-service');
const arenaCaptureService = require('./arena-capture-service');
const activityTracker = require('../core/activity-tracker');
const StorageManager = require('../core/storage-manager');

//#endregion

// Cadence des vérifications quand l'app tourne. Assez espacé pour être
// invisible, assez fréquent pour qu'un poste allumé toute la journée reçoive
// une version publiée le matin.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Nombre d'échecs consécutifs du chemin natif avant de basculer sur le flux
// maison. Un incident ponctuel — réseau qui cligne, stockage momentanément
// indisponible — ne doit pas condamner le chemin léger et faire retélécharger
// 148 Mo. À la cadence de quatre heures, trois échecs représentent une
// demi-journée : c'est une panne, plus un incident.
const NATIVE_FAILURE_LIMIT = 3;

// Inactivité requise avant que l'application applique d'elle-même une mise à
// jour déjà téléchargée. Tools vit dans la barre système et peut tourner des
// semaines : sans cela une version reste en attente jusqu'à ce que
// l'utilisateur pense à redémarrer, ce qu'il ne fait pas.
const IDLE_APPLY_DELAY_MS = 30 * 60 * 1000;

// Cadence d'examen de cette inactivité. Bien plus serrée que la recherche de
// mise à jour : le calcul est local et ne coûte rien.
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Délai laissé au processus pour mourir après `quitAndInstall`. Passé ce délai,
// le redémarrage n'a pas eu lieu — c'est le SEUL échec observable, puisqu'un
// succès emporte le processus et ne laisse personne pour le constater.
const QUIT_GRACE_MS = 30 * 1000;

// Réglage retenant la version dont l'application automatique a échoué. Il est
// PERSISTANT à dessein : après un échec on relance l'application, donc un
// compteur en mémoire repartirait de zéro et l'on redémarrerait en boucle
// toutes les trente minutes sans jamais aboutir.
const AUTO_APPLY_FAILED_KEY = 'autoApplyFailedVersion';

// Durée d'affichage d'une notification flottante, alignée sur celle du message
// de lancement en arrière-plan.
const NOTICE_MS = 5000;

// Mode salle : installeur de la version cible, posé dans le dossier de
// l'application. Un nom unique suffit : un seul téléchargement à la fois.
const ARENA_INSTALLER_FILE = 'arena-update.exe';

// Mode salle : dernière installation lancée, `{ target, from }`. PERSISTANTE à
// dessein : si l'installeur échoue, Tools redémarre sur l'ancienne version, et
// seul ce réglage dit qu'on a déjà essayé. Sans lui, chaque battement relancerait
// l'installeur — et couperait la captation — indéfiniment.
const ARENA_ATTEMPT_KEY = 'arenaTargetAttempt';

// Mode salle : délai avant de retenter un téléchargement échoué. Le battement
// part aussi sur changement d'état, parfois à quelques secondes d'intervalle :
// sans ce délai, une release introuvable serait redemandée en rafale.
const ARENA_DOWNLOAD_RETRY_MS = 5 * 60 * 1000;

// Mise à jour ordonnée par un admin : délai maximal d'attente que le poste se
// libère (ffmpeg qui finalise son segment, découpe, envois), et cadence de
// vérification. Borné à dessein — un ordre coordonné par téléphone avec la
// salle ne doit pas rester lettre morte parce qu'un envoi s'éternise.
const FORCED_WAIT_MS = 60 * 1000;
const FORCED_POLL_MS = 2000;

class UpdateService {
    githubVersion = '';
    // L'updater natif a-t-il déjà été câblé, et a-t-il échoué ? Un échec fait
    // repasser définitivement ce poste sur le flux maison : mieux vaut le
    // chemin lent que plus de chemin du tout.
    #nativeReady = false;
    #nativeFailed = false;
    // Version téléchargée et prête, en attente du prochain démarrage. Sert au
    // menu du tray : sans elle, rien n'indique qu'une mise à jour attend.
    pendingVersion = undefined;
    #checkTimer = null;
    #idleTimer = null;
    // Une application automatique est-elle en cours ? Entre `quitAndInstall` et
    // le constat d'échec, le minuteur d'inactivité continue de battre : sans ce
    // garde il en lancerait une seconde par-dessus la première.
    #applying = false;
    // La recherche en cours vient-elle d'un clic sur « Check for update » ?
    // Une vérification périodique et une vérification demandée n'appellent pas
    // la même conclusion : la seconde doit aboutir à quelque chose.
    #userRequestedCheck = false;
    // L'utilisateur a cliqué pendant un travail et on lui a promis un
    // redémarrage « dès que ce sera terminé ». Cette promesse doit être tenue
    // sans attendre les trente minutes d'inactivité.
    #applyWhenFree = false;
    // Mode salle : version assignée par le serveur, version en cours de
    // téléchargement, et date du dernier téléchargement raté.
    #arenaTarget = null;
    #arenaDownloading = null;
    #arenaDownloadFailedAt = 0;
    // Une vérification Squirrel est-elle en cours ? Sans ce garde, deux appels
    // rapprochés se marchent dessus et le second échoue.
    #checking = false;
    #nativeFailures = 0;

    constructor() {
        this.localVersion = version;
    }

    /**
     * Mise à jour Windows par Squirrel, le mécanisme natif de l'installeur.
     *
     * On ne demande JAMAIS `quitAndInstall` : Squirrel dépose la nouvelle
     * version dans un dossier versionné à côté, et le lanceur la prend au
     * démarrage suivant. Ne pas forcer le redémarrage supprime toute modale et
     * n'interrompt jamais une analyse en cours — c'est le comportement qu'on
     * envie à Discord, et c'est aussi le moins risqué.
     *
     * Le succès n'est pas signalé : c'est l'événement `launch` suivant, portant
     * la nouvelle version, qui le prouve mieux qu'un événement émis d'avance.
     */
    #checkNative() {
        if (!this.#nativeReady) {
            // Squirrel.Mac attend un manifeste JSON et veut qu'on le dise ;
            // Squirrel.Windows attend un dossier dans lequel il cherche
            // RELEASES lui-même.
            NATIVE.setFeedURL(
                os.platform() === 'darwin'
                    ? { url: UPDATE_FEED_URL, serverType: 'json' }
                    : { url: UPDATE_FEED_URL }
            );

            NATIVE.on('checking-for-update', () => {
                console.log(`[update] native: checking ${UPDATE_FEED_URL}`);
            });

            NATIVE.on('update-not-available', () => {
                this.#checking = false;
                this.#nativeFailures = 0;
                console.log(
                    `[update] native: up to date (${this.localVersion})`
                );

                // Le clic mérite une réponse, même quand la réponse est « rien
                // à faire » : sans elle, l'utilisateur ne peut pas distinguer
                // « déjà à jour » de « le bouton ne marche pas ».
                if (this.#userRequestedCheck) {
                    this.#userRequestedCheck = false;
                    this.#notice(
                        'fa-sharp fa-solid fa-check',
                        '.common.alreadyUpToDate',
                        'success'
                    );
                }
            });

            NATIVE.on('update-available', () => {
                console.log('[update] native: update available, downloading');
                telemetryService.reportUpdate('update_available', {
                    feed: UPDATE_FEED_URL
                });
            });

            // Sous Windows, `releaseName` porte la version. Sans elle, le log
            // ne dirait pas CE QUI attend, ce qui est justement l'information
            // utile quand une mise à jour ne s'applique pas.
            NATIVE.on(
                'update-downloaded',
                (event, releaseNotes, releaseName) => {
                    this.#checking = false;
                    this.#nativeFailures = 0;
                    this.pendingVersion = releaseName || 'inconnue';
                    console.log(
                        `[update] native: ${this.pendingVersion} installée, ` +
                            'sera appliquée au prochain démarrage'
                    );
                    // Mode salle : la page admin attend ce moment pour proposer
                    // l'installation. Sans battement immédiat, elle ne le
                    // saurait qu'au périodique, jusqu'à 20 min plus tard.
                    arenaModeService.notifyChange();
                    this.#applyAfterUserCheck();
                }
            );

            NATIVE.on('error', (error) => {
                this.#checking = false;

                // Squirrel refuse une vérification quand la précédente tourne
                // encore. Ce n'est pas une panne : c'est notre propre appel
                // concurrent. Le compter comme un échec ferait basculer le
                // poste sur le flux maison — donc retélécharger l'installeur
                // entier — alors que le téléchargement en cours va aboutir.
                if (/already running/i.test(error.message)) {
                    console.log(
                        '[update] native: check already in progress, ignored'
                    );
                    return;
                }

                // Le clic est perdu avec cette vérification : le laisser
                // armé ferait redémarrer l'application sur le battement des
                // quatre heures, sans que personne l'ait demandé.
                this.#userRequestedCheck = false;

                this.#nativeFailures += 1;
                console.error(
                    `[update] native failed (${this.#nativeFailures}/${NATIVE_FAILURE_LIMIT}):`,
                    error.message
                );
                telemetryService.reportUpdate('update_failed', {
                    reason: `native: ${error.message}`
                });

                // Repli seulement après plusieurs échecs consécutifs : un poste
                // ne doit jamais rester sans chemin de mise à jour, mais un
                // incident ponctuel ne justifie pas d'abandonner le chemin léger.
                if (this.#nativeFailures >= NATIVE_FAILURE_LIMIT) {
                    this.#nativeFailed = true;
                    console.error('[update] native abandoned, falling back');
                    this.autoUpdate(true);
                }
            });

            this.#nativeReady = true;
        }

        if (this.#checking) {
            console.log('[update] native: check already in progress, skipped');
            return;
        }

        this.#checking = true;
        NATIVE.checkForUpdates();
    }

    //#region Functions

    /**
     * Mode salle : mise à jour FORCÉE, sans aucun dialogue ni UI — ordonnée
     * par un admin via le heartbeat, à exécuter immédiatement (le PC de salle
     * tourne sans humain ; sous Windows l'installeur Squirrel est silencieux
     * et relance l'app tout seul). No-op si déjà à jour ou en dev.
     *
     * La captation n'est arrêtée qu'une fois l'installation décidée : un ordre
     * qui tourne court (déjà à jour, GitHub injoignable, téléchargement raté)
     * ne doit pas laisser la salle sans enregistrement, car rien ne la
     * relancerait avant le prochain démarrage.
     */
    forceUpdate() {
        if (IS_DEV_MODE || this.localVersion.startsWith('0')) return;

        // Poste de salle : la version vient du serveur, pas de GitHub. L'ordre
        // sert alors à réessayer une installation qui a échoué.
        if (this.#isArena()) {
            StorageManager.setPermanentSettingsValue(ARENA_ATTEMPT_KEY, null);
            this.#arenaDownloadFailedAt = 0;
            if (this.#arenaTarget) this.setArenaTarget(this.#arenaTarget);
            return;
        }

        // Squirrel a déjà déposé la version sur le disque : il ne reste qu'à
        // redémarrer. Le chemin GitHub ci-dessous retéléchargerait l'installeur
        // ENTIER (149 Mo) pour arriver exactement au même résultat — sur la
        // connexion d'une salle, et alors que la captation est déjà à l'arrêt.
        //
        // `applyPendingUpdate()` sans marqueur d'échec : un ordre d'admin est
        // une action humaine, elle doit rester rejouable. Poser le marqueur
        // condamnerait en plus la fenêtre de maintenance pour cette version.
        if (this.pendingVersion) {
            console.log(
                `[update] forced update → ${this.pendingVersion} already ` +
                    'downloaded, waiting for the machine to be free'
            );
            arenaCaptureService.stopCapture();
            this.#applyOnceFree(FORCED_WAIT_MS);
            return;
        }

        this.getProjectLatestVersion(() => {
            if (!this.githubVersion || this.githubVersion === this.localVersion) {
                return;
            }
            const NAMES = this.#assetNames();
            if (!NAMES) return;
            console.log(
                `[update] forced update ${this.localVersion} → ${this.githubVersion}`
            );
            telemetryService.reportUpdate('update_available', {
                target: this.githubVersion,
                forced: true
            });
            this.#downloadAndInstall(NAMES, true);
        });
    }

    /**
     * Mode salle : téléchargement ordonné par un admin, SANS installation. Sert
     * à préparer une fenêtre courte : Squirrel dépose la version à l'avance, et
     * l'ordre de mise à jour (`forceUpdate`) n'a plus qu'à redémarrer. La
     * captation n'est pas touchée.
     *
     * Squirrel seul : le flux maison ne sait que télécharger PUIS installer.
     * Sur ce chemin l'ordre est ignoré, l'ordre de mise à jour reste disponible.
     */
    predownload() {
        if (IS_DEV_MODE || this.localVersion.startsWith('0')) return;

        // Poste de salle : le téléchargement suit la version cible, de lui-même.
        if (this.#isArena()) {
            console.log('[update] predownload: arena follows its target, ignored');
            return;
        }

        if (this.pendingVersion) {
            console.log(
                `[update] predownload: ${this.pendingVersion} already downloaded`
            );
            arenaModeService.notifyChange();
            return;
        }

        if (!['win32', 'darwin'].includes(os.platform()) || this.#nativeFailed) {
            console.log(
                '[update] predownload: native updater unavailable, ignored'
            );
            return;
        }

        console.log('[update] predownload ordered by admin');
        this.#checkNative();
    }

    /**
     * Attend que le poste se libère, puis applique la version en attente.
     *
     * L'appelant vient d'arrêter la captation, mais `stopCapture` est
     * SYNCHRONE : il écrit `q` sur l'entrée de ffmpeg et rend la main aussitôt,
     * alors que la finalisation du segment prend quelques secondes. L'ancien
     * chemin masquait ce délai derrière le téléchargement de l'installeur ;
     * appliquer directement couperait ffmpeg en pleine écriture.
     *
     * @param {number} timeoutMs Au-delà, on applique quand même.
     */
    #applyOnceFree(timeoutMs) {
        this.#whenFree(timeoutMs, () => {
            if (this.pendingVersion) this.applyPendingUpdate();
        });
    }

    /**
     * Exécute `action` dès que le poste est libre, ou au plus tard après
     * `timeoutMs`.
     */
    #whenFree(timeoutMs, action) {
        const DEADLINE = Date.now() + timeoutMs;

        const TICK = () => {
            if (activityTracker.isBusy() && Date.now() < DEADLINE) {
                setTimeout(TICK, FORCED_POLL_MS);
                return;
            }

            if (activityTracker.isBusy()) {
                console.log(
                    '[update] forced update: still busy after ' +
                        `${timeoutMs / 1000}s, applying anyway`
                );
            }
            action();
        };

        TICK();
    }

    /**
     * Noms de l'asset GitHub et du fichier local d'installation pour la
     * plateforme courante. Null si plateforme non gérée.
     */
    #assetNames() {
        switch (os.platform()) {
            case 'win32':
                return {
                    githubFileName: `EBP-Tools-${this.githubVersion}.exe`,
                    localFileName: 'update.exe'
                };
            case 'darwin': {
                const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
                return {
                    githubFileName: `EBP-Tools-${this.githubVersion}-${ARCH}.dmg`,
                    localFileName: 'update.dmg'
                };
            }
        }
        return null;
    }

    /**
     * Télécharge l'installeur de `githubVersion` puis le lance et quitte
     * l'app. Partagé entre le flux interactif (autoUpdate) et le flux forcé
     * du mode salle.
     *
     * @param {boolean} stopCapture Mode salle : la captation tourne pendant le
     * téléchargement et n'est arrêtée qu'une fois l'installeur sur le disque,
     * en laissant à ffmpeg le temps de finaliser son segment.
     */
    #downloadAndInstall({ githubFileName, localFileName }, stopCapture = false) {
        const FILE_URL = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${this.githubVersion}/${githubFileName}`;
        const DESTINATION_PATH = path.join(
            app.getPath('userData'),
            localFileName
        );
        telemetryService.reportUpdate('update_started', {
            target: this.githubVersion
        });

        const ON_ERROR = (reason) => {
            console.error(`[update] download failed: ${reason}`);
            telemetryService.reportUpdate('update_failed', {
                target: this.githubVersion,
                reason
            });
        };

        const INSTALL = () => {
            switch (os.platform()) {
                case 'win32':
                    spawn(DESTINATION_PATH, {
                        detached: true,
                        stdio: 'ignore'
                    }).unref();
                    break;
                case 'darwin':
                    spawn('open', [DESTINATION_PATH], {
                        detached: true,
                        stdio: 'ignore'
                    }).unref();
                    break;
            }

            // Même piège que pour `quitAndInstall` : la fenêtre principale
            // annule sa propre fermeture pour se cacher, et `app.quit()` passe
            // par cette fermeture — il se faisait donc annuler. L'installeur
            // démarrait alors que l'application tournait encore, et devait la
            // tuer lui-même pour remplacer ses fichiers. On lui rend la place.
            const WINDOW = getMainWindow();
            if (WINDOW && !WINDOW.isDestroyed()) {
                WINDOW.destroy();
            }

            app.quit();
        };

        this.#download(FILE_URL, DESTINATION_PATH, () => {
            if (!stopCapture) {
                INSTALL();
                return;
            }
            arenaCaptureService.stopCapture();
            this.#whenFree(FORCED_WAIT_MS, INSTALL);
        }, ON_ERROR);
    }

    /**
     * Automatically updates the application.
     * @param {boolean} invisible Should we hide the graphical update elements?
     */
    autoUpdate(invisible) {
        if (IS_DEV_MODE || this.localVersion.startsWith('0')) {
            return;
        }

        // Poste de salle : jamais le flux commun. Une release y partirait vers
        // toutes les salles, et Squirrel y défairait tout retour à une version
        // antérieure. La version vient du serveur (`setArenaTarget`).
        if (this.#isArena()) return;

        // Windows et macOS passent par Squirrel, qui télécharge et installe en
        // tâche de fond sans rien demander. Le flux maison reste le repli, et
        // demeure le seul chemin sous Linux, que Squirrel ne couvre pas.
        const NATIVE_PLATFORMS = ['win32', 'darwin'];
        if (NATIVE_PLATFORMS.includes(os.platform()) && !this.#nativeFailed) {
            // `invisible === false` ne vient que du menu du tray : c'est un
            // clic de l'utilisateur, pas le battement des quatre heures.
            if (invisible === false) {
                this.#userRequestedCheck = true;
            }
            this.#checkNative();
            return;
        }

        this.getProjectLatestVersion(async () => {
            if (this.githubVersion) {
                if (this.githubVersion != this.localVersion) {
                    let githubFileName = '';
                    let localFileName = '';
                    switch (os.platform()) {
                        case 'win32':
                            githubFileName = `EBP-Tools-${this.githubVersion}.exe`;
                            localFileName = `update.exe`;
                            break;
                        case 'darwin':
                            // Starting with the multi-arch release, macOS
                            // DMGs are published with an arch suffix
                            // (`-arm64` for Apple Silicon, `-x64` for
                            // Intel). `process.arch` reports the arch of
                            // the currently running Electron binary, which
                            // is what we want: an arm64 build running
                            // under Rosetta on an Intel Mac should keep
                            // pulling the arm64 DMG.
                            const ARCH =
                                process.arch === 'arm64' ? 'arm64' : 'x64';
                            githubFileName = `EBP-Tools-${this.githubVersion}-${ARCH}.dmg`;
                            localFileName = `update.dmg`;
                            break;
                    }

                    if (githubFileName && localFileName) {
                        telemetryService.reportUpdate('update_available', {
                            target: this.githubVersion
                        });

                        // Un PC de salle tourne sans personne devant : la
                        // question resterait sans réponse, et se réempilerait
                        // toutes les quatre heures. La mise à jour passe alors
                        // par l'ordre d'un admin (`forceUpdate`).
                        if (arenaModeService.getState().registered) {
                            console.log(
                                `[update] ${this.githubVersion} available, ` +
                                    'no dialog in arena mode — waiting for an admin order'
                            );
                            return;
                        }

                        const { response } = await dialog.showMessageBox(
                            getMainWindow(),
                            {
                                type: 'question',
                                buttons: ['Update', 'Later'],
                                defaultId: 0,
                                cancelId: 1,
                                title: 'Update available',
                                message: `A new version (${this.githubVersion}) is available. Do you want to install it now?`
                            }
                        );
                        if (response !== 0) {
                            return;
                        }

                        getMainWindow().webContents.send(
                            'global-message',
                            'common.updatingInProgress'
                        );

                        if (invisible === false) {
                            getMainWindow()?.hide();

                            createFloatingWindow(
                                450,
                                150,
                                JSON.stringify({
                                    percent: 0,
                                    leftRounded: true,
                                    infinite: false,
                                    icon: undefined,
                                    text: '.common.updatingInProgress',
                                    state: 'info'
                                })
                            );
                        }

                        this.#downloadAndInstall({
                            githubFileName,
                            localFileName
                        });
                    }
                }
            }
        });
    }

    /**
     * Vérifie au démarrage, puis toutes les quatre heures.
     *
     * La vérification était auparavant accrochée à l'AFFICHAGE de la fenêtre,
     * ce qui produisait deux défauts opposés : un poste lancé au démarrage de
     * session garde sa fenêtre masquée et ne vérifiait donc JAMAIS, tandis
     * qu'ouvrir et fermer la fenêtre relançait une vérification à chaque fois.
     * La découpler de l'interface corrige les deux.
     *
     * Idempotent : un second appel ne crée pas un second minuteur.
     */
    startPeriodicCheck() {
        if (this.#checkTimer) {
            return;
        }

        this.autoUpdate(true);
        this.#checkTimer = setInterval(
            () => this.autoUpdate(true),
            CHECK_INTERVAL_MS
        );
        this.#idleTimer = setInterval(
            () => this.#considerIdleApply(),
            IDLE_CHECK_INTERVAL_MS
        );
    }

    /**
     * Applique d'elle-même une mise à jour téléchargée quand l'application est
     * restée inactive assez longtemps.
     *
     * Le redémarrage est invisible : la fenêtre est masquée par définition (on
     * s'abstient sinon), et l'application revient dans la barre système.
     */
    #considerIdleApply() {
        if (!this.pendingVersion || this.#applying) return;

        // Mode salle : la version est celle que le serveur assigne
        // (`setArenaTarget`), jamais une version déposée par Squirrel.
        if (this.#isArena()) return;

        if (activityTracker.isBusy()) return;

        // Promesse tenue : l'utilisateur a cliqué pendant un travail, la
        // notification lui a annoncé un redémarrage à la fin de celui-ci. Ni
        // les trente minutes ni la fenêtre ouverte ne s'y opposent — c'est lui
        // qui l'a demandé.
        if (this.#applyWhenFree) {
            this.#applyWhenFree = false;
            console.log(
                `[update] work finished → applying ${this.pendingVersion} as promised`
            );
            this.applyPendingUpdate();
            return;
        }

        // Fenêtre ouverte : l'utilisateur est devant l'IHM. On repousse le
        // compteur, pour qu'il faille de nouveau trente minutes après sa
        // fermeture — sinon la refermer déclencherait un redémarrage immédiat.
        const WINDOW = getMainWindow();
        if (WINDOW && !WINDOW.isDestroyed() && WINDOW.isVisible()) {
            activityTracker.ping();
            return;
        }

        if (activityTracker.idleMs() < IDLE_APPLY_DELAY_MS) return;

        // Cette version a déjà fait échouer une application automatique : on ne
        // la retente pas. Elle s'appliquera au prochain démarrage manuel, par
        // le lanceur, sans rien casser entre-temps.
        if (
            StorageManager.getPermanentSettingsValue(AUTO_APPLY_FAILED_KEY) ===
            this.pendingVersion
        ) {
            return;
        }

        console.log(
            `[update] idle for ${Math.round(activityTracker.idleMs() / 60000)} min ` +
                `→ applying ${this.pendingVersion}`
        );
        this.applyPendingUpdate(true);
    }

    /**
     * Ce poste est-il un poste de salle piloté par sa version cible ? Windows
     * seulement : sous macOS l'installeur est un .dmg, qui attend un humain.
     */
    #isArena() {
        return (
            os.platform() === 'win32' &&
            arenaModeService.getState().registered
        );
    }

    /**
     * Mode salle : aligne le poste sur la version que le serveur lui assigne,
     * reçue par le battement ou par le socket. Seul chemin de mise à jour d'un
     * poste de salle, dans les deux sens : l'installeur complet de la version
     * cible remplace la version en place, qu'elle soit plus récente ou plus
     * ancienne — Squirrel, lui, ne sait que monter.
     *
     * Télécharge sans toucher à la captation, puis installe aussitôt. Idempotent :
     * rappelé à chaque battement, il ne relance ni un téléchargement en cours ni
     * une installation déjà tentée depuis cette version.
     *
     * @param {string} target Version assignée par le serveur.
     */
    setArenaTarget(target) {
        if (IS_DEV_MODE || this.localVersion.startsWith('0')) return;
        if (!this.#isArena() || typeof target !== 'string' || !target) return;

        this.#arenaTarget = target;
        if (target === this.localVersion) return;
        // Le téléchargement en cours relira la cible en finissant.
        if (this.#arenaDownloading) return;
        if (Date.now() - this.#arenaDownloadFailedAt < ARENA_DOWNLOAD_RETRY_MS) {
            return;
        }

        // L'installeur a déjà été lancé vers cette cible depuis cette version,
        // et l'on tourne toujours sur l'ancienne : il a échoué. On ne le relance
        // pas de soi-même — l'ordre de mise à jour d'un admin efface ce
        // marqueur (`forceUpdate`).
        const ATTEMPT = StorageManager.getPermanentSettingsValue(ARENA_ATTEMPT_KEY);
        if (
            ATTEMPT &&
            ATTEMPT.target === target &&
            ATTEMPT.from === this.localVersion
        ) {
            if (!ATTEMPT.reported) {
                console.error(
                    `[update] arena: ${target} installer ran but ` +
                        `${this.localVersion} is still running`
                );
                telemetryService.reportUpdate('update_failed', {
                    target,
                    reason: 'installer ran, version unchanged'
                });
                StorageManager.setPermanentSettingsValue(ARENA_ATTEMPT_KEY, {
                    ...ATTEMPT,
                    reported: true
                });
            }
            return;
        }

        const FILE_URL = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${target}/EBP-Tools-${target}.exe`;
        const DESTINATION_PATH = path.join(
            app.getPath('userData'),
            ARENA_INSTALLER_FILE
        );
        console.log(
            `[update] arena target ${target} (running ${this.localVersion}) ` +
                '→ downloading installer'
        );
        this.#arenaDownloading = target;
        telemetryService.reportUpdate('update_started', { target });

        this.#download(
            FILE_URL,
            DESTINATION_PATH,
            () => {
                this.#arenaDownloading = null;
                // La cible a changé pendant le téléchargement : ce fichier ne
                // sert plus, on repart sur la nouvelle (ou on reste, si elle est
                // revenue à la version en place).
                if (this.#arenaTarget !== target) {
                    console.log(
                        `[update] arena: ${target} downloaded but target is now ` +
                            `${this.#arenaTarget} → discarded`
                    );
                    this.setArenaTarget(this.#arenaTarget);
                    return;
                }
                this.#installArenaTarget(target, DESTINATION_PATH);
            },
            (reason) => {
                this.#arenaDownloading = null;
                this.#arenaDownloadFailedAt = Date.now();
                console.error(
                    `[update] arena: ${target} download failed: ${reason}`
                );
                telemetryService.reportUpdate('update_failed', {
                    target,
                    reason
                });
            }
        );
    }

    /**
     * Mode salle : arrête la captation, attend que le poste se libère (ffmpeg
     * finalise son segment), puis lance l'installeur et quitte. L'installeur
     * relance Tools, qui reprend la captation au boot.
     */
    #installArenaTarget(target, installerPath) {
        console.log(`[update] arena: installing ${target}, stopping capture`);
        arenaCaptureService.stopCapture();

        this.#whenFree(FORCED_WAIT_MS, () => {
            // La cible a changé pendant l'attente : on n'installe pas, et l'on
            // rend la captation — une salle sans enregistrement est le pire
            // des échecs.
            if (this.#arenaTarget !== target) {
                arenaCaptureService.autoStart();
                this.setArenaTarget(this.#arenaTarget);
                return;
            }

            // Posé AVANT de lancer : un échec ramène sur l'ancienne version sans
            // que personne ne revienne l'écrire.
            StorageManager.setPermanentSettingsValue(ARENA_ATTEMPT_KEY, {
                target,
                from: this.localVersion
            });
            spawn(installerPath, {
                detached: true,
                stdio: 'ignore'
            }).unref();

            // Même piège que dans `#downloadAndInstall` : la fenêtre principale
            // annule sa propre fermeture pour se cacher.
            const WINDOW = getMainWindow();
            if (WINDOW && !WINDOW.isDestroyed()) {
                WINDOW.destroy();
            }

            app.quit();
        });
    }

    /**
     * Une mise à jour vient d'être téléchargée à la suite d'un clic sur
     * « Check for update ». L'utilisateur a demandé quelque chose : laisser la
     * version en attente, sans rien de visible, donne l'impression que son clic
     * n'a servi à rien — il faudrait qu'il rouvre le menu pour découvrir qu'un
     * second clic est attendu. On applique donc tout de suite.
     *
     * Deux abstentions, dans lesquelles le menu affichera « Restart to apply »
     * et lui laissera la décision : un travail en cours, qu'un redémarrage
     * couperait, et une fenêtre ouverte, qu'il regarde peut-être — « Check for
     * update » ne promet pas de la fermer, au contraire de « Restart ».
     */
    #applyAfterUserCheck() {
        if (!this.#userRequestedCheck) return;
        this.#userRequestedCheck = false;

        // Un travail tourne : le couper serait la pire réponse à un clic
        // anodin. On l'annonce, et `#considerIdleApply` tiendra la promesse
        // dès que la dernière tâche se sera achevée.
        if (activityTracker.isBusy()) {
            // Sauf en mode salle : ce poste tourne sans personne devant lui et
            // enchaîne les sessions. Un redémarrage différé s'y déclencherait
            // dans un creux, sans témoin — c'est précisément ce qu'on interdit
            // aux mises à jour automatiques. On ne promet donc rien qu'on ne
            // tiendra pas ; la voie coordonnée reste l'ordre de l'admin.
            //
            // Machine LIBRE, en revanche, on redémarre même en mode salle : le
            // clic est une action humaine, délibérée, devant l'écran.
            if (arenaModeService.getState().registered) {
                console.log(
                    `[update] ${this.pendingVersion} ready, arena mode busy ` +
                        '→ left for the next restart'
                );
                this.#notice(
                    'fa-sharp fa-solid fa-download',
                    '.common.updateReadyOnRestart',
                    'info'
                );
                return;
            }

            console.log(
                `[update] ${this.pendingVersion} ready but Tools is busy ` +
                    '→ will restart once free'
            );
            this.#applyWhenFree = true;
            this.#notice(
                'fa-sharp fa-solid fa-download',
                '.common.updateReadyWhenFree',
                'info'
            );
            return;
        }

        this.applyPendingUpdate();
    }

    /**
     * Affiche une notification flottante quelques secondes.
     *
     * La fenêtre flottante est UNIQUE et partagée avec les barres de
     * progression des analyses, des découpes et des téléchargements : la
     * réquisitionner effacerait la progression qu'un travail y affiche, et
     * l'effacer au bout de cinq secondes la lui retirerait pour de bon. Quand
     * elle est déjà prise on s'abstient donc — l'utilisateur a de toute façon
     * sous les yeux la preuve que Tools travaille.
     */
    #notice(icon, text, state) {
        if (getFloatingWindow()) {
            console.log(
                `[update] notice skipped, floating window in use: ${text}`
            );
            return;
        }

        createFloatingWindow(
            450,
            150,
            JSON.stringify({
                percent: 100,
                infinite: false,
                icon,
                text,
                leftRounded: true,
                state
            })
        ).catch((error) =>
            console.error('[update] floating notice failed', error.message)
        );

        setTimeout(() => deleteFloatingWindow(false), NOTICE_MS);
    }

    /**
     * Appelé quand le processus vit encore après `quitAndInstall` : le
     * redémarrage n'a pas eu lieu, et la fenêtre principale a été détruite —
     * « Open » ne répondrait plus, l'IHM serait injoignable et rien ne le
     * dirait. On relance donc l'application, qui revient sur la version
     * courante, en état de marche ; la mise à jour s'appliquera au démarrage
     * suivant, par le lanceur.
     *
     * `app.exit` plutôt que `app.quit` : le second repasse par la fermeture des
     * fenêtres, c'est-à-dire précisément le chemin qui vient d'échouer.
     */
    #recoverFromFailedQuit(target) {
        console.error(
            `[update] ${target} not applied: still running ` +
                `${QUIT_GRACE_MS / 1000}s after quitAndInstall — relaunching`
        );
        telemetryService.reportUpdate('update_failed', {
            target,
            reason: 'quitAndInstall left the process alive'
        });
        app.relaunch();
        app.exit(0);
    }

    /**
     * Applique une mise à jour déjà téléchargée.
     *
     * `app.relaunch()` ne conviendrait pas : il relance `process.execPath`,
     * donc l'exécutable de la version COURANTE — l'ancienne redémarrerait.
     * Seul `quitAndInstall` passe par le lanceur Squirrel, qui bascule sur la
     * nouvelle version.
     *
     * L'appel se surveille lui-même quelle qu'en soit l'origine : la fenêtre
     * vient d'être détruite, et si le redémarrage n'a pas lieu, « Open » ne
     * répondrait plus. C'est précisément la panne observée en juillet, où trois
     * clics sur « Confirm restart » n'ont fait que masquer la fenêtre.
     *
     * @param {boolean} automatic Déclenché par l'inactivité plutôt que par
     * l'utilisateur. Seul ce cas mémorise un échec : une tentative demandée
     * doit toujours pouvoir être retentée.
     */
    applyPendingUpdate(automatic = false) {
        if (!this.pendingVersion) {
            return;
        }
        const TARGET = this.pendingVersion;
        console.log(
            `[update] applying ${TARGET} ${automatic ? 'after idle' : 'on user request'}`
        );

        // La fenêtre principale intercepte sa fermeture pour se CACHER au lieu
        // de quitter (`event.preventDefault()` dans window-manager). Or
        // `quitAndInstall` appelle `app.quit()`, qui déclenche cette fermeture,
        // se fait annuler, et renonce : l'app masquait donc sa fenêtre en
        // restant sur l'ancienne version, sans rien signaler.
        //
        // On détruit la fenêtre d'abord — `destroy()` court-circuite le
        // gestionnaire de fermeture —, exactement comme le fait l'entrée
        // « Quit » du tray, qui est la seule à fonctionner pour cette raison.
        const WINDOW = getMainWindow();
        if (WINDOW && !WINDOW.isDestroyed()) {
            WINDOW.destroy();
        }

        this.#applying = true;

        if (automatic) {
            // Marqueur posé AVANT la tentative : un échec peut prendre la forme
            // d'un plantage, dont on ne reviendrait pas pour l'écrire. Le
            // laisser en place après une réussite est sans conséquence — la
            // version suivante portera un autre numéro.
            StorageManager.setPermanentSettingsValue(
                AUTO_APPLY_FAILED_KEY,
                TARGET
            );
        }

        setTimeout(() => this.#recoverFromFailedQuit(TARGET), QUIT_GRACE_MS);

        NATIVE.quitAndInstall();
    }

    /**
     * Retrieves the number of the latest published version of the project.
     * @param {Function} callback (Optional) Return function.
     */
    getProjectLatestVersion(callback) {
        const OPTIONS = {
            hostname: 'api.github.com',
            path: `/repos/${UPDATE_REPOSITORY}/releases`,
            method: 'GET',
            headers: { 'User-Agent': '' }
        };

        const REQUEST = https.request(OPTIONS, (res) => {
            let data = '';

            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const DATA = JSON.parse(data);
                    const RELEASE = DATA.find(
                        (r) => r.tag_name && !r.tag_name.startsWith('0')
                    );
                    this.githubVersion = RELEASE ? RELEASE.tag_name : undefined;

                    if (typeof callback !== 'undefined') {
                        callback();
                    }
                } catch (err) {}
            });
        });

        REQUEST.on('error', (err) => console.error(err));
        REQUEST.end();
    }

    /**
     * Downloads a file.
     * @param {String} url URL of the file to download.
     * @param {String} dest Path to place the file.
     * @param {Function} callback Callback function.
     */
    #download(url, dest, callback, onError) {
        const REQUEST = https.get(url, (res) => {
            // Redirection
            if (
                (res.statusCode === 301 || res.statusCode === 302) &&
                res.headers.location
            ) {
                return this.#download(
                    res.headers.location,
                    dest,
                    callback,
                    onError
                );
            }

            if (res.statusCode !== 200) {
                res.resume();
                onError?.(`HTTP ${res.statusCode}`);
                return;
            }

            const TOTAL = Number.parseInt(res.headers['content-length'], 10);
            let downloaded = 0;
            let lastPercent = 0;

            const FILE = fs.createWriteStream(dest);

            res.on('data', (chunk) => {
                downloaded += chunk.length;

                const WINDOW = getMainWindow();
                if (TOTAL && WINDOW && !WINDOW.isDestroyed()) {
                    const PERCENT = Math.round((downloaded / TOTAL) * 100);
                    if (PERCENT > lastPercent) {
                        lastPercent = PERCENT;
                        WINDOW.webContents.send(
                            'set-notification-data',
                            {
                                percent: PERCENT,
                                infinite: PERCENT == 100,
                                icon:
                                    PERCENT == 100
                                        ? 'fa-sharp fa-solid fa-download'
                                        : undefined,
                                text: '.common.updatingInProgress',
                                leftRounded: true,
                                state: 'info'
                            }
                        );
                    }
                }
            });

            res.pipe(FILE);

            FILE.on('error', (err) => onError?.(err.message));

            FILE.on('finish', () => {
                FILE.close(() => {
                    // On Windows, the OS may not release the file handle immediately after close(), causing EBUSY when trying to spawn the installer.
                    // A short delay ensures the kernel has fully released the file.
                    if (os.platform() === 'win32') {
                        setTimeout(() => callback?.(), 500);
                    } else {
                        callback?.();
                    }
                });
            });
        });

        // Sans cet écouteur, une coupure réseau émet un 'error' non géré, ce
        // qui fait planter le processus principal au lieu d'échouer proprement.
        REQUEST.on('error', (err) => onError?.(err.message));
    }

    //#endregion
}

module.exports = UpdateService;
