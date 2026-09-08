// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  Component,
  ElementRef,
  isDevMode,
  NgZone,
  ViewChild
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { GridModule } from '../../shared/grid/grid.module';
import { LoaderComponent } from '../../shared/loader/loader.component';
import Tesseract, { createWorker } from 'tesseract.js';
import { ToastrService } from 'ngx-toastr';
import { Map } from './models/map';
import { Game } from './models/game';
import { RGB } from './models/rgb';
import { GlobalService } from '../../core/services/global.service';
import { MatInputModule } from '@angular/material/input';
import { OpenCVService } from '../../core/services/open-cv.service';
import { MatDialog } from '@angular/material/dialog';
import { ReplayCutterCropDialog } from './dialogs/crop/crop.dialog';
import { CropperPosition } from 'ngx-image-cropper';
import { ReplayCutterSettingsDialog } from './dialogs/settings/settings.dialog';
import { Settings } from './models/settings';
import { ReplayCutterUpscaleConfirmationDialog } from './dialogs/upscale-confirmation/upscale-confirmation.dialog';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FormsModule } from '@angular/forms';
import { MODES } from './models/mode';
import { ReplayCutterEditTeamScoreDialog } from './dialogs/edit-score/edit-score.dialog';
import { ReplayCutterEditMapDialog } from './dialogs/edit-map/edit-map.dialog';
import { NotificationService } from '../notification/services/notification.service';
import { ReplayCutterBeforeRemovingBordersDialog } from './dialogs/before-removing-borders/before-removing-borders.dialog';
import { ReplayCutterService } from './services/replay-cutter.service';

//#endregion

/**
 * Nom affiché des jeux autres qu'After-H, qui n'ont pas de map. Un jeu absent de
 * cette table (analyseur plus récent que l'interface) s'affiche sous son nom
 * technique plutôt que sous un « ? » qui ne dirait rien.
 */
const GAME_TYPE_LABEL: Record<string, string> = {
  'color-chaos': 'Color Chaos',
  zombies: 'Zombies',
  'gun-game': 'Gun Game',
  'free-for-all': 'Chacun pour soi'
};
// Modes du jeu After-H : ils ont une map, donc un nom et une vignette à afficher.
// Le jeu d'arme en fait partie — s'il a son propre type, c'est parce que son écran
// de fin ne porte pas de scores d'équipe, pas parce qu'il n'aurait pas de map.
// Color Chaos et Zombies, eux, n'en ont aucune : leur nom en tient lieu.
const AFTER_H_LIKE_TYPES = new Set(['after-h', 'gun-game', 'free-for-all']);

@Component({
  selector: 'view-replay_cutter',
  templateUrl: './replay_cutter.component.html',
  styleUrls: ['./replay_cutter.component.scss'],
  standalone: true,
  imports: [
    GridModule,
    MatTooltipModule,
    TranslateModule,
    LoaderComponent,
    MatInputModule,
    MatCheckboxModule,
    FormsModule
  ]
})
export class ReplayCutterComponent {
  //#region Attributes

  @ViewChild('debug') debug?: ElementRef<HTMLDivElement>;
  public debugPause: boolean = false;
  private settings: Settings = new Settings();

  protected percent: number = -1;
  protected inputFileDisabled: boolean = true;
  private lastDetectedGamePlayingFrame?: number;
  private pythonAnalysisRunning: boolean = false;

  private _videoPath: string | undefined;
  public set videoPath(value: string | undefined) {
    if (value) {
      this.percent = 0;
      this.globalService.loading = '';
      console.log(`The user defined this video path: "${value}"`);
      this.translateService
        .get('view.replay_cutter.videoIsBeingAnalyzed', {
          games: this._games.length
        })
        .subscribe((translated: string) => {
          window.electronAPI.showNotification(
            true,
            500,
            150,
            JSON.stringify({
              percent: 0,
              infinite: false,
              icon: undefined,
              text: translated,
              leftRounded: true
            })
          );
        });
    }
    this._videoPath = value;
  }
  public get videoPath(): string | undefined {
    return this._videoPath;
  }

  private _games: Game[] = [];
  public get games(): Game[] {
    return this._games;
  }

  private justJumped: boolean = false;
  private videoOldTime: number | undefined = undefined;
  private start: number = 0;

  private tesseractWorker_basic: Tesseract.Worker | undefined;
  private tesseractWorker_number: Tesseract.Worker | undefined;
  private tesseractWorker_letter: Tesseract.Worker | undefined;
  private tesseractWorker_time: Tesseract.Worker | undefined;

  protected maps: Map[] = [
    new Map('Artefact', ['artefact'], [4, 1, 6, 1], [38, 18, 390, 223]), // v
    new Map('Atlantis', ['atlantis'], [3, 2, 3, 2], [13, 21, 433, 228]), // v
    new Map('Ceres', ['ceres'], [3, 2, 3, 2], [20, 25, 420, 212]), // v
    new Map('Engine', ['engine'], [3, 2, 3, 2], [6, 12, 442, 225]), // v
    new Map(
      'Helios Station',
      ['helios', 'station'],
      [3, 2, 3, 2],
      [14, 23, 432, 217]
    ),
    new Map(
      'Lunar Outpost',
      ['lunar', 'outpost'],
      [3, 2, 3, 2],
      [18, 38, 593, 301]
    ),
    new Map('Outlaw', ['outlaw', 'qutlaw'], [3, 5, 5, 3], [4, 5, 269, 270]),
    new Map('Polaris', ['polaris'], [3, 2, 3, 2], [16, 18, 428, 237]), // v
    new Map('Silva', ['silva'], [3, 2, 3, 2], [29, 18, 310, 237]), // v
    new Map('The Cliff', ['cliff'], [3, 3, 3, 3]), // v
    new Map('The Rock', ['rock'], [3, 2, 3, 2], [14, 22, 432, 217]),
    new Map('Horizon', ['horizon'], [3, 2, 3, 2], [19, 29, 327, 209]) // v
  ];

  //#endregion

  constructor(
    protected readonly globalService: GlobalService,
    private readonly toastrService: ToastrService,
    private readonly ngZone: NgZone,
    private readonly translateService: TranslateService,
    private readonly openCVService: OpenCVService,
    private readonly dialogService: MatDialog,
    private readonly notificationService: NotificationService
  ) {}

