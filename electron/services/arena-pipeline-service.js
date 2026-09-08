// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const path = require('node:path');
const chokidar = require('chokidar');
const { safeMapName } = require('./global-service');
const { cutCopyGame, concatCopySegments } = require('./video-service');
const arenaModeService = require('./arena-mode-service');
const arenaCaptureService = require('./arena-capture-service');

//#endregion

// Mode salle — CONSOMMATEUR DU SPOOL. Transforme les segments bruts écrits par
// la brique de captation en fichiers de game découpés et nommés pour l'upload.
//
// Principe (fenêtre glissante, zéro modification du Python) : la phase 1 de
// l'analyseur (`runAnalyzer`) scanne à rebours et ne rapporte QUE les games
// complètes (score frame ET loading frame trouvées). On lui donne donc la
// concaténation (stream-copy) des segments fermés non encore consommés :
//   - une game entièrement dans la fenêtre → détectée → découpée en
//     stream-copy/remux mp4 (la captation encode déjà web-ready : H.264,
//     GOP 1 s, +faststart au remux — AUCUN réencodage, coupe précise à ±1 s),
//     nommée `{roomId}_{arenaId}_{SafeMap}_{startEpoch}_{endEpoch}_{sO}-{sB}.mp4`
//     — ou `{préfixe}_{roomId}_{arenaId}_{startEpoch}_{endEpoch}.mp4` pour une
//     game d'un AUTRE jeu (`cc_` Color Chaos), qui n'a ni map ni scores et ne
//     s'identifie pas côté EVA ;
//   - une game encore en cours à la fin de la fenêtre → invisible pour la
//     phase 1 → retrouvée au round suivant, quand le segment contenant sa
//     score frame sera fermé. C'est ça, la gestion du "à cheval sur deux
//     segments" : pas de machine à états, la fenêtre s'en charge.
// Le watermark (borne absolue en dessous de laquelle tout est consommé)
// avance après chaque round : derrière la dernière game extraite, ou à
// (fin de fenêtre - durée max d'une game) quand il ne se passe rien — une
// game encore en cours ne peut pas avoir commencé avant ça, donc on ne jette
// jamais un segment qui pourrait encore servir. Les segments entièrement
// sous le watermark sont supprimés (le disque d'un PC de salle se remplit en
// une journée sinon).
//
// La déduplication entre rounds est gratuite : le nom de sortie est
// déterministe (epochs absolus) — si le fichier existe déjà, la game a déjà
// été extraite (y compris après un crash/redémarrage).

