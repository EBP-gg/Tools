// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('path');

module.exports = {
    packagerConfig: {
        asar: true,
        extraResource: [
            './angular/dist/angular/browser/',
            './electron/assets/',
            './electron/template.xlsx',
            './binaries/audio-loopback/',
            './app-update.yml'
        ],
        icon: 'electron/assets/icon',
        name: 'EBP - Tools',
        executableName: 'ebp-tools',
        protocols: [
            {
                name: 'EBP Tools Protocol',
                schemes: ['tools']
            }
        ],
        osxSign: process.env.SKIP_NOTARIZATION
            ? false
            : {
                  identity:
                      'Developer ID Application: Antoine Duval (5DQ59NSHNB)',
                  hardenedRuntime: true,
                  entitlements: 'build/entitlements.plist',
                  'entitlements-inherit': 'build/entitlements.plist'
              },
        osxNotarize: process.env.SKIP_NOTARIZATION
            ? false
            : {
                  appleId: process.env.APPLE_ID,
                  appleIdPassword: process.env.APPLE_PASSWORD,
                  teamId: process.env.APPLE_TEAM_ID
              }
    },
    rebuildConfig: {
        /*
        onlyModules: [],
        force: false,
        debug: false,
        extraModules: [],
        disablePreGypCopy: false,
        types: ['prod', 'optional'],
        prebuildTagPrefix: 'v',
        mode: 'sequential',
        exclude: ['register-scheme']
        */
    },
    makers: [
        {
            // Windows
            name: '@electron-forge/maker-squirrel',
            config: {
                setupIcon: './electron/assets/icon.ico',
                loadingGif: './electron/assets/install.gif',
                description: 'EBP - Tools',
                // Flux des versions déjà publiées. Renseigné, il fait
                // télécharger les paquets précédents à electron-winstaller, qui
                // produit alors des paquets DELTA : seuls les fichiers modifiés
                // voyagent, soit ~5 Mo au lieu de 125 pour une release typique,
                // le moteur Electron (262 Mo) ne changeant pas d'une version à
                // l'autre.
                //
                // Laissé vide en local (build hors ligne) et au tout premier
                // passage, quand aucun RELEASES n'existe : le CI ne le renseigne
                // qu'après avoir constaté que le flux répond.
                remoteReleases: process.env.SQUIRREL_REMOTE_RELEASES || undefined
            }
        },
        {
            // Linux (Debian/Ubuntu)
            name: '@electron-forge/maker-deb',
            config: {
                options: {
                    icon: './electron/assets/icon.png',
                    maintainer: 'Antoine Duval',
                    homepage: 'https://github.com/HeyHeyChicken/EBP-Tools',
                    description:
                        'EBP - Tools is a tooling application for EVA (eva.gg) players, offering replay cutting, YouTube timecode generation, game history export, and replay downloading from YouTube and Twitch.',
                    productDescription:
                        'An application providing essential tools for EVA players including auto-cutting game replays, YouTube timecode generation, Excel export of game history, and replay downloading capabilities.',
                    categories: ['Game', 'Utility'],
                    section: 'games',
                    priority: 'optional',
                    depends: [
                        'libnotify4',
                        'libxtst6',
                        'libnss3',
                        'libxss1',
                        'tesseract-ocr',
                        'tesseract-ocr-eng'
                    ]
                }
            }
        },
        {
            // MacOS
            name: '@electron-forge/maker-dmg',
            config: {
                format: 'ULFO',
                name: 'EBP-Tools',
                icon: 'electron/assets/icon.icns',
                background: 'electron/assets/dmg-background.png',
                overwrite: true,
                window: {
                    size: {
                        width: 660,
                        height: 500
                    }
                }
            }
        },
        {
            // ZIP (.app) pour auto-update
            name: '@electron-forge/maker-zip',
            platforms: ['darwin'],
            config: {
                // Renseigné, le maker télécharge le RELEASES.json existant, y
                // ajoute cette version et le réécrit — l'exact équivalent de
                // `remoteReleases` côté Windows, en beaucoup plus simple
                // puisqu'il gère lui-même l'absence de manifeste au premier
                // passage. Laissé vide en local, ce qui garde le build hors
                // ligne.
                macUpdateManifestBaseUrl:
                    process.env.SQUIRREL_MAC_MANIFEST_BASE_URL || undefined
            }
        }
    ],
    plugins: [
        {
            name: '@electron-forge/plugin-auto-unpack-natives',
            config: {}
        },
        {
            name: '@electron-forge/plugin-webpack',
            config: {
                mainConfig: './webpack.main.config.js',
                renderer: {
                    config: './webpack.renderer.config.js',
                    entryPoints: [
                        {
                            html: './angular/dist/angular/browser/index.html',
                            js: './angular/dist/angular/browser/main.js',
                            name: 'main_window',
                            preload: {
                                js: './electron/preload.js'
                            }
                        }
                    ]
                }
            }
        },
        // Fuses are used to enable/disable various Electron functionality
        // at package time, before code signing the application
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true
        })
    ]
};
