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
import { FormsModule } from '@angular/forms';

import { ToastrService } from 'ngx-toastr';
import { MessageComponent } from '../../shared/message/message.component';
import {
  ArenaAudioLevel,
  ArenaCaptureDevice,
  ArenaCaptureStatus,
  ArenaLocation,
  ArenaModeState
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

  protected devices: ArenaCaptureDevice[] = [];
  /** Même liste, séparée pour les deux groupes du sélecteur. */
  protected screenDevices: ArenaCaptureDevice[] = [];
  protected cameraDevices: ArenaCaptureDevice[] = [];
  protected selectedDeviceId?: string;
  protected captureStatus?: ArenaCaptureStatus;
  /** Bascule start/stop en cours : désactive le bouton (anti double-clic). */
  protected capturePending: boolean = false;
  private captureStatusTimer?: ReturnType<typeof setInterval>;

  @ViewChild('previewVideo')
  private previewVideo?: ElementRef<HTMLVideoElement>;
  private previewStream?: MediaStream;
  /** Nom du device actuellement prévisualisé (évite de rouvrir en boucle). */
  private previewDeviceName?: string;

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
    private readonly translateService: TranslateService
  ) {}

  //#region Functions

  ngOnInit(): void {
    window.electronAPI.arenaModeGetState().then((state: ArenaModeState) => {
      this.ngZone.run(() => {
        this.state = state;
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
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.stopPreview();
    this.stopAudioMonitor();
  }

  /**
   * Aperçu et VU-mètre ne tournent que lorsque la page est visible : fenêtre
   * minimisée ou masquée → on coupe (un PC de salle peut rester des heures sur
   * cette page). Au retour, on relance aussitôt sur la source courante plutôt
   * que d'attendre le prochain poll de statut.
   *
   * Ni l'un ni l'autre ne participe à l'enregistrement : la captation vidéo et
   * la piste son vivent entièrement dans le main process, et continuent quoi
   * que fasse l'opérateur dans l'interface.
   */
  private readonly onVisibilityChange = (): void => {
    this.ngZone.run(() => {
      if (document.hidden) {
        this.stopPreview();
        this.stopAudioMonitor();
      } else {
        if (this.captureStatus?.deviceName) {
          this.startPreview(this.captureStatus.deviceName);
        }
        this.startAudioMonitor();
      }
    });
  };

  /**
   * Aperçu live de la source : la même caméra (virtuelle) que ffmpeg, ouverte
   * en parallèle via getUserMedia — les caméras virtuelles acceptent plusieurs
   * lecteurs. Résolution réduite : c'est un contrôle visuel, pas la captation.
   */
  private async startPreview(deviceName: string): Promise<void> {
    // Les sources écran n'ont pas d'aperçu live : leur vignette ddagrab, elle,
    // montre vraiment ce qui sera enregistré.
    if (
      this.previewDeviceName === deviceName ||
      this.captureStatus?.deviceKind === 'screen'
    ) {
      return;
    }
    this.previewDeviceName = deviceName;
    // On garde l'ancien flux vivant jusqu'à l'acquisition du nouveau. Couper
    // avant de rouvrir (track.stop() puis getUserMedia) laisse certaines
    // caméras virtuelles renvoyer une image noire : le device est encore en
    // cours de libération côté OS quand on le réacquiert. C'est ce qui
    // noircissait l'aperçu au changement de source.
    const PREVIOUS = this.previewStream;
    try {
      // ffmpeg/dshow renvoie le nom nu ("Logitech BRIO") tandis que Chromium
      // suffixe le label des webcams USB avec l'ID matériel ("Logitech BRIO
      // (046d:085e)"). L'égalité stricte marche pour OBS (nom identique des
      // deux côtés) mais échoue pour les caméras → on tolère préfixe/inclusion.
      const FIND_MATCH = (
        list: MediaDeviceInfo[]
      ): MediaDeviceInfo | undefined => {
        const CAMS = list.filter((d) => d.kind === 'videoinput');
        return (
          CAMS.find((d) => d.label === deviceName) ??
          CAMS.find((d) => d.label.startsWith(deviceName)) ??
          CAMS.find((d) => d.label.includes(deviceName))
        );
      };
      let devices = await navigator.mediaDevices.enumerateDevices();
      let match = FIND_MATCH(devices);
      // Chromium masque labels et deviceId tant qu'aucun flux caméra n'a été
      // accordé au document : sur un profil neuf (PC de salle) l'énumération
      // renvoie des labels vides → aucun match, aperçu noir. On débloque en
      // ouvrant un flux générique jetable, puis on ré-énumère.
      if (!match) {
        const PRIMER = await navigator.mediaDevices.getUserMedia({
          video: true
        });
        for (const TRACK of PRIMER.getTracks()) {
          TRACK.stop();
        }
        devices = await navigator.mediaDevices.enumerateDevices();
        match = FIND_MATCH(devices);
      }
      if (!match) {
        this.previewDeviceName = undefined;
        return;
      }
      const MATCH = match;
      const STREAM = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: MATCH.deviceId },
          width: { ideal: 640 }
        }
      });
      this.previewStream = STREAM;
      this.attachPreview();
    } catch (e) {
      // Une DOMException n'a pas de champs énumérables → JSON.stringify donne
      // "{}". On extrait name+message pour un diagnostic exploitable.
      const ERR = e as { name?: string; message?: string };
      console.warn(
        `Preview unavailable for ${deviceName}: ${ERR?.name} - ${ERR?.message}`
      );
      this.previewDeviceName = undefined;
    } finally {
      // Libération de l'ancien flux seulement après coup. Sur échec (STREAM non
      // acquis), this.previewStream vaut toujours PREVIOUS → on le garde, donc
      // un switch raté ne noircit pas l'aperçu en cours.
      if (PREVIOUS && PREVIOUS !== this.previewStream) {
        for (const TRACK of PREVIOUS.getTracks()) {
          TRACK.stop();
        }
      }
    }
  }

  /**
   * Attache le flux au <video>. L'élément n'existe qu'une fois le bloc
   * "running" rendu : si le rendu n'est pas encore passé, on réessaie.
   */
  private attachPreview(attempt: number = 0): void {
    if (!this.previewStream) {
      return;
    }
    if (this.previewVideo) {
      const VIDEO = this.previewVideo.nativeElement;
      VIDEO.srcObject = this.previewStream;
      // `autoplay` ne joue qu'au chargement initial. Après un switch ou un
      // masquage/refocus, on réassigne `srcObject` sur une vidéo mise en pause
      // (srcObject=null) : sans play() explicite elle reste figée = écran noir
      // alors que le flux est bien vivant.
      VIDEO.play().catch(() => {
        // Lecture interrompue par un nouveau switch immédiat : sans gravité.
      });
    } else if (attempt < 10) {
      setTimeout(() => this.attachPreview(attempt + 1), 100);
    }
  }

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
      this.audioMeter.nativeElement.style.width = `${Math.round(RATIO * 100)}%`;
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
      this.audioMeter.nativeElement.style.width = '0';
    }
    this.silentSince = undefined;
    this.audioState = 'off';
    this.audioTarget = null;
  }

  private stopPreview(): void {
    if (this.previewStream) {
      for (const TRACK of this.previewStream.getTracks()) {
        TRACK.stop();
      }
      this.previewStream = undefined;
    }
    if (this.previewVideo) {
      this.previewVideo.nativeElement.srcObject = null;
    }
    this.previewDeviceName = undefined;
  }

  /**
   * Charge périphériques + statut de captation, et rafraîchit le statut
   * toutes les 5 s tant que la page est ouverte (la captation vit côté main
   * process, indépendamment de cette page).
   */
  private initCapture(): void {
    this.refreshDevices();
    this.refreshCaptureStatus();
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

  protected refreshDevices(): void {
    window.electronAPI
      .arenaCaptureListDevices()
      .then((devices: ArenaCaptureDevice[]) => {
        this.ngZone.run(() => {
          this.devices = devices;
          this.screenDevices = devices.filter((d) => d.kind === 'screen');
          this.cameraDevices = devices.filter((d) => d.kind === 'camera');
        });
      });
  }

  private refreshCaptureStatus(): void {
    window.electronAPI
      .arenaCaptureGetStatus()
      .then((status: ArenaCaptureStatus) => {
        this.ngZone.run(() => {
          this.captureStatus = status;
          if (this.selectedDeviceId === undefined && status.deviceId) {
            this.selectedDeviceId = status.deviceId;
          }
          // Prévisu dès qu'une source est sélectionnée, que la captation
          // tourne ou non (choisir une source ne sert qu'à la prévisualiser),
          // mais seulement si la page est visible — sinon on laisse coupé.
          if (status.deviceName && !document.hidden) {
            this.startPreview(status.deviceName);
          } else if (!status.deviceName) {
            this.stopPreview();
          }
        });
      });
  }

  /**
   * Sélectionne le périphérique et met à jour la prévisualisation. Ne démarre
   * pas la captation : seul le bouton Démarrer le fait. Si une captation est
   * déjà en cours, le main process bascule dessus tout seul.
   */
  protected applyDevice(): void {
    const DEVICE = this.devices.find((d) => d.id === this.selectedDeviceId);
    if (!DEVICE) {
      return;
    }
    window.electronAPI
      .arenaCaptureSetDevice(DEVICE)
      .then((status: ArenaCaptureStatus) => {
        this.ngZone.run(() => {
          this.captureStatus = status;
          if (!document.hidden) {
            this.startPreview(DEVICE.name);
          }
        });
      });
  }

  /** Ouvre le dossier de travail du mode salle (spool/, work/, games/). */
  protected openFolder(): void {
    window.electronAPI.arenaOpenFolder();
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
    const WAS_RUNNING = this.captureStatus?.running;
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
        this.stopAudioMonitor();
      });
    });
  }

  //#endregion
}