  //#region Functions

  ngOnInit(): void {
    this.videoPath = undefined;
    window.electronAPI.removeNotification(false);

    this.initServices();

    window.electronAPI.globalMessage(
      (i18nPath: string, i18nVariables: object) => {
        this.ngZone.run(() => {
          if (!i18nPath) {
            this.inputFileDisabled = false;
          }
        });
      }
    );

    // The server send the border removing process percent to the font-end.
    window.electronAPI.setRemoveBordersPercent((percent: number) => {
      this.ngZone.run(() => {
        this.globalService.loading = '';

        this.translateService
          .get('view.notification.removing-border.description')
          .subscribe((translated: string) => {
            this.notificationService.sendMessage({
              percent: percent,
              infinite: false,
              icon: undefined,
              text: translated,
              leftRounded: true,
              state: 'info'
            });
          });
      });
    });

    // The server send the manual cut process percent to the font-end.
    window.electronAPI.setManualCutPercent((percent: number) => {
      this.ngZone.run(() => {
        this.globalService.loading = '';

        this.translateService
          .get('view.notification.manual-cutting.description')
          .subscribe((translated: string) => {
            this.notificationService.sendMessage({
              percent: percent,
              infinite: percent == 100,
              icon:
                percent == 100 ? 'fa-sharp fa-solid fa-scissors' : undefined,
              text: translated,
              leftRounded: true,
              state: 'info'
            });
          });
      });
    });

    // The server gives the path of the video file selected by the user.
    window.electronAPI.setVideoFile((path: string) => {
      window.electronAPI.removeNotification(false);
      this.ngZone.run(() => {
        if (path) {
          this.videoPath = encodeURIComponent(path);
        }
        else {
          this.globalService.loading = undefined;
        }
      });
    });

    // Receive progress / result updates from the Python analyzer binary.
    window.electronAPI.onAnalyzerUpdate((msg) => {
      this.ngZone.run(() => {
        switch (msg.type) {
          case 'progress':
            this.percent = msg.percent ?? this.percent;
            const GAMES_COUNT =
              typeof msg.nbGames === 'number'
                ? msg.nbGames
                : this._games.length;
            if (this.percent > 0) {
              this.translateService
                .get('view.replay_cutter.videoIsBeingAnalyzed', {
                  games: GAMES_COUNT
                })
                .subscribe((translated: string) => {
                  this.notificationService.sendMessage({
                    percent: this.percent,
                    infinite: this.percent === 0,
                    icon: undefined,
                    text: translated,
                    leftRounded: true,
                    state: 'info'
                  });
                });
            }
            break;
          case 'done':
            console.log('[analyzer] done');
            this.pythonAnalysisRunning = false;
            this.globalService.loading = undefined;
            this.onVideoEnded(this._games);
            break;
          case 'error':
            console.error('[analyzer] error:', msg.message);
            this.pythonAnalysisRunning = false;
            this.globalService.loading = undefined;
            this.onVideoEnded(this._games);
            break;
          case 'game':
            if (msg.game) {
              this._games.unshift(this.createGameFromJSON(msg.game));
            }
            break;
          default:
            console.log('[analyzer]', msg);
            break;
        }
      });
    });
  }

  /**
   * Returns true if all games in the list are checked.
   * Used to determine the checked state of the master checkbox in the table header.
   * @returns true if there are games and all are checked, false otherwise.
   */
  protected get allGamesChecked(): boolean {
    return this._games.length > 0 && this._games.every((game) => game.checked);
  }

  /**
   * Returns true if at least one game in the list is checked.
   * Used to determine the indeterminate state of the master checkbox in the table header.
   * @returns true if any game is checked, false if no games are checked.
   */
  protected get someGamesChecked(): boolean {
    return this._games.some((game) => game.checked);
  }

  /**
   * Toggles the checked state of all games in the list.
   * If all games are currently checked, it will uncheck them all.
   * If not all games are checked, it will check them all.
   * Triggered by clicking the master checkbox in the table header.
   */
  protected toggleAllGames(): void {
    const SHOULD_CHECK = !this.allGamesChecked;
    this._games.forEach((game) => (game.checked = SHOULD_CHECK));
  }

  /**
   * Returns true if the application is running in development mode.
   * @returns true if in development mode, false otherwise.
   */
  protected get isDevMode(): boolean {
    return isDevMode();
  }

  /**
   * Initializes the required services for the replay cutter component.
   * This includes initializing Tesseract for OCR functionality and setting up OpenCV with proper error handling.
   * Once OpenCV is successfully loaded, enables the file input for video processing.
   */
  private async initServices(): Promise<void> {
    await this.initTesseract();

    this.openCVService.isLoaded$.subscribe((loaded: boolean) => {
      if (loaded) {
        console.debug('OpenCV is loaded');
      } else {
        console.error("OpenCV isn't loaded");
        this.toastrService.error("Erreur lors du chargement d'OpenCV");
      }
    });
  }

  /**
   * Opens the settings dialog with the current settings.
   */
  protected openSettings(): void {
    this.dialogService.open(ReplayCutterSettingsDialog, {
      data: this.settings,
      autoFocus: false,
      disableClose: true
    });
  }

