// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { GridModule } from '../../shared/grid/grid.module';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ConnectedPosition, OverlayModule } from '@angular/cdk/overlay';
import { FormsModule } from '@angular/forms';

import { ToastrService } from 'ngx-toastr';
import { MessageComponent } from '../../shared/message/message.component';
import { GlobalService } from '../../core/services/global.service';
import {
  ArenaAudioLevel,
  ArenaCaptureStatus,
  ArenaLocation,
  ArenaModeState,
  ArenaScene,
  ArenaSceneItem,
  ArenaSceneView,
  ArenaWebcam
} from '../../../models/electron';

//#endregion

/** Niveau sous lequel on considère qu'un jeu capté ne produit pas de son. */
const SILENCE_DBFS: number = -60;
/** Bas de l'échelle du VU-mètre : en linéaire, un niveau de jeu normal
 * resterait collé au bas de la barre et le contrôle visuel ne servirait à rien. */
const METER_FLOOR_DBFS: number = -60;
/** Silence continu au-delà duquel on alerte (un blanc pendant une game est
 * normal ; c'est l'absence durable qui signale une source muette). */
const SILENCE_DELAY_MS: number = 20000;
/** Cadence du sondage : le helper natif publie un niveau par seconde. */
const AUDIO_SAMPLE_MS: number = 1000;
/** Cadre de la scène, en pixels : celui de l'enregistrement. */
const SCENE_WIDTH: number = 1920;
const SCENE_HEIGHT: number = 1080;
/** Plus petite largeur d'un élément de la scène, pour qu'il reste saisissable. */
const SCENE_MIN_WIDTH: number = 32;
/** Cadence de l'aperçu de la scène : ffmpeg réécrit l'image toutes les secondes. */
const SCENE_PREVIEW_MS: number = 1000;

@Component({
  selector: 'view-arena-mode',
  templateUrl: './arena_mode.component.html',
  styleUrls: ['./arena_mode.component.scss'],
  standalone: true,
  imports: [
    GridModule,
    TranslateModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    OverlayModule,
    FormsModule,
    MessageComponent
  ]
})
export class ArenaModeComponent implements OnInit, OnDestroy {
  //#region Attributes

  protected state?: ArenaModeState;

  protected roomId?: number;
  /** Id T_EVA_Terrains de l'arène. */
  protected arenaId?: number;
  protected key?: string;
  protected registering: boolean = false;

  /** Salles activables (clé posée par un admin), pour les listes déroulantes. */
  protected locations: ArenaLocation[] = [];
  /** Arène unique dans la salle choisie → présélectionnée et verrouillée. */
  protected arenaLocked: boolean = false;

  /** Sélecteur de webcam affiché en surcouche, derrière un backdrop. */
  protected webcamPickerOpen: boolean = false;
  /** À droite du bouton, aligné sur son haut. */
  protected readonly webcamPickerPositions: ConnectedPosition[] = [
    { originX: 'end', originY: 'top', overlayX: 'start', overlayY: 'top' }
  ];
  /** Webcams posables dans la scène, avec un libellé qui distingue les homonymes. */
  protected webcamOptions: { device: ArenaWebcam; label: string }[] = [];
  /** Scène en cours d'édition : n'est appliquée que sur « Appliquer ». */
  protected scene: ArenaScene = { webcam: null, images: [] };
  /** Scène enregistrée, sérialisée : sert à savoir s'il y a des changements. */
  private savedScene: string = JSON.stringify(this.scene);
  protected sceneImageUrls: Record<string, string> = {};
  /** Webcam choisie dans le sélecteur, '' pour aucune. */
  protected selectedWebcamId: string = '';
  /** Image réellement enregistrée (scène comprise), quand la captation tourne. */
  protected scenePreview: string | null = null;
  private scenePreviewTimer?: ReturnType<typeof setInterval>;
  @ViewChild('sceneStage')
  private sceneStage?: ElementRef<HTMLDivElement>;
  /** Déplacement ou redimensionnement en cours, en pixels du cadre. */
  private sceneDrag?: {
    item: ArenaSceneItem;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    origin: ArenaSceneItem;
  };
  protected captureStatus?: ArenaCaptureStatus;
  /** Bascule start/stop en cours : désactive le bouton (anti double-clic). */
  protected capturePending: boolean = false;
  private captureStatusTimer?: ReturnType<typeof setInterval>;