const SEGMENT_RE = /^rec_(\d{8})-(\d{6})\.mkv$/;
// Marge au-delà de la durée nominale d'un segment pour décider qu'un trou
// sépare deux runs de captation (crash/redémarrage de ffmpeg) — les segments
// d'un même run sont contigus, ceux de runs différents ne se concatènent pas.
const RUN_GAP_TOLERANCE_S = 60;
// Durée max d'une game EVA + marge : borne d'avance du watermark quand aucune
// game n'est extraite (« une game en cours ne peut pas avoir commencé avant »).
// La durée est CONFIGURÉE par la salle avant la partie — on ne la connaît jamais
// à l'avance — et monte jusqu'à 12 min, une pause technique pouvant l'allonger
// encore. Trop bas, on purge les segments d'une game en cours ; trop haut, le
// spool grossit (~4,5 Go/h).
const MAX_GAME_S = 12 * 60 + 180;
// La même borne pour une game Zombies, qui joue dans une tout autre échelle :
// 27, 30 et 35 min sur les trois enregistrements de salle chronométrés, plus les
// ~5 min de pré-game qui précèdent son écran de loading. Cet horizon ne sert QUE
// quand une game zombie est en cours (cf. `zombiesInProgress`) : le reste du
// temps le spool reste dimensionné pour de l'After-H, sinon on ferait scanner
// 45 min de vidéo toutes les 5 min à un PC de salle pour rien.
const ZOMBIES_MAX_GAME_S = 45 * 60;
// Au-delà, une game détectée n'est pas « longue » mais FAUSSE : son début a été
// pris dans la game précédente (cf. le filtre de `processRun`). Seuil distinct
// et large, il ne sert qu'à écarter les débordements francs.
const IMPLAUSIBLE_GAME_S = 20 * 60;
// Pendant Zombies, le début mal détecté serait le loading de la game d'AVANT,
// soit ~40 min plus tôt : le seuil reste un filet à débordements francs.
const ZOMBIES_IMPLAUSIBLE_GAME_S = 45 * 60;
// Modes du jeu After-H. Ils ont une game chez EVA, donc une identité à résoudre
// et un replay qui vit avec les autres : nom identifiable à 6 champs, puis
// `statistics/replays/{guid}`. Le jeu d'arme en fait partie — l'analyzer le
// distingue d'une Domination au libellé de l'écran final, mais pour EVA c'est
// une game comme une autre, avec sa map, ses scores et son id.
//
// Le Zombies (MoonOfTheDead, mode EVA 7) les a rejoints le 06/09/2026, quand ce
// mode est entré dans T_Games. Il n'a ni map ni scores à lire, mais ça ne le
// disqualifie pas : le nom porte alors `unknown` et `0-0`, et le resolve traite
// déjà `unknown` comme « OCR de map en échec » — il désactive le garde-fou map
// au lieu de refuser. La fin de game suffit à l'identifier.
// Le Chacun pour soi (FreeForAll, mode EVA 2) les a rejoints le 07/09/2026 :
// il a bien une game chez EVA, mais sa fin est un podium par joueur, pas une
// score frame — d'où ni scores (`0-0`) ni map (`unknown`, l'analyseur ne lit
// celle-ci que sur le HUD d'équipes qu'il n'a pas), exactement le cas que le
// resolve sait déjà traiter pour le Zombies.
const AFTER_H_LIKE_TYPES = new Set([
    'after-h',
    'gun-game',
    'free-for-all',
    'zombies'
]);
// Préfixe du nom de fichier par jeu qui n'est PAS After-H. Ces parties n'ont pas
// de game chez EVA : rien à identifier, donc un nom qui ne ressemble pas à celui
// d'une game et une route d'upload à part, où le préfixe dit de quel jeu il
// s'agit. Un jeu absent de cette table est détecté mais pas extrait.
//
// Il ne reste que le Color Chaos — le seul vrai « autre jeu », absent du modèle
// de données EVA.
const OTHER_GAME_PREFIX = {
    'color-chaos': 'cc'
};
// Marge de sécurité avant purge d'un segment sous le watermark.
const PURGE_MARGIN_S = 60;
// Tolérance sur la comparaison fin-de-game vs watermark : les epochs sont
// reconstruits par arrondi depuis des offsets relatifs, deux rounds peuvent
// dater la même fin à ±quelques secondes. Deux games réelles ne peuvent pas
// se terminer à moins de quelques secondes d'écart.
const REEXTRACT_TOLERANCE_S = 5;
// Marge de découpe stream-copy : la captation a un GOP de 1 s, la coupe
// démarre donc au plus 2 s avant le début détecté de la game.
const ARENA_CUT_MARGIN_S = 1;
// La score frame finale reste affichée ~10 s. Si la frontière de segment
// tombe dedans, le round courant ne voit que sa première partie : la game
// serait bornée (et découpée) au bord du segment, amputée des secondes de
// score frame restantes — précieuses pour l'analyse (les premières peuvent
// être floues). Une game dont la fin détectée touche la fin de fenêtre est
// donc différée d'un round : au suivant, le segment d'après est fermé et le
// scan à rebours borne la game sur la DERNIÈRE seconde de score frame
// visible. Ne s'applique que si la captation tourne (sinon rien n'arrivera).
const SCORE_FRAME_GUARD_S = 15;

// Round périodique de rattrapage : à l'arrêt de la captation, le dernier
// segment n'est jamais suivi d'un N+1 qui déclencherait son traitement.
const CATCHUP_INTERVAL_MS = 60 * 1000;

let watcher = null;
let catchupTimer = null;
let deps = null;
let roundRunning = false;
let roundPending = false;
// Borne absolue (epoch s) : tout ce qui est antérieur est extrait ou périmé.
let watermark = 0;
let lastRoundAt = null;
let lastRoundGames = 0;
let extractedCount = 0;
let lastError = null;

function getSpoolFolder() {
    return arenaCaptureService.getStatus().spoolFolder;
}

