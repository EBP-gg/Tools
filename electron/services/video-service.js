// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const {
    FFMPEG_PATH,
    DEFAULT_VIDEO_WIDTH,
    DEFAULT_VIDEO_HEIGHT
} = require('../config/constants');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('node:path');
const { unlinkSync, lowerProcessPriority } = require('./global-service');

//#endregion

/**
 * Durée d'une vidéo, en secondes. Lue dans la ligne `Duration:` que ffmpeg écrit
 * sur stderr quand on lui donne une entrée sans sortie : pas de ffprobe embarqué
 * dans `binaries/`, et cette ligne suffit.
 * @param inputPath Path to the video file.
 * @returns {Promise<number>} Duration in seconds.
 */
function probeVideoDuration(inputPath /* string */) {
    return new Promise((resolve, reject) => {
        const PROBE = spawn(FFMPEG_PATH, ['-i', inputPath]);

        let stderr = '';
        PROBE.stderr.on('data', (d) => (stderr += d.toString()));
        PROBE.on('error', reject);

        PROBE.on('close', () => {
            // Duration: 00:01:23.45, start: 0.000000, bitrate: ...
            const MATCH = stderr.match(/Duration:\s(\d+):(\d+):(\d+\.\d+)/);
            if (!MATCH) {
                reject(new Error(`Duration not found: ${inputPath}`));
                return;
            }
            resolve(+MATCH[1] * 3600 + +MATCH[2] * 60 + parseFloat(MATCH[3]));
        });
    });
}

/**
 * Upscales a video to 1920x1080 resolution using FFmpeg with progress tracking.
 * Sends real-time progress updates to the main window.
 * @param inputPath Path to the source video file to upscale.
 * @param outputPath Path where the upscaled video will be saved.
 * @param percentCallback Function called when the upscaling process percent changed.
 */
function changeVideoResolution(
    inputPath /* string */,
    outputPath /* string */,
    width /* number */,
    height /* number */,
    percentCallback /* Function */
) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }

        const FFMPEG_ARGS = [
            '-i',
            inputPath,
            '-vf',
            `scale=${width}:${height}:flags=lanczos`,
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '18',
            '-c:a',
            'copy',
            outputPath
        ];

        console.log(
            `[FFMPEG] Upscale - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);

        let duration = 0;

        // Retrieving duration + progress information
        FFMPEG.stderr.on('data', (data) => {
            const DATA = data.toString();

            // Log all ffmpeg output for debugging
            console.log(`[FFMPEG] Upscale - ${DATA.trim()}`);

            // Total duration
            const DURATION_MATCH = DATA.match(
                /Duration: (\d+):(\d+):(\d+\.\d+)/
            );
            if (DURATION_MATCH) {
                const HOURS = Number.parseInt(DURATION_MATCH[1]);
                const MINUTES = Number.parseInt(DURATION_MATCH[2]);
                const SECONDES = Number.parseFloat(DURATION_MATCH[3]);
                duration = HOURS * 3600 + MINUTES * 60 + SECONDES;
            }

            // Progress
            const TIME_MATCH = DATA.match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (TIME_MATCH && duration > 0) {
                const HOURS = Number.parseInt(TIME_MATCH[1]);
                const MINUTES = Number.parseInt(TIME_MATCH[2]);
                const SECONDES = Number.parseFloat(TIME_MATCH[3]);
                const CURRENT = HOURS * 3600 + MINUTES * 60 + SECONDES;

                const PERCENT = Math.ceil((CURRENT / duration) * 100);

                if (percentCallback) {
                    percentCallback(PERCENT);
                }
            }
        });

        FFMPEG.on('close', (code) => {
            if (code === 0) {
                resolve(outputPath);
            } else {
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        FFMPEG.on('error', (error) => {
            reject(error);
        });
    });
}

function removeBorders(inputPath, cropPosition) {
    return new Promise((resolve) => {
        const EXTENSION = inputPath.split('.').pop().toLowerCase();
        const VIDEO_DIR = path.dirname(inputPath);
        const VIDEO_NAME = path.basename(inputPath, `.${EXTENSION}`);
        const OUTPUT_FILE_PATH = path.join(
            VIDEO_DIR,
            `${VIDEO_NAME} - without borders.${EXTENSION}`
        );

        if (fs.existsSync(OUTPUT_FILE_PATH)) {
            unlinkSync(OUTPUT_FILE_PATH);
        }

        const FFMPEG_ARGS = [
            '-i',
            inputPath,
            '-vf',
            `crop=${cropPosition.x2 - cropPosition.x1}:${cropPosition.y2 - cropPosition.y1}:${cropPosition.x1}:${cropPosition.y1},scale=${DEFAULT_VIDEO_WIDTH}:${DEFAULT_VIDEO_HEIGHT},setsar=1`,
            '-r',
            '30',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            OUTPUT_FILE_PATH
        ];

        console.log(
            `[FFMPEG] Remove borders - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);

        let duration = 0;

        // Retrieving duration + progress information
        FFMPEG.stderr.on('data', (data) => {
            const DATA = data.toString();

            // Log all ffmpeg output for debugging
            console.log(`[FFMPEG] Remove borders - ${DATA.trim()}`);

            // Total duration
            const DURATION_MATCH = DATA.match(
                /Duration: (\d+):(\d+):(\d+\.\d+)/
            );
            if (DURATION_MATCH) {
                const HOURS = Number.parseInt(DURATION_MATCH[1]);
                const MINUTES = Number.parseInt(DURATION_MATCH[2]);
                const SECONDES = parseFloat(DURATION_MATCH[3]);
                duration = HOURS * 3600 + MINUTES * 60 + SECONDES;
            }

            // Progress
            const TIME_MATCH = DATA.match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (TIME_MATCH && duration > 0) {
                const HOURS = Number.parseInt(TIME_MATCH[1]);
                const MINUTES = Number.parseInt(TIME_MATCH[2]);
                const SECONDES = parseFloat(TIME_MATCH[3]);
                const CURRENT = HOURS * 3600 + MINUTES * 60 + SECONDES;

                const PERCENT = Math.ceil((CURRENT / duration) * 100);

                const { getMainWindow } = require('../core/window-manager');
                getMainWindow().webContents.send(
                    'set-remove-borders-percent',
                    PERCENT
                );
            }
        });

        FFMPEG.on('close', (code) => {
            resolve(OUTPUT_FILE_PATH);
        });
    });
}