  /**
   * Suivi du son ENREGISTRÉ. `ok` = un jeu est capté et il produit du son,
   * `idle` = aucun jeu ne tourne (normal : la salle est entre deux parties),
   * `silent` = alerte, un jeu est bien capté mais la piste est muette,
   * `unavailable` = plateforme sans helper natif, on ne mesure rien et on le
   * dit plutôt que de crier au loup.
   */
  protected audioState:
    | 'off'
    | 'unavailable'
    | 'idle'
    | 'silent'
    | 'ok' = 'off';
  /** Exécutable capté, affiché à côté du VU-mètre comme diagnostic. */
  protected audioTarget: string | null = null;

  @ViewChild('audioMeter')
  private audioMeter?: ElementRef<HTMLDivElement>;
  private audioTimer?: ReturnType<typeof setInterval>;
  /** Début du silence en cours (ms), sinon undefined. */
  private silentSince?: number;

  //#endregion

  constructor(
    private readonly toastrService: ToastrService,
    private readonly ngZone: NgZone,
    private readonly translateService: TranslateService,
    private readonly globalService: GlobalService
  ) {}

  //#region Functions

  ngOnInit(): void {
    window.electronAPI.arenaModeGetState().then((state: ArenaModeState) => {
      this.ngZone.run(() => {
        this.state = state;
        this.globalService.arenaModeRegistered = state.registered;
        if (state.registered) {
          this.initCapture();
        } else {
          this.fetchLocations();
        }
      });
    });
  }

  private fetchLocations(): void {
    window.electronAPI
      .arenaModeListLocations()
      .then((locations: ArenaLocation[]) => {
        this.ngZone.run(() => {
          this.locations = locations;
        });
      });
  }

  /** Salle choisie : arène unique → présélection + verrouillage du select. */
  protected onRoomChange(): void {
    const LOCATION = this.locations.find(
      (l) => Number(l.id) === this.roomId
    );
    if (LOCATION && LOCATION.terrains.length === 1) {
      this.arenaId = Number(LOCATION.terrains[0].id);
      this.arenaLocked = true;
    } else {
      this.arenaId = undefined;
      this.arenaLocked = false;
    }
  }

  protected get selectedLocation(): ArenaLocation | undefined {
    return this.locations.find((l) => Number(l.id) === this.roomId);
  }