  /**
   * Automatically detects the minimap dimensions by analyzing the white borders in the upper left corner of the image.
   * @param videoFrame The canvas containing the image to be analyzed.
   * @returns The coordinates of the minimap (x1, y1, x2, y2) or the default values ​​if not found.
   */
  public detectMinimap(
    game: Game,
    callback: Function,
    index: number = 0,
    max: number = 30
  ): void {
    if (this._videoPath) {
      console.log(
        `"detectMinimap": Trying to detect the minimap (${index})...`
      );
      let retry: boolean = false;

      const BACK: CropperPosition = JSON.parse(
        JSON.stringify(ReplayCutterCropDialog.DEFAULT_CROPPER)
      );

      ReplayCutterService.videoURLToCanvas(
        `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
        Math.round((game.start + index) * 1000),
        (videoFrame?: HTMLCanvasElement) => {
          if (videoFrame) {
            const CTX = videoFrame.getContext('2d');
            if (CTX) {
              const IMAGE_DATA = CTX.getImageData(
                0,
                0,
                videoFrame.width,
                videoFrame.height
              ).data;

              const MAX_COLOR_DIFFERENCE: number = 50;

              // We are looking for x1
              l1: for (
                let x = 0;
                x < ReplayCutterCropDialog.DEFAULT_CROPPER.x2;
                x++
              ) {
                for (
                  let y = 0;
                  y < ReplayCutterCropDialog.DEFAULT_CROPPER.y2;
                  y++
                ) {
                  const INDEX = (y * videoFrame.width + x) * 4;
                  const R = IMAGE_DATA[INDEX];
                  const G = IMAGE_DATA[INDEX + 1];
                  const B = IMAGE_DATA[INDEX + 2];

                  if (
                    ReplayCutterService.colorSimilarity(
                      new RGB(R, G, B),
                      new RGB(255, 255, 255),
                      MAX_COLOR_DIFFERENCE
                    )
                  ) {
                    BACK.x1 = x;
                    break l1;
                  }
                }
              }

              // We are looking for x2
              l1: for (
                let x = ReplayCutterCropDialog.DEFAULT_CROPPER.x2;
                x >= 0;
                x--
              ) {
                for (
                  let y = 0;
                  y < ReplayCutterCropDialog.DEFAULT_CROPPER.y2;
                  y++
                ) {
                  const INDEX = (y * videoFrame.width + x) * 4;
                  const R = IMAGE_DATA[INDEX];
                  const G = IMAGE_DATA[INDEX + 1];
                  const B = IMAGE_DATA[INDEX + 2];

                  if (
                    ReplayCutterService.colorSimilarity(
                      new RGB(R, G, B),
                      new RGB(255, 255, 255),
                      MAX_COLOR_DIFFERENCE
                    )
                  ) {
                    BACK.x2 = x + 1;
                    break l1;
                  }
                }
              }

              // We are looking for y1
              l1: for (
                let y = 0;
                y < ReplayCutterCropDialog.DEFAULT_CROPPER.y2;
                y++
              ) {
                for (
                  let x = 0;
                  x < ReplayCutterCropDialog.DEFAULT_CROPPER.x2;
                  x++
                ) {
                  const INDEX = (y * videoFrame.width + x) * 4;
                  const R = IMAGE_DATA[INDEX];
                  const G = IMAGE_DATA[INDEX + 1];
                  const B = IMAGE_DATA[INDEX + 2];

                  if (
                    ReplayCutterService.colorSimilarity(
                      new RGB(R, G, B),
                      new RGB(255, 255, 255),
                      MAX_COLOR_DIFFERENCE
                    )
                  ) {
                    BACK.y1 = y;
                    break l1;
                  }
                }
              }

              // We are looking for y1
              l1: for (
                let y = ReplayCutterCropDialog.DEFAULT_CROPPER.y2;
                y >= 0;
                y--
              ) {
                for (
                  let x = 0;
                  x < ReplayCutterCropDialog.DEFAULT_CROPPER.x2;
                  x++
                ) {
                  const INDEX = (y * videoFrame.width + x) * 4;
                  const R = IMAGE_DATA[INDEX];
                  const G = IMAGE_DATA[INDEX + 1];
                  const B = IMAGE_DATA[INDEX + 2];

                  if (
                    ReplayCutterService.colorSimilarity(
                      new RGB(R, G, B),
                      new RGB(255, 255, 255),
                      MAX_COLOR_DIFFERENCE
                    )
                  ) {
                    BACK.y2 = y + 1;
                    break l1;
                  }
                }
              }
            }

            // Map bound check

            const GAME_MAP = ReplayCutterService.getMapByName(game.map);
            if (GAME_MAP && GAME_MAP.mapBound) {
              const TOLERANCE: number = videoFrame.width * 0.01;

              if (
                // X
                BACK.x1 < GAME_MAP.mapBound[0] - TOLERANCE ||
                BACK.x1 > GAME_MAP.mapBound[0] + TOLERANCE ||
                // Y
                BACK.y1 < GAME_MAP.mapBound[1] - TOLERANCE ||
                BACK.y1 > GAME_MAP.mapBound[1] + TOLERANCE ||
                // Width
                BACK.x2 <
                  GAME_MAP.mapBound[0] + GAME_MAP.mapBound[2] - TOLERANCE ||
                BACK.x2 >
                  GAME_MAP.mapBound[0] + GAME_MAP.mapBound[2] + TOLERANCE ||
                // Height
                BACK.y2 <
                  GAME_MAP.mapBound[1] + GAME_MAP.mapBound[3] - TOLERANCE ||
                BACK.y2 >
                  GAME_MAP.mapBound[1] + GAME_MAP.mapBound[3] + TOLERANCE
              ) {
                retry = true;
                console.warn(
                  'Error: "detectMinimap", the dimensions of the minimap do not match the expected.'
                );
                if (index < max) {
                  console.warn('Retrying...');
                  this.detectMinimap(game, callback, index + 1, max);
                } else {
                  console.warn(`index == max (${max})...`);
                  callback(BACK, videoFrame);
                }
              }
            }

            if (!retry) {
              callback(BACK, videoFrame);
            }
          }
        }
      );
    } else {
      console.error('Error: "detectMinimap", this._videoPath is undefined.');
    }
  }

  /**
   * This function initializes the different instances of the OCR.
   */
  private async initTesseract(): Promise<void> {
    this.tesseractWorker_basic = await createWorker('eng');
    this.tesseractWorker_number = await createWorker('eng');
    this.tesseractWorker_letter = await createWorker('eng');
    this.tesseractWorker_time = await createWorker('eng');

    this.tesseractWorker_basic.setParameters({
      tessedit_char_whitelist:
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    });
    this.tesseractWorker_number.setParameters({
      tessedit_char_whitelist: '0123456789'
    });
    this.tesseractWorker_letter.setParameters({
      tessedit_char_whitelist:
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz '
    });
    this.tesseractWorker_time.setParameters({
      tessedit_char_whitelist: '0123456789:'
    });

    this.inputFileDisabled = false;
  }

  /**
   * Automatically detects the position boundaries of a team's player information area on a replay video frame by analyzing team color pixels to determine the UI bounds.
   * @param gameIndex Index of the game to analyze.
   * @param color RGB color of the team to detect (orange or blue).
   * @param callback Function called with the detected position bounds {left, top, bottom, right}.
   */
  private getTeamInfosPosition(
    gameIndex: number,
    color: RGB,
    callback: Function,
    frame?: CanvasImageSource,
    index: number = 1,
    nbPlayers: number = 4
  ): void {
    if (frame) {
      this.getTeamInfosPosition_Step2(
        gameIndex,
        color,
        callback,
        frame,
        index,
        nbPlayers
      );
    } else if (this._videoPath) {
      ReplayCutterService.videoURLToCanvas(
        `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
        (this._games[gameIndex].start + index) * 1000,
        (videoFrame?: HTMLCanvasElement) => {
          if (videoFrame) {
            this.getTeamInfosPosition_Step2(
              gameIndex,
              color,
              callback,
              videoFrame,
              index,
              nbPlayers
            );
          }
        }
      );
    }
  }