function fixForBrowser(videoPath) {
    return new Promise((resolve, reject) => {
        const EXTENSION = videoPath.split('.').pop().toLowerCase();
        const VIDEO_DIR = path.dirname(videoPath);
        const TEMP_OUTPUT_PATH = path.join(
            VIDEO_DIR,
            `output_${Date.now()}.${EXTENSION}`
        );

        const FFMPEG_ARGS = [
            '-i',
            videoPath,
            '-c',
            'copy',
            '-movflags',
            'faststart',
            TEMP_OUTPUT_PATH
        ];

        console.log(
            `[FFMPEG] Fix for browser - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);

        FFMPEG.on('close', (code) => {
            if (code === 0 && fs.existsSync(TEMP_OUTPUT_PATH)) {
                unlinkSync(videoPath);
                fs.renameSync(TEMP_OUTPUT_PATH, videoPath);
                resolve(videoPath);
            } else {
                if (fs.existsSync(TEMP_OUTPUT_PATH)) {
                    unlinkSync(TEMP_OUTPUT_PATH);
                }
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });
    });
}

/**
 * Copies a video to `dest` while remuxing it (stream copy + faststart), so any
 * source — Twitch, YouTube or a raw capture — lands in the watch folder with a
 * clean container. Replaces a plain copy: same disk I/O, just a clean rewrite.
 * Never touches the source file. Falls back to a raw copy if FFmpeg fails, so a
 * file we couldn't remux still gets analyzed.
 * @param {string} src  Source video.
 * @param {string} dest Destination in the watch folder.
 * @returns {Promise<string>} Resolves with `dest`.
 */
function remuxToForAnalysis(src, dest) {
    return new Promise((resolve) => {
        const FFMPEG_ARGS = [
            '-y',
            '-i',
            src,
            '-c',
            'copy',
            '-movflags',
            'faststart',
            dest
        ];

        console.log(
            `[FFMPEG] Remux for analysis - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);

        FFMPEG.on('close', (code) => {
            if (code === 0 && fs.existsSync(dest)) {
                resolve(dest);
            } else {
                console.warn(
                    `[FFMPEG] Remux for analysis failed (code ${code}), falling back to raw copy`
                );
                if (fs.existsSync(dest)) {
                    unlinkSync(dest);
                }
                fs.copyFileSync(src, dest);
                resolve(dest);
            }
        });

        FFMPEG.on('error', (err) => {
            console.warn(
                `[FFMPEG] Remux for analysis errored (${err.message}), falling back to raw copy`
            );
            fs.copyFileSync(src, dest);
            resolve(dest);
        });
    });
}