function getWorkFolder() {
    return path.join(path.dirname(getSpoolFolder()), 'work');
}

function getGamesFolder() {
    return path.join(path.dirname(getSpoolFolder()), 'games');
}

/**
 * La game est-elle déjà extraite ? Le nom écrit ici porte 6 champs, mais le
 * service d'identification y INSÈRE le gameId en 3e position dès qu'EBP a
 * répondu — le fichier ne s'appelle alors plus pareil. On teste donc le nom
 * exact ET son suffixe `_{map}_{start}_{end}_{scores}.mp4`, invariant entre les
 * deux formes (les epochs absolus le rendent unique), sinon on re-découperait la
 * game après un redémarrage.
 * @param {string} gamesDir
 * @param {string} name nom à 6 champs tel que produit par ce service.
 */
function alreadyExtracted(gamesDir, name) {
    if (fs.existsSync(path.join(gamesDir, name))) return true;
    const I1 = name.indexOf('_');
    const SUFFIX = name.slice(name.indexOf('_', I1 + 1));
    try {
        return fs.readdirSync(gamesDir).some((f) => f.endsWith(SUFFIX));
    } catch (_) {
        return false;
    }
}

/**
 * Epoch (secondes UTC) encodé dans le nom d'un segment `rec_%Y%m%d-%H%M%S.mkv`
 * (strftime ffmpeg en heure LOCALE — Date.UTC ne convient donc pas).
 * @returns {number|null}
 */
function segmentEpoch(fileName) {
    const M = fileName.match(SEGMENT_RE);
    if (!M) return null;
    const [D, T] = [M[1], M[2]];
    const DATE = new Date(
        parseInt(D.slice(0, 4), 10),
        parseInt(D.slice(4, 6), 10) - 1,
        parseInt(D.slice(6, 8), 10),
        parseInt(T.slice(0, 2), 10),
        parseInt(T.slice(2, 4), 10),
        parseInt(T.slice(4, 6), 10)
    );
    return Math.floor(DATE.getTime() / 1000);
}

/**
 * Segments fermés du spool, triés chronologiquement, groupés en runs contigus.
 * Le plus récent de tous est exclu : ffmpeg est probablement encore en train
 * de l'écrire (un segment n'est fermé que quand le suivant existe — ou que la
 * captation est arrêtée, cas couvert par le round périodique).
 * @returns {{epoch:number, path:string}[][]}
 */
function listClosedRuns() {
    const SPOOL = getSpoolFolder();
    if (!fs.existsSync(SPOOL)) return [];
    const SEGMENTS = fs
        .readdirSync(SPOOL)
        .map((f) => ({ epoch: segmentEpoch(f), path: path.join(SPOOL, f) }))
        .filter((s) => s.epoch !== null)
        .sort((a, b) => a.epoch - b.epoch);
    // Dernier segment = en cours d'écriture, sauf si la captation est arrêtée
    // (plus personne n'écrit → tout est fermé).
    if (SEGMENTS.length > 0 && arenaCaptureService.getStatus().running) {
        SEGMENTS.pop();
    }

    const RUNS = [];
    const SEGMENT_S = arenaCaptureService.getStatus().segmentSeconds;
    for (const SEG of SEGMENTS) {
        const RUN = RUNS[RUNS.length - 1];
        const PREV = RUN ? RUN[RUN.length - 1] : null;
        if (PREV && SEG.epoch - PREV.epoch <= SEGMENT_S + RUN_GAP_TOLERANCE_S) {
            RUN.push(SEG);
        } else {
            RUNS.push([SEG]);
        }
    }
    return RUNS;
}

/**
 * Traite un run : concatène les segments au-dessus du watermark, lance la
 * phase 1 de détection, découpe chaque game complète non déjà extraite, puis
 * avance le watermark et purge les segments consommés.
 */