  /**
   * Determines the bounding box of a team's information area in a frame based on its color.
   * The function scans the frame vertically to find the top and bottom edges, then horizontally to find the left and right edges of the team info.
   * @param color The RGB color representing the team
   * @param frame The source image or video frame
   * @param callback A function called with the calculated bounding box { x1, y1, x2, y2, frame }
   */
  private getTeamInfosPosition_Step2(
    gameIndex: number,
    color: RGB,
    callback: Function,
    frame: CanvasImageSource,
    index: number,
    nbPlayers: number
  ): void {
    const EXPECTED_HEIGHT: number = 83;
    const TOLERANCE: number = 0.1;

    let step = 0;

    let top = 0;
    let right = 0;
    let bottom = 0;
    let left = 0;

    const TEAM_IS_ORANGE = color.r > 255 / 2;

    const FRAME_DATA = ReplayCutterService.captureFrameData(frame);
    if (!FRAME_DATA) {
      return;
    }

    // We are looking for the bottom and the top.
    const X: number = TEAM_IS_ORANGE ? 125 : 1806;
    for (let y = ReplayCutterService.getSourceSize(frame).height; y >= 0; y--) {
      const IS_PRIMARY_COLOR = ReplayCutterService.colorSimilarity(
        ReplayCutterService.getPixelColorFromData(FRAME_DATA, X, y),
        color
      );

      if (IS_PRIMARY_COLOR && bottom == 0) {
        bottom = Math.floor(
          y + ReplayCutterService.getSourceSize(frame).height * 0.058
        );
        step = 1;
        continue;
      }

      if (
        (!IS_PRIMARY_COLOR && step == 1) ||
        (IS_PRIMARY_COLOR && step == 2) ||
        (!IS_PRIMARY_COLOR && step == 3) ||
        (IS_PRIMARY_COLOR && step == 4) ||
        (!IS_PRIMARY_COLOR && step == 5) ||
        (IS_PRIMARY_COLOR && step == 6) ||
        (!IS_PRIMARY_COLOR && step == 7)
      ) {
        step++;
        continue;
      }

      if (!IS_PRIMARY_COLOR && step == 8) {
        top = y;
        break;
      }
    }

    // We are looking for the left and the right.
    const Y = Math.floor(
      top + ReplayCutterService.getSourceSize(frame).height * 0.005
    );
    for (
      let x = 0;
      x < ReplayCutterService.getSourceSize(frame).width / 4;
      x++
    ) {
      const IS_PRIMARY_COLOR = ReplayCutterService.colorSimilarity(
        ReplayCutterService.getPixelColorFromData(
          FRAME_DATA,
          TEAM_IS_ORANGE
            ? x
            : ReplayCutterService.getSourceSize(frame).width - x,
          Y
        ),
        color,
        30
      );

      if (IS_PRIMARY_COLOR) {
        if (TEAM_IS_ORANGE) {
          if (left == 0) {
            left = x;
          }
          right = x;
        } else {
          if (right == 0) {
            right = ReplayCutterService.getSourceSize(frame).width - x;
          }
          left = ReplayCutterService.getSourceSize(frame).width - x;
        }
      }
    }

    const HEIGHT = bottom - top;
    const WIDTH = right - left;
    if (
      WIDTH <= 0 ||
      HEIGHT < EXPECTED_HEIGHT * nbPlayers * (1 - TOLERANCE) ||
      HEIGHT > EXPECTED_HEIGHT * nbPlayers * (1 + TOLERANCE)
    ) {
      console.warn(
        '"getTeamInfosPosition_Step2", the team infos image width or height seems wrong, retrying...'
      );
      this.getTeamInfosPosition(
        gameIndex,
        color,
        callback,
        undefined,
        index + 1,
        nbPlayers
      );
    } else {
      callback({
        x1: left,
        y1: top,
        x2: right,
        y2: bottom,
        frame: frame
      });
    }
  }

  /**
   * Handles the user's click on the file input to select a replay video.
   * Initializes the state for a new replay selection and opens the file dialog.
   * @param training Indicates whether the replay is for training mode.
   */
  protected onInputFileClick(): void {
    if (!this.inputFileDisabled) {
      this.inputFileDisabled = true;
      this.videoPath = undefined;
      this._games = [];

      window.electronAPI
        .openFiles(['mp4', 'mkv'])
        .then((filesPath: string[]) => {
          if (filesPath.length > 0) {
            this.analyzeVideoFile(filesPath[0]);
          }
        });
    }
  }