/**
 * Cuts a video segment and re-encodes the video track to libx264 with a
 * keyframe every second, so the web player can seek to any timecode quickly
 * (a seek only needs to download/decode ~1s back to the nearest keyframe).
 * We re-encode even when the source is already H.264 because game capture
 * tools emit a coarse GOP (~4s), which makes scrubbing slow — stream-copy
 * would preserve that coarse spacing. Audio is re-encoded to AAC (MP4 doesn't
 * officially support Opus). Faststart for browser streaming. `-ss` before
 * `-i` keeps input seeking fast while the re-encode makes the cut start
 * frame-accurate at `startSec`.
 * @param {string} inputPath  Source video.
 * @param {string} outputPath Destination .mp4.
 * @param {number} startSec   Inclusive start time (seconds).
 * @param {number} endSec     Exclusive end time (seconds).
 * @returns {Promise<string>} Resolves with outputPath on success.
 */
async function cutAndEncodeGame(
    inputPath,
    outputPath,
    startSec,
    endSec,
    onProgress /* (percent: 0-100) => void, optionnel */
) {
    if (fs.existsSync(outputPath)) {
        unlinkSync(outputPath);
    }

    return new Promise((resolve, reject) => {
        const FFMPEG_ARGS = [
            '-ss',
            String(startSec),
            '-to',
            String(endSec),
            '-i',
            inputPath,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            // Keyframe toutes les secondes, indépendamment du fps source, pour un seek
            // fluide côté lecteur web (cf. game-player). `n_forced` = index de keyframe forcée.
            '-force_key_frames',
            'expr:gte(t,n_forced*1)',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
            outputPath
        ];

        console.log(
            `[FFMPEG] Cut+encode - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);

        // Durée de sortie connue : -ss/-to rebasent les timestamps à 0, donc le
        // `time=` de ffmpeg va de 0 à (endSec - startSec). On l'utilise pour la
        // progression plutôt que la ligne `Duration:` (= durée de la source
        // entière, pas du segment coupé).
        const OUT_DURATION = Math.max(0, endSec - startSec);

        FFMPEG.stderr.on('data', (data) => {
            const DATA = data.toString();
            console.log(`[FFMPEG] Cut+encode - ${DATA.trim()}`);

            if (onProgress && OUT_DURATION > 0) {
                const TIME_MATCH = DATA.match(/time=(\d+):(\d+):(\d+\.\d+)/);
                if (TIME_MATCH) {
                    const CURRENT =
                        Number.parseInt(TIME_MATCH[1]) * 3600 +
                        Number.parseInt(TIME_MATCH[2]) * 60 +
                        Number.parseFloat(TIME_MATCH[3]);
                    const PERCENT = Math.min(
                        100,
                        Math.ceil((CURRENT / OUT_DURATION) * 100)
                    );
                    onProgress(PERCENT);
                }
            }
        });

        FFMPEG.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                if (fs.existsSync(outputPath)) {
                    unlinkSync(outputPath);
                }
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        FFMPEG.on('error', (err) => reject(err));
    });
}

/**
 * Marge (secondes) ajoutée de chaque côté d'un cut stream-copy. Stream-copy ne
 * peut couper que sur une keyframe, et les captures ont un GOP grossier (~4 s) :
 * on recule donc le début / avance la fin d'une marge > GOP pour garantir qu'on
 * déborde plutôt qu'on ne crope la game.
 */
const COPY_MARGIN_SEC = 6;

/**
 * Découpe une game en stream-copy (sans réencodage), pour les games NON
 * identifiées côté site : elles partent dans failed/ pour revue manuelle, jamais
 * dans le lecteur web, donc le surcoût de scrubbing du GOP grossier n'a aucune
 * importance — et on évite un réencodage libx264 software inutile. La coupe est
 * élargie de COPY_MARGIN_SEC de chaque côté (cf. constante). `-ss` avant `-i`
 * garde le seek rapide ; `-avoid_negative_ts make_zero` rebase les timestamps
 * pour que le clip démarre proprement à 0.
 * @param {string} inputPath  Source video.
 * @param {string} outputPath Destination .mp4.
 * @param {number} startSec   Début de game (s) ; reculé de la marge.
 * @param {number} endSec     Fin de game (s) ; avancée de la marge.
 * @param {boolean} lowPriority Passe ffmpeg en BELOW_NORMAL (mode salle).
 * @returns {Promise<string>} Resolves with outputPath on success.
 */
async function cutCopyGame(
    inputPath,
    outputPath,
    startSec,
    endSec,
    // Marge par défaut calibrée pour les VODs au GOP grossier (~4 s). Les
    // captations mode salle ont un GOP de 1 s → marge de 1 s suffisante pour
    // une coupe quasi exacte.
    marginSec = COPY_MARGIN_SEC,
    lowPriority = false
) {
    if (fs.existsSync(outputPath)) {
        unlinkSync(outputPath);
    }

    const FROM = Math.max(0, startSec - marginSec);
    const TO = endSec + marginSec;

    return new Promise((resolve, reject) => {
        const FFMPEG_ARGS = [
            '-ss',
            String(FROM),
            '-to',
            String(TO),
            '-i',
            inputPath,
            '-c',
            'copy',
            '-avoid_negative_ts',
            'make_zero',
            '-movflags',
            '+faststart',
            outputPath
        ];

        console.log(
            `[FFMPEG] Cut copy - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);
        if (lowPriority) lowerProcessPriority(FFMPEG, 'FFMPEG cut copy');

        FFMPEG.stderr.on('data', (data) => {
            console.log(`[FFMPEG] Cut copy - ${data.toString().trim()}`);
        });

        FFMPEG.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                if (fs.existsSync(outputPath)) {
                    unlinkSync(outputPath);
                }
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        FFMPEG.on('error', (err) => reject(err));
    });
}

