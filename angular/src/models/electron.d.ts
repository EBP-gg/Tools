// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { VideoPlatform } from '../app/views/replay_downloader/models/video-platform.enum';
import { Versions } from './versions';
import { LogData } from './log-data';
import { CropperPosition } from 'ngx-image-cropper';
import { Game } from '../app/views/replay_cutter/models/game';
import { Message } from '../app/views/notification/models/message.model';
import { VideoFormat } from '../app/views/replay_downloader/models/video-format.interface';

//#endregion

export interface AnalyzerMessage {
  type: 'progress' | 'done' | 'error' | 'close' | 'log' | 'game';
  percent?: number;
  /** In progress messages: number of completed games so far. */
  nbGames?: number;
  /** In game messages: the completed game object. */
  game?: {
    mode: number;
    start: number;
    end: number;
    map: string;
    mapImage?: string;
    orangeTeam: {
      name: string;
      score: number;
      nameImage?: string;
      scoreImage?: string;
    };
    blueTeam: {
      name: string;
      score: number;
      nameImage?: string;
      scoreImage?: string;
    };
  };
  message?: string;
  log?: string;
  code?: number;
}

export interface ArenaLocation {
  id: string;
  name: string;
  country: string;
  terrains: { id: string; name: string }[];
}

export interface ArenaModeState {
  registered: boolean;
  roomId?: number;
  arenaId?: number;
  roomName?: string;
  terrainId?: string;
  terrainName?: string;
}

export interface ArenaCaptureDevice {
  id: string;
  name: string;
  kind: 'screen' | 'camera';
  /** Écrans Windows uniquement : adaptateur et sortie DXGI pour ddagrab. */
  adapter?: number;
  outputIndex?: number;
  /** Écrans Windows uniquement : image captée par ddagrab, sert d'aperçu. */
  thumbnail?: string | null;
  width?: number;
  height?: number;
}

/** Niveau du son réellement enregistré, sondé chaque seconde par le VU-mètre. */
export interface ArenaAudioLevel {
  /** Faux là où le helper natif n'existe pas (hors Windows) : on ne mesure rien. */
  available: boolean;
  /** Exécutable du jeu capté, null si aucun ne tourne. */
  targetExecutable: string | null;
  /** null quand aucun jeu n'est capté ; plancher à -100 dBFS sinon. */
  levelDbfs: number | null;
}

export interface ArenaCaptureStatus {
  running: boolean;
  deviceId: string | null;
  deviceName: string | null;
  deviceKind: 'screen' | 'camera' | null;
  deviceThumbnail: string | null;
  encoder: string | null;
  startedAt: number | null;
  lastError: string | null;
  spoolFolder: string;
  segmentSeconds: number;
  /** Faux tant que ddagrab n'a produit aucune image : rien n'est enregistré. */
  videoStarted: boolean;
  audio: {
    running: boolean;
    connected: boolean;
    receivedBytes: number;
    sampleRate: number;
    channels: number;
    /** Exécutable du jeu dont le son est capté, null si aucun ne tourne. */
    targetExecutable: string | null;
    targetPid: number | null;
    /** Niveau du flux réellement enregistré. null = aucune cible en cours. */
    levelDbfs: number | null;
  };
}

export interface ElectronAPI {
  //#region Client to Server