async function processRun(run) {
    const STATE = arenaModeService.getState();
    // Segments utiles : ceux qui peuvent encore contenir de l'inextrait.
    const SEGMENTS = run.filter(
        (s) =>
            s.epoch + arenaCaptureService.getStatus().segmentSeconds >
            watermark
    );
    if (SEGMENTS.length === 0) return;

    const WORK = getWorkFolder();
    const GAMES_DIR = getGamesFolder();
    for (const DIR of [WORK, GAMES_DIR]) {
        if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    }

    const WINDOW_START_EPOCH = SEGMENTS[0].epoch;
    const WINDOW_PATH = path.join(WORK, 'window.mkv');
    console.log(
        `[arena-pipeline] window: ${SEGMENTS.length} segment(s) from epoch ${WINDOW_START_EPOCH}`
    );
    await concatCopySegments(
        SEGMENTS.map((s) => s.path),
        WINDOW_PATH,
        true
    );

    // Phase 1 (détection uniquement — même code que le watch-folder). Pas de
    // floating window : le pipeline salle est silencieux. Priorité OS
    // BELOW_NORMAL : sur un PC de salle, les logiciels de prod passent d'abord
    // — la détection prend les cycles restants. À surveiller : si la machine
    // est durablement saturée, la détection traîne derrière la captation et
    // les games s'accumulent dans le spool (~4,5 Go/h).
    const DETECT = await deps.runAnalyzer(WINDOW_PATH, null, {}, false, true);
    if (DETECT.type === 'error') {
        throw new Error(`Analyzer failed: ${DETECT.message}`);
    }
    // On écarte les games sans vrai début : `startFallback` = la détection a
    // atteint le début de la fenêtre sans loading frame (game déjà extraite à
    // un round précédent dont seule la fin est encore visible, ou game
    // entamée avant le lancement de la captation).
    //
    // Et on écarte les durées INVRAISEMBLABLES, symptôme d'un début mal
    // détecté : la recherche a franchi l'intro de la game et s'est arrêtée sur
    // celle de la PRÉCÉDENTE, produisant une vidéo qui contient deux games et
    // serait rattachée à la mauvaise. Mieux vaut perdre la game que publier ça.
    // Cas observé en prod le 2026-08-01 : 15 min 34 pour une game.
    //
    // Le seuil est volontairement LARGE : la durée d'une game est configurée par
    // la salle (7 min sur le cas observé), monte à 12 min, et une pause
    // technique peut l'allonger encore. Ce filtre n'est donc pas une mesure de
    // vraisemblance fine, seulement un filet contre les débordements francs.
    const GAMES = (DETECT.games || []).filter((g) => {
        if (g.start === -1 || g.startFallback) return false;
        const LIMIT =
            (g.gameType ?? 'after-h') === 'zombies'
                ? ZOMBIES_IMPLAUSIBLE_GAME_S
                : IMPLAUSIBLE_GAME_S;
        if (g.end - g.start > LIMIT) {
            console.warn(
                `[arena-pipeline] implausible game dropped: ${Math.round(g.end - g.start)}s (> ${LIMIT}s) map=${g.map || '?'} — début mal détecté`
            );
            return false;
        }
        return true;
    });
    console.log(`[arena-pipeline] ${GAMES.length} complete game(s) in window`);

    // Durée de la fenêtre (relative) : fin nominale du dernier segment.
    const WINDOW_END_REL =
        SEGMENTS[SEGMENTS.length - 1].epoch +
        arenaCaptureService.getStatus().segmentSeconds -
        WINDOW_START_EPOCH;
    const CAPTURING = arenaCaptureService.getStatus().running;

    let maxExtractedEndEpoch = 0;
    // Début de la game la plus ancienne DIFFÉRÉE ce round : le watermark ne doit
    // pas passer devant, sinon on purgerait les segments d'une game qu'on a
    // décidé de re-découper au round suivant.
    let deferredStartEpoch = 0;
    let extractedThisRound = 0;
    for (const G of GAMES) {
        const START_EPOCH = WINDOW_START_EPOCH + Math.round(G.start);
        const END_EPOCH = WINDOW_START_EPOCH + Math.round(G.end);
        if (END_EPOCH <= watermark + REEXTRACT_TOLERANCE_S) continue;
        // Fin de game collée à la fin de fenêtre : la score frame déborde
        // peut-être sur le segment suivant → on attend le round d'après pour
        // découper avec la score frame complète (cf. SCORE_FRAME_GUARD_S).
        if (CAPTURING && WINDOW_END_REL - G.end < SCORE_FRAME_GUARD_S) {
            console.log(
                `[arena-pipeline] game ending at ${Math.round(G.end)}s touches window end — deferred to next round`
            );
            deferredStartEpoch = deferredStartEpoch
                ? Math.min(deferredStartEpoch, START_EPOCH)
                : START_EPOCH;
            continue;
        }

        // Color Chaos : ni map, ni scores, et rien à identifier côté EVA. Nom à
        // part (préfixe `cc_`) — il ne doit surtout pas ressembler au nom
        // provisoire d'une game After-H, que le service d'identification
        // essaierait de résoudre en game EVA.
        //
        // Le jeu d'arme et le Zombies, eux, ONT une game côté EVA : ils prennent
        // le nom identifiable, sans quoi leur replay finirait dans une zone à
        // part alors qu'EBP connaît leur game et son guid. Le Zombies n'a ni map
        // ni scores à y mettre — `unknown` et `0-0` — ce que le resolve sait
        // traiter (il désactive alors le garde-fou map).
        const GAME_TYPE = G.gameType ?? 'after-h';
        const O_SCORE = G.orangeTeam ? G.orangeTeam.score : '?';
        const B_SCORE = G.blueTeam ? G.blueTeam.score : '?';
        let NAME;
        if (AFTER_H_LIKE_TYPES.has(GAME_TYPE)) {
            NAME = `${STATE.roomId}_${STATE.arenaId}_${safeMapName(G.map)}_${START_EPOCH}_${END_EPOCH}_${O_SCORE}-${B_SCORE}.mp4`;
        } else if (OTHER_GAME_PREFIX[GAME_TYPE]) {
            NAME = `${OTHER_GAME_PREFIX[GAME_TYPE]}_${STATE.roomId}_${STATE.arenaId}_${START_EPOCH}_${END_EPOCH}.mp4`;
        } else {
            // Jeu détecté par une version plus récente de l'analyseur que de
            // l'uploader : mieux vaut le laisser dans le spool que produire un
            // fichier que personne ne saura router.
            console.warn(`[arena-pipeline] unknown gameType '${GAME_TYPE}' — game ignorée`);
            continue;
        }
        const OUT = path.join(GAMES_DIR, NAME);
        // Nom déterministe → dédup entre rounds et après redémarrage.
        if (alreadyExtracted(GAMES_DIR, NAME)) {
            maxExtractedEndEpoch = Math.max(maxExtractedEndEpoch, END_EPOCH);
            continue;
        }

        // Découpe stream-copy + remux mp4 (+faststart) : la captation encode
        // déjà au format web (H.264, GOP 1 s) — le lecteur du site lit ces
        // fichiers comme ceux du watch-folder, sans qu'on ait payé un
        // réencodage. Marge de 1 s : la coupe démarre à la keyframe précédente.
        await cutCopyGame(
            WINDOW_PATH,
            OUT,
            G.start,
            G.end,
            ARENA_CUT_MARGIN_S,
            true
        );
        // Pas de sidecar : le PC de salle ne fait JAMAIS l'analyse (phase 2), qui
        // reste sur le PC du joueur. Tout ce dont la suite a besoin — arène,
        // gameId après identification, map, bornes absolues — est dans le nom du
        // fichier.
        extractedThisRound++;
        extractedCount++;
        maxExtractedEndEpoch = Math.max(maxExtractedEndEpoch, END_EPOCH);
        console.log(`[arena-pipeline] extracted ${NAME}`);
    }
    lastRoundGames = extractedThisRound;

    // Avance du watermark : derrière la dernière game extraite, et de toute
    // façon jamais moins que (fin de fenêtre - durée max d'une game) — une
    // game encore en cours ne peut pas avoir commencé avant.
    const LAST_SEGMENT = SEGMENTS[SEGMENTS.length - 1];
    const WINDOW_END_EPOCH =
        LAST_SEGMENT.epoch + arenaCaptureService.getStatus().segmentSeconds;
    // Horizon : une game zombie en cours (HUD encore affiché en fin de fenêtre,
    // outro pas encore vu) a pu commencer 40 min plus tôt. On ne l'étend que
    // dans ce cas — le tenir en permanence ferait scanner 45 min de vidéo tous
    // les 5 min sur un PC de salle, pour rien la plupart du temps.
    const HORIZON_S = DETECT.zombiesInProgress
        ? ZOMBIES_MAX_GAME_S
        : MAX_GAME_S;
    if (DETECT.zombiesInProgress) {
        console.log('[arena-pipeline] game Zombies en cours — horizon étendu');
    }
    // Une game différée fixe un plafond : son outro vient de se terminer, donc
    // plus rien ne signale « game en cours » et l'horizon est déjà retombé —
    // sans ce plafond, une game zombie de 35 min différée verrait son début
    // purgé avant d'être re-découpée au round suivant. Le max final garde le
    // watermark monotone : il ne recule jamais.
    const CANDIDATE = Math.max(
        maxExtractedEndEpoch,
        WINDOW_END_EPOCH - HORIZON_S
    );
    watermark = Math.max(
        watermark,
        deferredStartEpoch
            ? Math.min(CANDIDATE, deferredStartEpoch - 1)
            : CANDIDATE
    );

    // Purge : segments entièrement sous le watermark (avec marge).
    for (const SEG of run) {
        const SEG_END =
            SEG.epoch + arenaCaptureService.getStatus().segmentSeconds;
        if (SEG_END < watermark - PURGE_MARGIN_S) {
            try {
                fs.unlinkSync(SEG.path);
                console.log(
                    `[arena-pipeline] purged ${path.basename(SEG.path)}`
                );
            } catch (e) {
                console.error(
                    '[arena-pipeline] purge failed:',
                    SEG.path,
                    e.message
                );
            }
        }
    }

    try {
        fs.unlinkSync(WINDOW_PATH);
    } catch (_) {}
}