  ngOnDestroy(): void {
    if (this.captureStatusTimer) {
      clearInterval(this.captureStatusTimer);
    }
    if (this.scenePreviewTimer) {
      clearInterval(this.scenePreviewTimer);
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.stopAudioMonitor();
  }

  /**
   * Le VU-mètre ne tourne que lorsque la page est visible : fenêtre minimisée
   * ou masquée → on coupe (un PC de salle peut rester des heures sur cette
   * page). L'aperçu de la scène, lui, se coupe seul (cf. refreshScenePreview).
   *
   * Ni l'un ni l'autre ne participe à l'enregistrement : la captation vidéo et
   * la piste son vivent entièrement dans le main process, et continuent quoi
   * que fasse l'opérateur dans l'interface.
   */
  private readonly onVisibilityChange = (): void => {
    this.ngZone.run(() => {
      if (document.hidden) {
        this.stopAudioMonitor();
      } else {
        this.startAudioMonitor();
      }
    });
  };

  /**
   * Démarre le suivi du niveau. La page ne capte plus rien elle-même : le son
   * est prélevé sur le processus du jeu par le helper natif, dans le main
   * process. On ne fait ici que sonder le niveau de CE flux — le VU-mètre
   * mesure donc exactement ce qui part dans la vidéo, alors que l'ancien
   * loopback mesurait le mix système et pouvait afficher du son alors que la
   * piste enregistrée était muette.
   */
  private startAudioMonitor(): void {
    if (this.audioTimer) {
      return;
    }
    this.silentSince = undefined;
    this.sampleAudio();
    // Hors zone Angular : un sondage par seconde ne doit pas déclencher un
    // cycle de détection de changements par seconde (le VU-mètre est écrit
    // directement dans le DOM, seul le changement d'état rentre dans la zone).
    this.ngZone.runOutsideAngular(() => {
      this.audioTimer = setInterval(
        () => this.sampleAudio(),
        AUDIO_SAMPLE_MS
      );
    });
  }

  /** Relève le niveau enregistré, met à jour le VU-mètre et l'état d'alerte. */
  private sampleAudio(): void {
    window.electronAPI
      .arenaAudioGetLevel()
      .then((level: ArenaAudioLevel) => this.applyAudioLevel(level))
      .catch(() => this.setAudioState('unavailable', null));
  }

  private applyAudioLevel(level: ArenaAudioLevel): void {
    if (this.audioMeter) {
      const RATIO =
        level.levelDbfs === null
          ? 0
          : Math.min(
              1,
              Math.max(
                0,
                (level.levelDbfs - METER_FLOOR_DBFS) / -METER_FLOOR_DBFS
              )
            );
      this.audioMeter.nativeElement.style.height = `${Math.round(RATIO * 100)}%`;
    }
    if (!level.available) {
      this.setAudioState('unavailable', null);
      return;
    }
    // Aucun jeu ne tourne : il n'y a rien à capter et rien à signaler. C'est
    // le cas normal entre deux parties, et c'est ce qui distingue cette alerte
    // de l'ancienne — elle ne se déclenche plus que si un jeu est bel et bien
    // capté alors que sa piste est muette.
    if (level.levelDbfs === null) {
      this.silentSince = undefined;
      this.setAudioState('idle', null);
      return;
    }
    if (level.levelDbfs >= SILENCE_DBFS) {
      this.silentSince = undefined;
      this.setAudioState('ok', level.targetExecutable);
      return;
    }
    const NOW = Date.now();
    if (this.silentSince === undefined) {
      this.silentSince = NOW;
      this.setAudioState('ok', level.targetExecutable);
    } else if (NOW - this.silentSince >= SILENCE_DELAY_MS) {
      this.setAudioState('silent', level.targetExecutable);
    }
  }

  /** Ne rentre dans la zone Angular que sur un vrai changement d'état. */
  private setAudioState(
    state: 'unavailable' | 'idle' | 'silent' | 'ok',
    target: string | null
  ): void {
    if (this.audioState === state && this.audioTarget === target) {
      return;
    }
    this.ngZone.run(() => {
      this.audioState = state;
      this.audioTarget = target;
    });
  }

  private stopAudioMonitor(): void {
    if (this.audioTimer) {
      clearInterval(this.audioTimer);
      this.audioTimer = undefined;
    }
    if (this.audioMeter) {
      // Sinon la barre reste figée sur la dernière valeur mesurée, ce qui se
      // lit comme un niveau courant alors qu'on ne mesure plus rien.
      this.audioMeter.nativeElement.style.height = '0';
    }
    this.silentSince = undefined;
    this.audioState = 'off';
    this.audioTarget = null;
  }

  /**
   * Charge le statut de captation et le rafraîchit toutes les 5 s tant que la
   * page est ouverte (la captation vit côté main process, indépendamment de
   * cette page).
   */
  private initCapture(): void {
    this.refreshCaptureStatus();
    this.loadScene();
    if (!this.scenePreviewTimer) {
      this.scenePreviewTimer = setInterval(
        () => this.refreshScenePreview(),
        SCENE_PREVIEW_MS
      );
    }
    if (!this.captureStatusTimer) {
      this.captureStatusTimer = setInterval(
        () => this.refreshCaptureStatus(),
        5000
      );
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    if (!document.hidden) {
      this.startAudioMonitor();
    }
  }

  /**
   * Ouvre le sélecteur de webcam en rechargeant la liste : une webcam branchée
   * depuis l'ouverture de la page y apparaît sans rien faire de plus.
   */
  protected openWebcamPicker(): void {
    this.webcamPickerOpen = true;
    this.refreshWebcams();
  }

  private refreshWebcams(): void {
    window.electronAPI
      .arenaCaptureListWebcams()
      .then((WEBCAMS: ArenaWebcam[]) => {
        this.ngZone.run(() => {
          // Deux webcams du même modèle portent le même nom.
          this.webcamOptions = WEBCAMS.map((device) => {
            const SAME = WEBCAMS.filter((d) => d.name === device.name);
            return {
              device,
              label:
                SAME.length > 1
                  ? `${device.name} (${SAME.indexOf(device) + 1})`
                  : device.name
            };
          });
        });
      });
  }

  private refreshCaptureStatus(): void {
    window.electronAPI
      .arenaCaptureGetStatus()
      .then((status: ArenaCaptureStatus) => {
        this.ngZone.run(() => (this.captureStatus = status));
      });
  }

  /**
   * Captation armée : ffmpeg enregistre, ou attend la fenêtre du jeu. Dans les
   * deux cas, le bouton propose de l'arrêter.
   */
  protected get captureArmed(): boolean {
    return !!this.captureStatus?.running || !!this.captureStatus?.waitingGame;
  }

  //#region Scène

  private loadScene(): void {
    window.electronAPI.arenaSceneGet().then((view: ArenaSceneView) => {
      this.ngZone.run(() => {
        const { imageUrls, ...SCENE } = view;
        this.scene = SCENE;
        this.savedScene = JSON.stringify(SCENE);
        this.sceneImageUrls = imageUrls;
        this.selectedWebcamId = SCENE.webcam?.id ?? '';
      });
    });
  }

  protected get sceneDirty(): boolean {
    return JSON.stringify(this.scene) !== this.savedScene;
  }

  /** Fond de l'éditeur : l'image réellement enregistrée, scène comprise. */
  protected get sceneBackground(): string | null {
    return this.scenePreview;
  }

  private refreshScenePreview(): void {
    if (document.hidden || !this.captureStatus?.running) {
      this.scenePreview = null;
      return;
    }
    window.electronAPI.arenaCaptureGetPreview().then((image) => {
      this.ngZone.run(() => (this.scenePreview = image));
    });
  }

  /** Webcam choisie : posée en bas à droite si elle n'était pas déjà placée. */
  protected onWebcamChange(): void {
    const OPTION = this.webcamOptions.find(
      (o) => o.device.id === this.selectedWebcamId
    );
    if (!OPTION) {
      this.scene.webcam = null;
      return;
    }
    const WIDTH = this.scene.webcam?.width ?? 480;
    const HEIGHT = this.scene.webcam?.height ?? 270;
    this.scene.webcam = {
      id: OPTION.device.id,
      name: OPTION.device.name,
      x: this.scene.webcam?.x ?? SCENE_WIDTH - WIDTH - 20,
      y: this.scene.webcam?.y ?? SCENE_HEIGHT - HEIGHT - 20,
      width: WIDTH,
      height: HEIGHT
    };
  }

  /** Image choisie : posée en haut à gauche, à sa taille réelle si elle tient. */
  protected addSceneImage(): void {
    window.electronAPI.arenaSceneAddImage().then((image) => {
      if (!image) {
        return;
      }
      this.ngZone.run(() => {
        const RATIO = Math.min(
          1,
          (SCENE_WIDTH - 40) / image.width,
          (SCENE_HEIGHT - 40) / image.height
        );
        this.sceneImageUrls[image.file] = image.url;
        this.scene.images.push({
          file: image.file,
          x: 20,
          y: 20,
          width: Math.round(image.width * RATIO),
          height: Math.round(image.height * RATIO)
        });
      });
    });
  }

  protected removeSceneImage(file: string): void {
    this.scene.images = this.scene.images.filter((i) => i.file !== file);
  }

  protected startSceneDrag(
    event: PointerEvent,
    item: ArenaSceneItem,
    mode: 'move' | 'resize'
  ): void {
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.sceneDrag = {
      item,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...item }
    };
  }

  /** Déplace ou redimensionne (proportions conservées), sans sortir du cadre. */
  protected onSceneDrag(event: PointerEvent): void {
    if (!this.sceneDrag || !this.sceneStage) {
      return;
    }
    const { item, mode, origin } = this.sceneDrag;
    const SCALE =
      SCENE_WIDTH / this.sceneStage.nativeElement.getBoundingClientRect().width;
    const DX = (event.clientX - this.sceneDrag.startX) * SCALE;
    const DY = (event.clientY - this.sceneDrag.startY) * SCALE;
    const CLAMP = (n: number, min: number, max: number): number =>
      Math.round(Math.min(Math.max(n, min), max));
    if (mode === 'move') {
      item.x = CLAMP(origin.x + DX, 0, SCENE_WIDTH - item.width);
      item.y = CLAMP(origin.y + DY, 0, SCENE_HEIGHT - item.height);
      return;
    }
    const RATIO = origin.width / origin.height;
    const MAX_WIDTH = Math.min(
      SCENE_WIDTH - origin.x,
      (SCENE_HEIGHT - origin.y) * RATIO
    );
    item.width = CLAMP(origin.width + DX, SCENE_MIN_WIDTH, MAX_WIDTH);
    item.height = Math.round(item.width / RATIO);
  }

  protected endSceneDrag(): void {
    this.sceneDrag = undefined;
  }

  protected cancelScene(): void {
    this.scene = JSON.parse(this.savedScene);
    this.selectedWebcamId = this.scene.webcam?.id ?? '';
  }

  /** Enregistre la scène ; une captation en cours est relancée dessus. */
  protected applyScene(): void {
    window.electronAPI
      .arenaSceneSet(this.scene)
      .then((status: ArenaCaptureStatus) => {
        this.ngZone.run(() => {
          this.captureStatus = status;
          this.toastrService.success(
            this.translateService.instant('view.arena_mode.scene.applied')
          );
          // Relecture : le main process arrondit et borne les positions.
          this.loadScene();
        });
      });
  }

  //#endregion

  /** Ouvre le dossier de travail du mode salle (spool/, work/, games/). */
  protected openFolder(): void {
    window.electronAPI.arenaOpenFolder();
  }

  /** Ouvre le dossier des logs de Tools (tools-AAAA-MM-JJ.log). */
  protected openLogsFolder(): void {
    window.electronAPI.arenaOpenLogsFolder();
  }

  /**
   * Déplace le dossier de travail (EBP-Tools-Arena) vers un emplacement
   * choisi par l'utilisateur. Refusé pendant la captation ; les vidéos en
   * attente sont déplacées avec le dossier.
   */
  protected moveFolder(): void {
    window.electronAPI.arenaMoveFolder().then((result) => {
      this.ngZone.run(() => {
        if (result.success) {
          this.toastrService.success(result.root ?? '');
          this.refreshCaptureStatus();
        } else if (result.error === 'capture_running') {
          this.toastrService.error(
            this.translateService.instant(
              'view.arena_mode.capture.moveFolderStopFirst'
            )
          );
        } else if (result.error) {
          this.toastrService.error(result.error);
        }
      });
    });
  }

  protected toggleCapture(): void {
    if (this.capturePending) {
      return;
    }
    this.capturePending = true;
    const WAS_RUNNING = this.captureArmed;
    const CALL = WAS_RUNNING
      ? window.electronAPI.arenaCaptureStop()
      : window.electronAPI.arenaCaptureStart();
    CALL.then((status: ArenaCaptureStatus) => {
      this.ngZone.run(() => {
        this.captureStatus = status;
        // L'arrêt est gracieux : ffmpeg finalise le segment en cours avant de
        // se fermer, et ce n'est qu'à sa fermeture que le service repasse à
        // running=false. Le statut renvoyé ici est donc encore "running". On
        // re-poll rapidement le statut réel pour rafraîchir le bouton sans
        // attendre le poll de 5 s, et on garde le bouton désactivé jusqu'à ce
        // que l'état soit stabilisé (anti double-clic). Le start, lui, est
        // immédiatement à jour → on ré-active tout de suite.
        if (WAS_RUNNING) {
          setTimeout(() => this.refreshCaptureStatus(), 600);
          setTimeout(() => {
            this.refreshCaptureStatus();
            this.capturePending = false;
          }, 1800);
        } else {
          this.capturePending = false;
        }
      });
    }).catch(() => {
      // Échec de l'IPC : sans ça le bouton resterait désactivé indéfiniment.
      this.ngZone.run(() => (this.capturePending = false));
    });
  }

  /**
   * Registers this machine as the streaming PC of the given arena by
   * validating the room key against the EBP backend.
   */
  protected register(): void {
    if (this.registering || !this.roomId || !this.arenaId || !this.key) {
      return;
    }
    this.registering = true;
    window.electronAPI
      .arenaModeRegister(this.roomId, this.arenaId, this.key)
      .then((result) => {
        this.ngZone.run(() => {
          this.registering = false;
          if (result.success && result.state) {
            this.state = result.state;
            this.globalService.arenaModeRegistered = result.state.registered;
            this.key = undefined;
            this.initCapture();
          } else {
            this.toastrService.error(
              this.translateService.instant(
                `view.arena_mode.errors.${result.error ?? 'network'}`
              )
            );
          }
        });
      })
      .catch((e: unknown) => {
        // Échec de l'IPC lui-même (ex. main process sans le handler) : sans ce
        // catch, le spinner tournerait indéfiniment sans aucun feedback.
        console.error('arena-mode-register IPC failed', e);
        this.ngZone.run(() => {
          this.registering = false;
          this.toastrService.error(
            this.translateService.instant('view.arena_mode.errors.network')
          );
        });
      });
  }

  /**
   * Unregisters the arena mode on this machine.
   */
  protected unregister(): void {
    window.electronAPI.arenaModeUnregister().then((state: ArenaModeState) => {
      this.ngZone.run(() => {
        this.state = state;
        this.globalService.arenaModeRegistered = state.registered;
        this.stopAudioMonitor();
      });
    });
  }

  //#endregion
}