  setWindowSize: (width?: number, height?: number) => Promise<void>;
  cutVideoFile: (
    game: Game,
    videoPath: string,
    customText: string
  ) => Promise<string>;
  cutVideoFiles: (
    games: Game[],
    videoPath: string,
    customText: string
  ) => Promise<string>;
  debugMode: () => Promise<void>;
  getVideoFormats: (
    url: string
  ) => Promise<{ success: boolean; formats?: VideoFormat[]; error?: string }>;
  downloadReplay: (
    url: string,
    platform: VideoPlatform,
    formatId?: string
  ) => Promise<void>;
  getExpressPort: () => Promise<number>;
  getOS: () => Promise<NodeJS.Platform>;
  getReplayDownloaderOutputPath: () => Promise<string>;
  getVersion: () => Promise<Versions>;
  getVideoCutterOutputPath: () => Promise<string>;
  isDevMode: () => Promise<boolean>;
  openFile: (pathFile: string) => Promise<void>;
  openFiles: (extensions: string[]) => Promise<string[]>;
  openURL: (url: string) => void;
  setSetting: (setting: string) => Promise<string>;
  setVideoFile: (callback: (path: string) => void) => Promise<void>;
  uploadGameMiniMap: (
    gameIndex: number,
    game: Game,
    c: CropperPosition,
    margedC: CropperPosition,
    videoPath: string,
    gameID: number,
    orangeTeamInfosPosition: CropperPosition,
    blueTeamInfosPosition: CropperPosition,
    topInfosPosition: CropperPosition,
    sortedOrangePlayersNames: string[],
    sortedBluePlayersNames: string[]
  ) => void;
  manualCutVideoFile: (
    videoPath: string,
    chunks: { start: number; end: number; remove: boolean }[],
    notificationData: string
  ) => Promise<string>;
  setLanguage: (language?: string) => void;
  showNotification: (
    hideMainWindow: boolean,
    width: number,
    height: number,
    notificationData: string
  ) => void;
  removeNotification: (showMainWindow: boolean) => void;
  saveConsoleLogs: (logs: LogData[]) => Promise<string>;
  removeBorders: (cropperPosition: CropperPosition, videoPath: string) => void;
  setVideoResolution: (
    videoPath: string,
    width: number,
    height: number
  ) => Promise<string>;
  socketEmit: (socket: string, path: string, value: any) => void;
  runAnalyzer: (videoPath: string, settingsJSON: string) => Promise<void>;
  arenaModeGetState: () => Promise<ArenaModeState>;
  arenaModeListLocations: () => Promise<ArenaLocation[]>;
  arenaModeRegister: (
    roomId: number,
    arenaId: number,
    key: string
  ) => Promise<{ success: boolean; state?: ArenaModeState; error?: string }>;
  arenaModeUnregister: () => Promise<ArenaModeState>;
  arenaCaptureListDevices: () => Promise<ArenaCaptureDevice[]>;
  arenaCaptureGetStatus: () => Promise<ArenaCaptureStatus>;
  arenaCaptureSetDevice: (
    device: ArenaCaptureDevice
  ) => Promise<ArenaCaptureStatus>;
  arenaCaptureStart: () => Promise<ArenaCaptureStatus>;
  arenaCaptureStop: () => Promise<ArenaCaptureStatus>;
  arenaAudioGetLevel: () => Promise<ArenaAudioLevel>;
  arenaOpenFolder: () => Promise<void>;
  arenaMoveFolder: () => Promise<{
    success: boolean;
    root?: string;
    error?: string | null;
  }>;

  //#endregion

  //#region Server to Client

  setManualCutPercent: (callback: (percent: number) => void) => void;
  setUpscalePercent: (callback: (percent: number) => void) => void;
  setRemoveBordersPercent: (callback: (percent: number) => void) => void;
  gameIsUploaded: (callback: (gameIndex: number) => void) => void;
  analyzeVideoFile: (
    callback: (
      socket: string,
      filePath: string,
      forcedTraining: boolean | undefined
    ) => void
  ) => void;
  replayDownloaderError: (callback: (error: string) => void) => void;
  replayDownloaderSuccess: (callback: (path: string) => void) => void;
  globalMessage: (
    callback: (i18nPath: string, i18nVariables: object) => void
  ) => void;
  onConsoleLog: (callback: (logData: LogData) => void) => void;
  toast: (
    callback: (
      type: 'success' | 'error' | 'warning' | 'info',
      i18nPath: string,
      i18nVariables: object
    ) => void
  ) => void;
  setNotificationData: (callback: (data: Message) => void) => void;
  onAnalyzerUpdate: (callback: (msg: AnalyzerMessage) => void) => void;

  //#endregion
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
