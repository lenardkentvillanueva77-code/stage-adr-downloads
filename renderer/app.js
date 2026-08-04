/**
 * renderer/app.js
 *
 * Stage Post ADR Cue Recorder — workflow refinement.
 *
 * Security: NO require(), NO Node.js APIs. All IPC via window.api.
 *
 * Architectural rules:
 *   - HTML <video> is DISPLAY ONLY. currentTime drives the visible playhead only.
 *   - video.currentTime is NEVER used for recording trigger timing.
 *   - Zoom is VIEWPORT SCALING ONLY — no peak data regenerated per zoom.
 *   - All rendering is O(viewport width).
 *   - Renderer never directly mutates project data — all writes go through IPC.
 *   - Frame values are the timing source of truth. Timecodes are display only.
 *
 * Workflow changes in this revision:
 *   1. Create Cue modal — character select + optional new char inline.
 *      No dialogue/notes at creation time (those live in cue detail).
 *   2. Create Cue button: enabled only when valid In/Out AND no cue selected.
 *   3. Enter key: triggers Create Cue modal when In/Out valid and no cue selected.
 *   4. Cue list character dropdown is now a FILTER, not an assignment control.
 *   5. Character dropdown removed from cue detail panel.
 *   6. Cue status toggle: OPEN ↔ COMPLETED (button in cue detail header).
 *   7. "Rehearsal Settings" renamed to "Playback Settings".
 *   8. All existing behaviour (video, waveform, zoom, loop, pre-roll, overlay) preserved.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ZOOM LEVELS
// ═══════════════════════════════════════════════════════════════════════════════

const ZOOM_LEVELS = [
  { label: 'Full', seconds: null },
  { label: '10m',  seconds: 600  },
  { label: '8m',   seconds: 480  },
  { label: '5m',   seconds: 300  },
  { label: '3m',   seconds: 180  },
  { label: '2m',   seconds: 120  },
  { label: '1m',   seconds: 60   },
  { label: '45s',  seconds: 45   },
  { label: '30s',  seconds: 30   },
  { label: '20s',  seconds: 20   },
];

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-ROLL CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const PREROLL_BEATS     = 3;
const PREROLL_BPM       = 60;
const PREROLL_BEAT_SEC  = 60 / PREROLL_BPM;
const PREROLL_TOTAL_SEC = PREROLL_BEATS * PREROLL_BEAT_SEC;
const BEEP_FREQ_HZ      = 880;
const BEEP_DURATION_SEC = 0.08;
const BEEP_VOLUME       = 0.45;

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let currentProject  = null;
let currentFilePath = null;

let peakData = null;

let regionInFrames  = null;
let regionOutFrames = null;
let regionStreamerTargetFrames = [];

let isPlaying = false;
let isLooping = false;

/**
 * Explicit transport state — replaces the fragile _loopPassCount integer.
 *
 * States:
 *   'IDLE'       — no cue selected
 *   'CUE_READY'  — cue selected, not playing (loop flag may be on or off)
 *   'PREVIEWING' — playing via Play button, loop OFF
 *   'PREP_PASS'  — loop ON, first pass: playing immediately, no countdown
 *   'COUNTDOWN'  — loop ON, between passes: beeps + dots, video paused
 *   'TAKE_PASS'  — loop ON, subsequent passes: playing after countdown
 *
 * Single authority: _setTransportState(). Never mutate directly.
 *
 * isLooping is retained as a separate UI mode flag (loop button on/off).
 * transportState reflects what is currently happening.
 */
let transportState = 'IDLE';

function _setTransportState(state) {
  transportState = state;
  updateRecordButton();
  // Keep status indicator current for loop workflow states.
  // Non-loop states clear stale loop messages; each non-loop action sets
  // its own status message (or leaves the last one visible).
  switch (state) {
    case 'PREP_PASS':     setStatusInfo('Loop: Prep Pass');    break;
    case 'COUNTDOWN':     setStatusInfo('Loop: Countdown');    break;
    case 'TAKE_PASS':     setStatusInfo('Loop: Take Pass');    break;
    case 'RECORDING_TAKE': /* status set by recording context */ break;
    case 'CUE_READY':
    case 'IDLE':
    case 'PREVIEWING':
      if (els.statusMessage?.textContent?.startsWith('Loop:')) {
        setStatusInfo('');
      }
      break;
  }
}
let rafId     = null;

// Pre-roll
let isPrerolling  = false;
let prerollTimers      = [];   // setTimeout handles for countdown visual/callback ticks
let prerollOscillators = [];   // OscillatorNodes — kept so cancelPreroll can stop beeps early
let nativePrerollToneIds = [];

// ── Audio input runtime state (not persisted — machine-specific, session-local) ──
// Device selection is a workstation operator preference, not project metadata.
let audioInputDeviceId = null;   // deviceId of currently selected input; null = none
let audioInputReady    = false;  // true when device is selected and permission granted
let nativeAudioDevices = [];
let nativeMeterTimer = null;
let nativeRecordingActive = false;
let nativeDeviceOpen = false;
let nativeDeviceOpenMode = null;
let nativeTalkbackActive = false;
let nativeTalkbackLatched = false;
let nativeTalkbackLastPointerDown = 0;
let newProjectParentDirectory = null;
let recordMode = 'normal';
let recordArmed = false;
let pendingCueRecording = null;

// ── Recording engine state ────────────────────────────────────────────────────
let _audioWorkletNode  = null;   // AudioWorkletNode — created on first comp loop
let _mediaStream       = null;   // MediaStream from getUserMedia — held for recording
let _compTakeCount     = 0;      // takes completed in current comp loop sequence
let _activeTakePath    = null;   // file path of the in-progress take (set on finalise)
let _rafSafetyId       = null;   // requestAnimationFrame id for recording safety check
let _nativeLoopTakeContext = null;
let _nativeLoopStopTimer = null;
const COMP_TAKES_TOTAL = 3;      // hardcoded: 3 takes per comp loop
const MIN_PENDING_RECORDING_SECS = 0.3;
const WAVEFORM_AREA_MIN_HEIGHT = 80;
const WAVEFORM_AREA_MAX_HEIGHT = 420;

// Web Audio context
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new AudioContext();
  return _audioCtx;
}

// Workspace settings (persisted in project.settings.workspace)
const wsDefaults = {
  dialogueOverlayEnabled:  false,
  dialogueOverlayColor:    '#ffffff',
  dialogueOverlayFontSize: 'medium',
  cuePrerollEnabled:       true,
  boothTimecodeEnabled:    false,
  returnToStartOnStop:     true,
  preparedBy:              '',       // used in PDF export footer
  playbackVolume:          1.0,      // 0.0 – 1.0, controls video element volume
  cueBeepVolume:           0.45,     // 0.0 – 1.0, controls pre-roll beep gain
  cueBeepType:             'beep',
  recordingOffsetMs:       0,
  recordMode:              'normal',
  waveformHeightPx:        110,
  audioOutputMap:          { controlLeft: 0, controlRight: 1, boothLeft: 2, boothRight: 3 },
  audioLaneNames:          { mic1: 'Mic 1', mic2: 'Mic 2' },
  nativeAudioSetup:        {
    deviceId: '',
    bufferSize: 128,
    micSources: { mic1: 0, mic2: 1 },
    micArmed: { mic1: false, mic2: false },
    micMonitoring: { mic1: false, mic2: false },
    talkbackSource: 2,
  },
};
let ws = { ...wsDefaults };

// Viewport
let viewStart  = 0;
let viewWindow = null;
let zoomIndex  = 0;

// Canvas geometry
let canvasWidth  = 0;
let canvasHeight = 0;
let waveformVisualScale = 0.35;

// Scrollbar drag
let isScrollDragging  = false;
let scrollDragStartX  = 0;
let scrollDragStartVS = 0;

// Scrub drag
let isScrubbing = false;

// Auto-scroll
let autoScrollPaused     = false;
let autoScrollPauseTimer = null;

// Cue state
let selectedCueId = null;
let activeAuditionTakeId = null;
let activeAuditionLaneId = null;
let reviewAudio = null;
let reviewAudioTakeId = null;
let reviewAudioLaneId = null;
let reviewAudioCueId = null;
let nativeReviewPlaybackId = null;
let reviewUrlCache = new Map();
let goodTakesPlaybackEnabled = false;
let goodTakeAudioPlayers = new Map();
let nativeGoodTakePlayback = new Map();
let guideAudioPath = null;
let nativeGuidePreparedPath = null;
let nativeGuidePreparing = false;
let nativeGuidePlaybackId = null;
let nativeGuideStartOffset = 0;
let nativeGuideStartAtMs = 0;
let nativeGuideMissingWarned = false;
let nativeGuidePlaybackStarting = false;
let nativeGuidePendingRestart = false;
let videoTrackMuted = false;
let videoTrackSoloed = false;
let takesTrackMuted = false;
let takesTrackSoloed = false;
let playbackStartPosition = null;
let nativeAudioPanelBusy = false;

// Character filter for cue list (empty string = ALL)
let cueListFilter = '';

// Autosave — 60-second timer; fires only when project has unsaved changes
let _autosaveTimer     = null;
let _hasUnsavedChanges = false;
const AUTOSAVE_INTERVAL_MS = 60_000;

let transportActionGeneration = 0;
let boothTransportCommandId = 0;
const boothReadyWaiters = new Map();
const BOOTH_TRANSPORT_TYPES = new Set([
  'cuePlaybackStart',
  'cuePlaybackStop',
  'cueCountdownStart',
  'cueCountdownClear',
  'cuePrimed',
  'cueDeselected',
]);

// ── Booth display helper ──────────────────────────────────────────────────────
// boothSend() relays a low-frequency display-update to the booth window.
// Called only from: selectCue, deselectCue, saveCueEdits, overlay listeners.
// NOT called from video events, timers, or playback handlers.
// Uses invoke() — the only IPC pattern in this codebase.
// Deliberately not awaited so it never blocks the calling function.

function boothSend(payload) {
  const outbound = BOOTH_TRANSPORT_TYPES.has(payload?.type)
    ? { ...payload, commandId: ++boothTransportCommandId }
    : payload;
  window.api.booth.send(outbound).catch(() => {});
  return outbound?.commandId || null;
}

async function boothSendFlush(payload) {
  const outbound = BOOTH_TRANSPORT_TYPES.has(payload?.type)
    ? { ...payload, commandId: ++boothTransportCommandId }
    : payload;
  await window.api.booth.send(outbound).catch(() => {});
  return outbound?.commandId || null;
}

function normalizeStreamerTargetFrames(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(
    list
      .filter(frame => typeof frame === 'number' && Number.isFinite(frame))
      .map(frame => Math.max(0, Math.round(frame)))
  )].sort((a, b) => a - b);
}

function shiftStreamerTargetFrames(list, deltaFrames) {
  const normalized = normalizeStreamerTargetFrames(list);
  if (!normalized.length || !Number.isFinite(deltaFrames) || !deltaFrames) return normalized;
  return normalizeStreamerTargetFrames(normalized.map(frame => frame + Math.round(deltaFrames)));
}

function streamerTargetFramesEqual(a, b) {
  const left = normalizeStreamerTargetFrames(a);
  const right = normalizeStreamerTargetFrames(b);
  if (left.length !== right.length) return false;
  return left.every((frame, index) => frame === right[index]);
}

function getCueStreamerTargetFrames(cue) {
  if (Array.isArray(cue?.streamerTargetFrames)) {
    return normalizeStreamerTargetFrames(cue.streamerTargetFrames);
  }
  if (typeof cue?.streamerStartFrames === 'number') {
    return [Math.max(0, Math.round(cue.streamerStartFrames))];
  }
  return [];
}

function getDialogueStreamerSegments(text) {
  return String(text || '')
    .split('//')
    .map(part => part.trim())
    .filter(Boolean);
}

function cueHasValidStreamerSequence(cue) {
  const targets = getCueStreamerTargetFrames(cue);
  if (!targets.length) return false;
  return getDialogueStreamerSegments(cue?.dialogue || '').length === targets.length;
}

function getCueTakeCount(cueId) {
  if (!currentProject || !cueId) return 0;
  return (currentProject.takes || []).filter(take => take.cueId === cueId).length;
}

function getCueById(cueId) {
  if (!currentProject || !cueId) return null;
  return currentProject.cues.find(cue => cue.cueId === cueId) || null;
}

function selectedCueAllowsTimingEdit() {
  return !!selectedCueId && getCueTakeCount(selectedCueId) === 0;
}

function getCueBoothPayload(cue, characterName = '') {
  const streamerTargetFrames = cueHasValidStreamerSequence(cue) ? getCueStreamerTargetFrames(cue) : [];
  return {
    type: 'cueSelected',
    cueNumber: cue.cueNumber,
    characterName,
    dialogue: cue.dialogue || '',
    inTime: framesToSeconds(cue.inFrames),
    outTime: framesToSeconds(cue.outFrames),
    streamerTargetTime: streamerTargetFrames.length ? framesToSeconds(streamerTargetFrames[0]) : null,
    streamerTargetTimes: streamerTargetFrames.map(frame => framesToSeconds(frame)),
    overlayColor: ws.dialogueOverlayColor,
    overlayFontSize: ws.dialogueOverlayFontSize,
    showTimecode: ws.boothTimecodeEnabled,
    frameRate: currentProject?.settings?.frameRate || '25',
  };
}

function waitForBoothReady(commandId, timeoutMs = 350) {
  if (!commandId) return Promise.resolve(false);
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      boothReadyWaiters.delete(commandId);
      resolve(false);
    }, timeoutMs);
    boothReadyWaiters.set(commandId, () => {
      clearTimeout(timeout);
      boothReadyWaiters.delete(commandId);
      resolve(true);
    });
  });
}

async function prepareBoothForVideoStart(startTime, timeoutMs = 350) {
  const boothState = await window.api.booth.isOpen?.().catch(() => ({ isOpen: false }));
  if (!boothState?.isOpen) return true;
  const commandId = boothSend({ type: 'cuePrimed', currentTime: startTime });
  return waitForBoothReady(commandId, timeoutMs);
}

async function startSyncedVideoAt(startTime, allowedStates) {
  const actionGeneration = transportActionGeneration;
  els.videoPlayer.pause();
  els.videoPlayer.currentTime = startTime;
  await prepareBoothForVideoStart(startTime);
  if (actionGeneration !== transportActionGeneration) return false;
  if (Array.isArray(allowedStates) && allowedStates.length && !allowedStates.includes(transportState)) {
    return false;
  }
  els.videoPlayer.currentTime = startTime;
  await boothSendFlush({ type: 'cuePlaybackStart', currentTime: startTime });
  await els.videoPlayer.play().catch(() => {});
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOM REFS
// ═══════════════════════════════════════════════════════════════════════════════

const els = {
  // Header
  headerProjectName:      document.getElementById('header-project-name'),
  btnNewProject:          document.getElementById('btn-new-project'),
  btnOpenProject:         document.getElementById('btn-open-project'),
  btnSaveProject:         document.getElementById('btn-save-project'),
  btnLoadVideo:           document.getElementById('btn-load-video'),

  // Status
  statusIcon:             document.getElementById('status-icon'),
  statusMessage:          document.getElementById('status-message'),
  waveformProgressArea:   document.getElementById('waveform-progress-area'),
  waveformProgressLabel:  document.getElementById('waveform-progress-label'),
  waveformProgressFill:   document.getElementById('waveform-progress-fill'),
  waveformProgressPct:    document.getElementById('waveform-progress-pct'),

  // Video
  videoSection:           document.querySelector('.video-section'),
  videoPlaceholder:       document.getElementById('video-placeholder'),
  videoPlayer:            document.getElementById('video-player'),
  videoTrackMute:         document.getElementById('video-track-mute'),
  videoTrackSolo:         document.getElementById('video-track-solo'),
  guideAudioStatus:       document.getElementById('guide-audio-status'),
  infoTimecode:           document.getElementById('info-timecode'),
  infoFps:                document.getElementById('info-fps'),
  infoResolution:         document.getElementById('info-resolution'),
  infoCodec:              document.getElementById('info-codec'),
  infoRegionChip:         document.getElementById('info-region'),
  infoRegionIn:           document.getElementById('info-region-in'),
  infoRegionOut:          document.getElementById('info-region-out'),
  infoRegionDur:          document.getElementById('info-region-dur'),

  // Dialogue overlay
  dialogueOverlay:        document.getElementById('dialogue-overlay'),
  dialogueOverlayText:    document.getElementById('dialogue-overlay-text'),

  // Pre-roll dots
  prerollDots:            document.getElementById('preroll-dots'),
  prerollDot1:            document.getElementById('preroll-dot-1'),
  prerollDot2:            document.getElementById('preroll-dot-2'),
  prerollDot3:            document.getElementById('preroll-dot-3'),

  // Timeline
  timelineArea:            document.getElementById('timeline-area'),
  timelineResizeHandle:    document.getElementById('timeline-resize-handle'),
  waveformPlaceholder:    document.getElementById('waveform-placeholder'),
  btnGenerateWaveform:    document.getElementById('btn-generate-waveform'),
  timelineControls:       document.getElementById('timeline-controls'),
  zoomLevelStrip:         document.getElementById('zoom-level-strip'),
  btnZoomOut:             document.getElementById('btn-zoom-out'),
  btnZoomIn:              document.getElementById('btn-zoom-in'),
  btnFitProject:          document.getElementById('btn-fit-project'),
  btnZoomSelection:       document.getElementById('btn-zoom-selection'),
  zoomLabelDisplay:       document.getElementById('zoom-label-display'),
  waveformScaleControl:   document.getElementById('waveform-scale-control'),
  waveformScaleHandle:    document.getElementById('waveform-scale-handle'),
  timelineRuler:          document.getElementById('timeline-ruler'),
  waveformWrap:           document.getElementById('waveform-wrap'),
  waveformCanvas:         document.getElementById('waveform-canvas'),
  playhead:               document.getElementById('playhead'),
  regionHighlight:        document.getElementById('region-highlight'),
  markerIn:               document.getElementById('marker-in'),
  streamerMarkerLayer:    document.getElementById('streamer-marker-layer'),
  markerOut:              document.getElementById('marker-out'),
  timelineScrollbarTrack: document.getElementById('timeline-scrollbar-track'),
  timelineScrollbarThumb: document.getElementById('timeline-scrollbar-thumb'),

  // Info sidebar
  infoFilmTitle:          document.getElementById('info-film-title'),
  infoProjectName:        document.getElementById('info-project-name'),
  infoProjectId:          document.getElementById('info-project-id'),
  infoCreatedAt:          document.getElementById('info-created-at'),
  infoUpdatedAt:          document.getElementById('info-updated-at'),
  infoFilePath:           document.getElementById('info-file-path'),
  vmetaFilename:          document.getElementById('vmeta-filename'),
  vmetaDuration:          document.getElementById('vmeta-duration'),
  vmetaFramerate:         document.getElementById('vmeta-framerate'),
  vmetaResolution:        document.getElementById('vmeta-resolution'),
  vmetaVcodec:            document.getElementById('vmeta-vcodec'),
  vmetaAcodec:            document.getElementById('vmeta-acodec'),
  vmetaSamplerate:        document.getElementById('vmeta-samplerate'),
  vmetaChannels:          document.getElementById('vmeta-channels'),
  vmetaBitrate:           document.getElementById('vmeta-bitrate'),
  vmetaFormat:            document.getElementById('vmeta-format'),
  settingsFramerate:      document.getElementById('settings-framerate'),
  settingsSamplerate:     document.getElementById('settings-samplerate'),
  settingsBitdepth:       document.getElementById('settings-bitdepth'),
  framerateLockedRow:     document.getElementById('framerate-lock-row'),
  audioEngineStatus:      document.getElementById('audio-engine-status'),
  audioEngineDeviceCount: document.getElementById('audio-engine-device-count'),
  audioEngineRoutingStatus: document.getElementById('audio-engine-routing-status'),
  audioEngineIoStatus:    document.getElementById('audio-engine-io-status'),
  audioEngineDeviceSelect: document.getElementById('audio-engine-device-select'),
  audioEngineBufferSize: document.getElementById('audio-engine-buffer-size'),
  audioEngineRecordingOffsetMs: document.getElementById('audio-engine-recording-offset-ms'),
  audioEngineRecordingOffsetFeedback: document.getElementById('audio-engine-recording-offset-feedback'),
  audioEngineRouteMap:    document.getElementById('audio-engine-route-map'),
  audioEngineMeterInput1: document.getElementById('audio-engine-meter-input-1'),
  audioEngineMeterInput2: document.getElementById('audio-engine-meter-input-2'),
  audioEngineRecordStatus: document.getElementById('audio-engine-record-status'),
  audioEngineMic1Arm: document.getElementById('audio-engine-mic1-arm'),
  audioEngineMic2Arm: document.getElementById('audio-engine-mic2-arm'),
  audioEngineMic1Name: document.getElementById('audio-engine-mic1-name'),
  audioEngineMic2Name: document.getElementById('audio-engine-mic2-name'),
  audioEngineMic1Source: document.getElementById('audio-engine-mic1-source'),
  audioEngineMic2Source: document.getElementById('audio-engine-mic2-source'),
  audioEngineMic1Monitor: document.getElementById('audio-engine-mic1-monitor'),
  audioEngineMic2Monitor: document.getElementById('audio-engine-mic2-monitor'),
  audioEngineTalkbackSource: document.getElementById('audio-engine-talkback-source'),
  btnAudioEngineTalkback: document.getElementById('btn-audio-engine-talkback'),
  audioEngineControlOutputPair: document.getElementById('audio-engine-control-output-pair'),
  audioEngineBoothOutputPair: document.getElementById('audio-engine-booth-output-pair'),
  audioEngineDeviceList:  document.getElementById('audio-engine-device-list'),
  btnOpenAudioEngineDevice: document.getElementById('btn-open-audio-engine-device'),
  btnOpenAudioEngineDiagnostic: document.getElementById('btn-open-audio-engine-diagnostic'),
  btnNativeRecordStart: document.getElementById('btn-native-record-start'),
  btnNativeRecordStop: document.getElementById('btn-native-record-stop'),
  btnRefreshAudioEngine:  document.getElementById('btn-refresh-audio-engine'),
  regionInTc:             document.getElementById('region-in-tc'),
  regionInFramesEl:       document.getElementById('region-in-frames'),
  regionOutTc:            document.getElementById('region-out-tc'),
  regionOutFramesEl:      document.getElementById('region-out-frames'),
  regionDuration:         document.getElementById('region-duration'),
  regionLoopStatus:       document.getElementById('region-loop-status'),

  // Playback settings (previously "Rehearsal Settings")
  settingPrerollEnabled:  document.getElementById('setting-preroll-enabled'),
  settingOverlayEnabled:  document.getElementById('setting-overlay-enabled'),
  settingBoothTcEnabled:  document.getElementById('setting-booth-tc-enabled'),
  settingPlaybackVolume:  document.getElementById('setting-playback-volume'),
  settingPlaybackVolPct:  document.getElementById('setting-playback-volume-pct'),
  settingBeepVolume:      document.getElementById('setting-beep-volume'),
  settingBeepVolPct:      document.getElementById('setting-beep-volume-pct'),
  waveformVideoVolume:    document.getElementById('waveform-video-volume'),
  btnBoothTcToggle:       document.getElementById('btn-booth-tc-toggle'),
  btnPrerollToggle:       document.getElementById('btn-preroll-toggle'),
  btnGoodTakesPlayback:   document.getElementById('btn-good-takes-playback'),
  btnDialogueOverlayToggle: document.getElementById('btn-dialogue-overlay-toggle'),
  dxOverlayInline:        document.getElementById('dx-overlay-inline'),
  btnBeepToggle:          document.getElementById('btn-beep-toggle'),
  btnBeepSettings:        document.getElementById('btn-beep-settings'),
  modalBeepSettings:      document.getElementById('modal-beep-settings'),
  beepTypeSelect:         document.getElementById('beep-type-select'),
  beepModalVolume:        document.getElementById('beep-modal-volume'),
  btnBeepModalClose:      document.getElementById('btn-beep-modal-close'),
  modalKeyboardShortcuts: document.getElementById('modal-keyboard-shortcuts'),
  shortcutsList:          document.getElementById('shortcuts-list'),
  shortcutsHint:          document.getElementById('shortcuts-hint'),
  midiStatus:             document.getElementById('midi-status'),
  btnMidiEnable:          document.getElementById('btn-midi-enable'),
  btnShortcutsReset:      document.getElementById('btn-shortcuts-reset'),
  btnShortcutsClose:      document.getElementById('btn-shortcuts-close'),
  overlaySubSettings:     document.getElementById('overlay-sub-settings'),
  overlayColorPicker:     document.getElementById('overlay-color-picker'),
  overlayFontSize:        document.getElementById('overlay-font-size'),

  // Cue panel
  cueCharacterFilter:     document.getElementById('cue-character-filter'),  // filter, not assignment
  btnInspectorToggle:     document.getElementById('btn-inspector-toggle'),
  cueList:                document.getElementById('cue-list'),
  cueEmptyState:          document.getElementById('cue-empty-state'),
  cueDetail:              document.getElementById('cue-detail'),
  cueDetailNumber:        document.getElementById('cue-detail-number'),
  cueDetailChar:          document.getElementById('cue-detail-char'),       // display-only character label
  btnCueStatus:           document.getElementById('btn-cue-status'),        // OPEN/COMPLETED toggle
  btnDeleteCue:           document.getElementById('btn-delete-cue'),
  cueDetailIn:            document.getElementById('cue-detail-in'),
  cueDetailOut:           document.getElementById('cue-detail-out'),
  cueDetailDur:           document.getElementById('cue-detail-dur'),
  cueOverlapDetail:       document.getElementById('cue-overlap-detail'),
  cueOverlapList:         document.getElementById('cue-overlap-list'),
  cueDetailDialogue:      document.getElementById('cue-detail-dialogue'),
  cueDetailNotes:         document.getElementById('cue-detail-notes'),
  cueDetailActor:         document.getElementById('cue-detail-actor'),
  cueDetailTakes:         document.getElementById('cue-detail-takes'),
  btnSaveCue:             document.getElementById('btn-save-cue'),

  // Transport
  transportTimecode:      document.getElementById('transport-timecode'),
  btnPlay:                document.getElementById('btn-play'),
  btnStop:                document.getElementById('btn-stop'),
  btnRecord:              document.getElementById('btn-record'),
  audioInputSelect:       document.getElementById('audio-input-select'),
  audioInputStatus:       document.getElementById('audio-input-status'),
  btnMarkIn:              document.getElementById('btn-mark-in'),
  btnStreamerTarget:      document.getElementById('btn-streamer-target'),
  btnMarkOut:             document.getElementById('btn-mark-out'),
  btnLoop:                document.getElementById('btn-loop'),
  btnCreateCue:           document.getElementById('btn-create-cue'),
  playIcon:               document.getElementById('play-icon'),
  playLabel:              document.getElementById('play-label'),

  // New Project Modal
  modalNewProject:        document.getElementById('modal-new-project'),
  inputFilmTitle:         document.getElementById('input-film-title'),
  inputProjectName:       document.getElementById('input-project-name'),
  btnNewProjectLocation:  document.getElementById('btn-new-project-location'),
  newProjectLocationLabel: document.getElementById('new-project-location-label'),
  newProjectPreview:      document.getElementById('new-project-preview'),
  btnModalCancel:         document.getElementById('btn-modal-cancel'),
  btnModalCreate:         document.getElementById('btn-modal-create'),

  // Create Cue Modal (replaces separate Add Character modal)
  modalCreateCue:         document.getElementById('modal-create-cue'),
  createCueTiming:        document.getElementById('create-cue-timing'),
  createCueExistingGroup: document.getElementById('create-cue-existing-group'),
  createCueCharSelect:    document.getElementById('create-cue-char-select'),
  createCueDivider:       document.getElementById('create-cue-divider'),
  createCueNewChar:       document.getElementById('create-cue-new-char'),
  btnCreateCueCancel:     document.getElementById('btn-create-cue-cancel'),
  btnCreateCueSave:       document.getElementById('btn-create-cue-save'),

  // Booth Display
  btnOpenBooth:           document.getElementById('btn-open-booth'),

  // Actor Manager
  btnManageActors:        document.getElementById('btn-manage-actors'),
  modalActors:            document.getElementById('modal-actors'),
  actorList:              document.getElementById('actor-list'),
  actorInputName:         document.getElementById('actor-input-name'),
  actorInputEmail:        document.getElementById('actor-input-email'),
  btnActorAdd:            document.getElementById('btn-actor-add'),
  btnActorsClose:         document.getElementById('btn-actors-close'),
  actorFormError:         document.getElementById('actor-form-error'),

  // Export Modal
  modalExportPdf:         document.getElementById('modal-export-pdf'),
  inputPreparedBy:        document.getElementById('input-prepared-by'),
  btnExportModalCancel:   document.getElementById('btn-export-modal-cancel'),
  btnExportModalConfirm:  document.getElementById('btn-export-modal-confirm'),
  modalExportCharacter:   document.getElementById('modal-export-character'),
  exportCharacterSelect:  document.getElementById('export-character-select'),
  btnExportCharacterCancel: document.getElementById('btn-export-character-cancel'),
  btnExportCharacterConfirm: document.getElementById('btn-export-character-confirm'),
  modalExportResult:      document.getElementById('modal-export-result'),
  exportResultSubtitle:   document.getElementById('export-result-subtitle'),
  exportResultOffset:     document.getElementById('export-result-offset'),
  exportResultStems:      document.getElementById('export-result-stems'),
  exportResultPlaced:     document.getElementById('export-result-placed'),
  exportResultWarnings:   document.getElementById('export-result-warnings'),
  exportResultPackagePath: document.getElementById('export-result-package-path'),
  exportResultReportPaths: document.getElementById('export-result-report-paths'),
  exportResultStemList:   document.getElementById('export-result-stem-list'),
  btnExportResultClose:   document.getElementById('btn-export-result-close'),
};

// ═══════════════════════════════════════════════════════════════════════════════
function applyProWorkspaceLayout() {
  const move = (node, slotId) => {
    const slot = document.getElementById(slotId);
    if (node && slot) slot.appendChild(node);
  };

  move(els.audioEngineDeviceSelect?.closest('.audio-engine-open-row'), 'audio-console-device-slot');
  move(els.audioEngineBufferSize?.closest('.audio-engine-setting-row'), 'audio-console-buffer-slot');
  move(els.audioEngineRecordingOffsetMs?.closest('.audio-engine-setting-row'), 'audio-console-buffer-slot');
  move(els.audioEngineRecordingOffsetFeedback, 'audio-console-buffer-slot');
  move(els.audioEngineMic1Arm?.closest('.audio-engine-lane-row'), 'audio-console-mic1-slot');
  move(els.audioEngineMic2Arm?.closest('.audio-engine-lane-row'), 'audio-console-mic2-slot');
  move(els.audioEngineTalkbackSource?.closest('.audio-engine-talkback-row'), 'audio-console-talkback-slot');
  els.btnNativeRecordStart?.closest('.audio-engine-record-row')?.classList.add('hidden');
  els.btnOpenAudioEngineDiagnostic?.classList.add('hidden');
  move(els.audioEngineControlOutputPair?.closest('.audio-engine-output-grid'), 'audio-console-routing-slot');
  move(els.audioEngineBoothOutputPair?.closest('.audio-engine-output-grid'), 'audio-console-routing-slot');
  move(els.audioEngineMeterInput1?.closest('.audio-engine-meter-row'), 'audio-console-meter1-slot');
  move(els.audioEngineMeterInput2?.closest('.audio-engine-meter-row'), 'audio-console-meter2-slot');
  move(els.btnRefreshAudioEngine, 'audio-console-device-slot');
  move(els.btnOpenBooth, 'audio-console-display-slot');
  move(els.btnBoothTcToggle, 'audio-console-display-slot');
  move(els.btnDialogueOverlayToggle, 'audio-console-display-slot');
  move(els.dxOverlayInline, 'audio-console-display-slot');

  els.audioEngineStatus?.closest('.panel')?.classList.add('hidden');
  els.btnManageActors?.closest('.panel-action-row')?.classList.add('hidden');

  const existingTakes = els.cueDetailTakes;
  if (existingTakes && !document.getElementById('takes-panel')) {
    const cuesLane = els.cueDetail.closest('.sidebar-cues');
    const takesLane = document.createElement('aside');
    takesLane.className = 'sidebar sidebar-takes';
    takesLane.id = 'takes-lane';
    cuesLane?.insertAdjacentElement('afterend', takesLane);
    takesLane.appendChild(els.cueDetail);

    const takesPanel = document.createElement('div');
    takesPanel.className = 'takes-panel takes-panel-lane';
    takesPanel.id = 'takes-panel';
    takesPanel.innerHTML = '<div class="takes-panel-header"><span class="panel-title">Takes</span></div>';
    takesLane.appendChild(takesPanel);
    takesPanel.appendChild(existingTakes);
    if (!existingTakes.innerHTML.trim()) {
      existingTakes.innerHTML = '<div class="takes-empty">Select an ADR cue to view takes.</div>';
    }
    els.takesPanel = takesPanel;
  } else {
    els.takesPanel = document.getElementById('takes-panel');
  }
}

applyProWorkspaceLayout();

// STATUS
// ═══════════════════════════════════════════════════════════════════════════════

function setStatus(msg, type = 'info') {
  els.statusMessage.textContent = msg;
  els.statusIcon.className = 'status-icon ' + type;
}
function setStatusOk(m)    { setStatus(m, 'ok');    }
function setStatusWarn(m)  { setStatus(m, 'warn');  }
function setStatusError(m) { setStatus(m, 'error'); }
function setStatusInfo(m)  { setStatus(m, 'info');  }

function clearNativeRuntimeState() {
  stopNativeMetering();
  nativeRecordingActive = false;
  nativeDeviceOpen = false;
  nativeDeviceOpenMode = null;
  nativeTalkbackActive = false;
  nativeTalkbackLatched = false;
  nativeGuidePreparedPath = null;
  nativeGuidePreparing = false;
  nativeGuidePlaybackId = null;
  nativeGuideStartOffset = 0;
  nativeGuideStartAtMs = 0;
  nativeGuidePlaybackStarting = false;
  nativeGuidePendingRestart = false;
  nativeReviewPlaybackId = null;
  nativeGoodTakePlayback.clear();
  _nativeLoopTakeContext = null;
  _clearNativeLoopStopTimer();
  updateNativeRecordButtons(false);
  updateNativeTalkbackButton();
  applyMonitorState();
  updateGuideAudioStatus();
}

function isAudioEngineLoss(errorText) {
  return /timed out|exited|not writable|broken pipe|epipe|terminated|restarted/i.test(String(errorText || ''));
}

function handleNativeEngineLoss(errorText, context = 'playback') {
  if (!isAudioEngineLoss(errorText)) return;
  clearNativeRuntimeState();
  els.audioEngineRoutingStatus.textContent = 'Needs refresh';
  setStatusWarn(`Native audio engine lost ${context}. Press Refresh to restart and reopen the selected device.`);
}

function handleNativePlaybackFailure(errorText) {
  handleNativeEngineLoss(errorText, 'playback');
}

function setNativeAudioPanelBusy(busy) {
  nativeAudioPanelBusy = !!busy;
  const hasDeviceSelection = !!els.audioEngineDeviceSelect?.value;
  if (els.audioEngineDeviceSelect) els.audioEngineDeviceSelect.disabled = nativeAudioPanelBusy;
  if (els.audioEngineBufferSize) els.audioEngineBufferSize.disabled = nativeAudioPanelBusy;
  if (els.btnOpenAudioEngineDevice) els.btnOpenAudioEngineDevice.disabled = nativeAudioPanelBusy || !hasDeviceSelection;
  if (els.btnOpenAudioEngineDiagnostic) els.btnOpenAudioEngineDiagnostic.disabled = nativeAudioPanelBusy || !hasDeviceSelection;
  if (els.btnRefreshAudioEngine) els.btnRefreshAudioEngine.disabled = nativeAudioPanelBusy;
}

async function refreshAudioEnginePanel(options = {}) {
  if (!window.api?.audioEngine) return;
  const restartEngine = !!options.restartEngine;
  const reopenSelected = !!options.reopenSelected;
  const selectedDeviceId = els.audioEngineDeviceSelect?.value || ws.nativeAudioSetup?.deviceId || '';
  const selectedMode = nativeDeviceOpenMode || 'studio';

  els.audioEngineStatus.textContent = restartEngine ? 'Restarting...' : 'Checking...';
  els.audioEngineDeviceCount.textContent = '—';
  els.audioEngineRoutingStatus.textContent = '—';
  els.audioEngineIoStatus.textContent = '—';
  els.audioEngineRouteMap.textContent = '';
  els.audioEngineDeviceList.textContent = '';
  els.audioEngineRecordStatus.textContent = 'Idle';
  clearNativeRuntimeState();
  els.audioEngineDeviceSelect.innerHTML = '<option value="">Select device…</option>';
  renderNativeLaneSourceOptions(null);
  setNativeAudioPanelBusy(true);

  try {
    if (restartEngine) {
      setStatusInfo('Restarting native audio engine...');
      const restarted = await window.api.audioEngine.restart();
      if (!restarted.success) {
        setStatusWarn(`Native audio engine restart failed: ${restarted.error}`);
        return;
      }
    }

    const status = await window.api.audioEngine.status();
    if (!status.success || !status.engineExists) {
      els.audioEngineStatus.textContent = status.engineExists ? 'Unavailable' : 'Engine not built';
      els.audioEngineRoutingStatus.textContent = 'Unavailable';
      setStatusWarn('Native audio engine is not available.');
      return;
    }

    const result = await window.api.audioEngine.listDevices();
    if (!result.success) {
      const timedOut = /timed out/i.test(result.error || '');
      els.audioEngineStatus.textContent = timedOut ? 'Scan timed out' : 'Error';
      els.audioEngineRoutingStatus.textContent = 'Unavailable';
      setStatusWarn(timedOut
        ? 'Audio device scan timed out. Project/video work is still available; refresh audio later.'
        : `Native audio engine: ${result.error}`);
      return;
    }

    const devices = result.devices || [];
    nativeAudioDevices = devices;
    const studioDevices = devices.filter(d => getNativeDeviceCapability(d).mode === 'studio');
    const compactDevices = devices.filter(d => getNativeDeviceCapability(d).mode === 'compact');
    const hasProfessionalBackend = devices.some(d => ['ASIO', 'CoreAudio'].includes(d.backend));

    els.audioEngineStatus.textContent = 'Ready';
    els.audioEngineDeviceCount.textContent = String(devices.length);
    els.audioEngineRoutingStatus.textContent = studioDevices.length
      ? 'Studio routing ready'
      : compactDevices.length
        ? 'Compact routing ready'
        : 'No stereo output';

    renderAudioEngineDeviceOptions(devices);
    if (selectedDeviceId && devices.some(device => device.deviceId === selectedDeviceId)) {
      els.audioEngineDeviceSelect.value = selectedDeviceId;
      renderNativeLaneSourceOptions(getSelectedNativeDevice());
      renderNativeOutputOptions(getSelectedNativeDevice());
    }
    await refreshRoutingInspect();

    if (restartEngine && reopenSelected && els.audioEngineDeviceSelect.value) {
      setNativeAudioPanelBusy(false);
      if (selectedMode === 'diagnostic') await openSelectedAudioEngineDiagnostic();
      else await openSelectedAudioEngineDevice();
      return;
    }

    if (studioDevices.length && hasProfessionalBackend) {
      setStatusOk('Native audio engine found a studio routing-capable device.');
    } else if (studioDevices.length) {
      setStatusWarn('Multichannel device found, but not through ASIO/CoreAudio professional backend.');
    } else if (compactDevices.length) {
      setStatusOk('Native audio engine ready in compact routing mode.');
    } else {
      setStatusWarn('Native audio engine ready. No stereo output device detected.');
    }
  } catch (err) {
    const timedOut = /timed out/i.test(err.message || '');
    els.audioEngineStatus.textContent = timedOut ? 'Scan timed out' : 'Error';
    els.audioEngineRoutingStatus.textContent = 'Unavailable';
    setStatusWarn(timedOut
      ? 'Audio device scan timed out. Project/video work is still available; refresh audio later.'
      : `Native audio engine: ${err.message}`);
  } finally {
    setNativeAudioPanelBusy(false);
  }
}

async function refreshRoutingInspect() {
  const result = await window.api.audioEngine.inspectRouting();
  if (!result.success || !result.routing) {
    els.audioEngineRouteMap.textContent = '';
    return;
  }

  renderAudioEngineRouteMap(result.routing);
}

function renderAudioEngineRouteMap(routing) {
  routing = routing || {};
  els.audioEngineRouteMap.textContent = '';
  const outputMap = normalizeAudioOutputMap();
  const outputLabel = index => Number.isInteger(index) && index >= 0 ? `Output ${index + 1}` : 'None';
  const modeLabel = nativeDeviceOpenMode === 'studio'
    ? 'Studio'
    : nativeDeviceOpenMode === 'compact'
      ? 'Compact'
      : routing.profile || '—';

  const rows = [
    ['Profile', modeLabel],
    ['Record', 'Armed mic lanes -> WAV'],
    ['Talkback', nativeDeviceOpenMode === 'studio' ? 'Mapped input -> booth only' : 'Disabled in compact mode'],
    ['Control', `${outputLabel(outputMap.controlLeft)} / ${outputLabel(outputMap.controlRight)}`],
    ['Booth', `${outputLabel(outputMap.boothLeft)} / ${outputLabel(outputMap.boothRight)}`],
  ];

  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'audio-engine-route-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'audio-engine-route-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = 'audio-engine-route-value';
    valueEl.textContent = value;

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    els.audioEngineRouteMap.appendChild(row);
  });
}