/**
 * Concatène plusieurs segments vidéo issus du MÊME run d'encodage (codecs et
 * paramètres identiques) en un seul fichier, en stream-copy (concat demuxer,
 * zéro réencodage). Utilisé par le pipeline mode salle pour reconstruire la
 * fenêtre d'analyse à partir des segments de captation.
 * @param {string[]} inputPaths Segments dans l'ordre chronologique.
 * @param {string} outputPath Fichier de sortie (écrasé s'il existe).
 * @param {boolean} lowPriority Passe ffmpeg en BELOW_NORMAL (mode salle).
 */
async function concatCopySegments(inputPaths, outputPath, lowPriority = false) {
    if (fs.existsSync(outputPath)) {
        unlinkSync(outputPath);
    }

    // Fichier liste du concat demuxer. Quotes simples échappées (syntaxe ffmpeg).
    const LIST_PATH = outputPath + '.txt';
    fs.writeFileSync(
        LIST_PATH,
        inputPaths
            .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
            .join('\n'),
        'utf8'
    );

    return new Promise((resolve, reject) => {
        const FFMPEG_ARGS = [
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            LIST_PATH,
            '-c',
            'copy',
            '-avoid_negative_ts',
            'make_zero',
            outputPath
        ];

        console.log(
            `[FFMPEG] Concat copy - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);
        if (lowPriority) lowerProcessPriority(FFMPEG, 'FFMPEG concat copy');

        FFMPEG.stderr.on('data', (data) => {
            console.log(`[FFMPEG] Concat copy - ${data.toString().trim()}`);
        });

        const cleanup = () => {
            try {
                unlinkSync(LIST_PATH);
            } catch (_) {}
        };

        FFMPEG.on('close', (code) => {
            cleanup();
            if (code === 0 && fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                if (fs.existsSync(outputPath)) {
                    unlinkSync(outputPath);
                }
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        FFMPEG.on('error', (err) => {
            cleanup();
            reject(err);
        });
    });
}

/**
 * Appends a few seconds of a still image to the END of a video, re-encoding the
 * whole file. Used to artificially create the end-of-game team score frame that
 * Tools needs to bound a game when the source video doesn't contain it.
 * The image is scaled to the source resolution and the source frame rate; audio
 * is padded with silence (`apad`) when present. The scores will be drawn on top
 * of the image in a later step. `-c:v libx264` + faststart keep the result
 * browser/analysis-ready.
 * @param {string} inputPath     Source video.
 * @param {string} outputPath    Destination video.
 * @param {string} imagePath     Still image used for the tail (e.g. background).
 * @param {number} seconds       Tail duration (seconds).
 * @param {Function} [percentCallback] Called with an integer percent (0-100).
 * @returns {Promise<string>} Resolves with `outputPath` on success.
 */
function appendImageTail(
    inputPath,
    outputPath,
    imagePath,
    seconds = 5,
    percentCallback
) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(outputPath)) {
            unlinkSync(outputPath);
        }

        // Sonde la source : piste audio (sinon `apad` planterait), résolution et
        // fps pour aligner le segment image sur la vidéo (requis par `concat`).
        const PROBE = spawn(FFMPEG_PATH, ['-i', inputPath]);
        let probeStderr = '';
        PROBE.stderr.on('data', (d) => (probeStderr += d.toString()));
        PROBE.on('error', reject);
        PROBE.on('close', () => {
            const HAS_AUDIO = /Stream #.*Audio:/.test(probeStderr);
            const SIZE_MATCH = probeStderr.match(
                /Video:[^\n]*?\s(\d{2,5})x(\d{2,5})/
            );
            const FPS_MATCH = probeStderr.match(/([\d.]+)\s+fps/);
            const DURATION_MATCH = probeStderr.match(
                /Duration:\s(\d+):(\d+):(\d+\.\d+)/
            );
            const WIDTH = SIZE_MATCH ? SIZE_MATCH[1] : DEFAULT_VIDEO_WIDTH;
            const HEIGHT = SIZE_MATCH ? SIZE_MATCH[2] : DEFAULT_VIDEO_HEIGHT;
            const FPS = FPS_MATCH ? FPS_MATCH[1] : 30;
            const TOTAL = DURATION_MATCH
                ? +DURATION_MATCH[1] * 3600 +
                  +DURATION_MATCH[2] * 60 +
                  parseFloat(DURATION_MATCH[3]) +
                  seconds
                : 0;

            const FILTER =
                `[1:v]scale=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},format=yuv420p[tail];` +
                `[0:v]scale=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},format=yuv420p[main];` +
                `[main][tail]concat=n=2:v=1:a=0[v]` +
                (HAS_AUDIO ? `;[0:a]apad=pad_dur=${seconds}[a]` : '');

            const FFMPEG_ARGS = [
                '-i',
                inputPath,
                '-loop',
                '1',
                '-t',
                String(seconds),
                '-i',
                imagePath,
                '-filter_complex',
                FILTER,
                '-map',
                '[v]',
                ...(HAS_AUDIO ? ['-map', '[a]'] : []),
                '-c:v',
                'libx264',
                '-preset',
                'veryfast',
                '-crf',
                '23',
                ...(HAS_AUDIO ? ['-c:a', 'aac', '-b:a', '128k'] : []),
                '-movflags',
                '+faststart',
                outputPath
            ];

            console.log(
                `[FFMPEG] Append image tail - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
            );

            const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);

            FFMPEG.stderr.on('data', (data) => {
                const STR = data.toString();
                const TIME_MATCH = STR.match(/time=(\d+):(\d+):(\d+\.\d+)/);
                if (TIME_MATCH && TOTAL > 0 && percentCallback) {
                    const CURRENT =
                        +TIME_MATCH[1] * 3600 +
                        +TIME_MATCH[2] * 60 +
                        parseFloat(TIME_MATCH[3]);
                    percentCallback(
                        Math.min(100, Math.round((CURRENT / TOTAL) * 100))
                    );
                }
            });

            FFMPEG.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputPath)) {
                    resolve(outputPath);
                } else {
                    if (fs.existsSync(outputPath)) {
                        unlinkSync(outputPath);
                    }
                    reject(
                        new Error(`FFmpeg process exited with code ${code}`)
                    );
                }
            });

            FFMPEG.on('error', (err) => reject(err));
        });
    });
}