  private analyzeVideoFile(videoFilePath: string): void {
    ReplayCutterService.videoURLToCanvas(
      `http://localhost:${this.globalService.serverPort}/file?path=${encodeURIComponent(videoFilePath)}`,
      15 * 1000,
      (videoFrame?: HTMLCanvasElement) => {
        if (videoFrame) {
          const SIZE = ReplayCutterService.getSourceSize(videoFrame);
          const TARGET_WIDTH: number = 1920;
          const TARGET_HEIGHT: number = 1080;

          console.log(SIZE);

          if (SIZE.width == TARGET_WIDTH && SIZE.height == TARGET_HEIGHT) {
            this.startPythonAnalysis(videoFilePath);
          } else {
            this.dialogService
              .open(ReplayCutterUpscaleConfirmationDialog, {
                autoFocus: false,
                disableClose: true,
                data: SIZE.height
              })
              .afterClosed()
              .subscribe(async (upscale: boolean) => {
                if (upscale) {
                  this.translateService
                    .get('view.notification.upscaling.description')
                    .subscribe((translated: string) => {
                      window.electronAPI.showNotification(
                        true,
                        550,
                        150,
                        JSON.stringify({
                          percent: 0,
                          infinite: false,
                          icon: undefined,
                          text: translated,
                          leftRounded: true
                        })
                      );
                    });

                  const RESCALED_FILE_PATH =
                    await window.electronAPI.setVideoResolution(
                      videoFilePath,
                      TARGET_WIDTH,
                      TARGET_HEIGHT
                    );
                  if (RESCALED_FILE_PATH) {
                    this.analyzeVideoFile(RESCALED_FILE_PATH);
                  }
                } else {
                  this.globalService.loading = undefined;
                }
              });
          }
        }
      }
    );
  }

  /**
   * Launches the Python analyzer binary and wires up progress/result updates.
   * @param videoFilePath Absolute path to the 1920×1080 video to analyse.
   */
  private startPythonAnalysis(videoFilePath: string): void {
    this.percent = 0;
    this.inputFileDisabled = true;
    this._videoPath = videoFilePath;
    this._games = [];
    this.pythonAnalysisRunning = true;

    window.electronAPI.runAnalyzer(
      videoFilePath,
      JSON.stringify({
        maxTimePerGame: this.settings.maxTimePerGame
      })
    );
  }

  /**
   * Nom affiché d'un jeu qui n'est pas de l'After-H : ces jeux n'ont pas de map,
   * c'est leur nom qui en tient lieu dans le tableau.
   */
  public gameTypeLabel(gameType: string): string {
    return GAME_TYPE_LABEL[gameType] ?? gameType;
  }

  /** Cette game a-t-elle une map à afficher (nom + vignette) ? */
  public hasMap(gameType: string): boolean {
    return AFTER_H_LIKE_TYPES.has(gameType);
  }

  /**
   * Mode mentionné à côté de la map, pour les modes d'After-H qui ne sont pas
   * une game ordinaire — aujourd'hui le seul jeu d'arme.
   *
   * Ce n'est pas décoratif : la détection du jeu d'arme repose sur un libellé
   * lu à l'écran, avec un seuil calibré sur peu d'enregistrements et sur un
   * TEXTE, que le jeu pourrait traduire. Afficher le mode reconnu rend une
   * défaillance visible — sans mention, une détection qui ne déclenche pas
   * passerait inaperçue, la game s'affichant comme une After-H ordinaire.
   */
  public gameModeMention(gameType: string): string {
    if (gameType === 'after-h' || !AFTER_H_LIKE_TYPES.has(gameType)) return '';
    return GAME_TYPE_LABEL[gameType] ?? gameType;
  }

  /**
   * Reconstructs a typed Game instance from a plain JSON object emitted by the Python analyzer.
   */
  private createGameFromJSON(data: {
    mode: number;
    gameType?: string;
    start: number;
    end: number;
    map: string;
    mapImage?: string;
    orangeTeam: {
      score: number;
      nameImage?: string;
      scoreImage?: string;
    };
    blueTeam: {
      score: number;
      nameImage?: string;
      scoreImage?: string;
    };
  }): Game {
    const GAME = new Game(data.mode ?? 0);
    GAME.gameType = data.gameType ?? 'after-h';
    GAME.start = data.start ?? 0;
    GAME.end = data.end ?? 0;
    GAME.map = data.map ?? '';
    GAME.mapImage = data.mapImage ?? undefined;
    GAME.orangeTeam.score = data.orangeTeam?.score ?? 0;
    GAME.orangeTeam.nameImage = data.orangeTeam?.nameImage ?? undefined;
    GAME.orangeTeam.scoreImage = data.orangeTeam?.scoreImage ?? undefined;
    GAME.blueTeam.score = data.blueTeam?.score ?? 0;
    GAME.blueTeam.nameImage = data.blueTeam?.nameImage ?? undefined;
    GAME.blueTeam.scoreImage = data.blueTeam?.scoreImage ?? undefined;
    return GAME;
  }