function getNativeDeviceCapability(device) {
  const inputCount = Math.max(0, Number(device?.inputChannelCount || 0));
  const outputCount = Math.max(0, Number(device?.outputChannelCount || 0));
  if (inputCount >= 3 && outputCount >= 4) {
    return { mode: 'studio', label: 'Studio routing', canOpen: true, talkback: true };
  }
  if (outputCount >= 2) {
    return { mode: 'compact', label: 'Compact routing', canOpen: true, talkback: false };
  }
  return { mode: 'unavailable', label: 'No stereo output', canOpen: false, talkback: false };
}

function renderAudioEngineDeviceOptions(devices) {
  const savedDeviceId = ws.nativeAudioSetup?.deviceId || '';
  const currentDeviceId = els.audioEngineDeviceSelect.value || savedDeviceId;
  els.audioEngineDeviceSelect.innerHTML = '<option value="">Select device…</option>';

  devices.forEach(device => {
    const capability = getNativeDeviceCapability(device);
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.disabled = !capability.canOpen;
    option.textContent = `${device.backend || 'Audio'}: ${device.name || 'Unnamed device'} (${device.inputChannelCount || 0} in / ${device.outputChannelCount || 0} out, ${capability.label})`;
    els.audioEngineDeviceSelect.appendChild(option);
  });

  if (currentDeviceId && devices.some(device => device.deviceId === currentDeviceId)) {
    els.audioEngineDeviceSelect.value = currentDeviceId;
  }

  els.btnOpenAudioEngineDevice.disabled = nativeAudioPanelBusy || !els.audioEngineDeviceSelect.value;
  els.btnOpenAudioEngineDiagnostic.disabled = nativeAudioPanelBusy || !els.audioEngineDeviceSelect.value;
  renderNativeLaneSourceOptions(getSelectedNativeDevice());
  renderNativeOutputOptions(getSelectedNativeDevice());
}

function renderNativeLaneSourceOptions(device) {
  const inputCount = Math.max(0, Number(device?.inputChannelCount || 0));
  const inputNames = Array.isArray(device?.inputChannelNames) ? device.inputChannelNames : [];
  const savedSetup = ws.nativeAudioSetup || wsDefaults.nativeAudioSetup;
  const capability = getNativeDeviceCapability(device);
  const fill = (selectEl, preferredIndex) => {
    const previous = selectEl.value;
    selectEl.innerHTML = '<option value="">Source...</option>';
    for (let index = 0; index < inputCount; index++) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${index + 1}: ${inputNames[index] || `Input ${index + 1}`}`;
      selectEl.appendChild(option);
    }
    if (preferredIndex >= 0 && preferredIndex < inputCount) selectEl.value = String(preferredIndex);
    else if (previous && Number(previous) < inputCount) selectEl.value = previous;
  };

  fill(els.audioEngineMic1Source, Number(savedSetup.micSources?.mic1 ?? 0));
  fill(els.audioEngineMic2Source, Number(savedSetup.micSources?.mic2 ?? 1));
  fill(els.audioEngineTalkbackSource, Number(savedSetup.talkbackSource ?? Math.min(2, Math.max(0, inputCount - 1))));
  els.audioEngineTalkbackSource.disabled = capability.mode !== 'studio';
  updateNativeRecordButtons(nativeDeviceOpen);
  updateNativeTalkbackButton();
}

function renderNativeOutputOptions(device) {
  const outputCount = Math.max(0, Number(device?.outputChannelCount || 0));
  const outputNames = Array.isArray(device?.outputChannelNames) ? device.outputChannelNames : [];
  const outputMap = normalizeAudioOutputMap();
  const capability = getNativeDeviceCapability(device);

  const fillPair = (selectEl, preferredLeft) => {
    if (!selectEl) return;
    selectEl.innerHTML = '<option value="-1">None</option>';
    for (let index = 0; index < outputCount - 1; index += 2) {
      const option = document.createElement('option');
      option.value = String(index);
      const left = outputNames[index] || `Output ${index + 1}`;
      const right = outputNames[index + 1] || `Output ${index + 2}`;
      option.textContent = `${index + 1}-${index + 2}: ${left} / ${right}`;
      selectEl.appendChild(option);
    }
    if (preferredLeft >= 0 && preferredLeft < outputCount - 1) selectEl.value = String(preferredLeft - (preferredLeft % 2));
    else selectEl.value = '-1';
    selectEl.disabled = outputCount < 2;
  };

  fillPair(els.audioEngineControlOutputPair, outputMap.controlLeft >= 0 ? outputMap.controlLeft : 0);
  fillPair(els.audioEngineBoothOutputPair, capability.mode === 'studio' ? outputMap.boothLeft : -1);
  renderAudioEngineRouteMap();
}

function getSelectedNativeDevice() {
  const deviceId = els.audioEngineDeviceSelect.value;
  return nativeAudioDevices.find(d => d.deviceId === deviceId) || null;
}

function getSelectedNativeBufferSize() {
  const bufferSize = Number(els.audioEngineBufferSize.value);
  return [64, 128, 256, 512].includes(bufferSize) ? bufferSize : 128;
}

function getNativeAudioSetupFromUI() {
  const toInputIndex = (selectEl, fallback) => {
    const value = Number(selectEl?.value);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  };

  return {
    ...wsDefaults.nativeAudioSetup,
    ...(ws.nativeAudioSetup || {}),
    deviceId: els.audioEngineDeviceSelect?.value || '',
    bufferSize: getSelectedNativeBufferSize(),
    micSources: {
      mic1: toInputIndex(els.audioEngineMic1Source, wsDefaults.nativeAudioSetup.micSources.mic1),
      mic2: toInputIndex(els.audioEngineMic2Source, wsDefaults.nativeAudioSetup.micSources.mic2),
    },
    micArmed: {
      mic1: isToggleButtonOn(els.audioEngineMic1Arm),
      mic2: isToggleButtonOn(els.audioEngineMic2Arm),
    },
    micMonitoring: {
      mic1: isToggleButtonOn(els.audioEngineMic1Monitor),
      mic2: isToggleButtonOn(els.audioEngineMic2Monitor),
    },
    talkbackSource: toInputIndex(els.audioEngineTalkbackSource, wsDefaults.nativeAudioSetup.talkbackSource),
  };
}

async function saveNativeAudioSetup() {
  ws.nativeAudioSetup = getNativeAudioSetupFromUI();
  await saveWorkspaceSettings({ persist: true });
}

async function openSelectedAudioEngineDevice() {
  if (nativeAudioPanelBusy) return;
  const deviceId = els.audioEngineDeviceSelect.value;
  if (!deviceId) return;

  const device = nativeAudioDevices.find(d => d.deviceId === deviceId);
  const capability = getNativeDeviceCapability(device);
  if (!capability.canOpen) {
    setStatusWarn('Selected audio device does not expose a usable stereo output.');
    return;
  }
  setNativeAudioPanelBusy(true);
  els.audioEngineRoutingStatus.textContent = 'Opening...';

  try {
    const opener = capability.mode === 'studio'
      ? window.api.audioEngine.openDevice
      : window.api.audioEngine.openDiagnosticDevice;
    const response = await opener({
      deviceId,
      sampleRate: 48000,
      bufferSize: getSelectedNativeBufferSize(),
    });

    if (!response.success) {
      els.audioEngineRoutingStatus.textContent = 'Open failed';
      markNativeDeviceClosed();
      setStatusError(`Native audio device open failed: ${response.error}`);
      return;
    }

    if (response.result?.ok) {
      els.audioEngineRoutingStatus.textContent = capability.mode === 'studio' ? 'Studio routing ready' : 'Compact routing ready';
      setStatusOk(`${capability.label} opened: ${device?.name || deviceId}`);
      nativeDeviceOpen = true;
      nativeDeviceOpenMode = capability.mode;
      startNativeMetering();
      updateNativeRecordButtons(true);
      await configureNativeRouting();
      await configureNativeMonitoring();
      if (capability.mode !== 'studio') await configureNativeTalkback(false);
      else if (nativeTalkbackActive || nativeTalkbackLatched) await configureNativeTalkback(true);
      applyMonitorState();
      prepareNativeGuideAudio().catch(err => setStatusWarn('Native guide prepare failed: ' + err.message));
      if (isPlaying) resyncPlaybackTargetsForCurrentTimeline().catch(() => {});
      updateNativeTalkbackButton();
    } else {
      els.audioEngineRoutingStatus.textContent = `${capability.label} unavailable`;
      markNativeDeviceClosed();
      setStatusWarn(response.result?.message || 'Selected device could not be opened.');
    }
  } catch (err) {
    els.audioEngineRoutingStatus.textContent = 'Open failed';
    markNativeDeviceClosed();
    setStatusError(`Native audio device open failed: ${err.message}`);
  } finally {
    setNativeAudioPanelBusy(false);
  }
}

async function openSelectedAudioEngineDiagnostic() {
  if (nativeAudioPanelBusy) return;
  const deviceId = els.audioEngineDeviceSelect.value;
  if (!deviceId) return;

  const device = nativeAudioDevices.find(d => d.deviceId === deviceId);
  setNativeAudioPanelBusy(true);
  els.audioEngineRoutingStatus.textContent = 'Opening diagnostic...';

  try {
    const response = await window.api.audioEngine.openDiagnosticDevice({
      deviceId,
      sampleRate: 48000,
      bufferSize: getSelectedNativeBufferSize(),
    });

    if (!response.success) {
      els.audioEngineRoutingStatus.textContent = 'Diagnostic failed';
      markNativeDeviceClosed();
      setStatusError(`Diagnostic audio open failed: ${response.error}`);
      return;
    }

    if (response.result?.ok) {
      els.audioEngineRoutingStatus.textContent = 'Diagnostic metering only';
      setStatusWarn(`Diagnostic metering opened: ${device?.name || deviceId}`);
      nativeDeviceOpen = true;
      nativeDeviceOpenMode = 'diagnostic';
      startNativeMetering();
      updateNativeRecordButtons(true);
      await configureNativeRouting();
      await configureNativeMonitoring();
      applyMonitorState();
      prepareNativeGuideAudio().catch(err => setStatusWarn('Native guide prepare failed: ' + err.message));
      if (isPlaying) resyncPlaybackTargetsForCurrentTimeline().catch(() => {});
      updateNativeTalkbackButton();
    } else {
      els.audioEngineRoutingStatus.textContent = 'Diagnostic unavailable';
      markNativeDeviceClosed();
      setStatusWarn(response.result?.message || 'Selected device could not be opened for diagnostic metering.');
    }
  } catch (err) {
    els.audioEngineRoutingStatus.textContent = 'Diagnostic failed';
    markNativeDeviceClosed();
    setStatusError(`Diagnostic audio open failed: ${err.message}`);
  } finally {
    setNativeAudioPanelBusy(false);
  }
}

async function reopenNativeDeviceForBufferChange() {
  if (!nativeDeviceOpen || !nativeDeviceOpenMode || nativeRecordingActive || nativeAudioPanelBusy) return;

  setStatusInfo(`Reopening native audio at ${getSelectedNativeBufferSize()} samples...`);
  if (nativeDeviceOpenMode === 'studio' || nativeDeviceOpenMode === 'compact') {
    await openSelectedAudioEngineDevice();
  } else {
    await openSelectedAudioEngineDiagnostic();
  }
}

function startNativeMetering() {
  stopNativeMetering();
  nativeMeterTimer = setInterval(refreshNativeMeters, 150);
  refreshNativeMeters();
}

function stopNativeMetering() {
  if (nativeMeterTimer) {
    clearInterval(nativeMeterTimer);
    nativeMeterTimer = null;
  }
  updateNativeMeterBars([0, 0]);
  els.audioEngineIoStatus.textContent = '—';
}

function markNativeDeviceClosed() {
  nativeDeviceOpen = false;
  nativeDeviceOpenMode = null;
  nativeRecordingActive = false;
  nativeTalkbackActive = false;
  _nativeLoopTakeContext = null;
  _clearNativeLoopStopTimer();
  stopNativeMetering();
  stopNativeGuidePlayback();
  stopReviewPlayback();
  stopGoodTakesPlayback();
  updateNativeRecordButtons(false);
  updateNativeTalkbackButton();
  applyMonitorState();
}

async function refreshNativeMeters() {
  if (nativeGuidePreparing) return;
  try {
    const result = await window.api.audioEngine.meterSnapshot();
    if (result.success) {
      const meters = result.meters || {};
      updateNativeMeterBars(meters.inputs || []);
      updateNativeIoStatus(meters);
      return;
    }
    const message = result.error || 'Native metering failed.';
    if (isAudioEngineLoss(message)) {
      handleNativeEngineLoss(message, 'metering');
      return;
    }
    stopNativeMetering();
    els.audioEngineIoStatus.textContent = 'Metering failed';
  } catch (err) {
    const message = err.message || 'Native metering failed.';
    if (isAudioEngineLoss(message)) {
      handleNativeEngineLoss(message, 'metering');
      return;
    }
    stopNativeMetering();
    els.audioEngineIoStatus.textContent = 'Metering failed';
  }
}

function updateNativeMeterBars(inputs) {
  const toPct = (value) => {
    const scaled = Math.sqrt(Math.max(0, Math.min(1, value || 0)));
    return `${Math.round(scaled * 100)}%`;
  };
  els.audioEngineMeterInput1.style.width = toPct(inputs[0]);
  els.audioEngineMeterInput2.style.width = toPct(inputs[1]);
}

function updateNativeIoStatus(meters) {
  const callbacks = Math.floor(meters.callbackCount || 0);
  const inputs = Math.floor(meters.lastInputChannelCount || 0);
  const outputs = Math.floor(meters.lastOutputChannelCount || 0);
  const buffer = Math.floor(meters.lastBufferSize || 0);
  els.audioEngineIoStatus.textContent = callbacks > 0
    ? `${inputs} in / ${outputs} out, ${buffer} samples, ${callbacks} cb`
    : 'No audio callbacks';
}

function updateNativeRecordButtons(deviceOpen) {
  const armedLanes = getArmedNativeRecordLanes();
  const canRecord = !!deviceOpen && !nativeRecordingActive && armedLanes.length > 0;
  els.btnNativeRecordStart.disabled = !canRecord;
  els.btnNativeRecordStop.disabled = !nativeRecordingActive;
  updateNativeLaneButtons();
}

function updateNativeTalkbackButton() {
  const physicalInput = Number(els.audioEngineTalkbackSource.value);
  const selectedCapability = getNativeDeviceCapability(getSelectedNativeDevice());
  const talkbackCapable = nativeDeviceOpenMode === 'studio' || (!nativeDeviceOpen && selectedCapability.mode === 'studio');
  const canTalk = nativeDeviceOpen && nativeDeviceOpenMode === 'studio' && Number.isInteger(physicalInput) && physicalInput >= 0;
  els.btnAudioEngineTalkback.disabled = !canTalk;
  els.audioEngineTalkbackSource.disabled = !talkbackCapable;
  if (!canTalk && nativeTalkbackActive) {
    nativeTalkbackActive = false;
    nativeTalkbackLatched = false;
  }
  els.btnAudioEngineTalkback.classList.toggle('active', nativeTalkbackActive);
  els.btnAudioEngineTalkback.classList.toggle('latched', nativeTalkbackLatched);
}

function isToggleButtonOn(button) {
  return button?.getAttribute('aria-pressed') === 'true';
}

function setToggleButton(button, enabled) {
  if (!button) return;
  button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  button.classList.toggle('active', !!enabled);
}

function toggleButton(button) {
  setToggleButton(button, !isToggleButtonOn(button));
}

function updateNativeLaneButtons() {
  [
    els.audioEngineMic1Arm,
    els.audioEngineMic2Arm,
    els.audioEngineMic1Monitor,
    els.audioEngineMic2Monitor,
  ].forEach(button => setToggleButton(button, isToggleButtonOn(button)));
}

function getNativeLaneLabel(laneId) {
  const input = laneId === 'mic2' ? els.audioEngineMic2Name : els.audioEngineMic1Name;
  return (input?.value || '').trim() || (laneId === 'mic2' ? 'Mic 2' : 'Mic 1');
}

function getArmedNativeRecordLanes() {
  const lanes = [
    {
      laneId: 'mic1',
      label: getNativeLaneLabel('mic1'),
      armed: isToggleButtonOn(els.audioEngineMic1Arm),
      physicalInput: Number(els.audioEngineMic1Source.value),
    },
    {
      laneId: 'mic2',
      label: getNativeLaneLabel('mic2'),
      armed: isToggleButtonOn(els.audioEngineMic2Arm),
      physicalInput: Number(els.audioEngineMic2Source.value),
    },
  ];

  return lanes.filter(lane => lane.armed && Number.isInteger(lane.physicalInput) && lane.physicalInput >= 0);
}

function getNativeMonitorLanes() {
  const lanes = [
    {
      laneId: 'mic1',
      label: getNativeLaneLabel('mic1'),
      enabled: isToggleButtonOn(els.audioEngineMic1Monitor),
      physicalInput: Number(els.audioEngineMic1Source.value),
      gain: 1.0,
    },
    {
      laneId: 'mic2',
      label: getNativeLaneLabel('mic2'),
      enabled: isToggleButtonOn(els.audioEngineMic2Monitor),
      physicalInput: Number(els.audioEngineMic2Source.value),
      gain: 1.0,
    },
  ];

  return lanes.filter(lane => lane.enabled && Number.isInteger(lane.physicalInput) && lane.physicalInput >= 0);
}

function getNativeOutputRouting() {
  return normalizeAudioOutputMap(getAudioOutputMapFromUI());
}

async function configureNativeRouting() {
  if (!nativeDeviceOpen) return;

  const outputs = getNativeOutputRouting();
  try {
    const response = await window.api.audioEngine.configureRouting({ outputs });
    const result = response.result || {};
    if (!response.success || !result.ok) {
      const message = result.message || response.error || 'Native output routing could not be configured.';
      if (isAudioEngineLoss(message)) {
        handleNativeEngineLoss(message, 'routing');
        return;
      }
      setStatusWarn(message);
      return;
    }
    renderAudioEngineRouteMap();
    if (isPlaying) {
      resyncPlaybackTargetsForCurrentTimeline().catch(() => {});
    }
  } catch (err) {
    if (isAudioEngineLoss(err.message)) {
      handleNativeEngineLoss(err.message, 'routing');
      return;
    }
    setStatusError('Native output routing failed: ' + err.message);
  }
}

async function configureNativeMonitoring() {
  if (!nativeDeviceOpen) return;

  const lanes = getNativeMonitorLanes();
  try {
    const response = await window.api.audioEngine.configureMonitoring({ lanes });
    const result = response.result || {};
    if (!response.success || !result.ok) {
      const message = result.message || response.error || 'Native monitoring could not be configured.';
      if (isAudioEngineLoss(message)) {
        handleNativeEngineLoss(message, 'monitoring');
        return;
      }
      setStatusWarn(message);
      return;
    }

    setStatusInfo(lanes.length
      ? `Native monitoring on: ${lanes.map(l => l.label).join(' + ')}`
      : 'Native monitoring off.');
  } catch (err) {
    if (isAudioEngineLoss(err.message)) {
      handleNativeEngineLoss(err.message, 'monitoring');
      return;
    }
    setStatusError('Native monitoring failed: ' + err.message);
  }
}

async function configureNativeTalkback(enabled) {
  if (nativeDeviceOpenMode !== 'studio') {
    nativeTalkbackActive = false;
    nativeTalkbackLatched = false;
    updateNativeTalkbackButton();
    if (nativeDeviceOpen) {
      window.api.audioEngine.configureTalkback({ enabled: false, physicalInput: -1, gain: 1.0 }).catch(() => {});
    }
    return;
  }

  nativeTalkbackActive = !!enabled;
  updateNativeTalkbackButton();

  if (!nativeDeviceOpen) return;

  const physicalInput = Number(els.audioEngineTalkbackSource.value);
  if (!Number.isInteger(physicalInput) || physicalInput < 0) {
    nativeTalkbackActive = false;
    updateNativeTalkbackButton();
    return;
  }

  try {
    const response = await window.api.audioEngine.configureTalkback({
      enabled: nativeTalkbackActive,
      physicalInput,
      gain: 1.0,
    });
    const result = response.result || {};
    if (!response.success || !result.ok) {
      const message = result.message || response.error || 'Talkback could not be configured.';
      if (isAudioEngineLoss(message)) {
        handleNativeEngineLoss(message, 'talkback');
        return;
      }
      setStatusWarn(message);
      return;
    }

    setStatusInfo(nativeTalkbackActive ? 'Talkback open.' : 'Talkback closed.');
  } catch (err) {
    if (isAudioEngineLoss(err.message)) {
      handleNativeEngineLoss(err.message, 'talkback');
      return;
    }
    setStatusError('Talkback failed: ' + err.message);
  }
}

async function startNativeInputRecording() {
  if (nativeRecordingActive) return;

  try {
    els.audioEngineRecordStatus.textContent = 'Starting...';
    els.btnNativeRecordStart.disabled = true;
    const lanes = getArmedNativeRecordLanes();
    if (!lanes.length) {
      els.audioEngineRecordStatus.textContent = 'Arm a mic lane first';
      updateNativeRecordButtons(nativeDeviceOpen);
      return;
    }

    const response = await window.api.audioEngine.startRecording({ lanes });
    const result = response.result || {};

    if (!response.success || !result.ok) {
      nativeRecordingActive = false;
      els.audioEngineRecordStatus.textContent = result.message || response.error || 'Start failed';
      updateNativeRecordButtons(true);
      return;
    }

    nativeRecordingActive = true;
    els.audioEngineRecordStatus.textContent = `Recording ${lanes.map(l => l.label).join(' + ')}...`;
    updateNativeRecordButtons(true);
    setStatusOk('Native WAV recording started.');
  } catch (err) {
    nativeRecordingActive = false;
    els.audioEngineRecordStatus.textContent = 'Start failed';
    updateNativeRecordButtons(true);
    setStatusError('Native recording failed: ' + err.message);
  }
}

async function stopNativeInputRecording() {
  if (!nativeRecordingActive) return;

  try {
    els.audioEngineRecordStatus.textContent = 'Stopping...';
    els.btnNativeRecordStop.disabled = true;
    const response = await window.api.audioEngine.stopRecording();
    const result = response.result || {};
    nativeRecordingActive = false;
    updateNativeRecordButtons(true);

    if (!response.success || !result.ok) {
      els.audioEngineRecordStatus.textContent = result.message || response.error || 'No samples';
      setStatusWarn('Native recording stopped without usable samples.');
      return;
    }

    const seconds = Number(result.durationSecs || 0);
    const fileCount = Array.isArray(result.files) ? result.files.length : 1;
    els.audioEngineRecordStatus.textContent = `${seconds.toFixed(1)}s, ${fileCount} WAV`;
    setStatusOk(`Native WAV recorded: ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  } catch (err) {
    nativeRecordingActive = false;
    els.audioEngineRecordStatus.textContent = 'Stop failed';
    updateNativeRecordButtons(true);
    setStatusError('Native recording stop failed: ' + err.message);
  }
}

function renderAudioEngineDevices(devices) {
  els.audioEngineDeviceList.textContent = '';

  if (!devices.length) {
    const empty = document.createElement('div');
    empty.className = 'field-value small';
    empty.textContent = 'No audio devices reported.';
    els.audioEngineDeviceList.appendChild(empty);
    return;
  }

  devices.forEach(device => {
    const item = document.createElement('div');
    item.className = 'audio-engine-device';
    if (device.isProfessionalRoutingCapable) item.classList.add('ready');

    const name = document.createElement('div');
    name.className = 'audio-engine-device-name';
    name.textContent = device.name || 'Unnamed device';

    const meta = document.createElement('div');
    meta.className = 'audio-engine-device-meta';
    const backendNote = device.backend === 'DirectSound'
      ? 'DirectSound diagnostic stereo driver'
      : (device.backend || 'Unknown');
    meta.textContent = `${backendNote} - ${device.inputChannelCount || 0} in / ${device.outputChannelCount || 0} out`;

    item.appendChild(name);
    item.appendChild(meta);
    els.audioEngineDeviceList.appendChild(item);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISPLAY-ONLY TIMECODE
// ═══════════════════════════════════════════════════════════════════════════════

function getFps() {
  const fr = currentProject?.settings?.frameRate || '25';
  if (fr.includes('/')) {
    const [n, d] = fr.split('/').map(Number);
    return d ? n / d : 25;
  }
  return parseFloat(fr) || 25;
}

function secondsToTC(t) {
  if (!isFinite(t) || t < 0) return '00:00:00:00';
  const fps = getFps();
  const nom = Math.round(fps);
  const tf  = Math.floor(t * fps);
  const ff  = tf % nom;
  const ss  = Math.floor(tf / nom) % 60;
  const mm  = Math.floor(tf / (nom * 60)) % 60;
  const hh  = Math.floor(tf / (nom * 3600));
  const sep = (fps > 29.9 && fps < 30.0) || (fps > 59.9 && fps < 60.0) ? ';' : ':';
  return [hh, mm, ss].map(v => String(v).padStart(2, '0')).join(':') +
         sep + String(ff).padStart(2, '0');
}

function secondsToFrames(t) { return Math.round(t * getFps()); }
function framesToSeconds(f) { const fps = getFps(); return fps > 0 ? f / fps : 0; }
function framesToTC(f)      { return secondsToTC(framesToSeconds(f)); }

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE SETTINGS (persisted in project.settings.workspace)
// ═══════════════════════════════════════════════════════════════════════════════

function loadWorkspaceSettings() {
  const saved = currentProject?.settings?.workspace || {};
  ws = {
    dialogueOverlayEnabled:  saved.dialogueOverlayEnabled  ?? wsDefaults.dialogueOverlayEnabled,
    dialogueOverlayColor:    saved.dialogueOverlayColor    ?? wsDefaults.dialogueOverlayColor,
    dialogueOverlayFontSize: saved.dialogueOverlayFontSize ?? wsDefaults.dialogueOverlayFontSize,
    cuePrerollEnabled:       saved.cuePrerollEnabled       ?? wsDefaults.cuePrerollEnabled,
    boothTimecodeEnabled:    saved.boothTimecodeEnabled    ?? wsDefaults.boothTimecodeEnabled,
    returnToStartOnStop:     saved.returnToStartOnStop     ?? wsDefaults.returnToStartOnStop,
    preparedBy:              saved.preparedBy              ?? wsDefaults.preparedBy,
    playbackVolume:          saved.playbackVolume          ?? wsDefaults.playbackVolume,
    cueBeepVolume:           saved.cueBeepVolume           ?? wsDefaults.cueBeepVolume,
    cueBeepType:             saved.cueBeepType             ?? wsDefaults.cueBeepType,
    recordingOffsetMs:       saved.recordingOffsetMs       ?? wsDefaults.recordingOffsetMs,
    recordMode:              saved.recordMode              ?? wsDefaults.recordMode,
    waveformHeightPx:        clampWaveformAreaHeight(saved.waveformHeightPx ?? wsDefaults.waveformHeightPx),
    audioOutputMap:          {
      ...wsDefaults.audioOutputMap,
      ...(saved.audioOutputMap || {}),
    },
    audioLaneNames:          {
      ...wsDefaults.audioLaneNames,
      ...(saved.audioLaneNames || {}),
    },
    nativeAudioSetup:        {
      ...wsDefaults.nativeAudioSetup,
      ...(saved.nativeAudioSetup || {}),
      micSources: {
        ...wsDefaults.nativeAudioSetup.micSources,
        ...(saved.nativeAudioSetup?.micSources || {}),
      },
      micArmed: {
        ...wsDefaults.nativeAudioSetup.micArmed,
        ...(saved.nativeAudioSetup?.micArmed || {}),
      },
      micMonitoring: {
        ...wsDefaults.nativeAudioSetup.micMonitoring,
        ...(saved.nativeAudioSetup?.micMonitoring || {}),
      },
    },
  };
  recordMode = ws.recordMode === 'punch-in' ? 'punch-in' : 'normal';
  applyWorkspaceSettingsToUI();
}

async function saveWorkspaceSettings({ persist = false } = {}) {
  if (!currentProject) return;
  if (!currentProject.settings) currentProject.settings = {};
  currentProject.settings.workspace = { ...ws };
  try {
    const result = await window.api.project.updateWorkspaceSettings({ ...ws }, { persist });
    if (result?.success && result.project) currentProject = result.project;
  } catch (err) {
    console.warn('[workspace] Could not sync workspace settings:', err.message);
  }
  // Written to disk on the next explicit project:save or autosave snapshot.
}

function getWaveformAreaMaxHeight() {
  const videoSectionHeight = els.videoSection?.getBoundingClientRect?.().height || window.innerHeight;
  const dynamicMax = Math.floor(videoSectionHeight * 0.45);
  return Math.max(WAVEFORM_AREA_MIN_HEIGHT, Math.min(WAVEFORM_AREA_MAX_HEIGHT, dynamicMax));
}

function clampWaveformAreaHeight(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return wsDefaults.waveformHeightPx;
  return Math.max(WAVEFORM_AREA_MIN_HEIGHT, Math.min(getWaveformAreaMaxHeight(), Math.round(numericValue)));
}

function applyWaveformAreaHeight(value) {
  const nextHeight = clampWaveformAreaHeight(value);
  ws.waveformHeightPx = nextHeight;
  document.documentElement.style.setProperty('--waveform-height', `${nextHeight}px`);
  els.timelineResizeHandle?.setAttribute('aria-valuenow', String(nextHeight));
  els.timelineResizeHandle?.setAttribute('aria-valuemax', String(getWaveformAreaMaxHeight()));
  if (peakData) renderAll();
}

function getRecordingOffsetMs() {
  const value = Number(ws.recordingOffsetMs || 0);
  return Number.isFinite(value) ? Math.max(-1000, Math.min(1000, value)) : 0;
}

function getRecordingOffsetMsFromInput() {
  const value = Number(els.audioEngineRecordingOffsetMs?.value || 0);
  return Number.isFinite(value) ? Math.round(Math.max(-1000, Math.min(1000, value))) : 0;
}

function getRecordingStartOffsetSecs() {
  return getRecordingOffsetMs() / 1000;
}

function normalizeAudioOutputMap(map = ws.audioOutputMap) {
  const defaults = wsDefaults.audioOutputMap;
  const normalize = (key) => {
    const value = Number(map?.[key]);
    if (Number.isInteger(value) && value >= -1) return value;
    return defaults[key];
  };
  return {
    controlLeft: normalize('controlLeft'),
    controlRight: normalize('controlRight'),
    boothLeft: normalize('boothLeft'),
    boothRight: normalize('boothRight'),
  };
}

function getAudioOutputMapFromUI() {
  const pairFrom = (selectEl, fallbackLeft) => {
    const value = Number(selectEl?.value);
    if (Number.isInteger(value) && value >= -1) return value;
    return fallbackLeft;
  };
  const controlLeft = pairFrom(els.audioEngineControlOutputPair, wsDefaults.audioOutputMap.controlLeft);
  const boothLeft = pairFrom(els.audioEngineBoothOutputPair, wsDefaults.audioOutputMap.boothLeft);
  return {
    controlLeft,
    controlRight: controlLeft >= 0 ? controlLeft + 1 : -1,
    boothLeft,
    boothRight: boothLeft >= 0 ? boothLeft + 1 : -1,
  };
}

function getLiveAudioOutputMap() {
  if (els.audioEngineControlOutputPair && els.audioEngineBoothOutputPair) {
    return getAudioOutputMapFromUI();
  }
  return normalizeAudioOutputMap();
}

function updateRecordingOffsetFeedback() {
  if (!els.audioEngineRecordingOffsetFeedback) return;
  els.audioEngineRecordingOffsetFeedback.textContent = `${getRecordingOffsetMs()}ms recording offset applied`;
}

function applyWorkspaceSettingsToUI() {
  els.settingPrerollEnabled.checked = ws.cuePrerollEnabled;
  els.settingOverlayEnabled.checked = ws.dialogueOverlayEnabled;
  els.settingBoothTcEnabled.checked = ws.boothTimecodeEnabled;
  updateOverlaySubSettingsVisibility();
  els.overlayColorPicker.querySelectorAll('.color-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === ws.dialogueOverlayColor);
  });
  els.overlayFontSize.querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === ws.dialogueOverlayFontSize);
  });
  // Volume sliders
  els.settingPlaybackVolume.value  = ws.playbackVolume;
  if (els.waveformVideoVolume) els.waveformVideoVolume.value = ws.playbackVolume;
  applyWaveformAreaHeight(ws.waveformHeightPx);
  els.settingPlaybackVolPct.textContent = Math.round(ws.playbackVolume * 100) + '%';
  els.settingBeepVolume.value      = ws.cueBeepVolume;
  els.settingBeepVolPct.textContent = Math.round(ws.cueBeepVolume * 100) + '%';
  if (els.beepTypeSelect) els.beepTypeSelect.value = ws.cueBeepType;
  if (els.beepModalVolume) els.beepModalVolume.value = ws.cueBeepVolume;
  if (els.audioEngineRecordingOffsetMs) els.audioEngineRecordingOffsetMs.value = ws.recordingOffsetMs;
  updateRecordingOffsetFeedback();
  updateRecordButton();
  if (els.audioEngineBufferSize) {
    const savedBufferSize = Number(ws.nativeAudioSetup?.bufferSize);
    els.audioEngineBufferSize.value = [64, 128, 256, 512].includes(savedBufferSize) ? String(savedBufferSize) : '128';
  }
  if (els.audioEngineDeviceSelect && ws.nativeAudioSetup?.deviceId) {
    const hasSavedDevice = [...els.audioEngineDeviceSelect.options].some(option => option.value === ws.nativeAudioSetup.deviceId);
    if (hasSavedDevice) els.audioEngineDeviceSelect.value = ws.nativeAudioSetup.deviceId;
  } else if (els.audioEngineDeviceSelect) {
    els.audioEngineDeviceSelect.value = '';
  }
  renderNativeLaneSourceOptions(getSelectedNativeDevice());
  renderNativeOutputOptions(getSelectedNativeDevice());
  setToggleButton(els.audioEngineMic1Arm, !!ws.nativeAudioSetup?.micArmed?.mic1);
  setToggleButton(els.audioEngineMic2Arm, !!ws.nativeAudioSetup?.micArmed?.mic2);
  setToggleButton(els.audioEngineMic1Monitor, !!ws.nativeAudioSetup?.micMonitoring?.mic1);
  setToggleButton(els.audioEngineMic2Monitor, !!ws.nativeAudioSetup?.micMonitoring?.mic2);
  els.audioEngineMic1Name.value = ws.audioLaneNames?.mic1 || wsDefaults.audioLaneNames.mic1;
  els.audioEngineMic2Name.value = ws.audioLaneNames?.mic2 || wsDefaults.audioLaneNames.mic2;
  updateNativeRecordButtons(nativeDeviceOpen);
  updateNativeTalkbackButton();
  updateCompactPlaybackButtons();
  applyMonitorState();
  updateDialogueOverlay();
}