/**
 * Un round = traiter tous les runs fermés du spool, sérialisé (jamais deux
 * rounds en parallèle ; un round demandé pendant un round en cours est rejoué
 * à la fin).
 */
async function runRound() {
    if (roundRunning) {
        roundPending = true;
        return;
    }
    roundRunning = true;
    try {
        do {
            roundPending = false;
            const RUNS = listClosedRuns();
            for (const RUN of RUNS) {
                await processRun(RUN);
            }
            lastRoundAt = Date.now();
            lastError = null;
        } while (roundPending);
    } catch (e) {
        console.error('[arena-pipeline] round failed:', e.message);
        lastError = e.message;
    } finally {
        roundRunning = false;
    }
}

/**
 * Démarre le consommateur : un round à chaque nouveau segment fermé (l'ajout
 * du segment N ferme le N-1), plus un round périodique de rattrapage (fin de
 * captation : le dernier segment ne serait jamais suivi d'un N+1).
 * @param {{runAnalyzer: Function}} dependencies même injection que le watch-folder.
 */
function start(dependencies) {
    if (watcher) return;
    if (!dependencies || !dependencies.runAnalyzer) {
        throw new Error('arena-pipeline-service.start: missing runAnalyzer dep');
    }
    deps = dependencies;

    const SPOOL = getSpoolFolder();
    if (!fs.existsSync(SPOOL)) fs.mkdirSync(SPOOL, { recursive: true });

    watcher = chokidar.watch(SPOOL, {
        persistent: true,
        ignoreInitial: false,
        depth: 0,
        // Les segments sont écrits en continu par ffmpeg : pas d'attente de
        // stabilité — on n'analyse que les segments FERMÉS (cf. listClosedRuns).
        awaitWriteFinish: false
    });
    watcher.on('add', (p) => {
        if (SEGMENT_RE.test(path.basename(p))) {
            runRound();
        }
    });
    watcher.on('error', (e) =>
        console.error('[arena-pipeline] watcher error', e)
    );
    catchupTimer = setInterval(runRound, CATCHUP_INTERVAL_MS);

    console.log('[arena-pipeline] watching', SPOOL);
}

function stop() {
    if (watcher) {
        watcher.close();
        watcher = null;
    }
    if (catchupTimer) {
        clearInterval(catchupTimer);
        catchupTimer = null;
    }
    deps = null;
}

function getStatus() {
    return {
        active: !!watcher,
        roundRunning,
        lastRoundAt,
        lastRoundGames,
        extractedCount,
        watermark,
        gamesFolder: getGamesFolder(),
        lastError
    };
}

module.exports = { start, stop, runRound, getStatus };
