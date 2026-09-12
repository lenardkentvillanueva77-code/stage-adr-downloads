'use strict';

/**
 * preload.js
 *
 * Secure IPC bridge between the renderer and the main process.
 * contextIsolation: true — the renderer has NO access to Node.js APIs.
 * All communication goes through window.api.
 *
 * Phase 1.75 additions:
 *   window.api.cue.*   — character and cue CRUD
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

  // ── App lifecycle ────────────────────────────────────────────────────────────
  app: {
    /**
     * Tell the main process it may now close the window.
     * Called after the renderer has handled the unsaved-changes prompt.
     */
    confirmClose: (opts) => ipcRenderer.invoke('app:confirmClose', opts || {}),
    setTitle: (title) => ipcRenderer.invoke('app:setTitle', title),
    revealInFolder: (filePath) => ipcRenderer.invoke('app:revealInFolder', filePath),
  },

  // ── Project ─────────────────────────────────────────────────────────────────
  project: {
    new:             (opts) => ipcRenderer.invoke('project:new', opts),
    chooseParentFolder: () => ipcRenderer.invoke('project:chooseParentFolder'),
    save:            ()     => ipcRenderer.invoke('project:save'),
    saveAs:          ()     => ipcRenderer.invoke('project:saveAs'),
    open:            ()     => ipcRenderer.invoke('project:open'),
    openPath:        (filePath) => ipcRenderer.invoke('project:openPath', { filePath }),
    getCurrent:      ()     => ipcRenderer.invoke('project:getCurrent'),
    relinkFiles:     ()     => ipcRenderer.invoke('project:relinkFiles'),
    setVideo:        (meta) => ipcRenderer.invoke('project:setVideo', meta),
    updateWorkspaceSettings: (workspace, opts = {}) => ipcRenderer.invoke('project:updateWorkspaceSettings', { workspace, ...opts }),
    autosave:        ()     => ipcRenderer.invoke('project:autosave'),
    checkAutosave:   ()     => ipcRenderer.invoke('project:checkAutosave'),
    restoreAutosave: ()     => ipcRenderer.invoke('project:restoreAutosave'),
    clearAutosave:   ()     => ipcRenderer.invoke('project:clearAutosave'),
  },

  // ── Media ───────────────────────────────────────────────────────────────────
  media: {
    loadVideo:    ()         => ipcRenderer.invoke('media:loadVideo'),
    resolveVideo: (path)     => ipcRenderer.invoke('media:resolveVideo', path),
    resolveFileUrl: (path)   => ipcRenderer.invoke('media:resolveFileUrl', path),
    checkFfprobe: ()         => ipcRenderer.invoke('media:checkFfprobe'),
  },

  // ── Waveform ────────────────────────────────────────────────────────────────
  waveform: {
    checkFfmpeg:      () => ipcRenderer.invoke('waveform:checkFfmpeg'),
    status:           () => ipcRenderer.invoke('waveform:status'),
    extract:          () => ipcRenderer.invoke('waveform:extract'),
    load:             () => ipcRenderer.invoke('waveform:load'),
    migrateOnSaveAs:  (opts) => ipcRenderer.invoke('waveform:migrateOnSaveAs', opts),
  },

  // ── Cues & Characters (Phase 1.75) ──────────────────────────────────────────
  cue: {
    /**
     * Add a character to the project.
     * @param {{ name: string, description?: string }} opts
     * @returns {{ success, project, character? }}
     */
    addCharacter: (opts)           => ipcRenderer.invoke('cue:addCharacter', opts),

    /**
     * Create a new ADR cue from the current In/Out selection.
     * @param {{ characterId, inFrames, outFrames, dialogue?, notes? }} opts
     * @returns {{ success, project, cue? }}
     */
    createCue: (opts)              => ipcRenderer.invoke('cue:createCue', opts),

    /**
     * Update editable fields of an existing cue.
     * @param {{ cueId: string, patch: object }} opts
     * @returns {{ success, project }}
     */
    updateCue: (cueId, patch)      => ipcRenderer.invoke('cue:updateCue', { cueId, patch }),

    /**
     * Delete a cue (and its takes). Does not renumber remaining cues.
     * @param {string} cueId
     * @returns {{ success, project }}
     */
    deleteCue: (cueId)             => ipcRenderer.invoke('cue:deleteCue', { cueId }),

    /**
     * Add a recorded take to the project.
     * @param {{ take: object }}
     * @returns {{ success, project }}
     */
    addTake:   (opts)              => ipcRenderer.invoke('cue:addTake', opts),
    selectTake: (opts)             => ipcRenderer.invoke('cue:selectTake', opts),
    updateTakeEdit: (opts)         => ipcRenderer.invoke('cue:updateTakeEdit', opts),
    createCompTake: (opts)         => ipcRenderer.invoke('cue:createCompTake', opts),
  },

  // ── Actors ──────────────────────────────────────────────────────────────────
  actor: {
    addActor:    (opts) => ipcRenderer.invoke('actor:addActor',    opts),
    updateActor: (opts) => ipcRenderer.invoke('actor:updateActor', opts),
    deleteActor: (opts) => ipcRenderer.invoke('actor:deleteActor', opts),
    assignToCue: (opts) => ipcRenderer.invoke('actor:assignToCue', opts),
  },

  // ── Recording ────────────────────────────────────────────────────────────────
  recording: {
    finalise: (opts) => ipcRenderer.invoke('recording:finalise', opts),
    abort:    ()     => ipcRenderer.invoke('recording:abort'),
  },

  // Native professional audio engine (JUCE)
  audioEngine: {
    status:      () => ipcRenderer.invoke('audioEngine:status'),
    ping:        () => ipcRenderer.invoke('audioEngine:ping'),
    restart:     () => ipcRenderer.invoke('audioEngine:restart'),
    listDevices: () => ipcRenderer.invoke('audioEngine:listDevices'),
    openDevice:  (opts) => ipcRenderer.invoke('audioEngine:openDevice', opts),
    openDiagnosticDevice: (opts) => ipcRenderer.invoke('audioEngine:openDiagnosticDevice', opts),
    meterSnapshot: () => ipcRenderer.invoke('audioEngine:meterSnapshot'),
    configureRouting: (opts) => ipcRenderer.invoke('audioEngine:configureRouting', opts),
    configureMonitoring: (opts) => ipcRenderer.invoke('audioEngine:configureMonitoring', opts),
    configureTalkback: (opts) => ipcRenderer.invoke('audioEngine:configureTalkback', opts),
    preparePlayback: (opts) => ipcRenderer.invoke('audioEngine:preparePlayback', opts),
    startPlayback: (opts) => ipcRenderer.invoke('audioEngine:startPlayback', opts),
    stopPlayback: (opts) => ipcRenderer.invoke('audioEngine:stopPlayback', opts),
    scheduleTone: (opts) => ipcRenderer.invoke('audioEngine:scheduleTone', opts),
    stopTone: (opts) => ipcRenderer.invoke('audioEngine:stopTone', opts),
    startRecording: (opts) => ipcRenderer.invoke('audioEngine:startRecording', opts),
    stopRecording: () => ipcRenderer.invoke('audioEngine:stopRecording'),
    inspectRouting: () => ipcRenderer.invoke('audioEngine:inspectRouting'),
  },

  // ── Export ──────────────────────────────────────────────────────────────────
  export: {
    /**
     * Export the current project's cue list as an ADR List PDF.
     * @param {{ preparedBy: string }} opts
     * @returns {{ success: boolean, filePath?: string, error?: string }}
     */
    adrListPdf: (opts) => ipcRenderer.invoke('export:adrListPdf', opts),

    /**
     * Export the current project's cue list as an ADR List CSV.
     * @returns {{ success: boolean, filePath?: string, error?: string }}
     */
    adrListCsv: ()     => ipcRenderer.invoke('export:adrListCsv'),
    adrSessionReport: () => ipcRenderer.invoke('export:adrSessionReport'),
    remoteCueManifest: () => ipcRenderer.invoke('export:remoteCueManifest'),
    goodTakesPackage: (opts) => ipcRenderer.invoke('export:goodTakesPackage', opts),
    timelineTakesPackage: (opts) => ipcRenderer.invoke('export:timelineTakesPackage', opts),
  },

  // ── Dialogs ─────────────────────────────────────────────────────────────────
  dialog: {
    showError:    (opts) => ipcRenderer.invoke('dialog:showError',    opts),
    showWarning:  (opts) => ipcRenderer.invoke('dialog:showWarning',  opts),
    showInfo:     (opts) => ipcRenderer.invoke('dialog:showInfo',     opts),
    confirm:      (opts) => ipcRenderer.invoke('dialog:confirm',      opts),
    closeConfirm: (opts) => ipcRenderer.invoke('dialog:closeConfirm', opts),
  },

  // ── Menu events (main → renderer) ───────────────────────────────────────────
  onMenu: {
    newProject:    (cb) => ipcRenderer.on('menu:new-project',     cb),
    openProject:   (cb) => ipcRenderer.on('menu:open-project',    cb),
      openRecentProject: (cb) => ipcRenderer.on('menu:open-recent-project', (_event, filePath) => cb(filePath)),
      saveProject:   (cb) => ipcRenderer.on('menu:save-project',    cb),
      saveProjectAs: (cb) => ipcRenderer.on('menu:save-project-as', cb),
      loadVideo:     (cb) => ipcRenderer.on('menu:load-video',      cb),
      relinkFiles:   (cb) => ipcRenderer.on('menu:relink-files',    cb),
      manageActors:  (cb) => ipcRenderer.on('menu:manage-actors',   cb),
      exportReport:  (cb) => ipcRenderer.on('menu:export-report',   cb),
      exportRemoteCueManifest: (cb) => ipcRenderer.on('menu:export-remote-cue-manifest', cb),
      exportGoodTakesPackage: (cb) => ipcRenderer.on('menu:export-good-takes-package', cb),
      exportTimelineTakesPackage: (cb) => ipcRenderer.on('menu:export-timeline-takes-package', cb),
      exportGoodTakesCharacter: (cb) => ipcRenderer.on('menu:export-good-takes-character', cb),
      exportCsv:     (cb) => ipcRenderer.on('menu:export-csv',      cb),
      exportPdf:     (cb) => ipcRenderer.on('menu:export-pdf',      cb),
      returnToStartOnStop: (cb) => ipcRenderer.on('menu:return-to-start-on-stop', (_event, checked) => cb(checked)),
      recordMode:    (cb) => ipcRenderer.on('menu:record-mode',     (_event, mode) => cb(mode)),
      showPlaybackSettings: (cb) => ipcRenderer.on('menu:show-playback-settings', cb),
      showAudioIo:    (cb) => ipcRenderer.on('menu:show-audio-io', cb),
      showSessionSettings: (cb) => ipcRenderer.on('menu:show-session-settings', cb),
      showKeyboardShortcuts: (cb) => ipcRenderer.on('menu:show-keyboard-shortcuts', cb),
    },

  // ── App events (main → renderer) ────────────────────────────────────────────
  onApp: {
    closeRequested: (cb) => ipcRenderer.on('app:close-requested', cb),
    boothClosed:    (cb) => ipcRenderer.on('booth:closed',        cb),
    boothTransportCommand: (cb) => ipcRenderer.on('booth:transport-command', (_event, command) => cb(command)),
  },

  // ── Waveform push events (main → renderer) ───────────────────────────────────
  onWaveform: {
    progress: (cb) => ipcRenderer.on('waveform:progress', (_e, data) => cb(data)),
  },

  // ── Actor Booth Display — MVP ────────────────────────────────────────────────
  // Low-frequency state relay only. All three channels use invoke/handle.
  // booth.send() is called from selectCue(), saveCueEdits(), and overlay
  // setting listeners only — never from video events or timers.
  booth: {
    open:  ()        => ipcRenderer.invoke('booth:open'),
    send:  (payload) => ipcRenderer.invoke('booth:send', payload),
    isOpen: ()       => ipcRenderer.invoke('booth:isOpen'),
    close: ()        => ipcRenderer.invoke('booth:close'),
  },

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