function updateCompactPlaybackButtons() {
  els.btnBoothTcToggle?.classList.toggle('active', ws.boothTimecodeEnabled);
  els.btnPrerollToggle?.classList.toggle('active', ws.cuePrerollEnabled);
  els.btnGoodTakesPlayback?.classList.toggle('active', goodTakesPlaybackEnabled);
  if (els.btnGoodTakesPlayback) {
    els.btnGoodTakesPlayback.title = goodTakesPlaybackEnabled
      ? 'Good takes context playback on: selected good takes from all cues can play, including overlaps'
      : 'Play selected good takes from all cues in timeline context';
  }
  updateLoopButton();
  els.btnDialogueOverlayToggle?.classList.toggle('active', ws.dialogueOverlayEnabled);
  els.btnBeepToggle?.classList.toggle('active', ws.cueBeepVolume > 0);
  els.dxOverlayInline?.classList.toggle('hidden', !ws.dialogueOverlayEnabled);
  els.dxOverlayInline?.querySelectorAll('.dx-color-dot').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === ws.dialogueOverlayColor);
  });
  els.dxOverlayInline?.querySelectorAll('.dx-size-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === ws.dialogueOverlayFontSize);
  });
}

function setPlaybackVolume(value, { persist = true } = {}) {
  const v = Math.max(0, Math.min(1, Number(value)));
  if (!Number.isFinite(v)) return;
  ws.playbackVolume = v;
  els.settingPlaybackVolume.value = v;
  if (els.waveformVideoVolume) els.waveformVideoVolume.value = v;
  els.settingPlaybackVolPct.textContent = Math.round(v * 100) + '%';
  applyMonitorState();
  if (isPlaying) syncNativeGuidePlayback(els.videoPlayer.currentTime || 0, true).catch(() => {});
  if (persist) {
    saveWorkspaceSettings();
    markUnsaved();
  }
}

function hasAnySoloedTrack() {
  return videoTrackSoloed || takesTrackSoloed;
}

function isVideoTrackAudible() {
  return !videoTrackMuted && (!hasAnySoloedTrack() || videoTrackSoloed);
}

function isTakesTrackAudible() {
  return !takesTrackMuted && (!hasAnySoloedTrack() || takesTrackSoloed);
}

function getGuideAudioState() {
  if (!isVideoTrackAudible()) {
    return { mode: 'muted', text: 'Guide: Muted', title: 'Video/guide audio is muted by M/S state.' };
  }

  if (!nativeDeviceOpen) {
    return { mode: 'fallback', text: 'Guide: Browser', title: 'Native audio is not open. Video guide audio is playing through Electron/browser audio.' };
  }

  const target = getNativeGuidePlaybackTarget();
  if (target === 'none') {
    return { mode: 'silent', text: 'Guide: Silent', title: 'No Control or Booth output is assigned, so guide audio is intentionally silent.' };
  }

  if (!guideAudioPath) {
    return { mode: 'fallback', text: 'Guide: Browser', title: 'Generate waveform once to create guide_audio.wav and enable native-routed guide audio.' };
  }
  if (nativeGuidePreparing) {
    return { mode: 'fallback', text: 'Guide: Preparing', title: 'Preparing guide audio in the native engine.' };
  }
  if (nativeGuidePreparedPath !== guideAudioPath) {
    return { mode: 'fallback', text: 'Guide: Browser', title: 'Guide audio exists but is not prepared in the native engine yet.' };
  }

  const targetLabel = target === 'both' ? 'Control+Booth' : target === 'control' ? 'Control' : 'Booth';
  return { mode: 'native', text: `Guide: Native ${targetLabel}`, title: `Guide audio is playing through JUCE to ${targetLabel}.` };
}

function updateGuideAudioStatus() {
  if (!els.guideAudioStatus) return;
  const state = getGuideAudioState();
  els.guideAudioStatus.textContent = state.text;
  els.guideAudioStatus.title = state.title;
  els.guideAudioStatus.classList.remove('native', 'fallback', 'silent', 'muted');
  els.guideAudioStatus.classList.add(state.mode);
}

function applyMonitorState() {
  const nativeGuideReady = nativeDeviceOpen && !!guideAudioPath && nativeGuidePreparedPath === guideAudioPath;
  const nativeGuideTarget = nativeDeviceOpen ? getNativeGuidePlaybackTarget() : 'browser';
  const allowBrowserGuide = !nativeGuideReady && nativeGuideTarget !== 'none';
  els.videoPlayer.volume = (allowBrowserGuide && isVideoTrackAudible()) ? ws.playbackVolume : 0;
  els.videoPlayer.muted = !allowBrowserGuide;
  if (!isVideoTrackAudible()) stopNativeGuidePlayback();
  if (reviewAudio) reviewAudio.muted = !isTakesTrackAudible();
  for (const entry of goodTakeAudioPlayers.values()) {
    if (entry.audio) entry.audio.muted = !isTakesTrackAudible();
  }
  updateMonitorButtons();
  updateGuideAudioStatus();
}

function updateMonitorButtons() {
  els.videoTrackMute?.classList.toggle('active', videoTrackMuted);
  els.videoTrackSolo?.classList.toggle('active', videoTrackSoloed);

  const takesMute = document.getElementById('takes-track-mute');
  const takesSolo = document.getElementById('takes-track-solo');
  takesMute?.classList.toggle('active', takesTrackMuted);
  takesSolo?.classList.toggle('active', takesTrackSoloed);
}