// Largeur native de chaque chiffre PNG (assets/team-score/<n>.png). Tous font 89px
// de haut ; les largeurs varient (police proportionnelle). Les chiffres sont
// rendus à leur taille native (pas de redimensionnement).
const DIGIT_WIDTH = {
    0: 74,
    1: 59,
    2: 66,
    3: 59,
    4: 71,
    5: 64,
    6: 71,
    7: 61,
    8: 73,
    9: 65
};
// Coin haut-gauche du score, mesuré sur la maquette de référence (1920x1080) :
// le score orange est SOUS sa pastille, le score bleu AU-DESSUS de la sienne.
// Les scores sont alignés à gauche depuis ce point.
const ORANGE_SCORE_ANCHOR = { x: 36, y: 439 };
const BLUE_SCORE_ANCHOR = { x: 40, y: 629 };
const SCORE_DIGIT_SPACING = 6;
// Couleur des chiffres par équipe. Les PNG sont blancs : on les teinte par
// multiplication (`colorchannelmixer` diagonal) pour obtenir la teinte voulue
// tout en préservant l'alpha et l'anti-aliasing des glyphes.
const ORANGE_SCORE_COLOR = 'ff8000';
const BLUE_SCORE_COLOR = '3298fe';

/**
 * Construit le filtre `colorchannelmixer` qui teinte un glyphe blanc vers `hex`
 * (multiplication par canal : blanc -> couleur, gris d'anti-aliasing -> nuance).
 * @param {string} hex Couleur cible "rrggbb".
 * @returns {string}
 */