  /**
   * Handles updates to the video's current time during playback for analysis purposes.
   * This function analyzes each frame to detect game start, end, score frames, team names, and map names.
   * It updates the progress percentage, extracts relevant images and text using OCR, and manages game states.
   * Supports debug pause mode, automatic time jumps to game start, and notifications of analysis progress.
   * @param event The time update event from the video element.
   */
  protected async videoTimeUpdate(event: Event): Promise<void> {
    if (this.pythonAnalysisRunning) {
      return;
    }
    if (this.debugPause) {
      setTimeout(() => {
        this.videoTimeUpdate(event);
      }, 1000);
    } else {
      if (this._videoPath) {
        if (this.start == 0) {
          this.start = Date.now();
        }
        if (event.target) {
          const VIDEO = event.target as HTMLVideoElement;
          let found: boolean = false;
          const DEFAULT_STEP: number = 1;
          if (VIDEO.currentTime > 0) {
            const NOW: number = VIDEO.currentTime;
            this.percent = Math.ceil(100 - (NOW / VIDEO.duration) * 100);

            this.translateService
              .get('view.replay_cutter.videoIsBeingAnalyzed', {
                games: this._games.length
              })
              .subscribe((translated: string) => {
                this.notificationService.sendMessage({
                  percent: this.percent,
                  infinite: false,
                  icon: undefined,
                  text: translated,
                  leftRounded: true,
                  state: 'info'
                });
              });

            const FRAME_DATA = ReplayCutterService.captureFrameData(VIDEO);
            if (!FRAME_DATA) {
              return;
            }

            //#region Detection of a game score frame

            if (!found) {
              const MODE = ReplayCutterService.detectGameScoreFrame(FRAME_DATA);
              if (MODE >= 0) {
                found = true;
                if (this._games.length == 0 || this._games[0].start != -1) {
                  if (MODE >= 0) {
                    this.justJumped = false;
                    const GAME: Game = new Game(MODE);
                    GAME.end = NOW - 1;
                    //#region Orange team

                    const ORANGE_TEAM_SCORE: string =
                      await ReplayCutterService.getTextFromImage(
                        VIDEO,
                        this.tesseractWorker_number!,
                        MODES[MODE].scoreFrame.orangeScore[0].x,
                        MODES[MODE].scoreFrame.orangeScore[0].y,
                        MODES[MODE].scoreFrame.orangeScore[1].x,
                        MODES[MODE].scoreFrame.orangeScore[1].y,
                        7,
                        200,
                        true,
                        undefined,
                        ReplayCutterService.scoreChecker
                      );
                    if (ORANGE_TEAM_SCORE) {
                      const INT_VALUE = Number.parseInt(ORANGE_TEAM_SCORE);
                      if (INT_VALUE <= 100) {
                        GAME.orangeTeam.score = INT_VALUE;
                      }
                    }

                    //#endregion

                    //#region Blue team

                    const BLUE_TEAM_SCORE: string =
                      await ReplayCutterService.getTextFromImage(
                        VIDEO,
                        this.tesseractWorker_number!,
                        MODES[MODE].scoreFrame.blueScore[0].x,
                        MODES[MODE].scoreFrame.blueScore[0].y,
                        MODES[MODE].scoreFrame.blueScore[1].x,
                        MODES[MODE].scoreFrame.blueScore[1].y,
                        7,
                        200,
                        true,
                        undefined,
                        ReplayCutterService.scoreChecker
                      );
                    // DEBUG
                    this.debug?.nativeElement.append(
                      ReplayCutterService.videoToCanvas(VIDEO)
                    );
                    if (BLUE_TEAM_SCORE) {
                      const INT_VALUE = Number.parseInt(BLUE_TEAM_SCORE);
                      if (INT_VALUE <= 100) {
                        GAME.blueTeam.score = INT_VALUE;
                      }
                    }

                    //#endregion

                    const FRAME = ReplayCutterService.videoToCanvas(VIDEO);
                    if (FRAME) {
                      GAME.orangeTeam.scoreImage =
                        ReplayCutterService.cropImage(
                          FRAME,
                          MODES[MODE].scoreFrame.orangeScore[0].x,
                          MODES[MODE].scoreFrame.orangeScore[0].y,
                          MODES[MODE].scoreFrame.orangeScore[1].x,
                          MODES[MODE].scoreFrame.orangeScore[1].y
                        )?.toDataURL();

                      GAME.orangeTeam.nameImage = ReplayCutterService.cropImage(
                        FRAME,
                        MODES[MODE].scoreFrame.orangeName[0].x,
                        MODES[MODE].scoreFrame.orangeName[0].y,
                        MODES[MODE].scoreFrame.orangeName[1].x,
                        MODES[MODE].scoreFrame.orangeName[1].y
                      )?.toDataURL();

                      GAME.blueTeam.scoreImage = ReplayCutterService.cropImage(
                        FRAME,
                        MODES[MODE].scoreFrame.blueScore[0].x,
                        MODES[MODE].scoreFrame.blueScore[0].y,
                        MODES[MODE].scoreFrame.blueScore[1].x,
                        MODES[MODE].scoreFrame.blueScore[1].y
                      )?.toDataURL();

                      GAME.blueTeam.nameImage = ReplayCutterService.cropImage(
                        FRAME,
                        MODES[MODE].scoreFrame.blueName[0].x,
                        MODES[MODE].scoreFrame.blueName[0].y,
                        MODES[MODE].scoreFrame.blueName[1].x,
                        MODES[MODE].scoreFrame.blueName[1].y
                      )?.toDataURL();
                    }

                    this._games.unshift(GAME);

                    this.translateService
                      .get('view.replay_cutter.videoIsBeingAnalyzed', {
                        games: this._games.length
                      })
                      .subscribe((translated: string) => {
                        this.notificationService.sendMessage({
                          percent: this.percent,
                          infinite: false,
                          icon: undefined,
                          text: translated,
                          leftRounded: true,
                          state: 'info'
                        });
                      });
                  }
                } else if (
                  this.lastDetectedGamePlayingFrame &&
                  this._games[0].start == -1
                ) {
                  /*
                  console.log('SUPER SOLVE');
                  this._games[0].start = this.lastDetectedGamePlayingFrame;
                  this.lastDetectedGamePlayingFrame = undefined;
                  console.log(this._games[0].map);
                  */
                }
              }
            }

            //#endregion

            //#region Detection of the end of a game

            if (!found) {
              if (ReplayCutterService.detectGameEndFrame(FRAME_DATA)) {
                found = true;

                if (this._games.length == 0 || this._games[0].start != -1) {
                  this.justJumped = false;
                  const GAME: Game = new Game(1);
                  GAME.end = NOW;

                  const ORANGE_TEAM_SCORE: string =
                    await ReplayCutterService.getTextFromImage(
                      VIDEO,
                      this.tesseractWorker_number!,
                      636,
                      545,
                      903,
                      648,
                      7
                    );
                  if (ORANGE_TEAM_SCORE) {
                    const INT_VALUE = Number.parseInt(ORANGE_TEAM_SCORE);
                    if (INT_VALUE <= 100) {
                      GAME.orangeTeam.score = INT_VALUE;
                    }
                  }

                  const BLUE_TEAM_SCORE: string =
                    await ReplayCutterService.getTextFromImage(
                      VIDEO,
                      this.tesseractWorker_number!,
                      996,
                      545,
                      1257,
                      648,
                      7
                    );
                  if (BLUE_TEAM_SCORE) {
                    const INT_VALUE = Number.parseInt(BLUE_TEAM_SCORE);
                    if (INT_VALUE <= 100) {
                      GAME.blueTeam.score = INT_VALUE;
                    }
                  }

                  this._games.unshift(GAME);
                } else if (
                  this.lastDetectedGamePlayingFrame &&
                  this._games[0].start == -1
                ) {
                  /*
                  console.log('SUPER SOLVE 2222222222222');
                  this._games[0].start = this.lastDetectedGamePlayingFrame;
                  this.lastDetectedGamePlayingFrame = undefined;
                  console.log(this._games[0].map);
                  */
                }
              }
            }

            //#endregion

            //#region Detection of the start of a game

            if (!found) {
              if (
                ReplayCutterService.detectGameLoadingFrame(
                  FRAME_DATA,
                  this._games
                )
              ) {
                found = true;
                this.lastDetectedGamePlayingFrame = undefined;
                this._games[0].start =
                  NOW + 2 /* We remove the map loader end. */;
              }
            }

            if (!found) {
              if (
                ReplayCutterService.detectGameIntro(FRAME_DATA, this._games)
              ) {
                found = true;
                this.lastDetectedGamePlayingFrame = undefined;
                this._games[0].start =
                  NOW + 2 /* We remove the map animation bit. */;
              }
            }

            //#endregion

            //#region Detecting card name during game.

            if (!found) {
              if (
                ReplayCutterService.detectGamePlaying(FRAME_DATA, this._games)
              ) {
                this.lastDetectedGamePlayingFrame = NOW;
                // We are looking for the name of the map.
                if (this._games[0].map == '') {
                  const TEXT: string =
                    await ReplayCutterService.getTextFromImage(
                      VIDEO,
                      this.tesseractWorker_letter!,
                      MODES[this._games[0].mode].gameFrame.map[0].x,
                      MODES[this._games[0].mode].gameFrame.map[0].y,
                      MODES[this._games[0].mode].gameFrame.map[1].x,
                      MODES[this._games[0].mode].gameFrame.map[1].y,
                      7,
                      225,
                      true
                    );

                  if (TEXT) {
                    found = true;
                    if (this._games[0].map == '') {
                      const MAP_NAME: string =
                        ReplayCutterService.getMapByName(TEXT)?.name ?? '';
                      this._games[0].map = MAP_NAME;

                      const FRAME = ReplayCutterService.videoToCanvas(VIDEO);
                      if (FRAME) {
                        this._games[0].mapImage = ReplayCutterService.cropImage(
                          FRAME,
                          MODES[this._games[0].mode].gameFrame.map[0].x,
                          MODES[this._games[0].mode].gameFrame.map[0].y,
                          MODES[this._games[0].mode].gameFrame.map[1].x,
                          MODES[this._games[0].mode].gameFrame.map[1].y
                        )?.toDataURL();
                      }
                    }
                  }
                }

                if (this._games[0].map) {
                  if (!this._games[0].__debug__jumped) {
                    if (!this.justJumped) {
                      const TEXT: string =
                        await ReplayCutterService.getTextFromImage(
                          VIDEO,
                          this.tesseractWorker_time!,
                          MODES[this._games[0].mode].gameFrame.timer[0].x,
                          MODES[this._games[0].mode].gameFrame.timer[0].y,
                          MODES[this._games[0].mode].gameFrame.timer[1].x,
                          MODES[this._games[0].mode].gameFrame.timer[1].y,
                          7
                        );
                      if (TEXT) {
                        found = true;
                        const SPLITTED /* string[] */ = TEXT.split(':');
                        if (SPLITTED.length == 2) {
                          const MINUTES = Number.parseInt(SPLITTED[0]);
                          const SECONDES = Number.parseInt(SPLITTED[1]);

                          if (
                            !Number.isNaN(MINUTES) &&
                            !Number.isNaN(SECONDES)
                          ) {
                            if (MINUTES <= 9) {
                              const DIFFERENCE = Math.max(
                                (this.settings.maxTimePerGame - MINUTES) * 60 -
                                  SECONDES -
                                  20
                              );
                              if (!this._games[0].__debug__jumped) {
                                this._games[0].__debug__jumped = true;
                                console.log(
                                  `All game data has been recovered. Jumping to game's start ! (${MINUTES}:${SECONDES}) (${NOW - DIFFERENCE})`
                                );
                                this.lastDetectedGamePlayingFrame =
                                  NOW - DIFFERENCE;
                                this.justJumped = true;
                                this.setVideoCurrentTime(
                                  VIDEO,
                                  NOW - DIFFERENCE,
                                  this._games
                                );
                                return;
                              }
                            }
                          }
                        }
                      }
                    } else {
                      console.log('Jump is disabled');
                    }
                  }
                }
              }
            }

            //#endregion

            this.setVideoCurrentTime(
              VIDEO,
              Math.max(0, NOW - DEFAULT_STEP),
              this._games
            );
          } else {
            this.onVideoEnded(this._games);

            const DIFFERENCE = Date.now() - this.start;
            const MINUTES = Math.floor(DIFFERENCE / 60000);
            const SECONDS = Math.floor((DIFFERENCE % 60000) / 1000);

            console.log(
              `Scan duration:\n${MINUTES.toString().padStart(
                2,
                '0'
              )}m ${SECONDS.toString().padStart(2, '0')}s`
            );
            this.start = 0;
          }
        }
      }
    }
  }