function updateOverlaySubSettingsVisibility() {
  els.overlaySubSettings.style.display = ws.dialogueOverlayEnabled ? '' : 'none';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIALOGUE OVERLAY
// ═══════════════════════════════════════════════════════════════════════════════

function updateDialogueOverlay() {
  if (!ws.dialogueOverlayEnabled || !selectedCueId) {
    els.dialogueOverlay.classList.add('hidden');
    return;
  }
  const cue  = currentProject?.cues?.find(c => c.cueId === selectedCueId);
  const text = cue?.dialogue?.trim() || '';
  if (!text) { els.dialogueOverlay.classList.add('hidden'); return; }

  els.dialogueOverlayText.style.color = ws.dialogueOverlayColor;
  els.dialogueOverlay.classList.remove('size-small', 'size-medium', 'size-large');
  els.dialogueOverlay.classList.add(`size-${ws.dialogueOverlayFontSize}`);
  els.dialogueOverlayText.textContent = text;
  els.dialogueOverlay.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUE PRE-ROLL (fires ONLY from _startTakePass, never from togglePlay)
// ═══════════════════════════════════════════════════════════════════════════════

function scheduleBeep(ctx, startTime, freq, dur, vol) {
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(vol, startTime + 0.005);
  gain.gain.setValueAtTime(vol, startTime + dur - 0.01);
  gain.gain.linearRampToValueAtTime(0, startTime + dur);
  osc.start(startTime);
  osc.stop(startTime + dur + 0.01);
  return osc;   // returned so caller can stop() it early if cancelled
}

function setPrerollDot(dotIndex) {
  [els.prerollDot1, els.prerollDot2, els.prerollDot3].forEach((d, i) => {
    d.classList.toggle('lit', i === dotIndex);
  });
}

function cancelPreroll() {
  isPrerolling = false;
  prerollTimers.forEach(t => clearTimeout(t));
  prerollTimers = [];
  // Immediately silence any scheduled oscillator nodes from the last runPreroll call.
  // Without this, Web Audio scheduled beeps keep sounding until their stop() time
  // even after the visual countdown is cancelled.
  prerollOscillators.forEach(osc => {
    try { osc.stop(); } catch (_) { /* already stopped — safe to ignore */ }
  });
  prerollOscillators = [];
  nativePrerollToneIds.forEach(toneId => {
    window.api.audioEngine.stopTone({ toneId }).catch(() => {});
  });
  nativePrerollToneIds = [];
  els.prerollDots.classList.add('hidden');
  setPrerollDot(-1);
}

function runPreroll(onComplete) {
  cancelPreroll();
  isPrerolling = true;

  const nativeBeepTarget = getNativePrerollTarget();
  const useNativeBeeps = nativeDeviceOpen && nativeBeepTarget !== 'none';
  const useBrowserBeeps = !nativeDeviceOpen && nativeBeepTarget !== 'none';
  const ctx = useBrowserBeeps ? getAudioCtx() : null;
  const now = ctx ? ctx.currentTime + 0.05 : 0;

  els.prerollDots.classList.remove('hidden');
  setPrerollDot(-1);

  for (let i = 0; i < PREROLL_BEATS; i++) {
    const duration = ws.cueBeepType === 'click' ? 0.035 : BEEP_DURATION_SEC;
    const freq = ws.cueBeepType === 'click' ? 1800 : BEEP_FREQ_HZ;
    if (useNativeBeeps) {
      const toneId = `preroll:${Date.now()}:${i}`;
      nativePrerollToneIds.push(toneId);
      window.api.audioEngine.scheduleTone({
        toneId,
        delaySeconds: 0.05 + i * PREROLL_BEAT_SEC,
        frequencyHz: freq,
        durationSeconds: duration,
        gain: ws.cueBeepVolume,
        target: nativeBeepTarget,
      }).catch(err => setStatusWarn('Native beep failed: ' + err.message));
    } else if (useBrowserBeeps) {
      const osc = scheduleBeep(ctx, now + i * PREROLL_BEAT_SEC, freq, duration, ws.cueBeepVolume);
      prerollOscillators.push(osc);
    }
  }

  for (let i = 0; i < PREROLL_BEATS; i++) {
    const dotIndex = i;
    const t = setTimeout(() => {
      if (!isPrerolling) return;
      setPrerollDot(dotIndex);
      boothSend({ type: 'cueCountdownTick', dotIndex });
    }, i * PREROLL_BEAT_SEC * 1000);
    prerollTimers.push(t);
  }

  prerollTimers.push(setTimeout(() => {
    if (!isPrerolling) return;
    setPrerollDot(-1);
    boothSend({ type: 'cueCountdownTick', dotIndex: -1 });
  }, PREROLL_BEATS * PREROLL_BEAT_SEC * 1000 - 100));

  prerollTimers.push(setTimeout(() => {
    if (!isPrerolling) return;
    isPrerolling = false;
    els.prerollDots.classList.add('hidden');
    setPrerollDot(-1);
    console.log('[R3a-DIAG] CHECKPOINT 1: COUNTDOWN COMPLETE — calling onComplete()');
    setStatusInfo('[DIAG] COUNTDOWN COMPLETE');
    onComplete();
  }, PREROLL_TOTAL_SEC * 1000));
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a PREP pass — first pass of a loop cycle.
 * Plays immediately from cue In. No beep. No countdown.
 * Booth receives cuePlaybackStart.
 */
function _startPrepPass() {
  if (regionInFrames === null || regionOutFrames === null) return;
  const inSec = framesToSeconds(regionInFrames);
  _setTransportState('PREP_PASS');
  startSyncedVideoAt(inSec, ['PREP_PASS']).catch(err => {
    if (transportState === 'PREP_PASS') setStatusWarn('Booth sync start warning: ' + err.message);
  });
}

/**
 * Start a TAKE pass — any pass after the prep pass.
 * If preroll is enabled: pauses video, sends booth countdown messages,
 * runs beep sequence, then plays. Otherwise plays immediately.
 * Booth receives identical messages to before.
 */
function _startTakePass() {
  setStatusInfo('[DIAG] START TAKE PASS — audioInputReady=' + audioInputReady + ' _audioWorkletNode=' + !!_audioWorkletNode);
  console.log('[DIAG] _startTakePass entered. audioInputReady=', audioInputReady, '_audioWorkletNode=', !!_audioWorkletNode, 'transportState=', transportState);
  if (regionInFrames === null || regionOutFrames === null) return;
  const inSec           = framesToSeconds(regionInFrames);
  const cueOutSecs      = framesToSeconds(regionOutFrames);
  const cueDurationSecs = cueOutSecs - inSec;

  if (ws.cuePrerollEnabled) {
    _setTransportState('COUNTDOWN');
    els.videoPlayer.pause();
    els.videoPlayer.currentTime = inSec;
    setPlaybackState(false);
    boothSend({ type: 'cuePlaybackStop', currentTime: inSec });
    boothSend({ type: 'cueCountdownStart' });
    runPreroll(() => {
      console.log('[DIAG] COUNTDOWN COMPLETE — onComplete fired. audioInputReady=', audioInputReady, '_audioWorkletNode=', !!_audioWorkletNode);
      setStatusInfo('[DIAG] COUNTDOWN COMPLETE');
      if (nativeDeviceOpen && getArmedNativeRecordLanes().length > 0) {
        _beginNativeRecordingTake(cueOutSecs, cueDurationSecs).catch(err => {
          console.error('[native-recording] _beginNativeRecordingTake rejected:', err);
          _stopCompLoopAfterRecordingError('Native recording failed to start: ' + err.message);
        });
      } else if (audioInputReady && _audioWorkletNode) {
        console.log('[DIAG] → recording path taken');
        _beginRecordingTake(cueOutSecs, cueDurationSecs).catch(err => {
          console.error('[DIAG] _beginRecordingTake rejected:', err);
          setStatusError('Recording failed to start: ' + err.message);
          _abortCurrentTake();
        });
      } else {
        console.log('[DIAG] → preview-only path taken (no device or no worklet)');
        if (nativeDeviceOpen) {
          _stopCompLoopAfterRecordingError('Arm at least one native mic lane before loop recording.');
          return;
        }
        setStatusInfo('[DIAG] PREVIEW-ONLY PASS (no device)');
        _setTransportState('TAKE_PASS');
        startSyncedVideoAt(inSec, ['TAKE_PASS']).catch(err => setStatusWarn('Booth sync start warning: ' + err.message));
      }
    });
  } else {
    if (nativeDeviceOpen && getArmedNativeRecordLanes().length > 0) {
      _beginNativeRecordingTake(cueOutSecs, cueDurationSecs).catch(err => {
        console.error('[native-recording] _beginNativeRecordingTake rejected:', err);
        _stopCompLoopAfterRecordingError('Native recording failed to start: ' + err.message);
      });
    } else if (audioInputReady && _audioWorkletNode) {
      _beginRecordingTake(cueOutSecs, cueDurationSecs).catch(console.error);
    } else {
      if (nativeDeviceOpen) {
        _stopCompLoopAfterRecordingError('Arm at least one native mic lane before loop recording.');
        return;
      }
      _setTransportState('TAKE_PASS');
      startSyncedVideoAt(inSec, ['TAKE_PASS']).catch(err => setStatusWarn('Booth sync start warning: ' + err.message));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEWPORT MODEL
// ═══════════════════════════════════════════════════════════════════════════════

function getTotalDuration() { return peakData?.durationSeconds || 0; }

function getViewWindow() {
  const dur = getTotalDuration();
  if (!dur) return 1;
  if (viewWindow === null) return dur;
  return Math.min(viewWindow, dur);
}

function clampViewStart(vs) {
  const dur = getTotalDuration();
  const win = getViewWindow();
  return Math.max(0, Math.min(vs, Math.max(0, dur - win)));
}

function secondsToViewX(t) {
  const win = getViewWindow();
  if (win <= 0 || canvasWidth <= 0) return 0;
  return ((t - viewStart) / win) * canvasWidth;
}

function viewXToSeconds(px) {
  const win = getViewWindow();
  if (canvasWidth <= 0) return viewStart;
  return viewStart + (px / canvasWidth) * win;
}

// ── Zoom ──────────────────────────────────────────────────────────────────────

function applyZoom(newIndex, focalSeconds, focalRatio = 0.5) {
  if (!peakData) return;
  const dur = getTotalDuration();
  zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, newIndex));
  const level = ZOOM_LEVELS[zoomIndex];
  viewWindow = (level.seconds !== null) ? Math.min(level.seconds, dur) : null;
  const win = getViewWindow();
  viewStart = focalSeconds != null
    ? clampViewStart(focalSeconds - win * focalRatio)
    : clampViewStart(viewStart);
  updateZoomUI();
  renderAll();
}

function zoomIn(focalSec, focalRatio = 0.5) {
  if (focalSec == null) focalSec = els.videoPlayer.currentTime || 0;
  applyZoom(zoomIndex + 1, focalSec, focalRatio);
}
function zoomOut(focalSec, focalRatio = 0.5) {
  if (focalSec == null) focalSec = els.videoPlayer.currentTime || 0;
  applyZoom(zoomIndex - 1, focalSec, focalRatio);
}
function fitProject() {
  zoomIndex = 0; viewWindow = null; viewStart = 0;
  updateZoomUI(); renderAll();
}

function zoomToSelection() {
  if (regionInFrames === null || regionOutFrames === null) return;
  const dur  = getTotalDuration();
  const inS  = framesToSeconds(regionInFrames);
  const span = framesToSeconds(regionOutFrames) - inS;
  if (span <= 0) return;
  const winS = span * 1.2;
  let bestIdx = 0;
  for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
    const lvlSec = ZOOM_LEVELS[i].seconds !== null ? ZOOM_LEVELS[i].seconds : dur;
    if (lvlSec >= winS) { bestIdx = i; break; }
  }
  zoomIndex  = bestIdx;
  viewWindow = ZOOM_LEVELS[bestIdx].seconds !== null ? Math.min(ZOOM_LEVELS[bestIdx].seconds, dur) : null;
  const win  = getViewWindow();
  viewStart  = clampViewStart(inS + span / 2 - win / 2);
  updateZoomUI(); renderAll();
}

function panBy(deltaSec) { viewStart = clampViewStart(viewStart + deltaSec); renderAll(); }

let _zoomBtnEls = [];
function buildZoomLevelButtons() {
  els.zoomLevelStrip.innerHTML = '';
  _zoomBtnEls = [];
  ZOOM_LEVELS.forEach((lvl, i) => {
    const btn = document.createElement('button');
    btn.className   = 'zoom-level-btn';
    btn.textContent = lvl.label;
    btn.title       = lvl.seconds ? `Show ${lvl.label}` : 'Fit full project';
    btn.addEventListener('click', () => applyZoom(i, els.videoPlayer.currentTime || 0, 0.5));
    els.zoomLevelStrip.appendChild(btn);
    _zoomBtnEls.push(btn);
  });
}

function updateZoomUI() {
  _zoomBtnEls.forEach((btn, i) => btn.classList.toggle('active', i === zoomIndex));
  els.zoomLabelDisplay.textContent = ZOOM_LEVELS[zoomIndex].label;
  els.btnZoomIn.disabled  = !peakData || zoomIndex >= ZOOM_LEVELS.length - 1;
  els.btnZoomOut.disabled = !peakData || zoomIndex <= 0;
  updateScrollbar();
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

function renderAll() {
  renderWaveform();
  renderRuler();
  updatePlayheadPosition(els.videoPlayer.currentTime || 0);
  updateRegionHighlight();
  updateScrollbar();
}

function renderWaveform() {
  if (!peakData?.peaks?.length || canvasWidth === 0 || canvasHeight === 0) return;
  const canvas = els.waveformCanvas;
  const dpr    = window.devicePixelRatio || 1;
  canvas.width  = Math.floor(canvasWidth  * dpr);
  canvas.height = Math.floor(canvasHeight * dpr);
  const ctx  = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W    = canvasWidth, H = canvasHeight, midY = H / 2;
  const dur  = getTotalDuration(), win = getViewWindow();
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, W, H);
  const peaks = peakData.peaks, nPeaks = peaks.length;
  const startPeakF = (viewStart / dur) * nPeaks;
  const rangeF     = (win / dur) * nPeaks;
  for (let col = 0; col < W; col++) {
    const p0 = startPeakF + (col / W) * rangeF;
    const p1 = startPeakF + ((col + 1) / W) * rangeF;
    const i0 = Math.max(0, Math.floor(p0));
    const i1 = Math.min(nPeaks - 1, Math.ceil(p1));
    let maxPeak = 0;
    if (i1 >= i0) { for (let k = i0; k <= i1; k++) { if (peaks[k] > maxPeak) maxPeak = peaks[k]; } }
    else { maxPeak = peaks[i0] || 0; }
    const amp = maxPeak * midY * waveformVisualScale;
    ctx.fillStyle = `rgba(42,100,140,${0.45 + maxPeak * 0.55})`;
    ctx.fillRect(col, midY - amp, 1, amp * 2);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke();
}

function renderRuler() {
  if (!peakData || canvasWidth === 0) return;
  const canvas = els.timelineRuler;
  const dpr    = window.devicePixelRatio || 1;
  const rect   = canvas.getBoundingClientRect();
  canvas.width  = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height, win = getViewWindow();
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, W, H);
  if (!win || win <= 0) return;
  const pxPerSec = W / win;
  const IVS = [1/120,1/60,1/30,1/25,1/24,1/12,1/6,1/4,1/2,1,2,5,10,15,20,30,60,120,300,600,1800,3600];
  const maj  = IVS.find(iv => iv * pxPerSec >= 55) || IVS[IVS.length - 1];
  const majI = IVS.indexOf(maj);
  const min  = majI > 0 ? IVS[majI - 1] : maj;
  const viewEnd = viewStart + win;
  const fMaj = Math.ceil(viewStart / maj) * maj;
  const fMin = Math.ceil(viewStart / min) * min;
  ctx.font = `10px 'SF Mono', Consolas, monospace`;
  ctx.textBaseline = 'top';
  ctx.strokeStyle = '#232323'; ctx.lineWidth = 0.8;
  for (let t = fMin; t <= viewEnd + min; t += min) {
    const x = (t - viewStart) * pxPerSec;
    if (x < 0 || x > W) continue;
    ctx.beginPath(); ctx.moveTo(x, H * 0.6); ctx.lineTo(x, H); ctx.stroke();
  }
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
  for (let t = fMaj; t <= viewEnd + maj; t += maj) {
    const x = (t - viewStart) * pxPerSec;
    if (x < -2 || x > W + 2) continue;
    ctx.beginPath(); ctx.moveTo(x, H * 0.3); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillStyle = '#666';
    ctx.fillText(formatTimeLabel(t, maj), Math.max(2, x + 2), 2);
  }
}

function formatTimeLabel(t, iv) {
  if (iv < 1) {
    const ms = Math.round((t % 1) * 100), s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
    if (h > 0) return `${h}:${p2(m)}:${p2(s)}.${String(ms).padStart(2,'0')}`;
    if (m > 0) return `${m}:${p2(s)}.${String(ms).padStart(2,'0')}`;
    return `${s}.${String(ms).padStart(2,'0')}`;
  }
  if (iv < 60) {
    const s = Math.round(t) % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
    if (h > 0) return `${h}:${p2(m)}:${p2(s)}`;
    if (m > 0) return `${m}:${p2(s)}`;
    return `${s}s`;
  }
  const m = Math.round(t / 60) % 60, h = Math.floor(t / 3600);
  return h > 0 ? `${h}:${p2(m)}` : `${m}m`;
}
function p2(n) { return String(Math.floor(n)).padStart(2, '0'); }

function updatePlayheadPosition(t) {
  if (!peakData || canvasWidth === 0) return;
  els.playhead.style.left = `${secondsToViewX(t)}px`;
}

function updateRegionHighlight() {
  if (!peakData || canvasWidth === 0) {
    els.regionHighlight.style.display = 'none';
    els.markerIn.classList.add('hidden');
    if (els.streamerMarkerLayer) els.streamerMarkerLayer.innerHTML = '';
    els.markerOut.classList.add('hidden');
    els.infoRegionChip.classList.add('hidden');
    return;
  }
  const hasRegion = regionInFrames !== null && regionOutFrames !== null && regionOutFrames > regionInFrames;
  if (!hasRegion) {
    els.regionHighlight.style.display = 'none';
    els.markerIn.classList.add('hidden');
    if (els.streamerMarkerLayer) els.streamerMarkerLayer.innerHTML = '';
    els.markerOut.classList.add('hidden');
    els.infoRegionChip.classList.add('hidden');
    return;
  }
  const xIn  = secondsToViewX(framesToSeconds(regionInFrames));
  const xOut = secondsToViewX(framesToSeconds(regionOutFrames));
  els.regionHighlight.style.display = 'block';
  els.regionHighlight.style.left    = `${xIn}px`;
  els.regionHighlight.style.width   = `${Math.max(1, xOut - xIn)}px`;
  if (xIn >= -1 && xIn <= canvasWidth + 1) { els.markerIn.classList.remove('hidden'); els.markerIn.style.left = `${Math.max(0, xIn)}px`; }
  else { els.markerIn.classList.add('hidden'); }
  if (els.streamerMarkerLayer) {
    els.streamerMarkerLayer.innerHTML = '';
    const streamerFrames = getActiveStreamerTargetFrames();
    for (const streamerFrame of streamerFrames) {
      if (streamerFrame < regionInFrames || streamerFrame > regionOutFrames) continue;
      const xStreamer = secondsToViewX(framesToSeconds(streamerFrame));
      if (xStreamer < -1 || xStreamer > canvasWidth + 1) continue;
      const marker = document.createElement('div');
      marker.className = 'region-marker marker-streamer';
      marker.textContent = 'S';
      marker.style.left = `${Math.max(0, Math.min(canvasWidth, xStreamer))}px`;
      els.streamerMarkerLayer.appendChild(marker);
    }
  }
  if (xOut >= -1 && xOut <= canvasWidth + 1) { els.markerOut.classList.remove('hidden'); els.markerOut.style.left = `${Math.min(canvasWidth, xOut)}px`; }
  else { els.markerOut.classList.add('hidden'); }
  els.infoRegionChip.classList.remove('hidden');
  els.infoRegionIn.textContent  = framesToTC(regionInFrames);
  els.infoRegionOut.textContent = framesToTC(regionOutFrames);
  els.infoRegionDur.textContent = `${regionOutFrames - regionInFrames} f`;
}

function updateScrollbar() {
  if (!peakData) return;
  const dur = getTotalDuration(), win = getViewWindow();
  const thumbRatio = win / dur;
  const thumbW    = Math.max(20, Math.floor(thumbRatio * canvasWidth));
  const maxLeft   = canvasWidth - thumbW;
  const thumbLeft = dur > win ? Math.round((viewStart / (dur - win)) * maxLeft) : 0;
  els.timelineScrollbarThumb.style.width = `${thumbW}px`;
  els.timelineScrollbarThumb.style.left  = `${thumbLeft}px`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-SCROLL
// ═══════════════════════════════════════════════════════════════════════════════

function autoScrollToPlayhead(t) {
  if (!peakData || autoScrollPaused) return;
  const win = getViewWindow(), dur = getTotalDuration();
  if (win >= dur) return;
  const margin = win * 0.05, viewEnd = viewStart + win;
  if (t > viewEnd - margin) { viewStart = clampViewStart(t - win * 0.15); renderAll(); }
  else if (t < viewStart + margin) { viewStart = clampViewStart(t - win * 0.15); renderAll(); }
}

function pauseAutoScroll() {
  autoScrollPaused = true;
  clearTimeout(autoScrollPauseTimer);
  autoScrollPauseTimer = setTimeout(() => { autoScrollPaused = false; }, 2000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEEK
// ═══════════════════════════════════════════════════════════════════════════════

function seekToViewX(px) {
  if (!peakData) return;
  const t = Math.max(0, Math.min(getTotalDuration(), viewXToSeconds(px)));
  els.videoPlayer.currentTime = t;
  updatePlayheadPosition(t);
  const tc = secondsToTC(t);
  els.infoTimecode.textContent      = tc;
  els.transportTimecode.textContent = tc;
  if (isPlaying) syncNativeGuidePlayback(t, true).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIDEO PLAYER (display only)
// ═══════════════════════════════════════════════════════════════════════════════

function loadVideoInPlayer(videoSrc) {
  els.videoPlayer.src = videoSrc;
  applyMonitorState();
  els.videoPlayer.classList.remove('hidden');
  els.videoPlaceholder.classList.add('hidden');
  els.videoPlayer.addEventListener('timeupdate', onVideoTimeUpdate);
  els.videoPlayer.addEventListener('ended',      onVideoEnded);
  els.videoPlayer.addEventListener('error',      onVideoError);
  els.videoPlayer.addEventListener('play',       onVideoPlay);
  els.videoPlayer.addEventListener('pause',      onVideoPause);
  els.videoPlayer.load();
  els.btnPlay.disabled    = false;
  els.btnStop.disabled    = false;
  els.btnMarkIn.disabled  = false;
  els.btnMarkOut.disabled = false;
  // Notify booth of new video source — low frequency, called only on explicit load
  boothSend({ type: 'videoSource', src: videoSrc });
}

function unloadVideoPlayer() {
  cancelPreroll();
  stopPlayback();
  stopNativeGuidePlayback();
  guideAudioPath = null;
  nativeGuidePreparedPath = null;
  nativeGuidePreparing = false;
  nativeGuideMissingWarned = false;
  updateGuideAudioStatus();
  els.videoPlayer.removeEventListener('timeupdate', onVideoTimeUpdate);
  els.videoPlayer.removeEventListener('ended',      onVideoEnded);
  els.videoPlayer.removeEventListener('error',      onVideoError);
  els.videoPlayer.removeEventListener('play',       onVideoPlay);
  els.videoPlayer.removeEventListener('pause',      onVideoPause);
  els.videoPlayer.src = '';
  els.videoPlayer.classList.add('hidden');
  els.videoPlaceholder.classList.remove('hidden');
  els.infoTimecode.textContent      = '--:--:--:--';
  els.transportTimecode.textContent = '00:00:00:00';
  els.btnPlay.disabled    = true;
  els.btnStop.disabled    = true;
  els.btnMarkIn.disabled  = true;
  els.btnMarkOut.disabled = true;
  els.btnLoop.disabled    = true;
}

function onVideoTimeUpdate() {
  const t  = els.videoPlayer.currentTime;
  const tc = secondsToTC(t);
  els.infoTimecode.textContent      = tc;
  els.transportTimecode.textContent = tc;
  updatePlayheadPosition(t);
  // Loop enforcement: advance to next pass when Out point is reached.
  // Only fires during active playing states — not during COUNTDOWN (video is paused).
  if ((transportState === 'PREP_PASS' || transportState === 'TAKE_PASS') &&
      regionInFrames !== null && regionOutFrames !== null) {
    if (secondsToFrames(t) >= regionOutFrames) _handleLoopBoundary();
  }
  if (transportState === 'RECORDING_TAKE' &&
      _nativeLoopTakeContext &&
      regionOutFrames !== null &&
      secondsToFrames(t) >= regionOutFrames) {
    _finishNativeRecordingTake().catch(err => {
      setStatusError('Native take stop failed: ' + err.message);
      _abortCurrentTake();
    });
  }
}

function onVideoEnded() {
  if ((transportState === 'PREP_PASS' || transportState === 'TAKE_PASS') &&
      regionInFrames !== null && regionOutFrames !== null) {
    _handleLoopBoundary();
  } else {
    setPlaybackState(false);
  }
}

function _handleLoopBoundary() {
  if (transportState === 'PREP_PASS') {
    _startTakePass();
    return;
  }

  if (transportState === 'TAKE_PASS') {
    _compTakeCount++;
    _continueOrEndComp();
  }
}

function onVideoError()  { setStatusError('Video playback error.'); cancelPreroll(); setPlaybackState(false); }
function onVideoPlay()   { setPlaybackState(true); }
function onVideoPause()  { if (transportState === 'PREVIEWING') setPlaybackState(false); }

function togglePlay() {
  if (!currentProject || els.videoPlayer.readyState < 1) return;

  if (recordArmed && !selectedCueId) {
    startPendingCueRecording().catch(err => {
      recordArmed = false;
      updateRecordButton();
      setStatusError('Pending recording failed to start: ' + err.message);
    });
    return;
  }

  if (transportState === 'PREVIEWING' ||
      transportState === 'PREP_PASS'  ||
      transportState === 'COUNTDOWN'  ||
      transportState === 'TAKE_PASS'  ||
      transportState === 'RECORDING_TAKE' ||
      transportState === 'PENDING_RECORDING') {
    // Spacebar = stop transport in any active state.
    // For RECORDING_TAKE: stopPlayback() aborts the take (keeps partial if valid).
    handleTransportStop();

  } else if (transportState === 'CUE_READY' || transportState === 'IDLE') {
    // Play = preview only. Never triggers loop/recording workflow.
    playbackStartPosition = els.videoPlayer.currentTime || 0;
    _setTransportState('PREVIEWING');
    if (selectedCueId) {
      startSyncedVideoAt(els.videoPlayer.currentTime || 0, ['PREVIEWING']).catch(err => setStatusWarn('Booth sync start warning: ' + err.message));
    } else {
      els.videoPlayer.play().catch(() => {});
    }
  }
}

function handleTransportStop() {
  if (transportState === 'PENDING_RECORDING') {
    finishPendingCueRecording().catch(err => {
      pendingCueRecording = null;
      nativeRecordingActive = false;
      _setTransportState('IDLE');
      setStatusError('Pending recording stop failed: ' + err.message);
    });
    return;
  }
  stopPlayback();
}

function stopPlayback() {
  transportActionGeneration++;
  if (!els.videoPlayer.src) return;
  if (transportState === 'PENDING_RECORDING' && pendingCueRecording) {
    window.api.audioEngine.stopRecording().catch(() => {});
    pendingCueRecording = null;
    nativeRecordingActive = false;
  }
  stopReviewPlayback();
  stopGoodTakesPlayback();
  // If a recording take is in progress, send 'abort' to the worklet so the
  // incomplete take is discarded. Operator-interrupted takes are not kept.
  // Only a scheduled completion at cue Out creates a take.
  // 'stop' (keep partial) is reserved for future explicit partial-keep workflows.
  if (transportState === 'RECORDING_TAKE' && _audioWorkletNode) {
    _stopRafSafety();
    _audioWorkletNode.port.postMessage({ type: 'abort' });
    _compTakeCount = 0;
    _audioWorkletNode = null;  // force re-init on next comp loop
  }
  if (transportState === 'RECORDING_TAKE' && _nativeLoopTakeContext) {
    window.api.audioEngine.stopRecording().catch(() => {});
    _nativeLoopTakeContext = null;
    nativeRecordingActive = false;
    _clearNativeLoopStopTimer();
  }
  cancelPreroll();
  els.videoPlayer.pause();
  if (ws.returnToStartOnStop) {
    const returnTime = playbackStartPosition ?? (regionInFrames !== null ? framesToSeconds(regionInFrames) : els.videoPlayer.currentTime || 0);
    els.videoPlayer.currentTime = returnTime;
  }
  playbackStartPosition = null;
  setPlaybackState(false);
  if (isLooping) { isLooping = false; updateLoopButton(); }
  _setTransportState(selectedCueId ? 'CUE_READY' : 'IDLE');
  boothSend({ type: 'cuePlaybackStop', currentTime: els.videoPlayer.currentTime });
  boothSend({ type: 'cueCountdownClear' });
}

function setPlaybackState(playing) {
  isPlaying = playing;
  if (!playing) {
    stopNativeGuidePlayback();
    stopReviewPlayback();
    stopGoodTakesPlayback();
  } else {
    syncNativeGuidePlayback(els.videoPlayer.currentTime || 0, true).catch(() => {});
  }
  els.playIcon.textContent  = '▶';
  els.playLabel.textContent = 'Play';
  els.btnPlay.classList.toggle('active', playing);
  playing ? startPlayheadRaf() : stopPlayheadRaf();
}

function startPlayheadRaf() {
  if (rafId) return;
  function tick() {
    if (!isPlaying) { rafId = null; return; }
    const t = els.videoPlayer.currentTime;
    updatePlayheadPosition(t);
    autoScrollToPlayhead(t);
    syncNativeGuidePlayback(t).catch(() => {});
    syncReviewPlayback(t).catch(() => {});
    syncGoodTakesPlayback(t).catch(() => {});
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
}
function stopPlayheadRaf() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

function stopReviewPlayback() {
  if (reviewAudio) {
    try { reviewAudio.pause(); } catch (_) {}
  }
  if (nativeReviewPlaybackId) {
    window.api.audioEngine.stopPlayback({ playbackId: nativeReviewPlaybackId }).catch(() => {});
  }
  reviewAudio = null;
  reviewAudioTakeId = null;
  reviewAudioLaneId = null;
  reviewAudioCueId = null;
  nativeReviewPlaybackId = null;
}

function stopGoodTakesPlayback() {
  for (const entry of goodTakeAudioPlayers.values()) {
    try { entry.audio?.pause(); } catch (_) {}
  }
  goodTakeAudioPlayers.clear();
  for (const playbackId of nativeGoodTakePlayback.keys()) {
    window.api.audioEngine.stopPlayback({ playbackId }).catch(() => {});
  }
  nativeGoodTakePlayback.clear();
}

function findCueAtSeconds(seconds) {
  if (!currentProject?.cues?.length) return null;
  const frame = secondsToFrames(seconds);
  if (selectedCueId) {
    const selectedCue = currentProject.cues.find(c => c.cueId === selectedCueId);
    if (selectedCue && frame >= selectedCue.inFrames && frame < selectedCue.outFrames) {
      return selectedCue;
    }
  }
  return currentProject.cues.find(c => frame >= c.inFrames && frame < c.outFrames) || null;
}

function findActiveAuditionCueAtSeconds(seconds) {
  if (!currentProject || !activeAuditionTakeId) return null;
  const take = currentProject.takes?.find(t => t.takeId === activeAuditionTakeId) || null;
  if (!take) return null;
  const cue = currentProject.cues?.find(c => c.cueId === take.cueId) || null;
  if (!cue) return null;
  const frame = secondsToFrames(seconds);
  return frame >= cue.inFrames && frame < cue.outFrames ? cue : null;
}

function clearAuditionIfOutsideCue(cueId) {
  if (!activeAuditionTakeId || !currentProject) return;
  const take = currentProject.takes?.find(t => t.takeId === activeAuditionTakeId) || null;
  if (take?.cueId === cueId) return;
  stopReviewPlayback();
  activeAuditionTakeId = null;
  activeAuditionLaneId = null;
}

function getSelectedTakeForCue(cueId) {
  return currentProject?.takes?.find(t => t.cueId === cueId && t.isSelected) || null;
}

function getGoodTakePlaybackTrack(take) {
  // Context playback is one audible review lane per selected take.
  // If the operator has chosen an audition mic, use that lane for all
  // context playback where available; otherwise fall back predictably.
  return getTakeTrackForLane(take, activeAuditionLaneId || 'mic1');
}

function getGoodTakeContextCandidates(timelineSeconds) {
  if (!currentProject) return [];
  const frame = secondsToFrames(timelineSeconds);
  const candidates = [];
  const selectedTakes = (currentProject.takes || []).filter(take => take.isSelected);

  for (const take of selectedTakes) {
    const cue = currentProject.cues?.find(c => c.cueId === take.cueId);
    if (!cue || frame < cue.inFrames || frame >= cue.outFrames) continue;

    const track = getGoodTakePlaybackTrack(take);
    if (!track?.filePath) continue;

    const cueInSeconds = framesToSeconds(cue.inFrames);
    const takeStart = cueInSeconds + getRecordingStartOffsetSecs();
    if (timelineSeconds < takeStart) continue;

    const offset = Math.max(0, timelineSeconds - takeStart);
    const duration = Number(track.durationSecs || take.durationSecs || 0);
    if (duration > 0 && offset > duration + 0.1) continue;

    candidates.push({ take, cue, track, offset });
  }

  return candidates;
}

function getTakeTrackForLane(take, laneId) {
  const tracks = Array.isArray(take?.tracks) ? take.tracks : [];
  return tracks.find(track => track.laneId === laneId)
      || tracks[0]
      || { laneId: 'mic1', label: 'Mic 1', filePath: take?.filePath };
}

async function resolveReviewFileUrl(filePath) {
  if (!filePath) return null;
  if (reviewUrlCache.has(filePath)) return reviewUrlCache.get(filePath);
  const result = await window.api.media.resolveFileUrl(filePath);
  if (!result.success) throw new Error(result.error || 'Could not resolve review file.');
  reviewUrlCache.set(filePath, result.fileUrl);
  return result.fileUrl;
}

function getNativePlaybackTarget() {
  const outputMap = getLiveAudioOutputMap();
  if (outputMap.controlLeft >= 0 && outputMap.controlRight >= 0) return 'control';
  if (outputMap.boothLeft >= 0 && outputMap.boothRight >= 0) return 'booth';
  return 'none';
}

function getNativeSharedCueTarget() {
  const outputMap = getLiveAudioOutputMap();
  const hasControl = outputMap.controlLeft >= 0 && outputMap.controlRight >= 0;
  const hasBooth = outputMap.boothLeft >= 0 && outputMap.boothRight >= 0;
  if (hasControl && hasBooth) return 'both';
  if (hasControl) return 'control';
  if (hasBooth) return 'booth';
  return 'none';
}

function getNativeGuidePlaybackTarget() {
  // Guide is shared cueing material for both operator and actor whenever both
  // routes exist. If only one route is assigned, follow the remaining route.
  return getNativeSharedCueTarget();
}

function getNativePrerollTarget() {
  // Beeps/countdown belong to the cueing feed, so they follow guide routing.
  return getNativeSharedCueTarget();
}

function getNativeTakeReviewTarget() {
  // Audition and selected-good playback are review material tied to the cueing
  // experience, so they intentionally follow the same routing policy as guide.
  return getNativeSharedCueTarget();
}

function getNativeGoodTakeContextTarget() {
  return getNativeTakeReviewTarget();
}

function stopNativeGuidePlayback() {
  if (!nativeGuidePlaybackId) return;
  window.api.audioEngine.stopPlayback({ playbackId: nativeGuidePlaybackId }).catch(() => {});
  nativeGuidePlaybackId = null;
  nativeGuideStartOffset = 0;
  nativeGuideStartAtMs = 0;
  nativeGuidePendingRestart = false;
}

async function prepareNativeGuideAudio() {
  if (!nativeDeviceOpen || !guideAudioPath || nativeGuidePreparedPath === guideAudioPath || nativeGuidePreparing) return;
  nativeGuidePreparing = true;
  const wasMetering = !!nativeMeterTimer;
  if (wasMetering) stopNativeMetering();
  updateGuideAudioStatus();
  try {
    const response = await window.api.audioEngine.preparePlayback({ filePath: guideAudioPath });
    const result = response.result || {};
    if (!response.success || !result.ok) {
      const message = result.message || response.error || 'Native guide audio could not be prepared.';
      setStatusWarn(message);
      handleNativePlaybackFailure(message);
      return;
    }
    nativeGuidePreparedPath = guideAudioPath;
  } catch (err) {
    const message = err.message || 'Native guide audio could not be prepared.';
    setStatusWarn(message);
    handleNativePlaybackFailure(message);
  } finally {
    nativeGuidePreparing = false;
    if (wasMetering && nativeDeviceOpen) startNativeMetering();
    updateGuideAudioStatus();
  }
}

async function startNativeGuidePlayback(offsetSeconds) {
  if (nativeGuidePlaybackStarting) {
    nativeGuidePendingRestart = true;
    return false;
  }

  const target = getNativeGuidePlaybackTarget();
  if (!nativeDeviceOpen || target === 'none' || !isVideoTrackAudible()) {
    stopNativeGuidePlayback();
    return false;
  }
  if (!guideAudioPath) {
    stopNativeGuidePlayback();
    if (!nativeGuideMissingWarned) {
      nativeGuideMissingWarned = true;
      setStatusWarn('Generate waveform once to enable native-routed guide audio.');
    }
    return false;
  }
  if (nativeGuidePreparedPath !== guideAudioPath) {
    await prepareNativeGuideAudio();
    if (nativeGuidePreparedPath !== guideAudioPath) return false;
    if (isPlaying) offsetSeconds = els.videoPlayer.currentTime || offsetSeconds || 0;
  }

  const playbackId = 'guide:video';
  nativeGuidePlaybackStarting = true;
  nativeGuidePendingRestart = false;
  try {
    const response = await window.api.audioEngine.startPlayback({
      playbackId,
      filePath: guideAudioPath,
      offsetSeconds: Math.max(0, offsetSeconds || 0),
      gain: ws.playbackVolume,
      target,
    });
    const result = response.result || {};
    if (!response.success || !result.ok) {
      const message = result.message || response.error || 'Native guide audio could not start.';
      setStatusWarn(message);
      handleNativePlaybackFailure(message);
      stopNativeGuidePlayback();
      return false;
    }
    nativeGuidePlaybackId = playbackId;
    nativeGuideStartOffset = Math.max(0, offsetSeconds || 0);
    nativeGuideStartAtMs = performance.now();
    return true;
  } catch (err) {
    const message = err.message || 'Native guide audio could not start.';
    setStatusWarn(message);
    handleNativePlaybackFailure(message);
    return false;
  } finally {
    nativeGuidePlaybackStarting = false;
    if (nativeGuidePendingRestart && isPlaying) {
      const restartAt = els.videoPlayer.currentTime || offsetSeconds || 0;
      nativeGuidePendingRestart = false;
      startNativeGuidePlayback(restartAt).catch(() => {});
    }
  }
}

async function syncNativeGuidePlayback(timelineSeconds, force = false) {
  if (!nativeDeviceOpen) {
    stopNativeGuidePlayback();
    applyMonitorState();
    return;
  }

  const target = getNativeGuidePlaybackTarget();
  const nativeGuideReady = !!guideAudioPath && nativeGuidePreparedPath === guideAudioPath;
  const allowBrowserGuide = !nativeGuideReady && target !== 'none';
  els.videoPlayer.volume = (allowBrowserGuide && isVideoTrackAudible()) ? ws.playbackVolume : 0;
  els.videoPlayer.muted = !allowBrowserGuide;

  if (!isPlaying || !isVideoTrackAudible() || target === 'none') {
    stopNativeGuidePlayback();
    return;
  }
  if (!nativeGuideReady) {
    await startNativeGuidePlayback(timelineSeconds);
    return;
  }

  const elapsed = nativeGuidePlaybackId ? (performance.now() - nativeGuideStartAtMs) / 1000 : 0;
  const expected = nativeGuideStartOffset + elapsed;
  if (force || !nativeGuidePlaybackId || Math.abs(expected - timelineSeconds) > 0.15) {
    await startNativeGuidePlayback(timelineSeconds);
  }
}

async function startNativeTakePlayback({ playbackId, filePath, offset, target = getNativePlaybackTarget() }) {
  if (!nativeDeviceOpen || target === 'none') return false;
  try {
    const response = await window.api.audioEngine.startPlayback({
      playbackId,
      filePath,
      offsetSeconds: offset,
      gain: 1.0,
      target,
    });
    const result = response.result || {};
    if (!response.success || !result.ok) {
      const message = result.message || response.error || 'Native playback could not start.';
      setStatusWarn(message);
      handleNativePlaybackFailure(message);
      return false;
    }
    return true;
  } catch (err) {
    const message = err.message || 'Native playback could not start.';
    setStatusWarn(message);
    handleNativePlaybackFailure(message);
    return false;
  }
}

async function syncReviewPlayback(timelineSeconds) {
  if (!isPlaying || !currentProject) return;
  if (!activeAuditionTakeId || !activeAuditionLaneId || !isTakesTrackAudible()) {
    stopReviewPlayback();
    return;
  }
  const target = getNativeTakeReviewTarget();
  if (target === 'none') {
    stopReviewPlayback();
    return;
  }

  const cue = findActiveAuditionCueAtSeconds(timelineSeconds);
  if (!cue) { stopReviewPlayback(); return; }

  const take = currentProject.takes?.find(t => t.cueId === cue.cueId && t.takeId === activeAuditionTakeId) || null;
  if (!take) { stopReviewPlayback(); return; }

  const track = getTakeTrackForLane(take, activeAuditionLaneId);
  if (!track?.filePath) { stopReviewPlayback(); return; }

  const cueInSeconds = framesToSeconds(cue.inFrames);
  const takeStart = cueInSeconds + getRecordingStartOffsetSecs();
  if (timelineSeconds < takeStart) { stopReviewPlayback(); return; }
  const offset = Math.max(0, timelineSeconds - takeStart);
  const laneId = track.laneId || activeAuditionLaneId;
  const playbackId = `audition:${take.takeId}:${laneId}:offset:${getRecordingOffsetMs()}`;
  if (nativeDeviceOpen) {
    const sameNativeReview = nativeReviewPlaybackId === playbackId
      && reviewAudioTakeId === take.takeId
      && reviewAudioLaneId === laneId
      && reviewAudioCueId === cue.cueId;
    if (!sameNativeReview || Math.abs((reviewAudio?.currentTime || 0) - offset) > 0.12) {
      if (nativeReviewPlaybackId && nativeReviewPlaybackId !== playbackId) {
        window.api.audioEngine.stopPlayback({ playbackId: nativeReviewPlaybackId }).catch(() => {});
      }
      const ok = await startNativeTakePlayback({ playbackId, filePath: track.filePath, offset, target });
      if (!ok) return;
      nativeReviewPlaybackId = playbackId;
      reviewAudioTakeId = take.takeId;
      reviewAudioLaneId = laneId;
      reviewAudioCueId = cue.cueId;
      reviewAudio = { currentTime: offset, paused: false };
    } else if (reviewAudio) {
      reviewAudio.currentTime = offset;
    }
    return;
  }

  const sameReview = reviewAudio
    && reviewAudioTakeId === take.takeId
    && reviewAudioLaneId === laneId
    && reviewAudioCueId === cue.cueId;

  if (!sameReview) {
    stopReviewPlayback();
    const fileUrl = await resolveReviewFileUrl(track.filePath);
    if (!fileUrl) return;
    reviewAudio = new Audio(fileUrl);
    reviewAudio.muted = !isTakesTrackAudible();
    reviewAudioTakeId = take.takeId;
    reviewAudioLaneId = laneId;
    reviewAudioCueId = cue.cueId;
  }

  if (Math.abs((reviewAudio.currentTime || 0) - offset) > 0.12) {
    reviewAudio.currentTime = offset;
  }
  if (reviewAudio.paused) await reviewAudio.play();
}

async function syncGoodTakesPlayback(timelineSeconds) {
  if (!isPlaying || !currentProject || !goodTakesPlaybackEnabled || !isTakesTrackAudible()) {
    stopGoodTakesPlayback();
    return;
  }
  const target = getNativeGoodTakeContextTarget();
  if (target === 'none') {
    stopGoodTakesPlayback();
    return;
  }

  const activeKeys = new Set();
  const candidates = getGoodTakeContextCandidates(timelineSeconds);

  for (const { take, track, offset } of candidates) {
    const laneId = track.laneId || 'mic1';
    const key = `${take.takeId}:${laneId}:offset:${getRecordingOffsetMs()}`;
    if (take.takeId === activeAuditionTakeId && laneId === activeAuditionLaneId) continue;
    activeKeys.add(key);

    if (nativeDeviceOpen) {
      const playbackId = `good:${key}`;
      const previous = nativeGoodTakePlayback.get(playbackId);
      if (!previous || previous.filePath !== track.filePath || Math.abs(previous.offset - offset) > 0.12) {
        const ok = await startNativeTakePlayback({ playbackId, filePath: track.filePath, offset, target });
        if (ok) nativeGoodTakePlayback.set(playbackId, { filePath: track.filePath, offset });
      } else {
        previous.offset = offset;
      }
      continue;
    }

    let entry = goodTakeAudioPlayers.get(key);
    if (!entry || entry.filePath !== track.filePath) {
      if (entry?.audio) {
        try { entry.audio.pause(); } catch (_) {}
      }
      const fileUrl = await resolveReviewFileUrl(track.filePath);
      if (!fileUrl) continue;
      const audio = new Audio(fileUrl);
      audio.muted = !isTakesTrackAudible();
      entry = { audio, filePath: track.filePath };
      goodTakeAudioPlayers.set(key, entry);
    }

    if (Math.abs((entry.audio.currentTime || 0) - offset) > 0.12) {
      entry.audio.currentTime = offset;
    }
    if (entry.audio.paused) await entry.audio.play();
  }

  for (const [key, entry] of goodTakeAudioPlayers.entries()) {
    if (activeKeys.has(key)) continue;
    try { entry.audio?.pause(); } catch (_) {}
    goodTakeAudioPlayers.delete(key);
  }

  for (const [playbackId] of nativeGoodTakePlayback.entries()) {
    const key = playbackId.replace(/^good:/, '');
    if (activeKeys.has(key) && nativeDeviceOpen) continue;
    window.api.audioEngine.stopPlayback({ playbackId }).catch(() => {});
    nativeGoodTakePlayback.delete(playbackId);
  }
}

async function resyncPlaybackTargetsForCurrentTimeline({
  guide = true,
  review = true,
  goodTakes = true,
} = {}) {
  if (!isPlaying) return;
  const timelineSeconds = els.videoPlayer.currentTime || 0;

  if (guide) {
    stopNativeGuidePlayback();
    await syncNativeGuidePlayback(timelineSeconds, true);
  }
  if (review) {
    stopReviewPlayback();
    await syncReviewPlayback(timelineSeconds);
  }
  if (goodTakes) {
    stopGoodTakesPlayback();
    await syncGoodTakesPlayback(timelineSeconds);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARK IN / OUT
// ═══════════════════════════════════════════════════════════════════════════════

function markIn() {
  if (!currentProject || els.videoPlayer.readyState < 1) return;
  if (selectedCueId && !selectedCueAllowsTimingEdit()) {
    setStatusWarn('Cue timing is locked after recording. Create a new cue if you need a different region.');
    return;
  }
  const previousInFrames = regionInFrames;
  const nextInFrames = secondsToFrames(els.videoPlayer.currentTime);
  if (previousInFrames !== null && regionStreamerTargetFrames.length) {
    regionStreamerTargetFrames = shiftStreamerTargetFrames(regionStreamerTargetFrames, nextInFrames - previousInFrames);
  }
  regionInFrames = nextInFrames;
  if (regionOutFrames !== null && regionOutFrames <= regionInFrames) regionOutFrames = null;
  regionStreamerTargetFrames = normalizeStreamerTargetFrames(
    regionStreamerTargetFrames
      .map(frame => clampStreamerTargetFrames(frame))
      .filter(frame => frame !== null)
  );
  updateRegionPanelUI();
  updateRegionHighlight();
  updateCreateCueButton();
  setStatusInfo(`Mark In: ${framesToTC(regionInFrames)} (frame ${regionInFrames})`);
  updateLoopButton();
}

function markOut() {
  if (!currentProject || els.videoPlayer.readyState < 1) return;
  if (selectedCueId && !selectedCueAllowsTimingEdit()) {
    setStatusWarn('Cue timing is locked after recording. Create a new cue if you need a different region.');
    return;
  }
  const f = secondsToFrames(els.videoPlayer.currentTime);
  if (regionInFrames !== null && f <= regionInFrames) {
    setStatusWarn('Mark Out must be after Mark In.'); return;
  }
  regionOutFrames = f;
  regionStreamerTargetFrames = normalizeStreamerTargetFrames(
    regionStreamerTargetFrames
      .map(frame => clampStreamerTargetFrames(frame))
      .filter(frame => frame !== null)
  );
  updateRegionPanelUI();
  updateRegionHighlight();
  updateCreateCueButton();
  setStatusInfo(`Mark Out: ${framesToTC(regionOutFrames)} (frame ${regionOutFrames})`);
  updateLoopButton();
}

function updateRegionPanelUI() {
  if (regionInFrames !== null) {
    els.regionInTc.textContent       = framesToTC(regionInFrames);
    els.regionInFramesEl.textContent = `${regionInFrames} f`;
    els.btnMarkIn.classList.add('btn-mark-in-active');
  } else {
    els.regionInTc.textContent       = '—';
    els.regionInFramesEl.textContent = '—';
    els.btnMarkIn.classList.remove('btn-mark-in-active');
  }
  els.btnStreamerTarget.classList.toggle('btn-streamer-active', getActiveStreamerTargetFrames().length > 0);
  if (regionOutFrames !== null) {
    els.regionOutTc.textContent       = framesToTC(regionOutFrames);
    els.regionOutFramesEl.textContent = `${regionOutFrames} f`;
    els.btnMarkOut.classList.add('btn-mark-out-active');
  } else {
    els.regionOutTc.textContent       = '—';
    els.regionOutFramesEl.textContent = '—';
    els.btnMarkOut.classList.remove('btn-mark-out-active');
  }
  if (regionInFrames !== null && regionOutFrames !== null) {
    const df = regionOutFrames - regionInFrames;
    els.regionDuration.textContent = `${df} frames (${formatDuration(framesToSeconds(df))})`;
  } else {
    els.regionDuration.textContent = '—';
  }
  const hasRegion = regionInFrames !== null && regionOutFrames !== null && regionOutFrames > regionInFrames;
  els.btnZoomSelection.disabled = !hasRegion || !peakData;
  els.btnStreamerTarget.disabled = !hasRegion;
}

function getActiveStreamerTargetFrames() {
  return normalizeStreamerTargetFrames(regionStreamerTargetFrames);
}

function selectedCueTimingIsDirty() {
  if (!selectedCueId || !currentProject) return false;
  const cue = getCueById(selectedCueId);
  if (!cue) return false;
  return cue.inFrames !== regionInFrames
    || cue.outFrames !== regionOutFrames
    || !streamerTargetFramesEqual(getCueStreamerTargetFrames(cue), regionStreamerTargetFrames);
}

async function confirmDiscardCueTimingChanges() {
  if (!selectedCueTimingIsDirty()) return true;
  const cue = getCueById(selectedCueId);
  const label = cue?.cueNumber || 'selected cue';
  const result = await window.api.dialog.confirm({
    title: 'Discard Cue Timing Changes',
    message: `${label} has uncommitted cue timing or streamer changes.\nDiscard them?`,
  });
  return !!result?.confirmed;
}

async function submitCueTimingUpdate() {
  if (!selectedCueId || !currentProject) return;
  const cue = getCueById(selectedCueId);
  if (!cue) return;
  if (!selectedCueAllowsTimingEdit()) {
    setStatusWarn('Cue timing is locked after recording.');
    return;
  }
  if (regionInFrames === null || regionOutFrames === null || regionOutFrames <= regionInFrames) {
    setStatusWarn('Set a valid In and Out before updating the cue.');
    return;
  }
  if (!selectedCueTimingIsDirty()) {
    setStatusInfo('Cue timing already matches the current region.');
    return;
  }

  const result = await window.api.cue.updateCue(selectedCueId, {
    inFrames: regionInFrames,
    outFrames: regionOutFrames,
    streamerTargetFrames: regionStreamerTargetFrames,
    dialogue: els.cueDetailDialogue?.value ?? cue.dialogue ?? '',
    notes: els.cueDetailNotes?.value ?? cue.notes ?? '',
  });
  if (!result.success) {
    setStatusError(`Cue update failed: ${result.error}`);
    return;
  }

  currentProject = result.project;
  const updatedCue = currentProject.cues.find(c => c.cueId === selectedCueId);
  if (!updatedCue) return;

  regionInFrames = updatedCue.inFrames;
  regionOutFrames = updatedCue.outFrames;
  regionStreamerTargetFrames = getCueStreamerTargetFrames(updatedCue);

  renderCueList();
  showCueDetail(updatedCue);
  updateRegionPanelUI();
  updateRegionHighlight();
  updateCreateCueButton();
  updateDialogueOverlay();

  const chars = currentProject.characters || [];
  const char = chars.find(c => c.characterId === updatedCue.characterId);
  boothSend(getCueBoothPayload(updatedCue, char?.name || ''));
  boothSend({ type: 'cuePrimed', currentTime: framesToSeconds(updatedCue.inFrames) });

  markUnsaved();
  setStatusOk(`${updatedCue.cueNumber} updated.`);
}

function clampStreamerTargetFrames(frame) {
  if (regionInFrames === null || regionOutFrames === null || regionOutFrames <= regionInFrames) return null;
  if (typeof frame !== 'number' || !Number.isFinite(frame)) return null;
  return Math.max(regionInFrames, Math.min(regionOutFrames, Math.round(frame)));
}

async function setStreamerTargetAtCurrentPlayhead() {
  if (regionInFrames === null || regionOutFrames === null || regionOutFrames <= regionInFrames) {
    setStatusWarn('Set In and Out before placing a streamer target.');
    return;
  }
  const targetFrame = clampStreamerTargetFrames(secondsToFrames(els.videoPlayer.currentTime || 0));
  if (targetFrame === null) return;
  const toggleFrames = (frames) => {
    const normalized = normalizeStreamerTargetFrames(frames);
    const existingIndex = normalized.findIndex(frame => frame === targetFrame);
    if (existingIndex >= 0) {
      return {
        frames: normalized.filter((_frame, index) => index !== existingIndex),
        removed: true,
      };
    }
    return {
      frames: normalizeStreamerTargetFrames([...normalized, targetFrame]),
      removed: false,
    };
  };

  if (selectedCueId && currentProject) {
    const cue = currentProject.cues.find(c => c.cueId === selectedCueId);
    const nextTargets = toggleFrames(getCueStreamerTargetFrames(cue));
    const result = await window.api.cue.updateCue(selectedCueId, { streamerTargetFrames: nextTargets.frames });
    if (!result.success) {
      setStatusError(`Streamer target save failed: ${result.error}`);
      return;
    }
    currentProject = result.project;
    const updatedCue = currentProject.cues.find(c => c.cueId === selectedCueId);
    if (updatedCue) {
      regionStreamerTargetFrames = getCueStreamerTargetFrames(updatedCue);
      showCueDetail(updatedCue);
      const chars = currentProject.characters || [];
      const char = chars.find(c => c.characterId === updatedCue.characterId);
      boothSend(getCueBoothPayload(updatedCue, char?.name || ''));
    }
    updateRegionPanelUI();
    updateRegionHighlight();
    setStatusInfo(nextTargets.removed ? `Streamer target cleared at ${framesToTC(targetFrame)}.` : `Streamer target set at ${framesToTC(targetFrame)}.`);
    return;
  }

  const nextTargets = toggleFrames(regionStreamerTargetFrames);
  regionStreamerTargetFrames = nextTargets.frames;
  updateRegionPanelUI();
  updateRegionHighlight();
  setStatusInfo(nextTargets.removed ? `Streamer target cleared at ${framesToTC(targetFrame)}.` : `Streamer target prepared at ${framesToTC(targetFrame)}.`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOOP TOGGLE
// ═══════════════════════════════════════════════════════════════════════════════

function toggleLoop() {
  if (regionInFrames === null || regionOutFrames === null) {
    setStatusWarn('Set both Mark In and Mark Out before enabling loop.'); return;
  }
  if (isLooping) {
    // Turning loop OFF — stop any active loop pass immediately and return to ready
    cancelPreroll();
    isLooping = false;
    updateLoopButton();
    setStatusInfo('Loop off.');
    if (selectedCueId && regionInFrames !== null) {
      els.videoPlayer.pause();
      els.videoPlayer.currentTime = framesToSeconds(regionInFrames);
      updatePlayheadPosition(framesToSeconds(regionInFrames));
      setPlaybackState(false);
    }
    _setTransportState(selectedCueId ? 'CUE_READY' : 'IDLE');
    boothSend({ type: 'cuePlaybackStop', currentTime: els.videoPlayer.currentTime });
    boothSend({ type: 'cueCountdownClear' });
  } else {
    // Turning loop ON — immediately start comp loop workflow.
    isLooping = true;
    updateLoopButton();
    _compTakeCount = 0;

    if (audioInputReady) {
      // Initialise AudioWorklet now if not already done.
      setStatusInfo('Initialising recording engine…');
      console.log('[R3a-DIAG] toggleLoop ON — audioInputReady=true, calling _getAudioWorkletNode()');
      _getAudioWorkletNode()
        .then(node => {
          console.log('[R3a-DIAG] _getAudioWorkletNode resolved — node:', !!node, 'wiring onmessage');
          setStatusInfo('[DIAG] WORKLET READY — wiring onmessage');
          if (_mediaStream) {
            _mediaStream.getTracks().forEach(t => {
              t.onended = _onMediaStreamTrackEnded;
            });
          }
          node.port.onmessage = (e) => {
            console.log('[R3a-DIAG] worklet port message received:', e.data?.type, 'sampleCount:', e.data?.sampleCount);
            if (e.data?.type === 'recordingComplete') {
              _onRecordingComplete(e.data.buffer, e.data.sampleCount);
            }
          };
          console.log('[R3a-DIAG] onmessage wired — calling _startPrepPass()');
          setStatusInfo('[DIAG] WORKLET WIRED — starting prep pass');
          _startPrepPass();
        })
        .catch(err => {
          console.error('[R3a-DIAG] _getAudioWorkletNode FAILED:', err);
          setStatusError('Recording engine failed: ' + err.message);
          isLooping = false;
          updateLoopButton();
          _audioWorkletNode = null;
        });
    } else {
      // No device — preview-only comp loop
      console.log('[R3a-DIAG] toggleLoop ON — audioInputReady=false, preview-only');
      setStatusInfo('No input device — previewing comp only.');
      _startPrepPass();
    }
  }
}

function updateLoopButton() {
  const hasRegion = regionInFrames !== null && regionOutFrames !== null;
  const recordIntent = !!ws.cuePrerollEnabled;
  els.btnLoop.disabled = !hasRegion;
  els.btnLoop.classList.toggle('loop-record-intent', recordIntent);
  els.btnLoop.classList.toggle('loop-play-intent', !recordIntent);
  els.btnLoop.title = recordIntent
    ? 'Loop recording - pre-roll enabled'
    : 'Loop playback - pre-roll disabled';
  if (isLooping && hasRegion) {
    els.btnLoop.classList.add('active');
    els.regionLoopStatus.textContent = 'On';
    els.regionLoopStatus.style.color = 'var(--accent-green)';
  } else {
    els.btnLoop.classList.remove('active');
    els.regionLoopStatus.textContent = 'Off';
    els.regionLoopStatus.style.color = '';
  }
}

// ── Audio input ───────────────────────────────────────────────────────────────

/**
 * Set audio input status dot class and tooltip.
 * @param {'none'|'ready'|'permission'|'error'} state
 * @param {string} [tooltip]
 */
function setAudioInputStatus(state, tooltip) {
  const dot = els.audioInputStatus;
  dot.className = 'audio-input-status';       // reset
  if (state !== 'none') dot.classList.add(state);
  dot.title = tooltip || '';
}

/**
 * Enumerate audio input devices and populate the selector.
 * Labels are only available after permission has been granted.
 * If permission is needed, a call to getUserMedia triggers the OS prompt
 * naturally when the operator attempts to select a device.
 */
async function enumerateAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    els.audioInputSelect.innerHTML = '<option value="">Not supported</option>';
    els.audioInputSelect.disabled = true;
    setAudioInputStatus('error', 'Media devices not available');
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs  = devices.filter(d => d.kind === 'audioinput');

    if (inputs.length === 0) {
      els.audioInputSelect.innerHTML = '<option value="">No input devices</option>';
      els.audioInputSelect.disabled = true;
      setAudioInputStatus('none', 'No audio input devices found');
      updateRecordButton();
      return;
    }

    // Check if labels are available (requires prior permission grant)
    const hasLabels = inputs.some(d => d.label);

    const prevValue = els.audioInputSelect.value;
    els.audioInputSelect.innerHTML = '<option value="">Select input…</option>';
    inputs.forEach((d, i) => {
      const opt   = document.createElement('option');
      opt.value   = d.deviceId;
      opt.text    = d.label || `Microphone ${i + 1}`;
      els.audioInputSelect.appendChild(opt);
    });
    els.audioInputSelect.disabled = false;

    // Re-select previously chosen device if still present
    if (audioInputDeviceId && inputs.some(d => d.deviceId === audioInputDeviceId)) {
      els.audioInputSelect.value = audioInputDeviceId;
    } else if (audioInputDeviceId) {
      // Previously selected device no longer present
      audioInputReady = false;
      setAudioInputStatus('error', 'Device unavailable — reconnect or select another');
      updateRecordButton();
    }
  } catch (err) {
    console.warn('[audio] enumerateDevices failed:', err.message);
    setAudioInputStatus('error', 'Could not enumerate devices: ' + err.message);
  }
}

/**
 * Validate the selected device by requesting a short getUserMedia stream.
 * If permission is needed, the OS prompt appears naturally here.
 * On success: stream is immediately stopped (not recording), status → green.
 * On failure: error is surfaced, Record button disabled.
 */
async function validateAudioInput(deviceId) {
  audioInputReady = false;
  setAudioInputStatus('none', 'Checking device…');
  updateRecordButton();

  const constraints = {
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    video: false,
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // Stop all tracks immediately — we only needed the permission/availability check
    stream.getTracks().forEach(t => t.stop());
    audioInputDeviceId = deviceId;
    audioInputReady    = true;
    setAudioInputStatus('ready', 'Input ready');
    // Re-enumerate so labels are populated now that permission is granted
    await enumerateAudioInputs();
    updateRecordButton();
  } catch (err) {
    audioInputDeviceId = deviceId;   // remember the choice even on failure
    audioInputReady    = false;
    const msg = {
      NotAllowedError:       'Microphone access denied — check system permissions',
      NotFoundError:         'Device not found — reconnect and retry',
      NotReadableError:      'Device busy — in use by another application',
      OverconstrainedError:  'Device unavailable for the requested configuration',
    }[err.name] || 'Audio input error: ' + err.message;
    setAudioInputStatus(err.name === 'NotAllowedError' ? 'permission' : 'error', msg);
    setStatusError(msg);
    updateRecordButton();
  }
}

/**
 * Gate the Record button.
 * Enabled only when: cue selected + audio input ready + state is CUE_READY.
 * Disabled in all other conditions. No recording in R2 — placeholder feedback only.
 */
function updateRecordButton() {
  const canRecord = !!(currentProject &&
                       els.videoPlayer.readyState >= 1 &&
                       (transportState === 'IDLE' || transportState === 'CUE_READY' || transportState === 'PREVIEWING'));
  els.btnRecord.disabled = !canRecord;
  els.btnRecord.classList.toggle('armed', recordArmed);
  els.btnRecord.classList.toggle('recording', transportState === 'RECORDING_TAKE' || transportState === 'PENDING_RECORDING');
  els.btnRecord.title = recordMode === 'punch-in'
    ? 'Record (R) - Punch-in mode'
    : 'Record (R) - Normal mode';
}

function setRecordMode(mode, { persist = true } = {}) {
  recordMode = mode === 'punch-in' ? 'punch-in' : 'normal';
  ws.recordMode = recordMode;
  if (selectedCueId && recordMode === 'punch-in') {
    setStatusInfo('Punch-in mode selected. It is available when no cue is selected.');
  } else {
    setStatusInfo(`Recording mode: ${recordMode === 'punch-in' ? 'Punch-in' : 'Normal'}.`);
  }
  updateRecordButton();
  if (persist) saveWorkspaceSettings({ persist: true }).catch(() => {});
}

function disarmRecord(message = 'Record armed cancelled.') {
  if (!recordArmed) return;
  recordArmed = false;
  updateRecordButton();
  setStatusInfo(message);
}

function armRecord() {
  if (!currentProject || selectedCueId || transportState !== 'IDLE') return;
  recordArmed = true;
  updateRecordButton();
  setStatusInfo('Record armed. Press Play to record a new cue range.');
}

function getPendingTakeDirectory(mediaPath) {
  return `${mediaPath}/audio/_pending/${crypto.randomUUID()}`;
}

async function startSelectedCueRecord() {
  if (!selectedCueId || transportState !== 'CUE_READY') return;
  const cue = currentProject?.cues?.find(c => c.cueId === selectedCueId);
  if (!cue) return setStatusError('Cue not found for recording.');
  regionInFrames = cue.inFrames;
  regionOutFrames = cue.outFrames;
  updateRegionPanelUI();
  updateRegionHighlight();
  const cueOutSecs = framesToSeconds(cue.outFrames);
  const cueDurationSecs = framesToSeconds(cue.outFrames - cue.inFrames);
  try {
    await _beginNativeRecordingTake(cueOutSecs, cueDurationSecs);
  } catch (err) {
    _stopCompLoopAfterRecordingError('Native recording failed to start: ' + err.message);
  }
}

async function startPendingCueRecording() {
  if (!currentProject || selectedCueId) return;
  const mediaPath = _getProjectMediaPath();
  if (!mediaPath) return setStatusError('Project must be saved before recording.');
  const lanes = getArmedNativeRecordLanes();
  if (!lanes.length) return setStatusError('Arm at least one native mic lane before recording.');

  const startSecs = els.videoPlayer.currentTime || 0;
  const startFrame = secondsToFrames(startSecs);
  const takeDirectory = getPendingTakeDirectory(mediaPath);
  let response = await window.api.audioEngine.startRecording({ lanes, takeDirectory });
  if (!response.success || !response.result?.ok) {
    const message = response.result?.message || response.error || '';
    if (/already active/i.test(message)) {
      await window.api.audioEngine.stopRecording().catch(() => {});
      response = await window.api.audioEngine.startRecording({ lanes, takeDirectory });
    }
  }
  const result = response.result || {};
  if (!response.success || !result.ok) {
    throw new Error(result.message || response.error || 'Native record.start failed.');
  }

  pendingCueRecording = {
    mode: recordMode,
    lanes,
    takeDirectory,
    startSecs,
    startFrame,
    result: null,
  };
  recordArmed = false;
  playbackStartPosition = startSecs;
  _setTransportState('PENDING_RECORDING');
  nativeRecordingActive = true;
  updateNativeRecordButtons(nativeDeviceOpen);
  els.videoPlayer.play().catch(() => {});
  setStatusInfo('Recording pending cue...');
}

async function finishPendingCueRecording() {
  if (!pendingCueRecording) return;
  const context = pendingCueRecording;
  nativeRecordingActive = false;
  const stopSecs = els.videoPlayer.currentTime || context.startSecs;
  els.videoPlayer.pause();
  setPlaybackState(false);
  const response = await window.api.audioEngine.stopRecording();
  const result = response.result || {};
  updateNativeRecordButtons(nativeDeviceOpen);
  _setTransportState('IDLE');

  const durationSecs = Math.max(0, stopSecs - context.startSecs);
  if (!response.success || !result.ok) {
    pendingCueRecording = null;
    return setStatusError(result.message || response.error || 'Pending recording failed.');
  }
  if (durationSecs < MIN_PENDING_RECORDING_SECS) {
    pendingCueRecording = null;
    return setStatusWarn('Recording discarded: shorter than 0.3s.');
  }

  context.stopSecs = stopSecs;
  context.stopFrame = Math.max(context.startFrame + 1, secondsToFrames(stopSecs));
  context.durationSecs = durationSecs;
  context.result = result;
  pendingCueRecording = context;
  regionInFrames = context.startFrame;
  regionOutFrames = context.stopFrame;
  updateRegionPanelUI();
  updateRegionHighlight();
  updateCreateCueButton();
  showCreateCueModal();
  setStatusInfo('Create a cue to keep the pending recording, or Cancel to discard it.');
}

function discardPendingCueRecording(message = 'Pending recording discarded.') {
  pendingCueRecording = null;
  setStatusInfo(message);
}

async function attachPendingRecordingToCue(cue) {
  if (!pendingCueRecording || !cue) return false;
  const context = pendingCueRecording;
  const result = context.result || {};
  const files = Array.isArray(result.files) ? result.files : [];
  const primaryFile = files[0]?.filePath || result.filePath;
  if (!primaryFile) {
    discardPendingCueRecording('Pending recording had no usable WAV files.');
    return false;
  }

  const now = new Date().toISOString();
  const takeNumber = (currentProject.takes || []).filter(t => t.cueId === cue.cueId).length + 1;
  const takeDurationSecs = Number(result.durationSecs || 0) > 0 ? result.durationSecs : context.durationSecs;
  const take = {
    takeId:          crypto.randomUUID(),
    takeGroupId:     crypto.randomUUID(),
    projectId:       currentProject.projectId,
    cueId:           cue.cueId,
    takeNumber,
    filePath:        primaryFile,
    durationSecs:    takeDurationSecs,
    startOffsetSecs: getRecordingStartOffsetSecs(),
    recordingOffsetMs: getRecordingOffsetMs(),
    actorId:         cue.actorId || null,
    recordedAt:      now,
    createdAt:       now,
    updatedAt:       now,
    isSelected:      false,
    rating:          'none',
    syncStatus:      'local',
    notes:           '',
    cueNumber:       cue.cueNumber,
    takeName:        `T${String(takeNumber).padStart(2, '0')}`,
    archiveDirectory: context.takeDirectory,
    tracks:          files.map(file => ({
      laneId: file.laneId,
      label: file.label,
      trackName: file.label,
      physicalInput: file.physicalInput,
      filePath: file.filePath,
      durationSecs: Number(file.durationSecs || 0) > 0 ? file.durationSecs : takeDurationSecs,
      samplesWritten: file.samplesWritten,
      droppedBlocks: file.droppedBlocks,
      sampleRate: result.sampleRate,
      bitDepth: 24,
      channelCount: 1,
      recordingOffsetMs: getRecordingOffsetMs(),
    })),
    recordingEngine: 'native-juce',
    sampleRate:      result.sampleRate,
    bitDepth:        24,
    channelCount:    files.length || 1,
  };

  const addResult = await window.api.cue.addTake({ take });
  pendingCueRecording = null;
  if (!addResult.success) {
    setStatusError(`Cue created, but pending take attach failed: ${addResult.error}`);
    return false;
  }
  currentProject = addResult.project;
  markUnsaved();
  return true;
}

function handleRecordCommand() {
  if (recordArmed) {
    disarmRecord();
    return;
  }
  if (transportState === 'PENDING_RECORDING') {
    handleTransportStop();
    return;
  }
  if (selectedCueId) {
    startSelectedCueRecord();
    return;
  }
  if (transportState === 'PREVIEWING' && recordMode === 'punch-in') {
    startPendingCueRecording().catch(err => setStatusError('Punch-in failed to start: ' + err.message));
    return;
  }
  if (transportState === 'IDLE') {
    armRecord();
  }
}

function showRecordModeMenu(x, y) {
  let menu = document.getElementById('record-mode-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'record-mode-menu';
    menu.className = 'record-mode-menu hidden';
    menu.innerHTML = `
      <button type="button" data-mode="normal">Normal</button>
      <button type="button" data-mode="punch-in">Punch-in</button>
    `;
    document.body.appendChild(menu);
    menu.addEventListener('click', event => {
      const btn = event.target.closest('[data-mode]');
      if (!btn) return;
      setRecordMode(btn.dataset.mode);
      menu.classList.add('hidden');
    });
  }
  menu.querySelectorAll('[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === recordMode);
  });
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.remove('hidden');
}

function hideRecordModeMenu() {
  document.getElementById('record-mode-menu')?.classList.add('hidden');
}

function togglePrerollEnabled() {
  els.settingPrerollEnabled.checked = !ws.cuePrerollEnabled;
  els.settingPrerollEnabled.dispatchEvent(new Event('change'));
}

// ── Recording engine ──────────────────────────────────────────────────────────

/**
 * Ensure the AudioWorklet module is loaded and return a configured node.
 * Called once on the first comp loop attempt; result is cached.
 * @returns {Promise<AudioWorkletNode>}
 */
async function _getAudioWorkletNode() {
  console.log('[R3a-DIAG] CHECKPOINT 4: GET WORKLET — _audioWorkletNode already exists:', !!_audioWorkletNode);
  setStatusInfo('[DIAG] GET WORKLET node=' + !!_audioWorkletNode);
  const ctx = getAudioCtx();
  if (_audioWorkletNode) return _audioWorkletNode;

  try {
    await ctx.audioWorklet.addModule('./pcm-recorder-processor.js');
    console.log('[R3a-DIAG] CHECKPOINT 5: WORKLET MODULE LOADED');
    setStatusInfo('[DIAG] WORKLET MODULE LOADED');
  } catch (err) {
    console.error('[R3a-DIAG] CHECKPOINT 5: WORKLET MODULE FAILED:', err);
    setStatusError('[DIAG] WORKLET MODULE FAILED: ' + err.message);
    throw err;
  }

  const constraints = {
    audio: audioInputDeviceId ? { deviceId: { exact: audioInputDeviceId } } : true,
    video: false,
  };
  try {
    _mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log('[R3a-DIAG] CHECKPOINT 6: MEDIA STREAM READY — tracks:', _mediaStream.getTracks().length);
    setStatusInfo('[DIAG] MEDIA STREAM READY tracks=' + _mediaStream.getTracks().length);
  } catch (err) {
    console.error('[R3a-DIAG] CHECKPOINT 6: getUserMedia FAILED:', err.name, err.message);
    setStatusError('[DIAG] getUserMedia FAILED: ' + err.name + ' ' + err.message);
    throw err;
  }

  const source   = ctx.createMediaStreamSource(_mediaStream);
  const splitter = ctx.createChannelSplitter(Math.max(1, source.channelCount));
  source.connect(splitter);

  const workletNode = new AudioWorkletNode(ctx, 'pcm-recorder-processor', {
    numberOfInputs:  1,
    numberOfOutputs: 0,
    channelCount:    1,
  });
  splitter.connect(workletNode, 0, 0);

  _audioWorkletNode = workletNode;
  console.log('[R3a-DIAG] CHECKPOINT 7: WORKLET NODE CREATED');
  setStatusInfo('[DIAG] WORKLET NODE CREATED');
  return workletNode;
}

/**
 * Handle MediaStream track ending (device unplug mid-recording).
 */
function _onMediaStreamTrackEnded() {
  console.warn('[recording] Input device track ended unexpectedly.');
  if (transportState === 'RECORDING_TAKE') {
    setStatusError('Audio input disconnected — take aborted.');
    _abortCurrentTake();
  }
  audioInputReady = false;
  setAudioInputStatus('error', 'Device disconnected');
  updateRecordButton();
}

/**
 * Start the RAF safety net that catches cases where the AudioWorklet
 * scheduled stop fails to fire. Checks every frame.
 */
function _startRafSafety(cueOutSecs) {
  const MARGIN = 0.15;  // 150ms after scheduled stop
  function check() {
    if (transportState !== 'RECORDING_TAKE') return;  // already stopped
    if (els.videoPlayer.currentTime >= cueOutSecs + MARGIN) {
      console.warn('[recording] RAF safety net triggered — scheduled stop was missed.');
      // 'abort' is correct here: the scheduled stop failed, meaning the audio
      // clock and our timing are desynchronised. The PCM boundary is uncertain.
      // Discarding is safer than keeping potentially misaligned audio.
      if (_audioWorkletNode) {
        _audioWorkletNode.port.postMessage({ type: 'abort' });
      }
      _abortCurrentTake();
    } else {
      _rafSafetyId = requestAnimationFrame(check);
    }
  }
  _rafSafetyId = requestAnimationFrame(check);
}

function _stopRafSafety() {
  if (_rafSafetyId) { cancelAnimationFrame(_rafSafetyId); _rafSafetyId = null; }
}

function _clearNativeLoopStopTimer() {
  if (_nativeLoopStopTimer) {
    clearTimeout(_nativeLoopStopTimer);
    _nativeLoopStopTimer = null;
  }
}

function _safeFileSegment(value, fallback = 'item') {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || fallback;
}

function _resolveNativeTakeDirectory(mediaPath, cueNumber, takeNumber) {
  const safeCue = _safeFileSegment(cueNumber, 'cue');
  const num = String(takeNumber).padStart(2, '0');
  return `${mediaPath}/audio/${safeCue}/T${num}`;
}

function _escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function blurActiveButton() {
  const active = document.activeElement;
  if (active && active instanceof HTMLElement && active.matches('button, [role="button"]')) {
    active.blur();
  }
}

function isEditableShortcutTarget(target) {
  if (!target) return false;
  const tagName = target.tagName;
  if (tagName === 'TEXTAREA') return true;
  if (tagName === 'SELECT') return !target.matches('.audio-engine-select, .audio-input-select');
  if (tagName !== 'INPUT') return false;
  const type = String(target.type || 'text').toLowerCase();
  return type !== 'range';
}

/**
 * Discard the current take — device failure, RAF safety net, or invalid capture.
 * Sends 'abort' to the worklet (buffer discarded, no recordingComplete).
 * Operator stops (Stop button, Spacebar, L cancel) also discard the current
 * take via stopPlayback() → 'abort', matching this same discard behavior.
 * Only a scheduled cue-Out completion creates a take.
 */
function _abortCurrentTake() {
  _stopRafSafety();
  _clearNativeLoopStopTimer();
  if (_audioWorkletNode) {
    _audioWorkletNode.port.postMessage({ type: 'abort' });
  }
  window.api.recording.abort().catch(() => {});
  isLooping = false;
  updateLoopButton();
  _compTakeCount = 0;
  stopPlayback();   // handles state, booth messages, playhead
}

function _stopCompLoopAfterRecordingError(message) {
  isLooping = false;
  updateLoopButton();
  _compTakeCount = 0;
  _clearNativeLoopStopTimer();
  _nativeLoopTakeContext = null;
  nativeRecordingActive = false;
  setPlaybackState(false);
  _setTransportState(selectedCueId ? 'CUE_READY' : 'IDLE');
  setStatusError(message);
}

async function _beginNativeRecordingTake(cueOutSecs, cueDurationSecs) {
  const cue = currentProject?.cues?.find(c => c.cueId === selectedCueId);
  if (!cue) {
    setStatusError('Cue not found for native recording.');
    _abortCurrentTake(); return;
  }

  const mediaPath = _getProjectMediaPath();
  if (!mediaPath) {
    setStatusError('Project must be saved before native recording.');
    _abortCurrentTake(); return;
  }

  const lanes = getArmedNativeRecordLanes();
  if (!lanes.length) {
    setStatusError('Arm at least one native mic lane before recording.');
    _abortCurrentTake(); return;
  }

  const takeNumber = (currentProject.takes.filter(t => t.cueId === cue.cueId).length) + 1;
  const takeDirectory = _resolveNativeTakeDirectory(mediaPath, cue.cueNumber, takeNumber);
  let response = await window.api.audioEngine.startRecording({ lanes, takeDirectory });
  if (!response.success || !response.result?.ok) {
    const message = response.result?.message || response.error || '';
    if (/already active/i.test(message)) {
      await window.api.audioEngine.stopRecording().catch(() => {});
      response = await window.api.audioEngine.startRecording({ lanes, takeDirectory });
    }
  }
  const result = response.result || {};

  if (!response.success || !result.ok) {
    throw new Error(result.message || response.error || 'Native record.start failed.');
  }

  _nativeLoopTakeContext = { cue, takeNumber, lanes, cueOutSecs, cueDurationSecs };
  nativeRecordingActive = true;
  updateNativeRecordButtons(nativeDeviceOpen);

  const inSec = framesToSeconds(regionInFrames);
  const syncStarted = await startSyncedVideoAt(inSec, ['CUE_READY', 'COUNTDOWN']);
  if (!syncStarted) {
    await window.api.audioEngine.stopRecording().catch(() => {});
    _nativeLoopTakeContext = null;
    nativeRecordingActive = false;
    updateNativeRecordButtons(nativeDeviceOpen);
    throw new Error('Recording start was interrupted before synced playback could begin.');
  }

  _setTransportState('RECORDING_TAKE');
  _clearNativeLoopStopTimer();
  _nativeLoopStopTimer = setTimeout(() => {
    if (transportState !== 'RECORDING_TAKE' || !_nativeLoopTakeContext) return;
    _finishNativeRecordingTake().catch(err => {
      setStatusError('Native take stop failed: ' + err.message);
      _abortCurrentTake();
    });
  }, Math.max(0, cueDurationSecs * 1000));
  setStatusInfo(`Native recording take ${takeNumber} - ${lanes.map(l => l.label).join(' + ')}`);
}

async function _finishNativeRecordingTake() {
  const context = _nativeLoopTakeContext;
  if (!context) return;

  _nativeLoopTakeContext = null;
  nativeRecordingActive = false;
  _clearNativeLoopStopTimer();
  _stopRafSafety();
  els.videoPlayer.pause();
  boothSend({ type: 'cuePlaybackStop', currentTime: els.videoPlayer.currentTime });
  _setTransportState('COUNTDOWN');

  const response = await window.api.audioEngine.stopRecording();
  const result = response.result || {};
  updateNativeRecordButtons(nativeDeviceOpen);

  if (!response.success || !result.ok) {
    _stopCompLoopAfterRecordingError(result.message || response.error || 'Native take captured no samples.');
    return;
  }

  const now = new Date().toISOString();
  const files = Array.isArray(result.files) ? result.files : [];
  if (!files.length && !result.filePath) {
    _stopCompLoopAfterRecordingError(`Native take ${context.takeNumber} stopped but returned no WAV files.`);
    return;
  }
  if (files.length < context.lanes.length) {
    setStatusWarn(`Native take ${context.takeNumber}: ${files.length}/${context.lanes.length} armed lanes returned WAV files.`);
  }
  if (Number(result.samplesWritten || 0) <= 0) {
    setStatusWarn(`Native take ${context.takeNumber} created with no input samples reported.`);
  }
  const primaryFile = files[0]?.filePath || result.filePath;
  const takeDurationSecs = Number(result.durationSecs || 0) > 0
    ? result.durationSecs
    : context.cueDurationSecs;
  const take = {
    takeId:          crypto.randomUUID(),
    takeGroupId:     crypto.randomUUID(),
    projectId:       currentProject.projectId,
    cueId:           context.cue.cueId,
    takeNumber:      context.takeNumber,
    filePath:        primaryFile,
    durationSecs:    takeDurationSecs,
    startOffsetSecs: getRecordingStartOffsetSecs(),
    recordingOffsetMs: getRecordingOffsetMs(),
    actorId:         context.cue.actorId || null,
    recordedAt:      now,
    createdAt:       now,
    updatedAt:       now,
    isSelected:      false,
    rating:          'none',
    syncStatus:      'local',
    notes:           '',
    cueNumber:       context.cue.cueNumber,
    takeName:        `T${String(context.takeNumber).padStart(2, '0')}`,
    archiveDirectory: _resolveNativeTakeDirectory(_getProjectMediaPath(), context.cue.cueNumber, context.takeNumber),
    tracks:          files.map(file => ({
      laneId: file.laneId,
      label: file.label,
      trackName: file.label,
      physicalInput: file.physicalInput,
      filePath: file.filePath,
      durationSecs: Number(file.durationSecs || 0) > 0 ? file.durationSecs : takeDurationSecs,
      samplesWritten: file.samplesWritten,
      droppedBlocks: file.droppedBlocks,
      sampleRate: result.sampleRate,
      bitDepth: 24,
      channelCount: 1,
      recordingOffsetMs: getRecordingOffsetMs(),
    })),
    recordingEngine: 'native-juce',
    sampleRate:      result.sampleRate,
    bitDepth:        24,
    channelCount:    files.length || 1,
  };

  const addResult = await window.api.cue.addTake({ take });
  if (addResult.success) {
    currentProject = addResult.project;
    markUnsaved();
    if (selectedCueId === context.cue.cueId) {
      renderTakeList(context.cue.cueId);
    }
    setStatusOk(`Native take ${context.takeNumber} recorded - ${files.length || 1} file${files.length === 1 ? '' : 's'}`);
  } else {
    setStatusError(`Native take saved to disk but project update failed: ${addResult.error}`);
  }

  _compTakeCount++;
  _continueOrEndComp();
}

/**
 * Handle 'recordingComplete' message from the AudioWorklet.
 * Finalises the WAV, adds the take to the project, continues or ends comp loop.
 * @param {ArrayBuffer} buffer  — transferred Float32 PCM data
 * @param {number} sampleCount
 */
async function _onRecordingComplete(buffer, sampleCount) {
  console.log('[R3a-DIAG] CHECKPOINT 11: RECORDING COMPLETE RECEIVED — sampleCount:', sampleCount, 'buffer byteLength:', buffer?.byteLength, 'transportState:', transportState);
  setStatusInfo('[DIAG] RECORDING COMPLETE samples=' + sampleCount + ' state=' + transportState);
  _stopRafSafety();

  if (transportState !== 'RECORDING_TAKE') {
    console.log('[R3a-DIAG] CHECKPOINT 11: state is not RECORDING_TAKE — discarding buffer. state=', transportState);
    setStatusWarn('[DIAG] recordingComplete arrived but state=' + transportState + ' — discarding');
    return;
  }

  if (sampleCount === 0 || !buffer || buffer.byteLength === 0) {
    console.warn('[R3a-DIAG] CHECKPOINT 11: zero-sample take');
    setStatusWarn('[DIAG] No audio captured — take discarded.');
    _compTakeCount++;
    _continueOrEndComp();
    return;
  }

  const cue = currentProject?.cues?.find(c => c.cueId === selectedCueId);
  if (!cue) {
    console.error('[R3a-DIAG] Cue not found for selectedCueId:', selectedCueId);
    _abortCurrentTake(); return;
  }

  const takeNumber = (currentProject.takes.filter(t => t.cueId === cue.cueId).length) + 1;
  const mediaPath  = _getProjectMediaPath();
  if (!mediaPath) {
    setStatusError('[DIAG] Project must be saved before recording.');
    _abortCurrentTake(); return;
  }

  _setTransportState('COUNTDOWN');

  console.log('[R3a-DIAG] CHECKPOINT 12: FINALISE INVOKED — cueNumber:', cue.cueNumber, 'takeNumber:', takeNumber, 'mediaPath:', mediaPath, 'bufferBytes:', buffer.byteLength);
  setStatusInfo('[DIAG] FINALISE INVOKED take=' + takeNumber);

  const result = await window.api.recording.finalise({
    pcmBuffer:        buffer,
    cueNumber:        cue.cueNumber,
    takeNumber,
    projectMediaPath: mediaPath,
  });

  console.log('[R3a-DIAG] CHECKPOINT 13: FINALISE RESULT —', JSON.stringify({ success: result.success, error: result.error, filePath: result.filePath, durationSecs: result.durationSecs }));
  setStatusInfo('[DIAG] FINALISE ' + (result.success ? 'OK path=' + (result.filePath || '?') : 'FAILED ' + result.error));

  if (!result.success) {
    if (result.error === 'zero_samples') {
      setStatusWarn(`Take ${takeNumber} — no audio captured, discarded.`);
    } else {
      setStatusError(`Take ${takeNumber} write failed: ${result.error}`);
    }
    _compTakeCount++;
    _continueOrEndComp();
    return;
  }

  const now = new Date().toISOString();
  const take = {
    takeId:          crypto.randomUUID(),
    projectId:       currentProject.projectId,
    cueId:           cue.cueId,
    takeNumber,
    filePath:        result.filePath,
    durationSecs:    result.durationSecs,
    startOffsetSecs: getRecordingStartOffsetSecs(),
    recordingOffsetMs: getRecordingOffsetMs(),
    actorId:         cue.actorId || null,
    recordedAt:      now,
    createdAt:       now,
    updatedAt:       now,
    isSelected:      false,
    rating:          'none',
    syncStatus:      'local',
    notes:           '',
    tracks:          [],
  };

  const addResult = await window.api.cue.addTake({ take });
  if (addResult.success) {
    currentProject = addResult.project;
    markUnsaved();
    renderTakeList(cue.cueId);
    setStatusOk(`Take ${takeNumber} recorded — ${result.durationSecs.toFixed(1)}s`);
  } else {
    setStatusError(`Take ${takeNumber} saved to disk but project update failed: ${addResult.error}`);
  }

  _compTakeCount++;
  _continueOrEndComp();
}

/**
 * Continue the comp loop (next countdown → take) or end it (3 takes done).
 */
function _continueOrEndComp() {
  if (_compTakeCount >= COMP_TAKES_TOTAL || !isLooping) {
    const completedTakes = Math.min(_compTakeCount, COMP_TAKES_TOTAL);
    // Sequence complete or was cancelled
    isLooping = false;
    updateLoopButton();
    _compTakeCount = 0;
    stopPlayback();
    setStatusInfo(`Comp complete - ${completedTakes} takes recorded.`);
    return;
  }
  // Start next countdown → take
  _startTakePass();
}

/**
 * Begin a RECORDING_TAKE pass. Called from the runPreroll onComplete callback.
 * @param {number} cueOutSecs
 * @param {number} cueDurationSecs
 */
async function _beginRecordingTake(cueOutSecs, cueDurationSecs) {
  console.log('[R3a-DIAG] CHECKPOINT 3: BEGIN RECORDING TAKE — _audioWorkletNode:', !!_audioWorkletNode, 'cueOutSecs:', cueOutSecs, 'dur:', cueDurationSecs);
  setStatusInfo('[DIAG] BEGIN RECORDING TAKE node=' + !!_audioWorkletNode);

  if (!_audioWorkletNode) {
    console.error('[R3a-DIAG] CHECKPOINT 3: ABORT — no worklet node');
    setStatusError('[DIAG] No worklet node — recording engine not initialised.');
    _abortCurrentTake();
    return;
  }

  const ctx = getAudioCtx();
  const inSec = framesToSeconds(regionInFrames);

  const syncStarted = await startSyncedVideoAt(inSec, ['CUE_READY', 'COUNTDOWN']);
  if (!syncStarted) {
    console.warn('[R3a-DIAG] CHECKPOINT 10: RECORD START CANCELLED before synced playback');
    setStatusWarn('[DIAG] Record start cancelled before synced playback began.');
    return;
  }

  console.log('[R3a-DIAG] CHECKPOINT 10: RECORD PLAY STARTED — currentTime:', inSec);
  setStatusInfo('[DIAG] RECORD PLAY STARTED at ' + inSec.toFixed(2) + 's');

  // Pre-arm: 50ms ahead so the worklet processes 'start' before the first
  // recording quantum. The stop is scheduled exactly cueDurationSecs after
  // the start — no additional margin, so recording ends precisely at cue Out.
  const scheduleStartTime = ctx.currentTime + 0.05;
  const stopAtAudioTime   = scheduleStartTime + cueDurationSecs;

  _audioWorkletNode.port.postMessage({ type: 'start' });
  console.log('[R3a-DIAG] CHECKPOINT 8: WORKLET START SENT');

  _audioWorkletNode.port.postMessage({ type: 'scheduleStop', stopAtAudioTime });
  console.log('[R3a-DIAG] CHECKPOINT 9: SCHEDULE STOP SENT — stopAtAudioTime:', stopAtAudioTime.toFixed(3), 'duration:', cueDurationSecs.toFixed(3));
  setStatusInfo('[DIAG] RECORDING — stop at ' + stopAtAudioTime.toFixed(2) + ' dur=' + cueDurationSecs.toFixed(2) + 's');

  _setTransportState('RECORDING_TAKE');
  _startRafSafety(cueOutSecs);
}

/**
 * Derive the project _media folder path from currentFilePath.
 * Returns null if project is unsaved.
 */
function _getProjectMediaPath() {
  const configured = currentProject?.settings?.projectFolders?.mediaPath;
  if (configured) return String(configured).replace(/\\/g, '/');
  if (!currentFilePath) return null;
  const dir  = currentFilePath.substring(0, currentFilePath.lastIndexOf('/') + 1) ||
               currentFilePath.substring(0, currentFilePath.lastIndexOf('\\') + 1);
  const base = currentFilePath.replace(/\\/g, '/').split('/').pop().replace(/\.stageadr$/, '');
  return (dir + base + '_media').replace(/\\/g, '/');
}

/**
 * Render the take list for the currently selected cue.
 * @param {string} cueId
 */
function renderTakeList(cueId) {
  return renderTakeListGrouped(cueId);
  const container = els.cueDetailTakes;
  if (!container || !currentProject) return;

  const takes = currentProject.takes
    .filter(t => t.cueId === cueId)
    .sort((a, b) => a.takeNumber - b.takeNumber);

  if (takes.length === 0) {
    container.innerHTML = '';
    return;
  }

  const header = `<div class="takes-header">
    <span>Takes (${takes.length})</span>
    <span class="track-monitor-group">
      <button class="track-monitor-btn" id="takes-track-mute" data-action="toggle-takes-mute" title="Mute take audition">M</button>
      <button class="track-monitor-btn" id="takes-track-solo" data-action="toggle-takes-solo" title="Solo take audition">S</button>
    </span>
  </div>`;
  const rows = takes.map(t => {
    const actor = t.actorId
      ? (currentProject.actors.find(a => a.actorId === t.actorId)?.name || '—')
      : '';
    const dur = typeof t.durationSecs === 'number' ? t.durationSecs.toFixed(1) + 's' : '—';
    const trackLabel = Array.isArray(t.tracks) && t.tracks.length > 0 ? ` · ${t.tracks.length} mic` : '';
    return `<div class="take-row">
      <span class="take-number">T${t.takeNumber}</span>
      <span class="take-duration">${dur}${trackLabel}</span>
      ${actor ? `<span class="take-actor">${actor}</span>` : ''}
    </div>`;
  }).join('');

  container.innerHTML = header + rows;
}

function renderTakeListGrouped(cueId) {
  const container = els.cueDetailTakes;
  if (!container) return;

  const header = `<div class="takes-header">
    <span>Takes Monitor</span>
    <span class="track-monitor-group">
      <button class="track-monitor-btn" id="takes-track-mute" data-action="toggle-takes-mute" title="Mute take audition">M</button>
      <button class="track-monitor-btn" id="takes-track-solo" data-action="toggle-takes-solo" title="Solo take audition">S</button>
    </span>
  </div>`;

  if (!currentProject) {
    container.innerHTML = header + '<div class="takes-empty">No project open.</div>';
    updateMonitorButtons();
    return;
  }

  if (!cueId) {
    container.innerHTML = header + '<div class="takes-empty">Select an ADR cue to view takes.</div>';
    updateMonitorButtons();
    return;
  }

  const takes = (currentProject.takes || [])
    .filter(t => t.cueId === cueId)
    .sort((a, b) => a.takeNumber - b.takeNumber);

  if (takes.length === 0) {
    container.innerHTML = header + '<div class="takes-empty">No takes recorded.</div>';
    updateMonitorButtons();
    return;
  }

  const selectedTake = takes.find(t => t.isSelected);
  const activeAuditionTake = activeAuditionTakeId
    ? takes.find(t => t.takeId === activeAuditionTakeId)
    : null;
  const countLabel = `<div class="takes-count">
    <span>Takes (${takes.length})</span>
    ${selectedTake ? `<span class="takes-state-chip good">Good T${selectedTake.takeNumber}</span>` : ''}
    ${activeAuditionTake ? `<span class="takes-state-chip audition">Audition T${activeAuditionTake.takeNumber} ${_escapeHtml(activeAuditionLaneId || '')}</span>` : ''}
  </div>`;
  const rows = takes.map(t => {
    const actor = t.actorId
      ? (currentProject.actors.find(a => a.actorId === t.actorId)?.name || '-')
      : '';
    const dur = typeof t.durationSecs === 'number' ? t.durationSecs.toFixed(1) + 's' : '-';
    const tracks = Array.isArray(t.tracks) && t.tracks.length > 0
      ? t.tracks
      : [{ laneId: 'mic1', label: 'Mic 1', filePath: t.filePath, durationSecs: t.durationSecs }];
    const revealFilePath = tracks.find(track => !!track.filePath)?.filePath || t.filePath || '';
    const selectedClass = t.isSelected ? ' selected' : '';
    const auditionClass = t.takeId === activeAuditionTakeId ? ' audition-source' : '';
    const trackRows = tracks.map(track => {
      const laneId = track.laneId || 'mic1';
      const laneLabel = track.trackName || track.label || laneId;
      const isAuditioning = t.takeId === activeAuditionTakeId && laneId === activeAuditionLaneId;
      const activeClass = isAuditioning ? ' active' : '';
      return `<button class="take-lane-row${activeClass}" data-action="toggle-audition-track" data-lane-id="${_escapeHtml(laneId)}" data-take-id="${_escapeHtml(t.takeId)}" data-file-path="${_escapeHtml(track.filePath || revealFilePath)}" title="${_escapeHtml(track.filePath || '')}" aria-pressed="${isAuditioning ? 'true' : 'false'}">
        <span class="take-lane-name"><span class="take-lane-dot"></span>${_escapeHtml(laneLabel)}</span>
        <span class="take-lane-badges">
          ${t.isSelected ? '<span class="take-lane-chip export">Export</span>' : ''}
          <span class="take-lane-chip audition">${isAuditioning ? 'Auditioning' : 'Audition'}</span>
        </span>
      </button>`;
    }).join('');

    return `<div class="take-group${selectedClass}${auditionClass}" data-take-id="${_escapeHtml(t.takeId)}" data-file-path="${_escapeHtml(revealFilePath)}">
      <div class="take-row">
        <span class="take-number">T${t.takeNumber}</span>
        <span class="take-duration">${dur}</span>
        ${actor ? `<span class="take-actor">${_escapeHtml(actor)}</span>` : '<span class="take-actor"></span>'}
        <button class="btn btn-xs btn-ghost take-good-btn${t.isSelected ? ' active' : ''}" data-action="toggle-good-take" data-take-id="${_escapeHtml(t.takeId)}" aria-pressed="${t.isSelected ? 'true' : 'false'}">${t.isSelected ? 'Good Take' : 'Mark Good'}</button>
      </div>
      <div class="take-lane-list">${trackRows}</div>
    </div>`;
  }).join('');

  container.innerHTML = header + countLabel + rows;
  updateMonitorButtons();
}

async function toggleGoodTake(takeId) {
  if (!selectedCueId || !takeId) return;
  const current = currentProject?.takes?.find(t => t.takeId === takeId);
  const result = await window.api.cue.selectTake({ cueId: selectedCueId, takeId: current?.isSelected ? null : takeId });
  if (!result.success) {
    setStatusError(result.error || 'Could not update good take.');
    return;
  }
  currentProject = result.project;
  markUnsaved();
  renderCueList();
  renderTakeList(selectedCueId);
  setStatusOk(current?.isSelected ? 'Good take cleared.' : 'Good take selected.');
}

function toggleAuditionTrack(takeId, laneId) {
  if (!takeId || !laneId) return;
  const wasActive = activeAuditionTakeId === takeId && activeAuditionLaneId === laneId;
  activeAuditionTakeId = wasActive ? null : takeId;
  activeAuditionLaneId = wasActive ? null : laneId;
  if (wasActive) stopReviewPlayback();
  if (selectedCueId) renderTakeList(selectedCueId);
  setStatusInfo(wasActive ? 'Take audition off.' : `Audition armed: ${laneId}`);
}

/**
 * Create Cue button rule:
 *   ENABLED  = valid In + valid Out + NO cue selected
 *   DISABLED = any of: no In, no Out, Out ≤ In, a cue is currently selected
 *
 * When a cue is selected the operator is in editing mode, not spotting mode.
 */
function updateCreateCueButton() {
  const hasRegion = regionInFrames !== null
                 && regionOutFrames !== null
                 && regionOutFrames > regionInFrames;
  if (!currentProject) {
    els.btnCreateCue.textContent = 'Create Cue';
    els.btnCreateCue.disabled = true;
    return;
  }
  if (selectedCueId) {
    if (selectedCueAllowsTimingEdit()) {
      els.btnCreateCue.textContent = 'Update Cue';
      els.btnCreateCue.disabled = !(hasRegion && selectedCueTimingIsDirty());
    } else {
      els.btnCreateCue.textContent = 'Cue Locked';
      els.btnCreateCue.disabled = true;
    }
    return;
  }
  els.btnCreateCue.textContent = 'Create Cue';
  els.btnCreateCue.disabled = !hasRegion;
}

function handlePrimaryCueAction() {
  if (selectedCueId) {
    submitCueTimingUpdate().catch(err => setStatusError(err.message));
    return;
  }
  showCreateCueModal();
}

/**
 * Show the Create Cue modal. Populates the existing character dropdown.
 * Hides the existing-char section if no characters exist yet.
 */
function showCreateCueModal() {
  if (!currentProject) return;
  if (regionInFrames === null || regionOutFrames === null || regionOutFrames <= regionInFrames) {
    setStatusWarn('Set a valid In and Out before creating a cue.'); return;
  }
  if (selectedCueId) return; // safety guard

  const chars = currentProject.characters || [];

  // Populate existing characters dropdown
  els.createCueCharSelect.innerHTML = '<option value="">— select existing character —</option>';
  chars.forEach(c => {
    const opt = document.createElement('option');
    opt.value       = c.characterId;
    opt.textContent = c.name;
    els.createCueCharSelect.appendChild(opt);
  });

  // Show/hide existing-char section
  const hasChars = chars.length > 0;
  els.createCueExistingGroup.style.display = hasChars ? '' : 'none';
  els.createCueDivider.style.display       = hasChars ? '' : 'none';

  // Reset fields
  els.createCueCharSelect.value = '';
  els.createCueNewChar.value    = '';

  // Show timing in modal subtitle
  els.createCueTiming.textContent =
    `${framesToTC(regionInFrames)} → ${framesToTC(regionOutFrames)}`;

  els.modalCreateCue.classList.remove('hidden');

  // Focus: new char input if no existing chars, else existing select
  setTimeout(() => {
    (hasChars ? els.createCueCharSelect : els.createCueNewChar).focus();
  }, 50);
}

function hideCreateCueModal({ discardPending = true } = {}) {
  if (discardPending && pendingCueRecording) {
    discardPendingCueRecording();
  }
  els.modalCreateCue.classList.add('hidden');
}

/**
 * Submit the Create Cue modal.
 * Resolves character: existing selection takes priority over new-char text field.
 * If a new character name is typed, create the character first, then create the cue.
 */
async function submitCreateCue() {
  const existingId  = els.createCueCharSelect.value;
  const newCharName = els.createCueNewChar.value.trim();

  // Validate: need exactly one character source
  if (!existingId && !newCharName) {
    els.createCueNewChar.focus();
    setStatusWarn('Select an existing character or enter a new character name.');
    return;
  }

  const hadPendingRecording = !!pendingCueRecording;
  hideCreateCueModal({ discardPending: false });

  let characterId = existingId;

  // Create new character inline if typed
  if (newCharName) {
    const charResult = await window.api.cue.addCharacter({ name: newCharName });
    if (!charResult.success) {
      setStatusError(`Could not create character: ${charResult.error}`);
      if (pendingCueRecording) showCreateCueModal();
      return;
    }
    currentProject = charResult.project;
    characterId    = charResult.character.characterId;
    rebuildCharacterFilter();
    setStatusInfo(`Character "${charResult.character.name}" created.`);
  }

  // Create the cue
  const cueResult = await window.api.cue.createCue({
    characterId,
    inFrames:  regionInFrames,
    outFrames: regionOutFrames,
    streamerTargetFrames: regionStreamerTargetFrames,
    dialogue:  '',
    notes:     '',
  });

  if (!cueResult.success) {
    setStatusError(`Could not create cue: ${cueResult.error}`);
    if (pendingCueRecording) showCreateCueModal();
    return;
  }

  currentProject = cueResult.project;
  regionStreamerTargetFrames = [];
  renderCueList();
  rebuildCharacterFilter();

  // New cue becomes active immediately
  if (cueResult.cue) await selectCue(cueResult.cue.cueId);
  if (cueResult.cue && pendingCueRecording) {
    const attached = await attachPendingRecordingToCue(cueResult.cue);
    if (attached) {
      renderTakeList(cueResult.cue.cueId);
      setStatusOk(`${cueResult.cue.cueNumber} created with pending take.`);
    }
  }

  markUnsaved();
  if (!hadPendingRecording) setStatusOk(`${cueResult.cue?.cueNumber} created.`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTER FILTER (not assignment)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Rebuild the cue list filter dropdown.
 * Options: "ALL CHARACTERS" (value '') + all project characters.
 */
function rebuildCharacterFilter() {
  const chars = currentProject?.characters || [];
  const prev  = els.cueCharacterFilter.value;

  els.cueCharacterFilter.innerHTML = `
    <option value="">ALL CHARACTERS</option>
    <option value="__open__">SHOW ALL OPEN CUES</option>
  `;
  chars.forEach(c => {
    const opt = document.createElement('option');
    opt.value       = c.characterId;
    opt.textContent = c.name;
    els.cueCharacterFilter.appendChild(opt);
  });

  // Restore selection if still valid
  if (prev === '__open__') {
    els.cueCharacterFilter.value = prev;
    cueListFilter = prev;
  } else if (prev && chars.some(c => c.characterId === prev)) {
    els.cueCharacterFilter.value = prev;
    cueListFilter = prev;
  } else {
    els.cueCharacterFilter.value = '';
    cueListFilter = '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUE LIST RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

function renderCueList() {
  const cues  = currentProject?.cues  || [];
  const chars = currentProject?.characters || [];

  // Remove existing cue items (keep empty-state node)
  els.cueList.querySelectorAll('.cue-item').forEach(n => n.remove());

  // Apply filter
  const visible = cueListFilter === '__open__'
    ? cues.filter(c => c.status !== 'completed')
    : cueListFilter
      ? cues.filter(c => c.characterId === cueListFilter)
      : cues;

  const sorted = [...visible].sort((a, b) => a.inFrames - b.inFrames);

  if (sorted.length === 0) {
    els.cueEmptyState.classList.remove('hidden');
    return;
  }
  els.cueEmptyState.classList.add('hidden');

  sorted.forEach(cue => {
    const char      = chars.find(c => c.characterId === cue.characterId);
    const dialogue  = cue.dialogue?.trim() || '(no dialogue)';
    const preview   = dialogue.length > 40 ? dialogue.slice(0, 38) + '…' : dialogue;
    const completed = cue.status === 'completed';
    const overlaps = getOverlappingCues(cue);
    const selectedOverlapCount = overlaps.filter(other => cueHasSelectedTake(other.cueId)).length;

    const item = document.createElement('div');
    item.className     = 'cue-item'
                       + (cue.cueId === selectedCueId ? ' selected' : '')
                       + (completed ? ' completed' : '');
    item.dataset.cueId = cue.cueId;

    item.innerHTML = `
      <div class="cue-item-top">
        <span class="cue-item-number">${escHtml(cue.cueNumber)}</span>
        <span class="cue-item-char">${escHtml(char?.name || '?')}</span>
        <button class="cue-complete-toggle${completed ? ' completed' : ''}"
          data-cue-id="${escHtml(cue.cueId)}"
          title="${completed ? 'Mark as Open' : 'Mark as Completed'}"
          aria-label="${completed ? 'Completed — click to mark open' : 'Open — click to mark completed'}"
        >${completed ? '✓' : '○'}</button>
      </div>
      <div class="cue-item-dialogue">${escHtml(preview)}</div>
      <div class="cue-item-timing">${framesToTC(cue.inFrames)} → ${framesToTC(cue.outFrames)}</div>
    `;

    if (overlaps.length) {
      const chip = document.createElement('span');
      chip.className = 'cue-overlap-chip';
      chip.title = `${selectedOverlapCount} overlapping cue(s) have good takes`;
      chip.textContent = `Overlap ${overlaps.length}${selectedOverlapCount ? ` / ${selectedOverlapCount} good` : ''}`;
      item.querySelector('.cue-item-timing')?.appendChild(chip);
    }

    // Cue selection: click anywhere on the item EXCEPT the complete toggle
    item.addEventListener('click', (e) => {
      if (e.target.closest('.cue-complete-toggle')) return; // handled separately
      selectCue(cue.cueId).catch(err => setStatusError(err.message));
    });

    // Complete toggle: stop propagation so it doesn't also select the cue,
    // then toggle status via the existing IPC path
    const toggleBtn = item.querySelector('.cue-complete-toggle');
    toggleBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleCueStatusById(cue.cueId);
    });
    els.cueList.appendChild(item);
  });
}

function resetCueAndTakeWorkspace() {
  selectedCueId = null;
  activeAuditionTakeId = null;
  activeAuditionLaneId = null;
  stopReviewPlayback();
  stopGoodTakesPlayback();
  goodTakesPlaybackEnabled = false;
  regionInFrames = null;
  regionOutFrames = null;
  regionStreamerTargetFrames = [];
  els.cueDetail?.classList.add('hidden');
  els.cueList?.querySelectorAll('.cue-item.selected').forEach(el => el.classList.remove('selected'));
  renderTakeList(null);
  updateRegionPanelUI();
  updateRegionHighlight();
  updateLoopButton();
  updateCreateCueButton();
  updateDialogueOverlay();
  updateCompactPlaybackButtons();
  _setTransportState('IDLE');
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUE SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

function cuesOverlap(a, b) {
  if (!a || !b || a.cueId === b.cueId) return false;
  return Number(a.inFrames) < Number(b.outFrames) && Number(b.inFrames) < Number(a.outFrames);
}

function getOverlappingCues(cue) {
  if (!cue || !currentProject?.cues) return [];
  return currentProject.cues
    .filter(other => cuesOverlap(cue, other))
    .sort((a, b) => a.inFrames - b.inFrames || String(a.cueNumber).localeCompare(String(b.cueNumber)));
}

function cueHasSelectedTake(cueId) {
  return !!currentProject?.takes?.some(take => take.cueId === cueId && take.isSelected);
}

function cueCharacterName(cue) {
  const character = currentProject?.characters?.find(item => item.characterId === cue?.characterId);
  return character?.name || '?';
}

function renderCueOverlapDetail(cue) {
  if (!els.cueOverlapDetail || !els.cueOverlapList) return;
  const overlaps = getOverlappingCues(cue);
  if (!overlaps.length) {
    els.cueOverlapDetail.classList.add('hidden');
    els.cueOverlapList.innerHTML = '';
    return;
  }

  els.cueOverlapList.innerHTML = overlaps.map(other => {
    const hasGood = cueHasSelectedTake(other.cueId);
    const dialogue = other.dialogue?.trim() || '(no dialogue)';
    return `<button class="cue-overlap-row" data-cue-id="${escHtml(other.cueId)}" title="${escHtml(dialogue)}">
      <span class="cue-overlap-main">
        <span class="cue-overlap-number">${escHtml(other.cueNumber)}</span>
        <span class="cue-overlap-char">${escHtml(cueCharacterName(other))}</span>
      </span>
      <span class="cue-overlap-time">${framesToTC(other.inFrames)} â†’ ${framesToTC(other.outFrames)}</span>
      <span class="cue-overlap-good${hasGood ? ' active' : ''}">${hasGood ? 'Good' : 'No good'}</span>
    </button>`;
  }).join('');
  els.cueOverlapDetail.classList.remove('hidden');
}

async function selectCue(cueId) {
  if (selectedCueId && selectedCueId !== cueId) {
    const discardAllowed = await confirmDiscardCueTimingChanges();
    if (!discardAllowed) {
      setStatusInfo('Cue timing changes kept.');
      return;
    }
  }

  const cue = currentProject?.cues.find(c => c.cueId === cueId);
  if (!cue) return;

  selectedCueId = cueId;
  clearAuditionIfOutsideCue(cueId);

  // Highlight in list
  els.cueList.querySelectorAll('.cue-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.cueId === cueId);
  });

  // Set region to cue timing
  regionInFrames  = cue.inFrames;
  regionOutFrames = cue.outFrames;
  regionStreamerTargetFrames = getCueStreamerTargetFrames(cue);
  updateRegionPanelUI();
  updateRegionHighlight();
  updateLoopButton();

  // Do NOT auto-enable loop. Loop is an explicit operator action only.
  // Entering CUE_READY is the clean state for a newly selected cue.
  _setTransportState('CUE_READY');

  // Seek video to in-point (display only)
  const inSec = framesToSeconds(cue.inFrames);
  if (els.videoPlayer.readyState >= 1) {
    els.videoPlayer.currentTime = inSec;
    updatePlayheadPosition(inSec);
  }

  // Scroll timeline so cue is visible
  if (peakData) {
    viewStart = clampViewStart(inSec - getViewWindow() * 0.15);
    renderAll();
  }

  // Populate detail editor
  showCueDetail(cue);

  // Update dialogue overlay
  updateDialogueOverlay();

  // Create Cue is disabled while a cue is selected
  updateCreateCueButton();

  // Notify booth — low frequency, not awaited
  const chars2 = currentProject?.characters || [];
  const char2  = chars2.find(c => c.characterId === cue.characterId);
  boothSend(getCueBoothPayload(cue, char2?.name || ''));
  // Prime booth video at the cue in-point so it is seeked and ready
  // before the first loop pass triggers cueLoopRestart + countdown.
  boothSend({ type: 'cuePrimed', currentTime: inSec });
}

async function deselectCue() {
  const discardAllowed = await confirmDiscardCueTimingChanges();
  if (!discardAllowed) {
    setStatusInfo('Cue timing changes kept.');
    return;
  }
  selectedCueId = null;
  els.cueList.querySelectorAll('.cue-item').forEach(el => el.classList.remove('selected'));
  els.cueDetail.classList.add('hidden');
  renderTakeList(null);

  // Stop any active playback immediately — Escape mid-pass must stop video now.
  cancelPreroll();
  els.videoPlayer.pause();
  setPlaybackState(false);

  // Clear In/Out region and loop — return to neutral spotting state
  regionInFrames  = null;
  regionOutFrames = null;
  regionStreamerTargetFrames = [];
  isLooping       = false;
  updateRegionPanelUI();
  updateRegionHighlight();
  updateLoopButton();

  updateDialogueOverlay();
  updateCreateCueButton();
  _setTransportState('IDLE');
  boothSend({ type: 'cuePlaybackStop', currentTime: els.videoPlayer.currentTime });
  boothSend({ type: 'cueCountdownClear' });
  boothSend({ type: 'cueDeselected' });
}

function showCueDetail(cue) {
  const chars = currentProject?.characters || [];
  const char  = chars.find(c => c.characterId === cue.characterId);

  els.cueDetailNumber.textContent = cue.cueNumber;
  els.cueDetailChar.textContent   = char?.name || '—';

  // Status toggle button — label clearly indicates the CURRENT state, not an action
  const completed = cue.status === 'completed';
  els.btnCueStatus.textContent = completed ? '✓ Completed' : '○ Open';
  els.btnCueStatus.classList.toggle('completed', completed);
  els.btnCueStatus.title = completed ? 'Click to mark as Open' : 'Click to mark as Completed';

  // Timing (display only — not editable)
  const durF = cue.outFrames - cue.inFrames;
  els.cueDetailIn.textContent  = framesToTC(cue.inFrames);
  els.cueDetailOut.textContent = framesToTC(cue.outFrames);
  els.cueDetailDur.textContent = `${durF} f`;
  renderCueOverlapDetail(cue);

  // Editable fields
  els.cueDetailDialogue.value = cue.dialogue || '';
  els.cueDetailNotes.value    = cue.notes    || '';

  // Assigned Actor dropdown — set to current actorId (or '' for Unassigned)
  els.cueDetailActor.value = cue.actorId || '';

  renderTakeList(cue.cueId);

  els.cueDetail.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUE STATUS TOGGLE (OPEN ↔ COMPLETED)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Toggle the status of any cue by ID.
 * Used by both the list-item toggle and the detail-panel button.
 * Does NOT require the cue to be selected.
 */
async function toggleCueStatusById(cueId) {
  if (!currentProject || !cueId) return;
  const cue = currentProject.cues.find(c => c.cueId === cueId);
  if (!cue) return;
  const newStatus = cue.status === 'completed' ? 'open' : 'completed';

  const result = await window.api.cue.updateCue(cueId, { status: newStatus });
  if (!result.success) { setStatusError(`Status update failed: ${result.error}`); return; }

  currentProject = result.project;

  // If this is the selected cue, refresh its detail panel too
  if (selectedCueId === cueId) {
    const updated = currentProject.cues.find(c => c.cueId === cueId);
    if (updated) showCueDetail(updated);
  }

  renderCueList();
  markUnsaved();
  setStatusInfo(`${cue.cueNumber} marked ${newStatus}.`);
}

/**
 * Toggle the currently selected cue's status.
 * Called from the detail-panel status button.
 */
async function toggleCueStatus() {
  if (!selectedCueId) return;
  await toggleCueStatusById(selectedCueId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUE EDITS + DELETE
// ═══════════════════════════════════════════════════════════════════════════════

async function saveCueEdits() {
  if (!selectedCueId || !currentProject) return;
  const patch = {
    dialogue: els.cueDetailDialogue.value,
    notes:    els.cueDetailNotes.value,
    // character not editable post-creation in this phase
  };
  const result = await window.api.cue.updateCue(selectedCueId, patch);
  if (!result.success) { setStatusError(`Save failed: ${result.error}`); return; }

  currentProject = result.project;
  renderCueList();

  const updated = currentProject.cues.find(c => c.cueId === selectedCueId);
  if (updated) showCueDetail(updated);

  // Refresh overlay if dialogue changed
  updateDialogueOverlay();

  // Notify booth of updated cue payload so streamer validation stays in sync
  if (updated) {
    const chars = currentProject.characters || [];
    const char = chars.find(c => c.characterId === updated.characterId);
    boothSend(getCueBoothPayload(updated, char?.name || ''));
  }

  markUnsaved();
  setStatusOk('Cue saved.');
}

async function deleteCue() {
  if (!selectedCueId || !currentProject) return;
  const cue = currentProject.cues.find(c => c.cueId === selectedCueId);
  if (!cue) return;

  const confirmed = await window.api.dialog.confirm({
    title:   'Delete Cue',
    message: `Delete ${cue.cueNumber}? This cannot be undone.`,
  });
  if (!confirmed.confirmed) return;

  const result = await window.api.cue.deleteCue(selectedCueId);
  if (!result.success) { setStatusError(`Delete failed: ${result.error}`); return; }

  currentProject = result.project;
  selectedCueId  = null;
  regionInFrames = regionOutFrames = null;
  regionStreamerTargetFrames = [];
  isLooping      = false;
  updateRegionPanelUI();
  updateRegionHighlight();
  updateLoopButton();
  updateCreateCueButton();
  renderCueList();
  rebuildCharacterFilter();
  els.cueDetail.classList.add('hidden');
  renderTakeList(null);
  updateDialogueOverlay();
  markUnsaved();
  setStatusOk(`${cue.cueNumber} deleted.`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WAVEFORM
// ═══════════════════════════════════════════════════════════════════════════════

function showWaveformUI() {
  els.waveformPlaceholder.classList.add('hidden');
  els.timelineControls.classList.remove('hidden');
  els.timelineRuler.classList.remove('hidden');
  els.waveformWrap.classList.remove('hidden');
  els.timelineScrollbarTrack.classList.remove('hidden');
}
function hideWaveformUI() {
  els.timelineControls.classList.add('hidden');
  els.timelineRuler.classList.add('hidden');
  els.waveformWrap.classList.add('hidden');
  els.timelineScrollbarTrack.classList.add('hidden');
  els.waveformPlaceholder.classList.remove('hidden');
}

function applyPeakData(data, nextGuideAudioPath = guideAudioPath) {
  peakData = data; viewStart = 0; viewWindow = null; zoomIndex = 0;
  guideAudioPath = nextGuideAudioPath || null;
  if (nativeGuidePreparedPath !== guideAudioPath) nativeGuidePreparedPath = null;
  nativeGuideMissingWarned = false;
  updateGuideAudioStatus();
  prepareNativeGuideAudio().catch(err => setStatusWarn('Native guide prepare failed: ' + err.message));
  showWaveformUI();
  buildZoomLevelButtons();
  updateZoomUI();
  requestAnimationFrame(() => {
    const rect   = els.waveformCanvas.getBoundingClientRect();
    canvasWidth  = rect.width;
    canvasHeight = rect.height;
    renderAll();
  });
}

function showWaveformProgress(v) {
  v ? els.waveformProgressArea.classList.remove('hidden')
    : els.waveformProgressArea.classList.add('hidden');
  if (!v) els.waveformProgressFill.style.width = '0%';
}
function updateWaveformProgress(stage, pct) {
  const labels = { extracting: 'Extracting audio…', generating: 'Generating waveform…', done: 'Done' };
  els.waveformProgressLabel.textContent = labels[stage] || stage;
  els.waveformProgressFill.style.width  = `${pct}%`;
  els.waveformProgressPct.textContent   = `${pct}%`;
}

async function generateWaveform() {
  if (!currentProject) return;
  if (!currentFilePath) { setStatusWarn('Save the project before generating the waveform.'); return; }
  const ffmpegStatus = await window.api.waveform.checkFfmpeg();
  if (!ffmpegStatus.available) { setStatusError('ffmpeg not found.'); return; }
  setStatusInfo('Generating waveform…');
  showWaveformProgress(true);
  els.btnGenerateWaveform.disabled = true;
  const result = await window.api.waveform.extract();
  showWaveformProgress(false);
  els.btnGenerateWaveform.disabled = false;
  if (!result.success) { setStatusError(`Waveform failed: ${result.error}`); return; }
  applyPeakData(result.peaks, result.guideAudioPath);
  setStatusOk('Waveform generated.');
}

function updateGenerateWaveformButton() {
  els.btnGenerateWaveform.disabled = !(currentProject?.video?.localPath && currentFilePath);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT → UI
// ═══════════════════════════════════════════════════════════════════════════════

function applyProjectToUI(project, filePath) {
  currentProject  = project;
  currentFilePath = filePath || null;
  resetCueAndTakeWorkspace();

  if (!project) {
    els.headerProjectName.textContent = 'No Project Open';
    updateWindowTitle();
    els.btnSaveProject.disabled = true;
    els.btnLoadVideo.disabled   = true;
    clearProjectPanel(); clearVideoPanel(); clearSettingsPanel();
    renderCueList();
    rebuildCharacterFilter();
    loadWorkspaceSettings();
    return;
  }

  const displayName = project.filmTitle
    ? `${project.filmTitle}  /  ${project.projectName}`
    : project.projectName || 'Untitled Project';
  els.headerProjectName.textContent = displayName;
  updateWindowTitle();
  els.btnSaveProject.disabled = false;
  els.btnLoadVideo.disabled   = false;

  els.infoFilmTitle.textContent   = project.filmTitle   || '—';
  els.infoProjectName.textContent = project.projectName || '—';
  els.infoProjectId.textContent   = project.projectId   || '—';
  els.infoCreatedAt.textContent   = formatDate(project.createdAt);
  els.infoUpdatedAt.textContent   = formatDate(project.updatedAt);
  els.infoFilePath.textContent    = filePath ? truncatePath(filePath, 36) : 'Not saved yet';

  applyVideoMetaToUI(project.video);
  applySettingsToUI(project.settings, project.cues);
  updateGenerateWaveformButton();
  loadWorkspaceSettings();

  rebuildCharacterFilter();
  renderCueList();
  updateCreateCueButton();
  updateExportButton();
  updateManageActorsButton();
  rebuildActorDropdown();
}

function clearProjectPanel() {
  ['infoFilmTitle','infoProjectName','infoProjectId','infoCreatedAt','infoUpdatedAt']
    .forEach(k => { els[k].textContent = '—'; });
  els.infoFilePath.textContent = 'Not saved yet';
}

function applyVideoMetaToUI(video) {
  if (!video?.fileName) { clearVideoPanel(); return; }
  els.vmetaFilename.textContent   = video.fileName   || '—';
  els.vmetaDuration.textContent   = formatDuration(video.durationSeconds);
  els.vmetaFramerate.textContent  = formatFrameRate(video.frameRate, video.displayFrameRate);
  els.vmetaResolution.textContent = (video.width && video.height) ? `${video.width} × ${video.height}` : '—';
  els.vmetaVcodec.textContent     = video.videoCodec || '—';
  els.vmetaAcodec.textContent     = video.audioCodec || '—';
  els.vmetaSamplerate.textContent = video.sampleRate ? `${video.sampleRate} Hz` : '—';
  els.vmetaChannels.textContent   = video.channels != null ? channelLabel(video.channels) : '—';
  els.vmetaBitrate.textContent    = video.bitRate    ? `${video.bitRate} kbps` : '—';
  els.vmetaFormat.textContent     = video.formatName || '—';
  els.infoFps.textContent         = formatFrameRate(video.frameRate, video.displayFrameRate);
  els.infoResolution.textContent  = (video.width && video.height) ? `${video.width}×${video.height}` : '—';
  els.infoCodec.textContent       = video.videoCodec || '—';
}

function clearVideoPanel() {
  ['vmetaFilename','vmetaDuration','vmetaFramerate','vmetaResolution',
   'vmetaVcodec','vmetaAcodec','vmetaSamplerate','vmetaChannels','vmetaBitrate','vmetaFormat']
    .forEach(k => { els[k].textContent = '—'; });
  els.infoFps.textContent = '-- fps';
  els.infoResolution.textContent = '-- × --';
  els.infoCodec.textContent = '--';
}

function applySettingsToUI(settings, cues) {
  if (!settings) { clearSettingsPanel(); return; }
  const hasCues = Array.isArray(cues) && cues.length > 0;
  els.settingsFramerate.textContent  = settings.frameRate  ? formatFrameRate(settings.frameRate) : '—';
  els.settingsSamplerate.textContent = settings.sampleRate ? `${settings.sampleRate} Hz` : '—';
  els.settingsBitdepth.textContent   = settings.bitDepth   ? `${settings.bitDepth}-bit`  : '—';
  hasCues ? els.framerateLockedRow.classList.remove('hidden')
          : els.framerateLockedRow.classList.add('hidden');
}

function clearSettingsPanel() {
  els.settingsFramerate.textContent  = '—';
  els.settingsSamplerate.textContent = '—';
  els.settingsBitdepth.textContent   = '—';
  els.framerateLockedRow.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOSAVE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mark the project as having unsaved changes so the autosave timer
 * will write a snapshot on the next tick.
 */
function markUnsaved() {
  _hasUnsavedChanges = true;
  updateWindowTitle();
}

function updateWindowTitle() {
  let title;
  if (!currentProject) {
    title = 'Post ADR Pro';
  } else {
    const identity = currentProject.filmTitle
      ? `${currentProject.filmTitle} - ${currentProject.projectName}`
      : currentProject.projectName || 'Untitled Session';
    title = `${_hasUnsavedChanges ? '* ' : ''}${identity} - Post ADR Pro`;
  }

  document.title = title;
  window.api?.app?.setTitle?.(title).catch(() => {});
}

/**
 * Start the periodic autosave timer.
 * Fires every AUTOSAVE_INTERVAL_MS; writes only when there are unsaved changes.
 * Safe to call multiple times — does nothing if the timer is already running.
 */
function startAutosaveTimer() {
  if (_autosaveTimer) return;
  _autosaveTimer = setInterval(async () => {
    if (!currentProject || !_hasUnsavedChanges) return;
    try {
      await window.api.project.autosave();
      // NOTE: do NOT clear _hasUnsavedChanges here.
      // Writing a recovery snapshot does not constitute saving the project.
      // The dirty flag must remain true until the operator explicitly saves,
      // so the close-protection prompt still fires and the recovery file is
      // preserved on a dirty exit.
      console.log('[autosave] Recovery snapshot written. Project remains unsaved.');
    } catch (err) {
      console.warn('[autosave] Write failed:', err);
    }
  }, AUTOSAVE_INTERVAL_MS);
}

function stopAutosaveTimer() {
  if (_autosaveTimer) { clearInterval(_autosaveTimer); _autosaveTimer = null; }
  _hasUnsavedChanges = false;
}

/**
 * Show the autosave recovery prompt and handle the user's choice.
 * @param {{ autosavePath: string, autosaveMtime: string }} asInfo
 */
async function offerAutosaveRecovery(recoveryInfo) {
  const mtime = recoveryInfo.recoveryMtime
    ? new Date(recoveryInfo.recoveryMtime).toLocaleString()
    : 'unknown time';
  const confirmed = await window.api.dialog.confirm({
    title:   'Recovery Available',
    message: `An unsaved recovery snapshot from ${mtime} was found.\n\nRestore it now?`,
  });
  if (!confirmed.confirmed) {
    // Ignore — clear the recovery file
    await window.api.project.clearAutosave();
    setStatusInfo('Recovery ignored. Current saved project loaded.');
    return;
  }
  // Restore — projectHandlers deletes the recovery file immediately
  const result = await window.api.project.restoreAutosave();
  if (!result.success) {
    setStatusError(`Could not restore recovery: ${result.error}`);
    return;
  }
  currentProject = result.project;
  applyProjectToUI(result.project, result.filePath);
  setStatusWarn('Recovery restored. Save to commit these changes.');
  markUnsaved();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTOR MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

function showActorModal() {
  if (!currentProject) return;
  renderActorList();
  els.actorInputName.value  = '';
  els.actorInputEmail.value = '';
  hideActorFormError();
  els.modalActors.classList.remove('hidden');
  setTimeout(() => els.actorInputName.focus(), 50);
}

function hideActorModal() {
  els.modalActors.classList.add('hidden');
}

function showActorFormError(msg) {
  els.actorFormError.textContent = msg;
  els.actorFormError.classList.remove('hidden');
}

function hideActorFormError() {
  els.actorFormError.classList.add('hidden');
  els.actorFormError.textContent = '';
}

function renderActorList() {
  const actors = currentProject?.actors || [];
  els.actorList.innerHTML = '';

  if (actors.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'actor-list-empty';
    empty.textContent = 'No actors added yet. Add an actor below.';
    els.actorList.appendChild(empty);
    return;
  }

  actors.forEach(actor => {
    const row = document.createElement('div');
    row.className = 'actor-row';
    row.innerHTML = `
      <div class="actor-row-info">
        <div class="actor-row-name">${escHtml(actor.name)}</div>
        <div class="actor-row-email">${escHtml(actor.email)}</div>
      </div>
      <span class="actor-row-remote" title="Remote workflow — available in a future release">Remote: Off</span>
      <button class="btn-actor-delete" data-actor-id="${escHtml(actor.actorId)}" title="Remove actor">✕</button>
    `;
    row.querySelector('.btn-actor-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      const actorId = e.currentTarget.dataset.actorId;
      await deleteActor(actorId);
    });
    els.actorList.appendChild(row);
  });
}

async function submitAddActor() {
  hideActorFormError();
  const name  = els.actorInputName.value.trim();
  const email = els.actorInputEmail.value.trim();

  if (!name)  { showActorFormError('Actor name is required.'); els.actorInputName.focus();  return; }
  if (!email) { showActorFormError('Email address is required.'); els.actorInputEmail.focus(); return; }

  const result = await window.api.actor.addActor({ name, email });
  if (!result.success) { showActorFormError(result.error); return; }

  currentProject = result.project;
  els.actorInputName.value  = '';
  els.actorInputEmail.value = '';
  renderActorList();
  rebuildActorDropdown();
  markUnsaved();
  setStatusOk(`Actor "${result.actor.name}" added.`);
  els.actorInputName.focus();
}

async function deleteActor(actorId) {
  const actor = currentProject?.actors?.find(a => a.actorId === actorId);
  if (!actor) return;

  // Count cues assigned to this actor for confirmation messaging
  const assignedCount = currentProject.cues.filter(c => c.actorId === actorId).length;
  const msg = assignedCount > 0
    ? `Remove "${actor.name}"? This actor is assigned to ${assignedCount} cue(s). Those cues will become unassigned.`
    : `Remove "${actor.name}" from this project?`;

  const confirmed = await window.api.dialog.confirm({ title: 'Remove Actor', message: msg });
  if (!confirmed.confirmed) return;

  const result = await window.api.actor.deleteActor({ actorId });
  if (!result.success) { setStatusError(`Could not remove actor: ${result.error}`); return; }

  currentProject = result.project;
  renderActorList();
  rebuildActorDropdown();
  // Refresh cue detail panel if the deleted actor was shown there
  if (selectedCueId) {
    const cue = currentProject.cues.find(c => c.cueId === selectedCueId);
    if (cue) showCueDetail(cue);
  }
  markUnsaved();
  setStatusOk(`Actor "${actor.name}" removed.`);
}

/**
 * Rebuild the Assigned Actor dropdown in the cue detail panel.
 * Called when the actor list changes or a project is opened.
 * Preserves the currently selected value if still valid.
 */
function rebuildActorDropdown() {
  const actors  = currentProject?.actors || [];
  const current = els.cueDetailActor.value;

  // Clear and repopulate
  els.cueDetailActor.innerHTML = '<option value="">Unassigned</option>';
  actors.forEach(actor => {
    const opt = document.createElement('option');
    opt.value       = actor.actorId;
    opt.textContent = `${actor.name} — ${actor.email}`;
    els.cueDetailActor.appendChild(opt);
  });

  // Restore selection if still valid
  if (current && actors.some(a => a.actorId === current)) {
    els.cueDetailActor.value = current;
  } else {
    els.cueDetailActor.value = '';
  }
}

/**
 * Enable/disable the Manage Actors button based on whether a project is open.
 */
function updateManageActorsButton() {
  els.btnManageActors.disabled = !currentProject;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PDF EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Export button is enabled only when a project is open.
 * (Exporting with zero cues is allowed — it will say "No cues".)
 */
function updateExportButton() {
  // Export actions now live in the native app menu.
}

function showExportModal() {
  if (!currentProject) return;
  // Pre-fill with persisted preparedBy value
  els.inputPreparedBy.value = ws.preparedBy || '';
  els.modalExportPdf.classList.remove('hidden');
  setTimeout(() => els.inputPreparedBy.focus(), 50);
}

function hideExportModal() {
  els.modalExportPdf.classList.add('hidden');
}

function showExportCharacterModal() {
  if (!currentProject) return;
  const characters = (currentProject.characters || [])
    .slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  if (!characters.length) {
    setStatusWarn('No characters are available to export.');
    return;
  }
  els.exportCharacterSelect.innerHTML = '<option value="">— select character —</option>' +
    characters.map(character =>
      `<option value="${_escapeHtml(character.characterId)}">${_escapeHtml(character.name || 'Unnamed Character')}</option>`
    ).join('');
  els.exportCharacterSelect.value = '';
  els.modalExportCharacter.classList.remove('hidden');
  setTimeout(() => els.exportCharacterSelect.focus(), 50);
}

function hideExportCharacterModal() {
  els.modalExportCharacter?.classList.add('hidden');
}

async function submitExportPdf() {
  const preparedBy = els.inputPreparedBy.value.trim();

  // Persist preparedBy for next time
  ws.preparedBy = preparedBy;
  await saveWorkspaceSettings();

  hideExportModal();
  setStatusInfo('Exporting ADR List PDF…');

  const result = await window.api.export.adrListPdf({ preparedBy });

  if (!result.success) {
    if (result.error !== 'Export cancelled.') {
      setStatusError(`PDF export failed: ${result.error}`);
    } else {
      setStatusInfo('Export cancelled.');
    }
    return;
  }

  setStatusOk(`PDF exported: ${result.filePath}`);
}

async function submitExportCsv() {
  if (!currentProject) return;
  setStatusInfo('Exporting ADR List CSV…');
  const result = await window.api.export.adrListCsv();
  if (!result.success) {
    if (result.error !== 'Export cancelled.') setStatusError(`CSV export failed: ${result.error}`);
    else setStatusInfo('Export cancelled.');
    return;
  }
  setStatusOk(`CSV exported: ${result.filePath}`);
}

async function submitExportReport() {
  if (!currentProject) return;
  setStatusInfo('Exporting ADR Session Report...');
  const result = await window.api.export.adrSessionReport();
  if (!result.success) {
    if (result.error !== 'Export cancelled.') setStatusError(`ADR report export failed: ${result.error}`);
    else setStatusInfo('Export cancelled.');
    return;
  }
  setStatusOk(`ADR report exported: ${result.folderPath}`);
}
// ═══════════════════════════════════════════════════════════════════════════════

async function submitExportRemoteCueManifest() {
  if (!currentProject) return;
  setStatusInfo('Exporting remote cue manifest...');
  const result = await window.api.export.remoteCueManifest();
  if (!result.success) {
    if (result.error !== 'Export cancelled.') setStatusError(`Remote cue manifest export failed: ${result.error}`);
    else setStatusInfo('Export cancelled.');
    return;
  }

  const cueCount = Number(result.cueCount || 0);
  const assignedCueCount = Number(result.assignedCueCount || 0);
  setStatusOk(`Remote cue manifest exported (${assignedCueCount}/${cueCount} cue${cueCount === 1 ? '' : 's'} assigned): ${result.folderPath}`);
}

function showExportResultModal(result, exportOffsetMs, scope = null) {
  const stems = Array.isArray(result.renderedFiles) ? result.renderedFiles : [];
  const missing = Array.isArray(result.missingFiles) ? result.missingFiles : [];
  const unsupported = Array.isArray(result.unsupportedFiles) ? result.unsupportedFiles : [];
  const skippedSelected = Array.isArray(result.skippedSelectedRows) ? result.skippedSelectedRows : [];
  const placedCount = stems.reduce((sum, stem) => sum + Number(stem.placedTakeCount || 0), 0);
  const warningCount = missing.length + unsupported.length + skippedSelected.length;
  const scopeLabel = scope?.type === 'character'
    ? `Character export: ${scope.name || 'Character'}`
    : 'Full project export';

  if (!els.modalExportResult) {
    window.api.dialog.showInfo({
      title: 'Full-Length Export Result',
      message: [
        scopeLabel,
        `Offset: ${exportOffsetMs} ms`,
        `Stems: ${stems.length}`,
        `Placed: ${placedCount}`,
        `Skipped selected: ${skippedSelected.length}`,
        `Warnings: ${warningCount}`,
        `Package: ${result.packageRoot || '-'}`,
      ].join('\n'),
    }).catch(() => {});
    return;
  }

  els.exportResultSubtitle.textContent = warningCount > 0
    ? `${scopeLabel} — completed with warnings`
    : `${scopeLabel} — completed`;
  els.exportResultOffset.textContent = `${exportOffsetMs} ms`;
  els.exportResultStems.textContent = String(stems.length);
  els.exportResultPlaced.textContent = String(placedCount);
  els.exportResultWarnings.textContent = String(warningCount);
  els.exportResultPackagePath.textContent = result.packageRoot || '-';
  els.exportResultReportPaths.innerHTML = [
    result.summaryPath ? `TXT: ${_escapeHtml(result.summaryPath)}` : '',
    result.csvPath ? `CSV: ${_escapeHtml(result.csvPath)}` : '',
    result.jsonPath ? `JSON: ${_escapeHtml(result.jsonPath)}` : '',
  ].filter(Boolean).join('<br>') || '-';

  if (stems.length) {
    els.exportResultStemList.innerHTML = stems.map(stem => `
      <div class="export-result-stem-row" title="${_escapeHtml(stem.destPath || '')}">
        <span>${_escapeHtml(stem.characterName || 'Character')}</span>
        <span>${_escapeHtml(stem.laneName || 'Mic')}</span>
        <span class="export-result-stem-count">${Number(stem.placedTakeCount || 0)} take${Number(stem.placedTakeCount || 0) === 1 ? '' : 's'}</span>
      </div>
    `).join('');
  } else {
    els.exportResultStemList.textContent = 'No stems rendered.';
  }

  els.modalExportResult.classList.remove('hidden');
}

function hideExportResultModal() {
  els.modalExportResult?.classList.add('hidden');
}

async function submitExportGoodTakesPackage() {
  return submitExportGoodTakesPackageForCharacter(null);
}

async function submitExportGoodTakesPackageForCharacter(characterId = null) {
  if (!currentProject) return;
  if (els.audioEngineRecordingOffsetMs) {
    ws.recordingOffsetMs = getRecordingOffsetMsFromInput();
    els.audioEngineRecordingOffsetMs.value = ws.recordingOffsetMs;
    updateRecordingOffsetFeedback();
    await saveWorkspaceSettings({ persist: true });
  }
  const character = characterId
    ? (currentProject.characters || []).find(item => item.characterId === characterId)
    : null;
  setStatusInfo(character ? `Exporting full-length good takes for ${character.name || 'character'}...` : 'Exporting full-length good takes...');
  const exportOffsetMs = getRecordingOffsetMs();
  const result = await window.api.export.goodTakesPackage({
    recordingOffsetMs: exportOffsetMs,
    characterId: characterId || null,
  });
  if (!result.success) {
    if (result.error !== 'Export cancelled.') setStatusError(`Full-length good takes export failed: ${result.error}`);
    else setStatusInfo('Export cancelled.');
    return;
  }

  const stemCount = Array.isArray(result.renderedFiles) ? result.renderedFiles.length : Array.isArray(result.copiedFiles) ? result.copiedFiles.length : 0;
  const missingCount = Array.isArray(result.missingFiles) ? result.missingFiles.length : 0;
  const unsupportedCount = Array.isArray(result.unsupportedFiles) ? result.unsupportedFiles.length : 0;
  const skippedSelectedCount = Array.isArray(result.skippedSelectedRows) ? result.skippedSelectedRows.length : 0;
  showExportResultModal(result, exportOffsetMs, character ? { type: 'character', name: character.name || '' } : null);
  if (missingCount > 0 || unsupportedCount > 0 || skippedSelectedCount > 0) {
    setStatusWarn(`${character ? `${character.name} stems` : 'Full-length stems'} exported with ${exportOffsetMs}ms offset, ${missingCount} missing, ${unsupportedCount} unsupported, and ${skippedSelectedCount} selected row(s) not placed: ${result.packageRoot}`);
    return;
  }
  setStatusOk(`${character ? `${character.name} good takes` : 'Full-length good takes'} exported with ${exportOffsetMs}ms offset (${stemCount} stem${stemCount === 1 ? '' : 's'}): ${result.packageRoot}`);
}

async function submitExportCharacterGoodTakes() {
  if (!currentProject) return;
  const characterId = els.exportCharacterSelect?.value || '';
  if (!characterId) {
    setStatusWarn('Select a character to export.');
    els.exportCharacterSelect?.focus();
    return;
  }
  hideExportCharacterModal();
  await submitExportGoodTakesPackageForCharacter(characterId);
}

function formatDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(undefined, { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
  catch { return iso; }
}
function formatDuration(s) {
  if (s == null || !isFinite(s)) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(2);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(5,'0')}` : `${m}:${String(sec).padStart(5,'0')}`;
}
function formatFrameRate(raw, display) {
  if (display) return `${display} fps`;
  if (!raw) return '—';
  if (raw.includes('/')) { const [n,d] = raw.split('/').map(Number); if (d) { const fps=n/d; return `${fps.toFixed(fps%1===0?0:3)} fps`; } }
  return `${raw} fps`;
}
function channelLabel(n) { if (n===1) return '1 (Mono)'; if (n===2) return '2 (Stereo)'; if (n===6) return '6 (5.1)'; return String(n); }
function truncatePath(p, maxLen) {
  if (!p || p.length <= maxLen) return p;
  const parts = p.split(/[/\\]/);
  if (parts.length > 3) return '…/' + parts.slice(-2).join('/');
  return '…' + p.slice(-(maxLen-1));
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESIZE OBSERVER
// ═══════════════════════════════════════════════════════════════════════════════

const resizeObserver = new ResizeObserver(() => {
  if (!peakData) return;
  const rect   = els.waveformCanvas.getBoundingClientRect();
  canvasWidth  = rect.width;
  canvasHeight = rect.height;
  renderAll();
});
resizeObserver.observe(els.waveformWrap);

let timelineResizeStartY = 0;
let timelineResizeStartHeight = wsDefaults.waveformHeightPx;

function setTimelineResizeHeightFromPointer(clientY) {
  const deltaY = timelineResizeStartY - clientY;
  applyWaveformAreaHeight(timelineResizeStartHeight + deltaY);
}

function commitWaveformAreaHeight() {
  applyWaveformAreaHeight(ws.waveformHeightPx);
  saveWorkspaceSettings({ persist: true }).catch(() => {});
}

function setWaveformVisualScaleFromClientY(clientY) {
  const rect = els.waveformScaleControl.getBoundingClientRect();
  const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  waveformVisualScale = 0.05 + ratio * 0.95;
  els.waveformScaleControl.setAttribute('aria-valuenow', waveformVisualScale.toFixed(2));
  els.waveformScaleHandle.style.top = `${(1 - ratio) * 100}%`;
  renderAll();
}

els.waveformScaleControl?.addEventListener('pointerdown', e => {
  e.preventDefault();
  els.waveformScaleControl.setPointerCapture(e.pointerId);
  setWaveformVisualScaleFromClientY(e.clientY);
});
els.waveformScaleControl?.addEventListener('pointermove', e => {
  if (!els.waveformScaleControl.hasPointerCapture(e.pointerId)) return;
  setWaveformVisualScaleFromClientY(e.clientY);
});

els.timelineResizeHandle?.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  timelineResizeStartY = e.clientY;
  timelineResizeStartHeight = ws.waveformHeightPx || wsDefaults.waveformHeightPx;
  document.body.classList.add('timeline-resizing');
  els.timelineResizeHandle.setPointerCapture(e.pointerId);
});

els.timelineResizeHandle?.addEventListener('pointermove', (e) => {
  if (!els.timelineResizeHandle.hasPointerCapture(e.pointerId)) return;
  setTimelineResizeHeightFromPointer(e.clientY);
});

els.timelineResizeHandle?.addEventListener('pointerup', (e) => {
  if (els.timelineResizeHandle.hasPointerCapture(e.pointerId)) {
    els.timelineResizeHandle.releasePointerCapture(e.pointerId);
  }
  document.body.classList.remove('timeline-resizing');
  commitWaveformAreaHeight();
});

els.timelineResizeHandle?.addEventListener('pointercancel', (e) => {
  if (els.timelineResizeHandle.hasPointerCapture(e.pointerId)) {
    els.timelineResizeHandle.releasePointerCapture(e.pointerId);
  }
  document.body.classList.remove('timeline-resizing');
  commitWaveformAreaHeight();
});

els.timelineResizeHandle?.addEventListener('keydown', (e) => {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const step = e.shiftKey ? 30 : 10;
  if (e.key === 'ArrowUp') applyWaveformAreaHeight((ws.waveformHeightPx || wsDefaults.waveformHeightPx) + step);
  if (e.key === 'ArrowDown') applyWaveformAreaHeight((ws.waveformHeightPx || wsDefaults.waveformHeightPx) - step);
  if (e.key === 'Home') applyWaveformAreaHeight(WAVEFORM_AREA_MIN_HEIGHT);
  if (e.key === 'End') applyWaveformAreaHeight(getWaveformAreaMaxHeight());
  commitWaveformAreaHeight();
});

window.addEventListener('resize', () => {
  applyWaveformAreaHeight(ws.waveformHeightPx || wsDefaults.waveformHeightPx);
});

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT EVENTS
// ═══════════════════════════════════════════════════════════════════════════════

// Waveform scrub
function onWaveformMouseDown(e) {
  if (!peakData) return;
  isScrubbing = true;
  seekToViewX(e.clientX - els.waveformWrap.getBoundingClientRect().left);
}
document.addEventListener('mousemove', (e) => {
  if (!isScrubbing || !peakData) return;
  const rect = els.waveformWrap.getBoundingClientRect();
  seekToViewX(Math.max(0, Math.min(canvasWidth, e.clientX - rect.left)));
});
document.addEventListener('mouseup', () => { isScrubbing = false; });

// ── Ruler drag-select ─────────────────────────────────────────────────────────
//
// Single click  → seek (existing behaviour preserved)
// Click-drag    → set In/Out range from dragged span, frame-accurate at all zooms
//
// Drag detection: movement ≥ RULER_DRAG_THRESHOLD px before mouseup = drag.
// On drag start: if a cue is currently selected, deselect it automatically
//   so the user enters a clean spotting state.
//
// The drag-select uses the same viewport model (viewXToSeconds, secondsToFrames)
// as Mark In/Out, so it is accurate at all zoom levels and scroll offsets.

const RULER_DRAG_THRESHOLD = 4;  // pixels; below this → treat as click

let _rulerDragActive     = false;  // true while a ruler mousedown is held
let _rulerDragStartX     = 0;      // mouseX at mousedown
let _rulerDragStartSec   = 0;      // timeline seconds at mousedown
let _rulerDragMoved      = false;  // became true once threshold exceeded

els.timelineRuler.addEventListener('mousedown', (e) => {
  if (!peakData || e.button !== 0) return;
  e.preventDefault();

  _rulerDragActive   = true;
  _rulerDragMoved    = false;
  _rulerDragStartX   = e.clientX;
  _rulerDragStartSec = viewXToSeconds(e.clientX - els.timelineRuler.getBoundingClientRect().left);
});

document.addEventListener('mousemove', async (e) => {
  if (!_rulerDragActive || !peakData) return;

  const dx = e.clientX - _rulerDragStartX;

  if (!_rulerDragMoved && Math.abs(dx) < RULER_DRAG_THRESHOLD) return;

  // First move past threshold: enter drag mode
  if (!_rulerDragMoved) {
    _rulerDragMoved = true;

    // Auto-deselect any active cue so we enter clean spotting mode
    if (selectedCueId) {
      await deselectCue();
      if (selectedCueId) {
        _rulerDragActive = false;
        _rulerDragMoved = false;
        return;
      }
    }
  }

  // Compute current cursor time
  const rect       = els.timelineRuler.getBoundingClientRect();
  const cursorPx   = Math.max(0, Math.min(canvasWidth, e.clientX - rect.left));
  const cursorSec  = viewXToSeconds(cursorPx);

  // In is the earlier time, Out is the later — order by position, not drag direction
  const startSec = _rulerDragStartSec;
  const endSec   = cursorSec;

  const inSec  = Math.min(startSec, endSec);
  const outSec = Math.max(startSec, endSec);

  const inF  = secondsToFrames(Math.max(0, inSec));
  const outF = secondsToFrames(Math.min(getTotalDuration(), outSec));

  if (outF > inF) {
    regionInFrames  = inF;
    regionOutFrames = outF;
    updateRegionPanelUI();
    updateRegionHighlight();
    updateCreateCueButton();
    updateLoopButton();
  }
});

document.addEventListener('mouseup', (e) => {
  if (!_rulerDragActive) return;
  const wasDrag = _rulerDragMoved;
  _rulerDragActive = false;
  _rulerDragMoved  = false;

  if (!peakData) return;

  if (!wasDrag) {
    // Single click → seek (existing behaviour)
    seekToViewX(e.clientX - els.timelineRuler.getBoundingClientRect().left);
  }
  // Drag → range already set in mousemove; nothing extra to do
});

// Wheel: Ctrl/Cmd = zoom; plain = pan
els.waveformWrap.addEventListener('wheel', (e) => {
  if (!peakData) return;
  e.preventDefault();
  const isMac    = navigator.platform.toUpperCase().includes('MAC');
  const isZoomMod = isMac ? e.metaKey : e.ctrlKey;
  if (isZoomMod) {
    const rect        = els.waveformWrap.getBoundingClientRect();
    const cursorPx    = e.clientX - rect.left;
    const cursorRatio = Math.max(0, Math.min(1, cursorPx / canvasWidth));
    const focalSec    = viewXToSeconds(cursorPx);
    if (e.deltaY < 0 && zoomIndex < ZOOM_LEVELS.length - 1) applyZoom(zoomIndex + 1, focalSec, cursorRatio);
    else if (e.deltaY > 0 && zoomIndex > 0)                 applyZoom(zoomIndex - 1, focalSec, cursorRatio);
  } else {
    pauseAutoScroll();
    const win = getViewWindow();
    const delta = e.deltaX !== 0 ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    if (delta !== 0) panBy((delta / canvasWidth) * win);
  }
}, { passive: false });

// Scrollbar
els.timelineScrollbarTrack.addEventListener('click', (e) => {
  if (!peakData || e.target === els.timelineScrollbarThumb) return;
  const r   = (e.clientX - els.timelineScrollbarTrack.getBoundingClientRect().left) / canvasWidth;
  viewStart = clampViewStart(r * (getTotalDuration() - getViewWindow()));
  pauseAutoScroll(); renderAll();
});
els.timelineScrollbarThumb.addEventListener('mousedown', (e) => {
  if (!peakData) return;
  isScrollDragging = true; scrollDragStartX = e.clientX; scrollDragStartVS = viewStart;
  els.timelineScrollbarThumb.classList.add('dragging');
  e.preventDefault(); e.stopPropagation();
});
document.addEventListener('mousemove', (e) => {
  if (!isScrollDragging || !peakData) return;
  const trackW = els.timelineScrollbarTrack.getBoundingClientRect().width;
  const dur = getTotalDuration(), win = getViewWindow();
  viewStart = clampViewStart(scrollDragStartVS + ((e.clientX - scrollDragStartX) / trackW) * (dur - win));
  pauseAutoScroll(); renderAll();
});
document.addEventListener('mouseup', () => {
  if (isScrollDragging) { isScrollDragging = false; els.timelineScrollbarThumb.classList.remove('dragging'); }
});
document.addEventListener('pointerdown', event => {
  hideRecordModeMenu();
  if (!recordArmed) return;
  const target = event.target;
  if (target?.closest?.('#btn-record, #btn-play')) return;
  disarmRecord();
}, true);

// Zoom buttons
els.btnZoomIn.addEventListener('click',  () => zoomIn());
els.btnZoomOut.addEventListener('click', () => zoomOut());
els.btnFitProject.addEventListener('click', fitProject);
els.btnZoomSelection.addEventListener('click', () => {
  if (regionInFrames !== null && regionOutFrames !== null) zoomToSelection();
});

// Transport
els.btnPlay.addEventListener('click',    togglePlay);
els.btnStop.addEventListener('click',    handleTransportStop);

els.btnRecord.addEventListener('click', () => {
  handleRecordCommand();
});
els.btnRecord.addEventListener('contextmenu', event => {
  event.preventDefault();
  showRecordModeMenu(event.clientX, event.clientY);
});

// ── Audio input device selector ───────────────────────────────────────────────

els.audioInputSelect.addEventListener('change', async () => {
  const deviceId = els.audioInputSelect.value;
  if (!deviceId) {
    // Operator selected the placeholder "Select input…" option
    audioInputDeviceId = null;
    audioInputReady    = false;
    setAudioInputStatus('none', 'No input selected');
    updateRecordButton();
    return;
  }
  // Validate the selected device — triggers OS permission prompt if needed
  await validateAudioInput(deviceId);
});

// Re-enumerate when devices are plugged/unplugged
if (navigator.mediaDevices) {
  navigator.mediaDevices.ondevicechange = async () => {
    await enumerateAudioInputs();
    // If the active device was unplugged, audioInputReady will have been cleared
    // and the status dot updated inside enumerateAudioInputs.
  };
}

// Enumerate on startup — labels may be blank until permission is granted,
// which is fine: they populate after the first device selection.
enumerateAudioInputs();
els.btnRefreshAudioEngine.addEventListener('click', () => {
  refreshAudioEnginePanel({ restartEngine: true, reopenSelected: true });
});
els.audioEngineDeviceSelect.addEventListener('change', () => {
  nativeDeviceOpen = false;
  nativeDeviceOpenMode = null;
  stopNativeGuidePlayback();
  applyMonitorState();
  ws.nativeAudioSetup = {
    ...wsDefaults.nativeAudioSetup,
    ...(ws.nativeAudioSetup || {}),
    deviceId: els.audioEngineDeviceSelect.value || '',
  };
  renderNativeLaneSourceOptions(getSelectedNativeDevice());
  renderNativeOutputOptions(getSelectedNativeDevice());
  els.btnOpenAudioEngineDevice.disabled = nativeAudioPanelBusy || !els.audioEngineDeviceSelect.value;
  els.btnOpenAudioEngineDiagnostic.disabled = nativeAudioPanelBusy || !els.audioEngineDeviceSelect.value;
  updateNativeRecordButtons(false);
  saveNativeAudioSetup().catch(err => setStatusWarn('Audio setup save failed: ' + err.message));
});
els.audioEngineBufferSize.addEventListener('change', () => {
  saveNativeAudioSetup().catch(err => setStatusWarn('Audio setup save failed: ' + err.message));
  reopenNativeDeviceForBufferChange().catch(err => setStatusError('Buffer change failed: ' + err.message));
});

async function commitRecordingOffsetFromInput() {
  ws.recordingOffsetMs = getRecordingOffsetMsFromInput();
  els.audioEngineRecordingOffsetMs.value = ws.recordingOffsetMs;
  updateRecordingOffsetFeedback();
  await saveWorkspaceSettings({ persist: true });
  stopReviewPlayback();
  stopGoodTakesPlayback();
  if (isPlaying) {
    const timelineSeconds = els.videoPlayer?.currentTime || 0;
    syncReviewPlayback(timelineSeconds).catch(() => {});
    syncGoodTakesPlayback(timelineSeconds).catch(() => {});
  }
  _hasUnsavedChanges = false;
  updateWindowTitle();
  setStatusInfo(`${ws.recordingOffsetMs}ms recording offset saved.`);
}

els.audioEngineRecordingOffsetMs?.addEventListener('change', () => {
  commitRecordingOffsetFromInput().catch(err => setStatusWarn('Recording offset save failed: ' + err.message));
});
els.audioEngineRecordingOffsetMs?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  commitRecordingOffsetFromInput().catch(err => setStatusWarn('Recording offset save failed: ' + err.message));
  els.audioEngineRecordingOffsetMs.blur();
});
els.audioEngineTalkbackSource.addEventListener('change', () => {
  if (nativeTalkbackActive) configureNativeTalkback(false);
  updateNativeTalkbackButton();
  saveNativeAudioSetup().catch(err => setStatusWarn('Audio setup save failed: ' + err.message));
});
[
  els.audioEngineControlOutputPair,
  els.audioEngineBoothOutputPair,
].forEach(el => el?.addEventListener('change', () => {
  ws.audioOutputMap = getNativeOutputRouting();
  renderAudioEngineRouteMap();
  applyMonitorState();
  saveNativeAudioSetup().catch(err => setStatusWarn('Audio setup save failed: ' + err.message));
  configureNativeRouting().then(() => configureNativeMonitoring());
}));
els.btnAudioEngineTalkback.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  const now = Date.now();
  if (nativeTalkbackLatched) {
    nativeTalkbackLatched = false;
    configureNativeTalkback(false);
    nativeTalkbackLastPointerDown = now;
    return;
  }
  if (now - nativeTalkbackLastPointerDown < 320) {
    nativeTalkbackLatched = true;
    configureNativeTalkback(true);
    nativeTalkbackLastPointerDown = 0;
    return;
  }
  nativeTalkbackLastPointerDown = now;
  configureNativeTalkback(true);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach(type => {
  els.btnAudioEngineTalkback.addEventListener(type, () => {
    if (!nativeTalkbackLatched && nativeTalkbackActive) configureNativeTalkback(false);
  });
});
els.btnOpenAudioEngineDevice.addEventListener('click', openSelectedAudioEngineDevice);
els.btnOpenAudioEngineDiagnostic.addEventListener('click', openSelectedAudioEngineDiagnostic);
els.btnNativeRecordStart.addEventListener('click', startNativeInputRecording);
els.btnNativeRecordStop.addEventListener('click', stopNativeInputRecording);
[
  els.audioEngineMic1Source,
  els.audioEngineMic2Source,
].forEach(el => el.addEventListener('change', () => {
  updateNativeRecordButtons(nativeDeviceOpen);
  configureNativeMonitoring();
  saveNativeAudioSetup().catch(err => setStatusWarn('Audio setup save failed: ' + err.message));
}));
[
  els.audioEngineMic1Arm,
  els.audioEngineMic2Arm,
].forEach(el => el.addEventListener('click', () => {
  toggleButton(el);
  updateNativeRecordButtons(nativeDeviceOpen);
  saveNativeAudioSetup().catch(err => setStatusWarn('Audio setup save failed: ' + err.message));
}));
[
  els.audioEngineMic1Monitor,
  els.audioEngineMic2Monitor,
].forEach(el => el.addEventListener('click', () => {
  toggleButton(el);
  configureNativeMonitoring();
  saveNativeAudioSetup().catch(err => setStatusWarn('Audio setup save failed: ' + err.message));
}));
[
  els.audioEngineMic1Name,
  els.audioEngineMic2Name,
].forEach(el => el.addEventListener('input', () => {
  ws.audioLaneNames = {
    mic1: els.audioEngineMic1Name.value.trim() || 'Mic 1',
    mic2: els.audioEngineMic2Name.value.trim() || 'Mic 2',
  };
  saveNativeAudioSetup().catch(err => setStatusWarn('Audio setup save failed: ' + err.message));
  updateNativeRecordButtons(nativeDeviceOpen);
  configureNativeMonitoring();
}));
els.btnMarkIn.addEventListener('click',  markIn);
els.btnStreamerTarget.addEventListener('click', () => {
  setStreamerTargetAtCurrentPlayhead().catch(err => setStatusError(err.message));
});
els.btnMarkOut.addEventListener('click', markOut);
els.btnLoop.addEventListener('click',    toggleLoop);

// Create Cue button → open modal
els.btnCreateCue.addEventListener('click', handlePrimaryCueAction);

// Waveform generate
els.btnGenerateWaveform.addEventListener('click', generateWaveform);
els.waveformWrap.addEventListener('mousedown', onWaveformMouseDown);

els.btnInspectorToggle?.addEventListener('click', () => {
  const main = document.querySelector('.main-content');
  const collapsed = main?.classList.toggle('info-sidebar-collapsed');
  els.btnInspectorToggle.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
  els.btnInspectorToggle.title = collapsed ? 'Show inspector' : 'Hide inspector';
});

// Character filter change
els.cueCharacterFilter.addEventListener('change', () => {
  cueListFilter = els.cueCharacterFilter.value;
  renderCueList();
});

// Cue status toggle
els.btnCueStatus.addEventListener('click', toggleCueStatus);

// Cue detail
els.btnSaveCue.addEventListener('click',   saveCueEdits);
els.btnDeleteCue.addEventListener('click', deleteCue);
els.cueOverlapList?.addEventListener('click', (event) => {
  const row = event.target.closest('.cue-overlap-row');
  if (!row?.dataset.cueId) return;
  selectCue(row.dataset.cueId).catch(err => setStatusError(err.message));
});
els.cueDetailTakes.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  if (target.dataset.action === 'toggle-good-take') {
    toggleGoodTake(target.dataset.takeId).catch(err => setStatusError(err.message));
  }

  if (target.dataset.action === 'toggle-audition-track') {
    toggleAuditionTrack(target.dataset.takeId, target.dataset.laneId);
  }

  if (target.dataset.action === 'toggle-takes-mute') {
    takesTrackMuted = !takesTrackMuted;
    applyMonitorState();
    if (!isTakesTrackAudible()) {
      stopReviewPlayback();
      stopGoodTakesPlayback();
    } else if (isPlaying) {
      resyncPlaybackTargetsForCurrentTimeline({ guide: false }).catch(() => {});
    }
  }

  if (target.dataset.action === 'toggle-takes-solo') {
    takesTrackSoloed = !takesTrackSoloed;
    applyMonitorState();
    if (!isTakesTrackAudible()) {
      stopReviewPlayback();
      stopGoodTakesPlayback();
    } else if (isPlaying) {
      resyncPlaybackTargetsForCurrentTimeline({ guide: false }).catch(() => {});
    }
  }
});
els.cueDetailTakes.addEventListener('contextmenu', async (event) => {
  const row = event.target.closest('.take-group, .take-lane-row');
  if (!row) return;
  event.preventDefault();
  const filePath = row.dataset.filePath || row.closest('.take-group')?.dataset.filePath || '';
  if (!filePath) {
    setStatusWarn('No recorded file is attached to this take.');
    return;
  }
  const result = await window.api.app.revealInFolder(filePath);
  if (!result?.success) {
    setStatusError(result?.error || 'Could not reveal the recorded file.');
    return;
  }
  setStatusInfo('Recorded take revealed in file location.');
});

// Playback settings toggles
els.settingPrerollEnabled.addEventListener('change', () => {
  ws.cuePrerollEnabled = els.settingPrerollEnabled.checked;
  updateCompactPlaybackButtons();
  saveWorkspaceSettings();
  markUnsaved();
});
els.settingOverlayEnabled.addEventListener('change', () => {
  ws.dialogueOverlayEnabled = els.settingOverlayEnabled.checked;
  updateOverlaySubSettingsVisibility();
  updateDialogueOverlay();
  updateCompactPlaybackButtons();
  saveWorkspaceSettings();
  markUnsaved();
});
els.settingBoothTcEnabled.addEventListener('change', () => {
  ws.boothTimecodeEnabled = els.settingBoothTcEnabled.checked;
  updateCompactPlaybackButtons();
  saveWorkspaceSettings();
  markUnsaved();
  boothSend({
    type: 'boothDisplaySettings',
    showTimecode: ws.boothTimecodeEnabled,
    frameRate: currentProject?.settings?.frameRate || '25',
  });
});

// Playback volume slider
els.settingPlaybackVolume.addEventListener('input', () => {
  const v = parseFloat(els.settingPlaybackVolume.value);
  ws.playbackVolume = v;
  els.settingPlaybackVolPct.textContent = Math.round(v * 100) + '%';
  if (els.waveformVideoVolume) els.waveformVideoVolume.value = v;
  applyMonitorState();  // live update — does NOT affect beep
  if (isPlaying) syncNativeGuidePlayback(els.videoPlayer.currentTime || 0, true).catch(() => {});
  saveWorkspaceSettings();
  markUnsaved();
});

els.waveformVideoVolume?.addEventListener('input', () => {
  const v = parseFloat(els.waveformVideoVolume.value);
  ws.playbackVolume = v;
  els.settingPlaybackVolume.value = v;
  els.settingPlaybackVolPct.textContent = Math.round(v * 100) + '%';
  applyMonitorState();
  if (isPlaying) syncNativeGuidePlayback(els.videoPlayer.currentTime || 0, true).catch(() => {});
  saveWorkspaceSettings();
  markUnsaved();
});

els.videoTrackMute.addEventListener('click', () => {
  videoTrackMuted = !videoTrackMuted;
  applyMonitorState();
  if (isPlaying) syncNativeGuidePlayback(els.videoPlayer.currentTime || 0, true).catch(() => {});
  if (!isTakesTrackAudible()) {
    stopReviewPlayback();
    stopGoodTakesPlayback();
  }
});

els.videoTrackSolo.addEventListener('click', () => {
  videoTrackSoloed = !videoTrackSoloed;
  applyMonitorState();
  if (isPlaying) syncNativeGuidePlayback(els.videoPlayer.currentTime || 0, true).catch(() => {});
  if (!isTakesTrackAudible()) {
    stopReviewPlayback();
    stopGoodTakesPlayback();
  }
});

// Beep volume slider
els.settingBeepVolume.addEventListener('input', () => {
  const v = parseFloat(els.settingBeepVolume.value);
  ws.cueBeepVolume = v;
  els.settingBeepVolPct.textContent = Math.round(v * 100) + '%';
  if (els.beepModalVolume) els.beepModalVolume.value = v;
  updateCompactPlaybackButtons();
  saveWorkspaceSettings();
  markUnsaved();
});

els.btnBoothTcToggle?.addEventListener('click', () => {
  els.settingBoothTcEnabled.checked = !ws.boothTimecodeEnabled;
  els.settingBoothTcEnabled.dispatchEvent(new Event('change'));
});

els.btnPrerollToggle?.addEventListener('click', () => {
  togglePrerollEnabled();
});

els.btnGoodTakesPlayback?.addEventListener('click', () => {
  goodTakesPlaybackEnabled = !goodTakesPlaybackEnabled;
  if (!goodTakesPlaybackEnabled) stopGoodTakesPlayback();
  if (goodTakesPlaybackEnabled && isPlaying) {
    syncGoodTakesPlayback(els.videoPlayer.currentTime || 0).catch(() => {});
  }
  updateCompactPlaybackButtons();
  const laneNote = activeAuditionLaneId ? ` using ${activeAuditionLaneId}` : '';
  setStatusInfo(goodTakesPlaybackEnabled
    ? `Good takes context playback on${laneNote}.`
    : 'Good takes context playback off.');
});

els.btnDialogueOverlayToggle?.addEventListener('click', () => {
  els.settingOverlayEnabled.checked = !ws.dialogueOverlayEnabled;
  els.settingOverlayEnabled.dispatchEvent(new Event('change'));
});

els.dxOverlayInline?.addEventListener('click', e => {
  const color = e.target.closest('.dx-color-dot');
  if (color) {
    ws.dialogueOverlayColor = color.dataset.color;
    els.overlayColorPicker.querySelectorAll('.color-swatch').forEach(b => b.classList.toggle('active', b.dataset.color === ws.dialogueOverlayColor));
  }
  const size = e.target.closest('.dx-size-btn');
  if (size) {
    ws.dialogueOverlayFontSize = size.dataset.size;
    els.overlayFontSize.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.size === ws.dialogueOverlayFontSize));
  }
  if (!color && !size) return;
  updateCompactPlaybackButtons();
  updateDialogueOverlay();
  saveWorkspaceSettings();
  markUnsaved();
  boothSend({
    type: 'overlaySettings',
    overlayColor: ws.dialogueOverlayColor,
    overlayFontSize: ws.dialogueOverlayFontSize,
    showTimecode: ws.boothTimecodeEnabled,
    frameRate: currentProject?.settings?.frameRate || '25',
  });
});

els.btnBeepToggle?.addEventListener('click', () => {
  const next = ws.cueBeepVolume > 0 ? 0 : 0.45;
  els.settingBeepVolume.value = next;
  els.settingBeepVolume.dispatchEvent(new Event('input'));
});

els.btnBeepSettings?.addEventListener('click', () => {
  els.beepTypeSelect.value = ws.cueBeepType;
  els.beepModalVolume.value = ws.cueBeepVolume;
  els.modalBeepSettings.classList.remove('hidden');
});

els.btnBeepModalClose?.addEventListener('click', () => {
  els.modalBeepSettings.classList.add('hidden');
});

els.modalBeepSettings?.addEventListener('click', e => {
  if (e.target === els.modalBeepSettings) els.modalBeepSettings.classList.add('hidden');
});

els.shortcutsList?.addEventListener('click', event => {
  const row = event.target.closest('.shortcut-row');
  if (!row?.dataset.commandId) return;
  if (event.target.closest('[data-action="capture-shortcut"]')) {
    shortcutCaptureCommandId = row.dataset.commandId;
    const command = commandRegistry.find(item => item.id === shortcutCaptureCommandId);
    setShortcutHint(`Press a new shortcut for ${command?.label || 'this command'}. Escape cancels.`);
    renderKeyboardShortcuts();
    return;
  }
  if (event.target.closest('[data-action="clear-shortcut"]')) {
    setCommandShortcut(row.dataset.commandId, '');
    setShortcutHint('Shortcut cleared.');
    return;
  }
  if (event.target.closest('[data-action="midi-learn"]')) {
    midiLearnCommandId = row.dataset.commandId;
    const command = commandRegistry.find(item => item.id === midiLearnCommandId);
    setShortcutHint(`Move or press the MIDI control for ${command?.label || 'this command'}. Escape cancels.`);
    renderKeyboardShortcuts();
    return;
  }
  if (event.target.closest('[data-action="midi-clear"]')) {
    delete midiMappings[row.dataset.commandId];
    saveMidiMappings();
    renderKeyboardShortcuts();
    setShortcutHint('MIDI mapping cleared.');
  }
});

els.btnShortcutsClose?.addEventListener('click', hideKeyboardShortcutsModal);
els.btnShortcutsReset?.addEventListener('click', resetKeyboardShortcuts);
els.btnMidiEnable?.addEventListener('click', enableMidiAccess);
els.modalKeyboardShortcuts?.addEventListener('click', event => {
  if (event.target === els.modalKeyboardShortcuts) hideKeyboardShortcutsModal();
});

els.btnExportResultClose?.addEventListener('click', hideExportResultModal);
els.modalExportResult?.addEventListener('click', e => {
  if (e.target === els.modalExportResult) hideExportResultModal();
});
els.btnExportCharacterCancel?.addEventListener('click', hideExportCharacterModal);
els.btnExportCharacterConfirm?.addEventListener('click', () => {
  submitExportCharacterGoodTakes().catch(err => setStatusError(err.message));
});
els.modalExportCharacter?.addEventListener('click', e => {
  if (e.target === els.modalExportCharacter) hideExportCharacterModal();
});

els.beepTypeSelect?.addEventListener('change', () => {
  ws.cueBeepType = els.beepTypeSelect.value === 'click' ? 'click' : 'beep';
  saveWorkspaceSettings();
  markUnsaved();
});

els.beepModalVolume?.addEventListener('input', () => {
  els.settingBeepVolume.value = els.beepModalVolume.value;
  els.settingBeepVolume.dispatchEvent(new Event('input'));
});
els.overlayColorPicker.addEventListener('click', (e) => {
  const swatch = e.target.closest('.color-swatch');
  if (!swatch) return;
  ws.dialogueOverlayColor = swatch.dataset.color;
  els.overlayColorPicker.querySelectorAll('.color-swatch').forEach(b => b.classList.toggle('active', b === swatch));
  updateDialogueOverlay();
  saveWorkspaceSettings();
  markUnsaved();
  boothSend({
    type: 'overlaySettings',
    overlayColor: ws.dialogueOverlayColor,
    overlayFontSize: ws.dialogueOverlayFontSize,
    showTimecode: ws.boothTimecodeEnabled,
    frameRate: currentProject?.settings?.frameRate || '25',
  });
});
els.overlayFontSize.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  ws.dialogueOverlayFontSize = btn.dataset.size;
  els.overlayFontSize.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
  updateDialogueOverlay();
  saveWorkspaceSettings();
  markUnsaved();
  boothSend({
    type: 'overlaySettings',
    overlayColor: ws.dialogueOverlayColor,
    overlayFontSize: ws.dialogueOverlayFontSize,
    showTimecode: ws.boothTimecodeEnabled,
    frameRate: currentProject?.settings?.frameRate || '25',
  });
});

// Keyboard
document.addEventListener('pointerup', (e) => {
  const button = e.target.closest?.('button, [role="button"]');
  if (!button || button.matches('input, textarea, select')) return;
  requestAnimationFrame(() => button.blur());
});

document.addEventListener('change', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'range') {
    requestAnimationFrame(() => e.target.blur());
  }
  if (e.target instanceof HTMLSelectElement) {
    requestAnimationFrame(() => e.target.blur());
  }
});

document.querySelectorAll('.audio-engine-select, .audio-input-select').forEach(select => {
  select.addEventListener('keydown', (e) => {
    if (e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    select.blur();
    togglePlay();
  });
});

async function handleCancelCommand() {
  if (recordArmed) {
    disarmRecord();
    return;
  }
  hideRecordModeMenu();
  if (shortcutCaptureCommandId) {
    shortcutCaptureCommandId = null;
    setShortcutHint('Shortcut edit cancelled.');
    renderKeyboardShortcuts();
    return;
  }
  if (midiLearnCommandId) {
    midiLearnCommandId = null;
    setShortcutHint('MIDI learn cancelled.');
    renderKeyboardShortcuts();
    return;
  }
  if (els.modalKeyboardShortcuts && !els.modalKeyboardShortcuts.classList.contains('hidden')) { hideKeyboardShortcutsModal(); return; }
  if (!els.modalActors.classList.contains('hidden'))      { hideActorModal();      return; }
  if (!els.modalCreateCue.classList.contains('hidden'))   { hideCreateCueModal();  return; }
  if (!els.modalNewProject.classList.contains('hidden'))  { hideNewProjectModal(); return; }
  if (!els.modalExportPdf.classList.contains('hidden'))   { hideExportModal();     return; }
  if (els.modalExportResult && !els.modalExportResult.classList.contains('hidden')) { hideExportResultModal(); return; }
  const projectInfoModal = document.getElementById('modal-project-info');
  if (projectInfoModal && !projectInfoModal.classList.contains('hidden')) {
    projectInfoModal.classList.add('hidden');
    return;
  }
  if (selectedCueId) {
    const hadSelectedCue = !!selectedCueId;
    await deselectCue();
    if (hadSelectedCue && !selectedCueId) {
      setStatusInfo('Cue deselected. In/Out cleared. Ready to spot.');
    }
    return;
  }
  if (regionInFrames !== null || regionOutFrames !== null) {
    regionInFrames = null;
    regionOutFrames = null;
    regionStreamerTargetFrames = [];
    isLooping = false;
    cancelPreroll();
    updateRegionPanelUI();
    updateRegionHighlight();
    updateLoopButton();
    updateCreateCueButton();
    setStatusInfo('In/Out cleared.');
  }
}

const SHORTCUT_STORAGE_KEY = 'postAdrPro.keyboardShortcuts.v1';
const MIDI_MAP_STORAGE_KEY = 'postAdrPro.midiMap.v1';
let shortcutOverrides = loadShortcutOverrides();
let shortcutCaptureCommandId = null;
let midiMappings = loadMidiMappings();
let midiLearnCommandId = null;
let midiAccess = null;
let midiLastValues = new Map();

const commandRegistry = [
  { id: 'transport.playStop', group: 'Transport', label: 'Play / Stop', defaultShortcut: 'Space', run: () => { blurActiveButton(); togglePlay(); } },
  { id: 'transport.stop', group: 'Transport', label: 'Stop', defaultShortcut: '', run: () => handleTransportStop() },
  { id: 'transport.record', group: 'Transport', label: 'Record', defaultShortcut: 'R', run: () => handleRecordCommand() },
  { id: 'transport.recordModeNormal', group: 'Transport', label: 'Recording Mode: Normal', defaultShortcut: '', run: () => setRecordMode('normal') },
  { id: 'transport.recordModePunchIn', group: 'Transport', label: 'Recording Mode: Punch-in', defaultShortcut: '', run: () => setRecordMode('punch-in') },
  { id: 'cue.markIn', group: 'Cue', label: 'Mark In', defaultShortcut: 'I', run: () => markIn() },
  { id: 'cue.markOut', group: 'Cue', label: 'Mark Out', defaultShortcut: 'O', run: () => markOut() },
  { id: 'cue.create', group: 'Cue', label: 'Create / Update Cue', defaultShortcut: 'Enter', run: () => {
    if (regionInFrames !== null && regionOutFrames !== null && regionOutFrames > regionInFrames && currentProject) handlePrimaryCueAction();
  } },
  { id: 'cue.loop', group: 'Cue', label: 'Loop / Loop Record', defaultShortcut: 'L', run: () => toggleLoop() },
  { id: 'cue.preroll', group: 'Cue', label: 'Cue Pre-roll', defaultShortcut: 'P', run: () => togglePrerollEnabled() },
  { id: 'cue.status', group: 'Cue', label: 'Toggle Cue Open / Completed', defaultShortcut: '', run: () => toggleCueStatus().catch(err => setStatusError(err.message)) },
  { id: 'cue.save', group: 'Cue', label: 'Save Cue Edits', defaultShortcut: '', run: () => saveCueEdits().catch(err => setStatusError(err.message)) },
  { id: 'cue.delete', group: 'Cue', label: 'Delete Selected Cue', defaultShortcut: '', run: () => deleteCue().catch(err => setStatusError(err.message)) },
  { id: 'playback.goodTakes', group: 'Playback', label: 'Good Takes Context Playback', defaultShortcut: '', run: () => els.btnGoodTakesPlayback?.click() },
  { id: 'playback.boothTc', group: 'Playback', label: 'Booth Timecode', defaultShortcut: '', run: () => els.btnBoothTcToggle?.click() },
  { id: 'playback.dxOverlay', group: 'Playback', label: 'Dialogue Overlay', defaultShortcut: '', run: () => els.btnDialogueOverlayToggle?.click() },
  { id: 'playback.beep', group: 'Playback', label: 'Cue Beep On / Off', defaultShortcut: '', run: () => els.btnBeepToggle?.click() },
  { id: 'playback.beepSettings', group: 'Playback', label: 'Beep Settings', defaultShortcut: '', run: () => els.btnBeepSettings?.click() },
  { id: 'playback.videoMute', group: 'Playback', label: 'Mute Video Audio', defaultShortcut: '', run: () => els.videoTrackMute?.click() },
  { id: 'playback.videoSolo', group: 'Playback', label: 'Solo Video Audio', defaultShortcut: '', run: () => els.videoTrackSolo?.click() },
  { id: 'playback.volume', group: 'Playback', label: 'Playback Volume Level', defaultShortcut: '', midiType: 'continuous', run: value => setPlaybackVolume(value) },
  { id: 'timeline.zoomIn', group: 'Timeline', label: 'Zoom In', defaultShortcut: '+', run: () => zoomIn() },
  { id: 'timeline.zoomOut', group: 'Timeline', label: 'Zoom Out', defaultShortcut: '-', run: () => zoomOut() },
  { id: 'timeline.fit', group: 'Timeline', label: 'Fit Project', defaultShortcut: 'F', run: () => fitProject() },
  { id: 'timeline.zoomSelection', group: 'Timeline', label: 'Zoom Selection', defaultShortcut: '', run: () => { if (regionInFrames !== null && regionOutFrames !== null) zoomToSelection(); } },
  { id: 'timeline.panLeft', group: 'Timeline', label: 'Pan Left', defaultShortcut: 'ArrowLeft', run: () => { if (peakData) { pauseAutoScroll(); panBy(-getViewWindow() * 0.1); } } },
  { id: 'timeline.panRight', group: 'Timeline', label: 'Pan Right', defaultShortcut: 'ArrowRight', run: () => { if (peakData) { pauseAutoScroll(); panBy(getViewWindow() * 0.1); } } },
  { id: 'timeline.zoomInKeyboard', group: 'Timeline', label: 'Zoom In (Keyboard)', defaultShortcut: 'Shift+ArrowUp', run: () => zoomIn() },
  { id: 'timeline.zoomOutKeyboard', group: 'Timeline', label: 'Zoom Out (Keyboard)', defaultShortcut: 'Shift+ArrowDown', run: () => zoomOut() },
  { id: 'project.new', group: 'Project', label: 'New Project', defaultShortcut: 'Ctrl+N', run: () => showNewProjectModal() },
  { id: 'project.open', group: 'Project', label: 'Open Project', defaultShortcut: 'Ctrl+O', run: () => els.btnOpenProject?.click() },
  { id: 'project.save', group: 'Project', label: 'Save Project', defaultShortcut: 'Ctrl+S', run: () => els.btnSaveProject?.click() },
  { id: 'project.saveAs', group: 'Project', label: 'Save Project As', defaultShortcut: 'Ctrl+Shift+S', run: () => saveProjectAs().catch(err => setStatusError(err.message)) },
  { id: 'project.loadVideo', group: 'Project', label: 'Load Video', defaultShortcut: 'Ctrl+L', run: () => els.btnLoadVideo?.click() },
  { id: 'project.manageActors', group: 'Project', label: 'Manage Actors', defaultShortcut: 'Ctrl+M', run: () => { if (currentProject) showActorModal(); } },
  { id: 'project.generateWaveform', group: 'Project', label: 'Generate Waveform', defaultShortcut: '', run: () => generateWaveform().catch(err => setStatusError(err.message)) },
  { id: 'audio.refresh', group: 'Audio', label: 'Refresh Audio Engine', defaultShortcut: '', run: () => refreshAudioEnginePanel({ restartEngine: true, reopenSelected: true }) },
  { id: 'audio.openDevice', group: 'Audio', label: 'Open Selected Device', defaultShortcut: '', run: () => openSelectedAudioEngineDevice() },
  { id: 'audio.talkback', group: 'Audio', label: 'Talkback Hold', defaultShortcut: '', midiType: 'hold', run: value => configureNativeTalkback(value == null ? !nativeTalkbackActive : !!value) },
  { id: 'display.booth', group: 'Display', label: 'Open Booth Display', defaultShortcut: '', run: () => els.btnOpenBooth?.click() },
  { id: 'view.inspector', group: 'View', label: 'Show / Hide Inspector', defaultShortcut: '', run: () => els.btnInspectorToggle?.click() },
  { id: 'export.goodTakes', group: 'Export', label: 'Full-Length Good Takes', defaultShortcut: '', run: () => submitExportGoodTakesPackage().catch(err => setStatusError(err.message)) },
  { id: 'export.goodTakesCharacter', group: 'Export', label: 'Full-Length Good Takes for Character', defaultShortcut: '', run: () => showExportCharacterModal() },
  { id: 'export.remoteManifest', group: 'Export', label: 'Remote Cue Manifest', defaultShortcut: '', run: () => submitExportRemoteCueManifest().catch(err => setStatusError(err.message)) },
  { id: 'export.sessionReport', group: 'Export', label: 'ADR Session Report', defaultShortcut: '', run: () => submitExportReport().catch(err => setStatusError(err.message)) },
  { id: 'export.csv', group: 'Export', label: 'ADR List CSV', defaultShortcut: '', run: () => submitExportCsv().catch(err => setStatusError(err.message)) },
  { id: 'export.pdf', group: 'Export', label: 'ADR List PDF', defaultShortcut: '', run: () => showExportModal() },
  { id: 'app.cancelContext', group: 'App', label: 'Cancel / Close / Clear Selection', defaultShortcut: 'Escape', run: () => handleCancelCommand().catch(err => setStatusError(err.message)) },
  { id: 'app.shortcuts', group: 'App', label: 'Keyboard Shortcuts', defaultShortcut: '', run: () => showKeyboardShortcutsModal() },
];

function loadShortcutOverrides() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveShortcutOverrides() {
  localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(shortcutOverrides));
}

function loadMidiMappings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MIDI_MAP_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveMidiMappings() {
  localStorage.setItem(MIDI_MAP_STORAGE_KEY, JSON.stringify(midiMappings));
}

function getCommandShortcut(command) {
  return shortcutOverrides[command.id] ?? command.defaultShortcut ?? '';
}

function setCommandShortcut(commandId, shortcut) {
  shortcutOverrides[commandId] = shortcut;
  saveShortcutOverrides();
  renderKeyboardShortcuts();
}

function resetKeyboardShortcuts() {
  shortcutOverrides = {};
  midiMappings = {};
  saveShortcutOverrides();
  saveMidiMappings();
  renderKeyboardShortcuts();
  setShortcutHint('Default shortcuts and MIDI mappings restored.');
}

function normalizeShortcutKey(event) {
  if (event.code === 'Space' || event.key === ' ') return 'Space';
  if (event.key === 'Esc') return 'Escape';
  if (event.key === '=' || event.key === '+') return '+';
  if (event.key === '_' || event.key === '-') return '-';
  if (/^Arrow/.test(event.key)) return event.key;
  if (/^F\d{1,2}$/.test(event.key)) return event.key;
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}

function eventToShortcut(event) {
  const key = normalizeShortcutKey(event);
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  const hasNonShiftModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (event.shiftKey && key !== '+' && key !== '-' && (hasNonShiftModifier || key.length !== 1 || !/^[A-Z]$/.test(key))) {
    parts.push('Shift');
  }
  parts.push(key);
  return parts.join('+');
}

function shortcutLabel(shortcut) {
  return shortcut || 'Unassigned';
}

function midiMappingLabel(mapping) {
  if (!mapping) return 'Unassigned';
  const channel = Number(mapping.channel) + 1;
  const type = mapping.type === 'cc' ? 'CC' : mapping.type === 'note' ? 'Note' : 'MIDI';
  return `Ch ${channel} ${type} ${mapping.number}`;
}

function midiEventKey(mapping) {
  if (!mapping) return '';
  return [mapping.type, mapping.channel, mapping.number].join(':');
}

function getCommandMidiMapping(command) {
  return midiMappings[command.id] || null;
}

function findCommandForShortcut(shortcut) {
  if (!shortcut) return null;
  return commandRegistry.find(command => getCommandShortcut(command) === shortcut) || null;
}

function findCommandForMidiMapping(mapping) {
  const key = midiEventKey(mapping);
  if (!key) return null;
  return commandRegistry.find(command => midiEventKey(getCommandMidiMapping(command)) === key) || null;
}

function setShortcutHint(message, warning = false) {
  if (!els.shortcutsHint) return;
  els.shortcutsHint.textContent = message;
  els.shortcutsHint.classList.toggle('warning', !!warning);
}

function renderKeyboardShortcuts() {
  if (!els.shortcutsList) return;
  els.shortcutsList.innerHTML = commandRegistry.map(command => `
    <div class="shortcut-row" data-command-id="${_escapeHtml(command.id)}">
      <span class="shortcut-group">${_escapeHtml(command.group)}</span>
      <span class="shortcut-label">${_escapeHtml(command.label)}</span>
      <button type="button" class="btn btn-ghost shortcut-capture${shortcutCaptureCommandId === command.id ? ' capturing' : ''}" data-action="capture-shortcut">
        ${_escapeHtml(shortcutLabel(getCommandShortcut(command)))}
      </button>
      <button type="button" class="btn btn-ghost shortcut-clear" data-action="clear-shortcut">Clear</button>
      <button type="button" class="btn btn-ghost midi-learn${midiLearnCommandId === command.id ? ' capturing' : ''}" data-action="midi-learn">
        ${_escapeHtml(midiMappingLabel(getCommandMidiMapping(command)))}
      </button>
      <button type="button" class="btn btn-ghost midi-clear" data-action="midi-clear">Clear</button>
    </div>
  `).join('');
}

function showKeyboardShortcutsModal() {
  shortcutCaptureCommandId = null;
  setShortcutHint('Click a shortcut, press the new key combination, then close.');
  if (midiAccess) updateMidiStatus(`${midiAccess.inputs.size} MIDI input${midiAccess.inputs.size === 1 ? '' : 's'} ready`, 'ready');
  else updateMidiStatus(navigator.requestMIDIAccess ? 'MIDI not enabled' : 'Web MIDI unavailable', navigator.requestMIDIAccess ? '' : 'warning');
  renderKeyboardShortcuts();
  els.modalKeyboardShortcuts?.classList.remove('hidden');
}

function hideKeyboardShortcutsModal() {
  shortcutCaptureCommandId = null;
  els.modalKeyboardShortcuts?.classList.add('hidden');
}

function captureShortcutForCommand(commandId, event) {
  const shortcut = eventToShortcut(event);
  if (!shortcut) return;
  const command = commandRegistry.find(item => item.id === commandId);
  if (!command) return;
  const existing = findCommandForShortcut(shortcut);
  if (existing && existing.id !== commandId) {
    setShortcutHint(`${shortcut} is already assigned to ${existing.label}.`, true);
    shortcutCaptureCommandId = null;
    renderKeyboardShortcuts();
    return;
  }
  setCommandShortcut(commandId, shortcut);
  shortcutCaptureCommandId = null;
  setShortcutHint(`${command.label} set to ${shortcut}.`);
}

function parseMidiMessage(message) {
  const [status, data1 = 0, data2 = 0] = message.data || [];
  const command = status & 0xf0;
  const channel = status & 0x0f;
  if (command === 0x90 && data2 > 0) return { type: 'note', channel, number: data1, value: data2 / 127 };
  if (command === 0x80 || (command === 0x90 && data2 === 0)) return { type: 'noteOff', channel, number: data1, value: 0 };
  if (command === 0xb0) return { type: 'cc', channel, number: data1, value: data2 / 127 };
  return null;
}

function updateMidiStatus(message, state = '') {
  if (!els.midiStatus) return;
  els.midiStatus.textContent = message;
  els.midiStatus.classList.toggle('ready', state === 'ready');
  els.midiStatus.classList.toggle('warning', state === 'warning');
}

function attachMidiInputs() {
  if (!midiAccess) return;
  midiAccess.inputs.forEach(input => {
    input.onmidimessage = handleMidiMessage;
  });
  updateMidiStatus(`${midiAccess.inputs.size} MIDI input${midiAccess.inputs.size === 1 ? '' : 's'} ready`, 'ready');
}

async function enableMidiAccess() {
  if (!navigator.requestMIDIAccess) {
    updateMidiStatus('Web MIDI is not available in this Electron runtime.', 'warning');
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    midiAccess.onstatechange = attachMidiInputs;
    attachMidiInputs();
  } catch (err) {
    updateMidiStatus(`MIDI access failed: ${err.message}`, 'warning');
  }
}

function captureMidiForCommand(commandId, midiEvent) {
  if (!['note', 'cc'].includes(midiEvent.type)) return;
  const command = commandRegistry.find(item => item.id === commandId);
  if (!command) return;
  const mapping = {
    type: midiEvent.type,
    channel: midiEvent.channel,
    number: midiEvent.number,
    behavior: command.midiType === 'continuous' ? 'continuous' : command.midiType === 'hold' ? 'hold' : midiEvent.type === 'cc' ? 'toggle' : 'trigger',
  };
  const existing = findCommandForMidiMapping(mapping);
  if (existing && existing.id !== commandId) {
    setShortcutHint(`${midiMappingLabel(mapping)} is already assigned to ${existing.label}.`, true);
    midiLearnCommandId = null;
    renderKeyboardShortcuts();
    return;
  }
  midiMappings[commandId] = mapping;
  saveMidiMappings();
  midiLearnCommandId = null;
  setShortcutHint(`${command.label} mapped to ${midiMappingLabel(mapping)}.`);
  renderKeyboardShortcuts();
}

function handleMidiMessage(message) {
  const midiEvent = parseMidiMessage(message);
  if (!midiEvent) return;
  if (midiLearnCommandId) {
    captureMidiForCommand(midiLearnCommandId, midiEvent);
    return;
  }
  const key = midiEventKey(midiEvent);
  const command = commandRegistry.find(item => {
    const mapping = getCommandMidiMapping(item);
    if (!mapping) return false;
    const eventType = midiEvent.type === 'noteOff' ? 'note' : midiEvent.type;
    return midiEventKey(mapping) === midiEventKey({ ...midiEvent, type: eventType });
  });
  if (!command) return;
  const mapping = getCommandMidiMapping(command);
  if (command.midiType === 'continuous' || mapping?.behavior === 'continuous') {
    command.run(midiEvent.value);
    return;
  }
  if (command.midiType === 'hold' || mapping?.behavior === 'hold') {
    command.run(midiEvent.type !== 'noteOff' && midiEvent.value >= 0.5);
    return;
  }
  const previousValue = midiLastValues.get(key) || 0;
  midiLastValues.set(key, midiEvent.value);
  if (midiEvent.type === 'noteOff') return;
  if (midiEvent.type === 'cc' && !(previousValue < 0.5 && midiEvent.value >= 0.5)) return;
  runCommand(command.id);
}

function runCommand(commandId) {
  const command = commandRegistry.find(item => item.id === commandId);
  if (!command) return false;
  command.run();
  return true;
}

function runShortcutEvent(event) {
  const shortcut = eventToShortcut(event);
  const command = findCommandForShortcut(shortcut);
  if (!command) return false;
  event.preventDefault();
  runCommand(command.id);
  return true;
}

document.addEventListener('keydown', (e) => {
  if (shortcutCaptureCommandId) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      shortcutCaptureCommandId = null;
      setShortcutHint('Shortcut edit cancelled.');
      renderKeyboardShortcuts();
      return;
    }
    captureShortcutForCommand(shortcutCaptureCommandId, e);
    return;
  }
  if (midiLearnCommandId && e.key === 'Escape') {
    e.preventDefault();
    midiLearnCommandId = null;
    setShortcutHint('MIDI learn cancelled.');
    renderKeyboardShortcuts();
    return;
  }
  // Never fire shortcuts when an input or textarea is focused
  if (isEditableShortcutTarget(e.target)) return;
  const pressedShortcut = eventToShortcut(e);
  const defaultCommand = commandRegistry.find(command => command.defaultShortcut === pressedShortcut);
  if (runShortcutEvent(e)) return;
  if (defaultCommand && getCommandShortcut(defaultCommand) !== pressedShortcut) {
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case ' ':
      e.preventDefault();
      blurActiveButton();
      if (e.target instanceof HTMLInputElement && e.target.type === 'range') e.target.blur();
      if (e.target instanceof HTMLSelectElement) e.target.blur();
      togglePlay();
      break;
    case 'Escape':
      handleCancelCommand().catch(err => setStatusError(err.message));
      break;
    case 'Enter':
      // Enter triggers the primary cue action (create or update) when the region is valid
      if (regionInFrames !== null && regionOutFrames !== null
          && regionOutFrames > regionInFrames && currentProject) {
        e.preventDefault();
        handlePrimaryCueAction();
      }
      break;
    case 's': case 'S':
      if (regionInFrames !== null && regionOutFrames !== null && regionOutFrames > regionInFrames) {
        e.preventDefault();
        setStreamerTargetAtCurrentPlayhead().catch(err => setStatusError(err.message));
      }
      break;
    case 'i': case 'I': markIn();  break;
    case 'o': case 'O': markOut(); break;
    case 'p': case 'P': e.preventDefault(); togglePrerollEnabled(); break;
    case 'r': case 'R': e.preventDefault(); handleRecordCommand(); break;
    case 'l': case 'L': toggleLoop(); break;
    case 'f': case 'F': fitProject(); break;
    case '+': case '=': e.preventDefault(); zoomIn();  break;
    case '-': case '_': e.preventDefault(); zoomOut(); break;
    case 'ArrowUp':
      if (e.shiftKey) { e.preventDefault(); zoomIn(); } break;
    case 'ArrowDown':
      if (e.shiftKey) { e.preventDefault(); zoomOut(); } break;
    case 'ArrowLeft':
      if (!e.shiftKey) { e.preventDefault(); if (peakData) { pauseAutoScroll(); panBy(-getViewWindow() * 0.1); } } break;
    case 'ArrowRight':
      if (!e.shiftKey) { e.preventDefault(); if (peakData) { pauseAutoScroll(); panBy(getViewWindow() * 0.1); } } break;
  }
});

// ── Collapsible sidebar panels ────────────────────────────────────────────────
// Any .panel[data-collapsible] toggles its .panel-body on header click.

document.querySelectorAll('.panel[data-collapsible] .panel-header-toggle').forEach(header => {
  header.addEventListener('click', () => {
    const panel   = header.closest('.panel');
    const body    = panel.querySelector('.panel-body');
    const chevron = header.querySelector('.panel-chevron');
    const collapsed = panel.hasAttribute('data-collapsed');
    if (collapsed) {
      panel.removeAttribute('data-collapsed');
      body.style.display    = '';
      chevron.textContent   = '▾';
    } else {
      panel.setAttribute('data-collapsed', '');
      body.style.display    = 'none';
      chevron.textContent   = '▸';
    }
  });
});

// ── Close protection ──────────────────────────────────────────────────────────
// When the OS/window close button is clicked, main.js sends 'app:close-requested'.
// We show a Save / Don't Save / Cancel prompt if there are unsaved changes.

window.api.onApp.closeRequested(async () => {
  if (!_hasUnsavedChanges || !currentProject) {
    // Nothing unsaved — clean exit; confirmClose will delete the recovery file
    await window.api.app.confirmClose({ hasUnsavedChanges: false });
    return;
  }

  const result = await window.api.dialog.closeConfirm({
    title:   'Unsaved Changes',
    message: `"${currentProject.projectName}" has unsaved changes.\nSave before closing?`,
  });

  // buttonIndex: 0 = Save, 1 = Don't Save, 2 = Cancel
  if (result.buttonIndex === 0) {
    // Save, then close — after save there are no unsaved changes
    if (!currentProject.settings) currentProject.settings = {};
    currentProject.settings.workspace = { ...ws };
    const saved = await window.api.project.save();
    if (!saved.success && saved.error !== 'Save cancelled.') {
      setStatusError(`Save failed: ${saved.error}`);
      return;
    }
    if (saved.success) {
      _hasUnsavedChanges = false;
      await window.api.app.confirmClose({ hasUnsavedChanges: false });
    }
  } else if (result.buttonIndex === 1) {
    // Don't Save — close without saving; keep recovery file (dirty exit)
    await window.api.app.confirmClose({ hasUnsavedChanges: true });
  }
  // buttonIndex === 2 (Cancel) — do nothing
});

// ── Booth Display button ──────────────────────────────────────────────────────

/**
 * Hydrate the booth window with all current display state.
 * Called after open, and also after a short delay to ensure the booth
 * renderer has finished loading and registered its window.booth.onUpdate
 * listener before we send the first messages.
 */
function hydrateBoothState() {
  // Video source — send first so the video element starts loading
  if (els.videoPlayer.src) {
    boothSend({ type: 'videoSource', src: els.videoPlayer.src });
  }

  // Overlay appearance settings
  boothSend({
    type:            'overlaySettings',
    overlayColor:    ws.dialogueOverlayColor,
    overlayFontSize: ws.dialogueOverlayFontSize,
    showTimecode:    ws.boothTimecodeEnabled,
    frameRate:       currentProject?.settings?.frameRate || '25',
  });

  // Ensure booth video is paused on open (not playing any stale state)
  boothSend({ type: 'cuePlaybackStop', currentTime: els.videoPlayer.currentTime || 0 });

  // Selected cue text — sent last so it appears above the video
  if (selectedCueId && currentProject) {
    const cue   = currentProject.cues.find(c => c.cueId === selectedCueId);
    const chars = currentProject.characters || [];
    const char  = chars.find(c => c.characterId === cue?.characterId);
    if (cue) {
      const cueInTime = framesToSeconds(cue.inFrames);
      boothSend(getCueBoothPayload(cue, char?.name || ''));
      boothSend({ type: 'cuePrimed', currentTime: cueInTime });
    }
  }
}

els.btnOpenBooth.addEventListener('click', async () => {
  await window.api.booth.open();
  els.btnOpenBooth.classList.add('open');

  // The booth window needs time to load booth.html, execute booth.js,
  // and register window.booth.onUpdate() before it can receive messages.
  // 350 ms is enough for a local file:// load; messages sent before that
  // would be relayed to a renderer that isn't listening yet and would be
  // silently dropped.
  setTimeout(hydrateBoothState, 350);
});

window.api.onApp.boothClosed(() => {
  els.btnOpenBooth.classList.remove('open');
});

window.api.onApp.boothTransportCommand?.((command) => {
  if (command?.type === 'ready' && Number.isFinite(command.commandId)) {
    boothReadyWaiters.get(command.commandId)?.();
  }
});

// ── Actor Manager ─────────────────────────────────────────────────────────────

els.btnManageActors.addEventListener('click', () => {
  if (currentProject) showActorModal();
});

els.btnActorsClose.addEventListener('click', hideActorModal);

els.modalActors.addEventListener('click', (e) => {
  if (e.target === els.modalActors) hideActorModal();
});

els.btnActorAdd.addEventListener('click', submitAddActor);

[els.actorInputName, els.actorInputEmail].forEach(inp => {
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  submitAddActor();
    if (e.key === 'Escape') hideActorModal();
  });
});

// Assigned Actor dropdown — fires when operator changes actor for selected cue
els.cueDetailActor.addEventListener('change', async () => {
  if (!selectedCueId || !currentProject) return;
  const newActorId = els.cueDetailActor.value || null;   // '' → null (Unassigned)

  const result = await window.api.actor.assignToCue({ cueId: selectedCueId, actorId: newActorId });
  if (!result.success) {
    setStatusError(`Actor assignment failed: ${result.error}`);
    // Revert dropdown to current saved state
    const cue = currentProject.cues.find(c => c.cueId === selectedCueId);
    els.cueDetailActor.value = cue?.actorId || '';
    return;
  }
  currentProject = result.project;
  markUnsaved();
  const actorName = newActorId
    ? (currentProject.actors.find(a => a.actorId === newActorId)?.name || 'Unknown')
    : 'Unassigned';
  setStatusOk(`Assigned: ${actorName}`);
});

// ── Create Cue Modal ──────────────────────────────────────────────────────────

els.btnCreateCueCancel.addEventListener('click', hideCreateCueModal);
els.btnCreateCueSave.addEventListener('click',   submitCreateCue);
els.modalCreateCue.addEventListener('click', e => {
  if (e.target === els.modalCreateCue) hideCreateCueModal();
});
// Enter in modal submits
[els.createCueCharSelect, els.createCueNewChar].forEach(el => {
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitCreateCue(); }
    if (e.key === 'Escape') hideCreateCueModal();
  });
});

// ── Export PDF button + modal ─────────────────────────────────────────────────

els.btnExportModalCancel.addEventListener('click', hideExportModal);
els.btnExportModalConfirm.addEventListener('click', submitExportPdf);
els.modalExportPdf.addEventListener('click', e => {
  if (e.target === els.modalExportPdf) hideExportModal();
});
els.inputPreparedBy.addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); submitExportPdf(); }
  if (e.key === 'Escape') hideExportModal();
});

// ── Export CSV button ─────────────────────────────────────────────────────────

// ── New Project Modal ─────────────────────────────────────────────────────────

els.btnNewProject.addEventListener('click', showNewProjectModal);

async function applyOpenedProjectResult(result) {
  peakData = null; guideAudioPath = null; cueListFilter = '';
  isLooping = false;
  cancelPreroll(); hideWaveformUI(); resetCueAndTakeWorkspace(); unloadVideoPlayer();
  applyProjectToUI(result.project, result.filePath);
  startAutosaveTimer();
  if (result.warnings?.length) {
    setStatusWarn(result.warnings[0]);
  } else {
    const video = result.project?.video;
    if (video?.localPath) {
      const rv = await window.api.media.resolveVideo(video.localPath);
      if (rv.success) {
        loadVideoInPlayer(rv.videoSrc);
        const wv = await window.api.waveform.load();
        if (wv.success) { applyPeakData(wv.peaks, wv.guideAudioPath); setStatusOk(`Opened: "${result.project.projectName}" (waveform cached)`); }
        else setStatusOk(`Opened: "${result.project.projectName}" — generate waveform to enable timeline.`);
      } else setStatusWarn(`Project opened, but video not found: ${video.fileName || ''}`);
    } else setStatusOk(`Opened: "${result.project.projectName}"`);
  }
  if (result.migrationsApplied?.length) console.info('[open] Migrations:', result.migrationsApplied.join(', '));
  if (result.recovery?.hasRecovery) await offerAutosaveRecovery(result.recovery);
}

els.btnOpenProject.addEventListener('click', async () => {
  setStatusInfo('Opening project…');
  const result = await window.api.project.open();
  if (!result.success) {
    result.error !== 'Open cancelled.'
      ? setStatusError(`Could not open: ${result.error}`) : setStatusInfo('Open cancelled.');
    return;
  }
  peakData = null; guideAudioPath = null; cueListFilter = '';
  isLooping = false;
  cancelPreroll(); hideWaveformUI(); resetCueAndTakeWorkspace(); unloadVideoPlayer();
  applyProjectToUI(result.project, result.filePath);
  startAutosaveTimer();
  if (result.warnings?.length) {
    setStatusWarn(result.warnings[0]);
  } else {
    const video = result.project?.video;
    if (video?.localPath) {
      const rv = await window.api.media.resolveVideo(video.localPath);
      if (rv.success) {
        loadVideoInPlayer(rv.videoSrc);
        const wv = await window.api.waveform.load();
        if (wv.success) { applyPeakData(wv.peaks, wv.guideAudioPath); setStatusOk(`Opened: "${result.project.projectName}" (waveform cached)`); }
        else setStatusOk(`Opened: "${result.project.projectName}" — generate waveform to enable timeline.`);
      } else setStatusWarn(`Project opened, but video not found: ${video.fileName || ''}`);
    } else setStatusOk(`Opened: "${result.project.projectName}"`);
  }
  if (result.migrationsApplied?.length) console.info('[open] Migrations:', result.migrationsApplied.join(', '));
  // Offer recovery if a newer autosave exists
  if (result.recovery?.hasRecovery) {
    await offerAutosaveRecovery(result.recovery);
  }
});

els.btnSaveProject.addEventListener('click', async () => {
  if (!currentProject) return;
  // Bake workspace settings into the project before saving
  if (!currentProject.settings) currentProject.settings = {};
  currentProject.settings.workspace = { ...ws };
  await saveWorkspaceSettings();
  setStatusInfo('Saving…');
  const result = await window.api.project.save();
  if (!result.success) {
    result.error !== 'Save cancelled.'
      ? setStatusError(`Save failed: ${result.error}`) : setStatusInfo('Save cancelled.');
    return;
  }
  currentFilePath = result.filePath; currentProject = result.project;
  els.infoFilePath.textContent  = truncatePath(result.filePath, 36);
  els.infoUpdatedAt.textContent = formatDate(result.project.updatedAt);
  updateGenerateWaveformButton();
  _hasUnsavedChanges = false;  // explicit save — autosave no longer needed
  updateWindowTitle();
  setStatusOk(`Saved: ${result.filePath}`);
});

async function saveProjectAs() {
  if (!currentProject) return;
  if (!currentProject.settings) currentProject.settings = {};
  currentProject.settings.workspace = { ...ws };
  await saveWorkspaceSettings();
  setStatusInfo('Saving As…');
  const result = await window.api.project.saveAs();
  if (!result.success) {
    result.error !== 'Save cancelled.'
      ? setStatusError(`Save As failed: ${result.error}`) : setStatusInfo('Save cancelled.');
    return;
  }
  currentFilePath = result.filePath; currentProject = result.project;
  els.infoFilePath.textContent  = truncatePath(result.filePath, 36);
  els.infoUpdatedAt.textContent = formatDate(result.project.updatedAt);
  updateGenerateWaveformButton();
  _hasUnsavedChanges = false;
  updateWindowTitle();

  // Migrate waveform peaks from the old media folder to the new one.
  // Non-fatal — operator can regenerate if this fails.
  if (result.oldFilePath) {
    const wm = await window.api.waveform.migrateOnSaveAs({ oldFilePath: result.oldFilePath });
    if (wm.success && wm.migrated) {
      // Reload the peaks from the new location so the waveform stays visible
      const wv = await window.api.waveform.load();
      if (wv.success) applyPeakData(wv.peaks, wv.guideAudioPath);
    }
  }

  setStatusOk(`Saved As: ${result.filePath}`);
}

els.btnLoadVideo.addEventListener('click', async () => {
  if (!currentProject) { setStatusWarn('Open or create a project first.'); return; }
  setStatusInfo('Selecting video file…');
  const result = await window.api.media.loadVideo();
  if (!result.success) {
    result.error !== 'No file selected.'
      ? setStatusError(`Video load failed: ${result.error}`) : setStatusInfo('Video load cancelled.');
    return;
  }
  const setResult = await window.api.project.setVideo(result.meta);
  if (!setResult.success) { setStatusError(`Could not update project: ${setResult.error}`); return; }
  currentProject = setResult.project;
  applyVideoMetaToUI(result.meta);
  applySettingsToUI(currentProject.settings, currentProject.cues);
  els.infoUpdatedAt.textContent = formatDate(currentProject.updatedAt);
  peakData = null; guideAudioPath = null;
  isLooping = false;
  cancelPreroll(); hideWaveformUI(); resetCueAndTakeWorkspace();
  loadVideoInPlayer(result.videoSrc);
  updateGenerateWaveformButton();
  updateDialogueOverlay();
  setStatusOk(`Video loaded: ${result.meta.fileName}`);
});

function showNewProjectModal() {
  els.inputFilmTitle.value = ''; els.inputProjectName.value = '';
  newProjectParentDirectory = null;
  updateNewProjectPreview();
  els.modalNewProject.classList.remove('hidden');
  setTimeout(() => els.inputFilmTitle.focus(), 50);
}
function hideNewProjectModal() { els.modalNewProject.classList.add('hidden'); }

function safePreviewSegment(value, fallback) {
  return String(value || fallback).replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || fallback;
}

function joinPreviewPath(parent, child) {
  if (!parent) return child;
  const separator = parent.includes('\\') ? '\\' : '/';
  return parent.replace(/[\\/]+$/, '') + separator + child;
}

function updateNewProjectPreview() {
  const sessionName = safePreviewSegment(els.inputProjectName.value.trim(), 'Session_Name');
  els.newProjectLocationLabel.textContent = newProjectParentDirectory || 'No location selected';
  els.newProjectPreview.textContent = newProjectParentDirectory
    ? `Will create: ${joinPreviewPath(newProjectParentDirectory, sessionName)}`
    : 'Choose a parent folder. The app will create a contained session folder inside it.';
}

async function chooseNewProjectLocation() {
  const result = await window.api.project.chooseParentFolder();
  if (!result.success) {
    if (result.error !== 'Choose cancelled.') setStatusError(result.error || 'Could not choose folder.');
    return;
  }
  newProjectParentDirectory = result.folderPath;
  updateNewProjectPreview();
}

async function submitNewProject() {
  const filmTitle   = els.inputFilmTitle.value.trim();
  const projectName = els.inputProjectName.value.trim();
  if (!filmTitle)   { els.inputFilmTitle.focus();   setStatusWarn('Please enter a film title.');   return; }
  if (!projectName) { els.inputProjectName.focus(); setStatusWarn('Please enter a session name.'); return; }
  if (!newProjectParentDirectory) { setStatusWarn('Please choose a parent folder.'); return; }
  hideNewProjectModal();
  setStatusInfo('Creating and saving project…');
  let result;
  try {
    result = await window.api.project.new({ filmTitle, projectName, parentDirectory: newProjectParentDirectory });
  } catch (err) {
    setStatusError(`Failed: ${err.message}`);
    showNewProjectModal();
    return;
  }
  if (!result.success) {
    if (result.error !== 'Create cancelled.') setStatusError(`Failed: ${result.error}`);
    else setStatusInfo('Create cancelled.');
    return;
  }
  peakData = null; guideAudioPath = null; cueListFilter = '';
  isLooping = false;
  cancelPreroll(); hideWaveformUI(); resetCueAndTakeWorkspace(); unloadVideoPlayer();
  currentFilePath = result.filePath;
  applyProjectToUI(result.project, result.filePath);
  startAutosaveTimer();
  _hasUnsavedChanges = false;
  updateWindowTitle();
  setStatusOk(`Project "${projectName}" created at ${result.projectRoot || result.filePath}`);
}

els.btnModalCancel.addEventListener('click', hideNewProjectModal);
els.btnModalCreate.addEventListener('click', submitNewProject);
els.btnNewProjectLocation.addEventListener('click', chooseNewProjectLocation);
[els.inputFilmTitle, els.inputProjectName].forEach(inp => {
  inp.addEventListener('input', updateNewProjectPreview);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') submitNewProject(); if (e.key === 'Escape') hideNewProjectModal(); });
});
els.modalNewProject.addEventListener('click', e => { if (e.target === els.modalNewProject) hideNewProjectModal(); });

// ── Menu events ───────────────────────────────────────────────────────────────

function setInspectorCollapsed(collapsed) {
  const main = document.querySelector('.main-content');
  if (!main || !els.btnInspectorToggle) return;
  main.classList.toggle('info-sidebar-collapsed', !!collapsed);
  els.btnInspectorToggle.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
  els.btnInspectorToggle.title = collapsed ? 'Show inspector' : 'Hide inspector';
}

function setPanelExpanded(panel, expanded) {
  if (!panel) return;
  const body = panel.querySelector('.panel-body');
  const chevron = panel.querySelector('.panel-chevron');
  panel.classList.remove('hidden');
  if (expanded) {
    panel.removeAttribute('data-collapsed');
    if (body) body.style.display = '';
    if (chevron) chevron.textContent = 'â–¾';
  } else {
    panel.setAttribute('data-collapsed', '');
    if (body) body.style.display = 'none';
    if (chevron) chevron.textContent = 'â–¸';
  }
}

function showPreferencePanel(panelName) {
  setInspectorCollapsed(false);
  document.querySelectorAll('[data-pref-panel]').forEach(panel => {
    const isTarget = panel.dataset.prefPanel === panelName;
    setPanelExpanded(panel, isTarget);
    if (panel.dataset.prefPanel === 'playback' && !isTarget) panel.classList.add('hidden');
  });
  document.querySelector(`[data-pref-panel="${panelName}"]`)?.scrollIntoView({ block: 'nearest' });
}

window.api.onMenu.newProject(   () => showNewProjectModal());
window.api.onMenu.openProject(  () => els.btnOpenProject.click());
window.api.onMenu.openRecentProject?.(async (filePath) => {
  setStatusInfo('Opening recent project...');
  const result = await window.api.project.openPath(filePath);
  if (!result.success) {
    setStatusError(`Could not open recent project: ${result.error}`);
    return;
  }
  await applyOpenedProjectResult(result);
});
window.api.onMenu.saveProject(  () => els.btnSaveProject.click());
window.api.onMenu.saveProjectAs(() => saveProjectAs());
window.api.onMenu.loadVideo(    () => els.btnLoadVideo.click());
window.api.onMenu.manageActors?.(() => {
  if (currentProject) showActorModal();
});
window.api.onMenu.exportGoodTakesPackage?.(() => submitExportGoodTakesPackage());
window.api.onMenu.exportGoodTakesCharacter?.(() => showExportCharacterModal());
window.api.onMenu.exportRemoteCueManifest?.(() => submitExportRemoteCueManifest());
window.api.onMenu.exportReport( () => submitExportReport());
window.api.onMenu.exportCsv(    () => submitExportCsv());
window.api.onMenu.exportPdf(    () => showExportModal());
window.api.onMenu.returnToStartOnStop((checked) => {
  ws.returnToStartOnStop = !!checked;
  saveWorkspaceSettings();
  markUnsaved();
  setStatusInfo(`Return to start position on stop ${ws.returnToStartOnStop ? 'enabled' : 'disabled'}.`);
});
window.api.onMenu.recordMode?.((mode) => {
  setRecordMode(mode);
});
window.api.onMenu.showPlaybackSettings?.(() => showPreferencePanel('playback'));
window.api.onMenu.showAudioIo?.(() => showPreferencePanel('audio'));
window.api.onMenu.showSessionSettings?.(() => showPreferencePanel('session'));
window.api.onMenu.showKeyboardShortcuts?.(() => showKeyboardShortcutsModal());

window.api.onWaveform.progress(({ stage, percent }) => { updateWaveformProgress(stage, percent); });

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
  setStatusInfo('Initialising…');
  buildZoomLevelButtons();
  loadWorkspaceSettings();
  refreshAudioEnginePanel();

  const ffprobeStatus = await window.api.media.checkFfprobe();
  if (!ffprobeStatus.available) setStatusWarn('ffprobe not found — video metadata unavailable.');

  const current = await window.api.project.getCurrent();
  if (current.project) {
    applyProjectToUI(current.project, current.filePath);
    const video = current.project?.video;
    if (video?.localPath) {
      const rv = await window.api.media.resolveVideo(video.localPath);
      if (rv.success) {
        loadVideoInPlayer(rv.videoSrc);
        const wv = await window.api.waveform.load();
        if (wv.success) applyPeakData(wv.peaks, wv.guideAudioPath);
      }
    }
    startAutosaveTimer();
    // Offer recovery if a newer autosave was found
    if (current.recovery?.hasRecovery) {
      await offerAutosaveRecovery(current.recovery);
    } else {
      setStatusOk('Session restored.');
    }
  } else {
    setStatusInfo('Ready. Create or open a project to begin.');
  }
}

init();
