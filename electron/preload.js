// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const { contextBridge, ipcRenderer } = require('electron');

// prettier-ignore
contextBridge.exposeInMainWorld("electronAPI", {
  //#region Client -> Server

  // The front-end asks the server to resize the main frame;
  setWindowSize: (width, height) => ipcRenderer.invoke("set-window-size", width, height),
  // The front-end asks the server to return the developer mode state.
  isDevMode: () => ipcRenderer.invoke("is-dev-mode"),
  // The front-end asks the server to return the user's operating system.
  getOS: () => ipcRenderer.invoke("get-os"),
  // The front-end asks the server to get available video formats for a URL.
  getVideoFormats: (url) => ipcRenderer.invoke("get-video-formats", url),
  // The front-end asks the server to download a YouTube video.
  downloadReplay: (url, platform, formatId) => ipcRenderer.invoke("download-replay", url, platform, formatId),
  // The front-end asks the server to enables/disables debug mode.
  debugMode: () => ipcRenderer.invoke("switch-debug-mode"),
  // The front-end asks the server to open an url in the default browser.
  openURL: (url) => ipcRenderer.invoke("open-url", url),
  // The front-end asks the server to return the web server port.
  getExpressPort: () => ipcRenderer.invoke("get-express-port"),
  // The front-end asks the server to return the project version.
  getVersion: () => ipcRenderer.invoke("get-version"),
  // The front-end asks the server to return the game-history output path.
  // The front-end asks the server to return the replay downloader output path.
  getReplayDownloaderOutputPath: () => ipcRenderer.invoke("get-replay-downloader-output-path"),
  // The front-end asks the server to return the cutter output path.
  getVideoCutterOutputPath: () => ipcRenderer.invoke("get-video-cutter-output-path"),
  // The front-end asks the server to edit the cutter output path.
  setSetting: (setting) => ipcRenderer.invoke("set-setting", setting),
  // The front-end asks the server to cut a video file.
  cutVideoFile: (game, videoPath, customText) => ipcRenderer.invoke("cut-video-file", game, videoPath, customText),
  // The front-end asks the server to cut all video files.
  cutVideoFiles: (game, videoPath, customText) => ipcRenderer.invoke("cut-video-files", game, videoPath, customText),
  // The front-end asks the server to play a video file that has just been cut.
  openFile: (path) => ipcRenderer.invoke("open-file", path),
  // The front-end asks the server to ask the user to select files.
  openFiles: (extensions) => ipcRenderer.invoke("open-files", extensions),
  // The front-end asks the server to crop, cut and upload a video to the EBP's S3 server.
  uploadGameMiniMap: (gameIndex, game, cropPosition, margedCropPosition, videoPath, gameID, orangeTeamInfosPosition, blueTeamInfosPosition, topInfosPosition, sortedOrangePlayersNames, sortedBluePlayersNames) => ipcRenderer.invoke("upload-game-mini-map", gameIndex, game, cropPosition, margedCropPosition, videoPath, gameID, orangeTeamInfosPosition, blueTeamInfosPosition, topInfosPosition, sortedOrangePlayersNames, sortedBluePlayersNames),
  // The front-end asks the server to cut a video file manualy edited.
  manualCutVideoFile: (videoPath, chunks, notificationData) => ipcRenderer.invoke("manual-cut-video-file", videoPath, chunks, notificationData),
  // The front-end asks the server to save the current language.
  setLanguage: (language) => ipcRenderer.invoke("set-language", language),
  // The front-end asks the server to show a notification.
  showNotification: (hideMainWindow, width, height, notificationData) => ipcRenderer.invoke("show-notification", hideMainWindow, width, height, notificationData),
  // The front-end asks the server to remove the notification.
  removeNotification: (showMainWindow) => ipcRenderer.invoke("remove-notification", showMainWindow),
  // The front-end asks the server to save console logs to a text file.
  saveConsoleLogs: (logs) => ipcRenderer.invoke("save-console-logs", logs),
  removeBorders: (cropperPosition, videoPath) => ipcRenderer.invoke("remove-borders", cropperPosition, videoPath),
  setVideoResolution: (videoPath, width, height) => ipcRenderer.invoke("set-video-resolution", videoPath, width, height),
  // The front-end asks the server to send a socket message to the EBP socket server.
  socketEmit: (socket, path, value) => ipcRenderer.invoke("socket-emit", socket, path, value),
  // The front-end asks the server to run the Python video analyzer.
  runAnalyzer: (videoPath, settingsJSON) => ipcRenderer.invoke("run-analyzer", videoPath, settingsJSON),
  // The front-end asks the server to return the arena (salle) mode state.
  arenaModeGetState: () => ipcRenderer.invoke("arena-mode-get-state"),
  // The front-end asks the server to list activable salles (with arenas) for the arena mode form.
  arenaModeListLocations: () => ipcRenderer.invoke("arena-mode-list-locations"),
  // The front-end asks the server to register this machine as an arena's streaming PC.
  arenaModeRegister: (roomId, arenaId, key) => ipcRenderer.invoke("arena-mode-register", roomId, arenaId, key),
  // The front-end asks the server to unregister the arena mode.
  arenaModeUnregister: () => ipcRenderer.invoke("arena-mode-unregister"),
  // The front-end asks the server to list video capture devices.
  arenaCaptureListDevices: () => ipcRenderer.invoke("arena-capture-list-devices"),
  // The front-end asks the server to return the arena capture status.
  arenaCaptureGetStatus: () => ipcRenderer.invoke("arena-capture-get-status"),
  // The front-end asks the server to select a capture device (preview only; capture is not started).
  arenaCaptureSetDevice: (device) => ipcRenderer.invoke("arena-capture-set-device", device),
  // The front-end asks the server to start/stop the arena capture.
  arenaCaptureStart: () => ipcRenderer.invoke("arena-capture-start"),
  arenaCaptureStop: () => ipcRenderer.invoke("arena-capture-stop"),
  // The front-end polls the recorded audio level for the VU meter.
  arenaAudioGetLevel: () => ipcRenderer.invoke("arena-audio-level"),
  // The front-end asks the server to open the arena working folder in the explorer.
  arenaOpenFolder: () => ipcRenderer.invoke("arena-open-folder"),
  // The front-end asks the server to move the arena working folder to a new location.
  arenaMoveFolder: () => ipcRenderer.invoke("arena-move-folder"),

  //#endregion

  //#region Server -> Client

  // The server send the manual cut process percent to the font-end.
  setManualCutPercent: (callback) => ipcRenderer.on("set-manual-cut-percent", (event, percent) => callback(percent)),
  // The server send the upscaling process percent to the font-end.
  setUpscalePercent: (callback) => ipcRenderer.on("set-upscale-percent", (event, percent) => callback(percent)),
  // The server send the border removing process percent to the font-end.
  setRemoveBordersPercent: (callback) => ipcRenderer.on("set-remove-borders-percent", (event, percent) => callback(percent)),
  // The server gives the path of the video file selected by the user.
  gameIsUploaded: (callback) => ipcRenderer.on("game-is-uploaded", (event, gameIndex) => callback(gameIndex)),
  // The server ask the front-end to analyse a video.
  analyzeVideoFile: (callback) => ipcRenderer.on("analyze-video-file", (event, socket, filePath, forcedTraining) => callback(socket, filePath, forcedTraining)),
  // The server gives the path of the video file selected by the user.
  setVideoFile: (callback) => ipcRenderer.on("set-video-file", (event, value) => callback(value)),
  // The server informs the front-end that the games are exported.
  // The server asks the font-end to display a replay downloader error.
  replayDownloaderError: (callback) => ipcRenderer.on("replay-downloader-error", (event, error) => callback(error)),
  // The server asks the font-end that the video is well downloaded.
  replayDownloaderSuccess: (callback) => ipcRenderer.on("replay-downloader-success", (event, path) => callback(path)),
  // The server asks the font-end to display a global message.
  globalMessage: (callback) => ipcRenderer.on("global-message", (event, i18nPath, i18nVariables) => callback(i18nPath, i18nVariables)),
  // The server sends console logs to the front-end.
  onConsoleLog: (callback) => ipcRenderer.on("console-log", (event, logData) => callback(logData)),
  // The server asks the font-end to display a toast.
  toast: (callback) => ipcRenderer.on("toast", (event, type, i18nPath, i18nVariables) => callback(type, i18nPath, i18nVariables)),
  // The server asks the font-end to update the notification data.
  setNotificationData: (callback) => ipcRenderer.on("set-notification-data", (event, data) => callback(data)),
  // The server sends a progress/done/error update from the Python video analyzer.
  onAnalyzerUpdate: (callback) => ipcRenderer.on("analyzer-update", (event, msg) => callback(msg)),

  //#endregion
});