  /**
   * This function allows you to set the timecode of the video.
   * @param video HTML DOM of the video element to set the timecode to
   * @param time Timecode in seconds to apply.
   * @param games List of games already detected.
   * @param discordServerURL EBP Discord server URL.
   */
  private setVideoCurrentTime(
    video: HTMLVideoElement,
    time: number,
    games: Game[]
  ): void {
    if (video) {
      if (time < video.duration) {
        if (this.videoOldTime == time) {
          console.warn(
            'The "setVideoCurrentTime" function seems to fail to change the video time. The analysis is considered finished.'
          );
          this.onVideoEnded(games);
        } else {
          video.currentTime = time;
          this.videoOldTime = time;
        }
      } else {
        this.onVideoEnded(games);
      }
    }
  }

  /**
   * This function is executed when the video scan is complete.
   * @param games List of detected games.
   */
  private onVideoEnded(games: Game[]): void {
    if (games.length == 0) {
      this.translateService
        .get('view.replay_cutter.toast.noGamesFoundInVideo')
        .subscribe((translated: string) => {
          this.toastrService.error(translated).onTap.subscribe(() => {
            window.electronAPI.openURL(this.globalService.discordServerURL);
          });
        });
    }
    this.percent = -1;
    console.log('onVideoEnded:\n', this._games);
    this.videoOldTime = undefined;
    window.electronAPI.removeNotification(true);
    this.globalService.loading = undefined;
    this.inputFileDisabled = false;
  }