function colorMixer(hex) {
    const RR = (parseInt(hex.slice(0, 2), 16) / 255).toFixed(4);
    const GG = (parseInt(hex.slice(2, 4), 16) / 255).toFixed(4);
    const BB = (parseInt(hex.slice(4, 6), 16) / 255).toFixed(4);
    return `colorchannelmixer=rr=${RR}:gg=${GG}:bb=${BB}`;
}

/**
 * Calcule la position (taille native) de chaque chiffre d'un score, aligné à
 * gauche depuis `anchor`, avec la couleur d'équipe.
 * @param {number} score Score 0-100.
 * @param {{x:number,y:number}} anchor Coin haut-gauche du premier chiffre.
 * @param {string} color Couleur cible "rrggbb".
 * @returns {{digit:string,x:number,y:number,color:string}[]}
 */
function layoutScore(score, anchor, color) {
    const STR = String(score);
    let x = anchor.x;
    const ITEMS = [];
    for (const D of STR) {
        ITEMS.push({ digit: D, x, y: anchor.y, color });
        x += DIGIT_WIDTH[D] + SCORE_DIGIT_SPACING;
    }
    return ITEMS;
}

/**
 * Compose l'écran de score d'équipe : écrit les scores orange et bleu (avec la
 * police des PNG chiffres, à leur taille native, teintés aux couleurs d'équipe)
 * par-dessus `background.jpg`, et écrit le résultat dans `outputPath` (PNG).
 * @param {string} backgroundPath Image de fond (1920x1080).
 * @param {string} digitsDir      Dossier contenant 0.png … 9.png.
 * @param {number} orangeScore    Score équipe orange (0-100).
 * @param {number} blueScore      Score équipe bleue (0-100).
 * @param {string} outputPath     PNG de sortie.
 * @returns {Promise<string>} Resolves with `outputPath` on success.
 */
function renderTeamScoreImage(
    backgroundPath,
    digitsDir,
    orangeScore,
    blueScore,
    outputPath
) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(outputPath)) {
            unlinkSync(outputPath);
        }

        const ITEMS = [
            ...layoutScore(orangeScore, ORANGE_SCORE_ANCHOR, ORANGE_SCORE_COLOR),
            ...layoutScore(blueScore, BLUE_SCORE_ANCHOR, BLUE_SCORE_COLOR)
        ];

        const INPUTS = ['-i', backgroundPath];
        const FILTER = [];
        let last = '0:v';
        let idx = 1;
        for (const ITEM of ITEMS) {
            INPUTS.push('-i', path.join(digitsDir, `${ITEM.digit}.png`));
            FILTER.push(`[${idx}:v]${colorMixer(ITEM.color)}[c${idx}]`);
            FILTER.push(
                `[${last}][c${idx}]overlay=${ITEM.x}:${ITEM.y}[o${idx}]`
            );
            last = `o${idx}`;
            idx++;
        }

        const FFMPEG_ARGS = [
            ...INPUTS,
            '-filter_complex',
            FILTER.join(';'),
            '-map',
            `[${last}]`,
            '-frames:v',
            '1',
            outputPath
        ];

        console.log(
            `[FFMPEG] Render team score - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);

        FFMPEG.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                if (fs.existsSync(outputPath)) {
                    unlinkSync(outputPath);
                }
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        FFMPEG.on('error', (err) => reject(err));
    });
}

module.exports = {
    probeVideoDuration,
    changeVideoResolution,
    removeBorders,
    fixForBrowser,
    remuxToForAnalysis,
    cutAndEncodeGame,
    cutCopyGame,
    concatCopySegments,
    appendImageTail,
    renderTeamScoreImage
};