  /**
   * This function allows the user to mute one of his games.
   * @param game Game to cut.
   */
  protected async save(game: Game): Promise<void> {
    if (this.videoPath === undefined) {
      this.translateService
        .get('view.replay_cutter.toast.videoFileNotFound')
        .subscribe((translated: string) => {
          this.toastrService.error(translated);
        });
      return;
    }
    this.globalService.loading = '';
    const FILE_PATH = await window.electronAPI.cutVideoFile(
      game,
      decodeURIComponent(this.videoPath),
      this.settings.freeText
    );
    this.globalService.loading = undefined;
    this.translateService
      .get('view.replay_cutter.toast.videoCutHere', { filePath: FILE_PATH })
      .subscribe((translated: string) => {
        this.toastrService.success(translated).onTap.subscribe(() => {
          window.electronAPI.openFile(FILE_PATH);
        });
      });
  }

  /**
   * This function allows the user to cut all games with a single click.
   */
  protected async saveAll(): Promise<void> {
    if (this.videoPath === undefined) {
      this.translateService
        .get('view.replay_cutter.toast.videoFileNotFound')
        .subscribe((translated: string) => {
          this.toastrService.error(translated);
        });
      return;
    }
    this.globalService.loading = '';
    const FILE_PATH = await window.electronAPI.cutVideoFiles(
      this._games.filter((game) => game.checked),
      decodeURIComponent(this.videoPath),
      this.settings.freeText
    );

    this.globalService.loading = undefined;
    this.translateService
      .get('view.replay_cutter.toast.videosCutHere', { filePath: FILE_PATH })
      .subscribe((translated: string) => {
        this.toastrService.success(translated).onTap.subscribe(() => {
          window.electronAPI.openFile(FILE_PATH);
        });
      });
  }

  /**
   * This function adds game timecodes to the user's clipboard.
   */
  protected copyTimeCodes(): void {
    let result = '';
    this._games
      .filter((game) => game.checked)
      .forEach((game) => {
        result += `${game.readableStart} - ${game.map}\n`;
      });
    navigator.clipboard.writeText(result);

    this.translateService
      .get('view.replay_cutter.toast.timeCodesCopiedClipboard')
      .subscribe((translated: string) => {
        this.toastrService.success(translated);
      });
  }

  /**
   * Opens a dialog to edit the map of a given game and updates the game with the selected map.
   * @param game The game object whose map is being edited
   */
  protected editGameMap(game: Game): void {
    this.dialogService
      .open(ReplayCutterEditMapDialog, {
        data: {
          map: game.map,
          maps: this.maps.map((x) => x.name)
        },
        width: '400px'
      })
      .afterClosed()
      .subscribe((newMap: string | undefined) => {
        if (newMap) {
          game.map = newMap;
        }
      });
  }

  /**
   * Opens a dialog to edit the score of a specific team for a given game.
   * @param game The game object to modify.
   * @param team The team whose score should be edited ('orange' or 'blue').
   */
  protected editTeamScore(game: Game, team: 'orange' | 'blue'): void {
    const CURRENT_SCORE =
      team === 'orange' ? game.orangeTeam.score : game.blueTeam.score;

    this.dialogService
      .open(ReplayCutterEditTeamScoreDialog, {
        data: CURRENT_SCORE,
        width: '400px'
      })
      .afterClosed()
      .subscribe((newScore: number | undefined) => {
        if (newScore) {
          if (team === 'orange') {
            game.orangeTeam.score = newScore;
          } else {
            game.blueTeam.score = newScore;
          }
        }
      });
  }

  protected openRemoveBorderDialog(): void {
    this.dialogService
      .open(ReplayCutterBeforeRemovingBordersDialog, {
        autoFocus: false
      })
      .afterClosed()
      .subscribe((crop: boolean | undefined) => {
        if (crop === true) {
          window.electronAPI
            .openFiles(['mp4', 'mkv'])
            .then((filesPath: string[]) => {
              if (filesPath.length > 0) {
                ReplayCutterService.videoURLToCanvas(
                  `http://localhost:${this.globalService.serverPort}/file?path=${filesPath[0]}`,
                  15 * 1000,
                  (videoFrame?: HTMLCanvasElement) => {
                    if (videoFrame) {
                      const DIALOG_WIDTH: string = 'calc(100vw - 12px * 4)';
                      const DIALOG_HEIGHT: string = 'calc(100vh - 12px * 4)';
                      const SIZE =
                        ReplayCutterService.getSourceSize(videoFrame);

                      this.dialogService
                        .open(ReplayCutterCropDialog, {
                          data: {
                            imgBase64: videoFrame.toDataURL('image/png'),
                            initialCropperPosition: {
                              x1: 0,
                              y1: 0,
                              x2: SIZE.width,
                              y2: SIZE.height
                            },
                            component: this,
                            gameIndex: -1
                          },
                          maxWidth: DIALOG_WIDTH,
                          maxHeight: DIALOG_HEIGHT,
                          width: DIALOG_WIDTH,
                          height: DIALOG_HEIGHT,
                          autoFocus: false
                        })
                        .afterClosed()
                        .subscribe((positions: CropperPosition | undefined) => {
                          window.electronAPI.setWindowSize();
                          if (positions) {
                            this.translateService
                              .get(
                                'view.notification.removing-border.description'
                              )
                              .subscribe((translated: string) => {
                                window.electronAPI.showNotification(
                                  true,
                                  500,
                                  150,
                                  JSON.stringify({
                                    percent: 0,
                                    infinite: false,
                                    icon: undefined,
                                    text: translated,
                                    leftRounded: true
                                  })
                                );
                              });
                            this.globalService.loading = '';
                            window.electronAPI.removeBorders(
                              positions,
                              filesPath[0]
                            );
                          } else {
                            this.globalService.loading = undefined;
                          }
                        });
                    }
                  }
                );
              }
            });
        } else {
          this.globalService.loading = undefined;
        }
      });
  }

  //#endregion
}
