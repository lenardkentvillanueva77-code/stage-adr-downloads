# Professional Audio Backend Implementation Plan

Status: Draft execution plan  
Depends on: `docs/professional-audio-backend-architecture.md`  
Scope: How to proceed from current Electron/browser-audio implementation toward a native JUCE professional audio backend

## 1. Purpose

This plan turns the professional audio architecture into buildable stages. The goal is to avoid a half-native, half-browser compromise and instead prove the real studio requirements in thin, verified slices.

The first engineering priority is not recording. The first priority is proving that Post ADR Pro can launch a native engine, see a professional interface, validate the default 3-input / 4-output studio preset, support remappable logical lanes, and show reliable metering.

## 2. Current Baseline

The current Electron app already has:

- Project creation/open/save/autosave workflow
- Cue spotting and cue list workflow
- Actor assignment
- Booth display window
- Browser/Electron transitional recording path
- Takes and persistence model
- FFmpeg/FFprobe media services
- Waveform generation and guide audio extraction foundation

This plan preserves that product surface while moving final audio responsibilities into a native engine.

## 3. Target Boundary

### 3.1 Renderer

The renderer remains UI only.

Allowed:

- Display device status
- Display meters
- Show routing state
- Send user intent through `window.api`
- Display transport and take state

Not allowed:

- Direct native engine connection
- Real-time audio routing
- Audio recording
- Talkback routing
- Hardware channel selection as an audio operation

### 3.2 Main Process

Electron main becomes the audio orchestration bridge.

Responsibilities:

- Launch native audio engine process
- Stop/restart native engine
- Own IPC connection to engine
- Validate engine protocol version
- Forward renderer commands to engine
- Forward engine events to renderer
- Persist audio settings into project state
- Translate project/cue/take objects into engine commands

Not responsible for:

- Real-time audio callbacks
- Mixing
- Recording sample buffers
- Talkback routing
- Guide/beep audio rendering

### 3.3 Native JUCE Engine

The JUCE engine owns:

- Device enumeration
- Device open/close
- Sample rate and buffer size
- Channel activation
- Fixed routing profile
- Audio callback
- Metering
- Talkback
- Native guide/beep playback
- Recording
- Take review

## 4. Proposed Repository Layout

Add native engine files under:

```text
native/
  audio-engine/
    CMakeLists.txt
    README.md
    src/
      main.cpp
      EngineApp.h
      EngineApp.cpp
      EngineIPC.h
      EngineIPC.cpp
      DeviceManager.h
      DeviceManager.cpp
      StudioRoutingProfile.h
      StudioRoutingProfile.cpp
      AudioGraph.h
      AudioGraph.cpp
      Metering.h
      Metering.cpp
      Diagnostics.h
      Diagnostics.cpp
```

Later stages add:

```text
      GuidePlayer.*
      BeepGenerator.*
      TalkbackRouter.*
      RecordCapture.*
      TakePlayer.*
      MonitorRouter.*
      WavTakeWriter.*
```

Electron bridge files can be added under:

```text
src/
  services/
    audioEngine/
      engineProcess.js
      engineClient.js
      engineProtocol.js
  ipc/
    audioEngineHandlers.js
```

Renderer UI can be added to existing `renderer/app.js` and `renderer/index.html` initially, then extracted later if the panel becomes large.

## 5. IPC Protocol Direction

Use a versioned JSON protocol for the first implementation.

Initial transport:

- Localhost TCP or WebSocket
- Engine listens on an ephemeral port and prints/returns connection details to Electron
- Electron main owns the connection
- Renderer communicates only through existing preload/contextBridge style

No live audio buffers cross IPC.

### 5.1 Protocol Envelope

Every message should follow this shape:

```json
{
  "id": "optional-request-id",
  "type": "message.type",
  "protocolVersion": 1,
  "payload": {}
}
```

Requests that expect responses use `id`. Events may omit `id`.

### 5.2 Required Stage 1 Messages

Electron to engine:

```json
{ "id": "1", "type": "engine.ping", "protocolVersion": 1, "payload": {} }
{ "id": "2", "type": "device.list", "protocolVersion": 1, "payload": {} }
{ "id": "3", "type": "device.open", "protocolVersion": 1, "payload": { "deviceId": "...", "sampleRate": 48000, "bufferSize": 128 } }
{ "id": "4", "type": "device.close", "protocolVersion": 1, "payload": {} }
```

Engine to Electron:

```json
{ "type": "engine.ready", "protocolVersion": 1, "payload": { "engineVersion": "0.1.0" } }
{ "id": "1", "type": "engine.pong", "protocolVersion": 1, "payload": {} }
{ "id": "2", "type": "device.list.result", "protocolVersion": 1, "payload": { "devices": [] } }
{ "id": "3", "type": "device.open.result", "protocolVersion": 1, "payload": { "ok": true } }
{ "type": "meter.snapshot", "protocolVersion": 1, "payload": { "inputs": [], "outputs": [] } }
{ "type": "engine.error", "protocolVersion": 1, "payload": { "code": "...", "message": "..." } }
```

### 5.3 Device Shape

```json
{
  "deviceId": "backend-specific-stable-id-or-derived-id",
  "name": "Interface Name",
  "backend": "ASIO",
  "inputChannelCount": 8,
  "outputChannelCount": 8,
  "inputChannelNames": ["Input 1", "Input 2", "Input 3"],
  "outputChannelNames": ["Output 1", "Output 2", "Output 3", "Output 4"],
  "sampleRates": [44100, 48000, 96000],
  "bufferSizes": [64, 128, 256, 512],
  "isProfessionalRoutingCapable": true
}
```

`isProfessionalRoutingCapable` is true only when the device can support at least 3 inputs and 4 outputs.

## 6. Project Schema Additions

Add an `audioEngine` section in a future schema version.

Draft shape:

```json
{
  "audioEngine": {
    "mode": "professional-native",
    "routingProfile": "studio-3in-4out-v1",
    "device": {
      "deviceId": "",
      "name": "",
      "backend": "",
      "sampleRate": 48000,
      "bufferSize": 128
    },
    "channelMap": {
      "recordLanes": [
        { "laneId": "adrMic1", "label": "Mic 1", "physicalInput": null, "armed": false },
        { "laneId": "adrMic2", "label": "Mic 2", "physicalInput": null, "armed": false }
      ],
      "talkbackMic": 2,
      "controlL": 0,
      "controlR": 1,
      "boothL": 2,
      "boothR": 3
    },
    "latency": {
      "inputLatencySamples": null,
      "outputLatencySamples": null,
      "calibratedOffsetSamples": 0
    }
  }
}
```

Do not write this schema until the first engine integration is ready. The schema should be added with migration logic, not as loose ad hoc data.

## 7. Milestone 1: Native Engine Connection and Hardware Validation

This is the first real implementation milestone.

### 7.1 Build Goals

- Add JUCE standalone engine skeleton.
- Add CMake build for local development.
- Engine starts as a separate process.
- Engine exposes protocol version.
- Electron main launches engine.
- Electron main connects to engine.
- Engine enumerates audio devices.
- Engine reports device channel counts and names.
- Engine validates professional routing capability.
- Engine opens a selected device.
- Engine emits input/output meter snapshots.
- Renderer displays basic engine/device state.

### 7.2 UI Goals

Add a simple professional audio panel:

- Engine status: stopped / starting / ready / error
- Device dropdown
- Backend label: ASIO / WASAPI / CoreAudio
- Sample rate selector or display
- Buffer size selector or display
- Input 1 meter: ADR Mic 1
- Input 2 meter: ADR Mic 2
- Input 3 meter: Talkback
- ADR Mic 1 physical input selector and arm toggle
- ADR Mic 2 physical input selector and arm toggle
- Output 1-2 meter: Control Room
- Output 3-4 meter: Booth
- Validation badge: Professional routing ready / unavailable

Keep this utilitarian. No flashy redesign.

### 7.3 Acceptance Criteria

Milestone 1 is complete only when:

- Electron can launch and stop the engine.
- Engine protocol mismatch is detected and shown.
- A real multichannel device can be listed.
- A device with fewer than 3 inputs or fewer than 4 outputs is rejected for professional routing.
- A capable device can be opened at 48 kHz.
- Input meters visibly respond on inputs 1, 2, and 3.
- Output meters exist, even if only silence is rendered in this stage.
- Renderer has no direct audio device access for this feature.

### 7.4 Out of Scope

- Recording
- Talkback audio routing
- Guide audio playback
- Beeps
- Take review
- Monitoring
- Packaging installer

## 8. Milestone 2: Native Talkback

### 8.1 Build Goals

- Add configurable talkback route with default `input[2] -> output[2]/output[3]`.
- Add push-to-talk command.
- Add click-free gain ramp.
- Add talkback active state event.
- Add booth output metering.
- Add tests for routing matrix state.

### 8.2 Acceptance Criteria

- Talkback is audible on outputs 3-4 only.
- Talkback is not present on outputs 1-2.
- Talkback route opens and closes from push-to-talk.
- Talkback cannot be connected to record bus in code.
- Talkback state is visible in UI.

## 9. Milestone 3: Native Guide Audio and Beeps

### 9.1 Build Goals

- Load extracted guide WAV into engine.
- Mute browser video audio in professional mode.
- Play guide audio from JUCE.
- Route guide audio to outputs 1-2 and 3-4.
- Generate cue beeps/countdown in JUCE.
- Route beeps to outputs 1-2 and 3-4.
- Make JUCE sample clock the audio transport clock.

### 9.2 Acceptance Criteria

- Guide audio is heard on both control and booth output pairs.
- Beeps/countdown are heard on both control and booth output pairs.
- Browser video element is not the source of professional audio.
- Transport position events flow from engine to Electron.

## 10. Milestone 4: Native ADR Recording

### 10.1 Build Goals

- Add logical ADR record lanes.
- Allow each lane to map to a physical input channel from the selected interface.
- Add arm/disarm state per lane.
- Record only armed lanes.
- Write one mono 48 kHz / 24-bit WAV per armed lane.
- Use FIFO/ring buffer from audio callback to writer thread.
- Persist take metadata with sample timing.
- Group all lane files created during one pass under one take/pass identity.
- Add recording state events.
- Add error handling for writer failure or disk unavailable.

### 10.2 Acceptance Criteria

- Recording is refused when no ADR lane is armed.
- A one-armed-lane pass produces one valid WAV.
- A two-armed-lane pass produces two valid linked WAV files.
- Logical lanes can be mapped to non-default physical inputs.
- Talkback is not present in recorded WAV.
- Guide audio is not present in recorded WAV.
- Beeps are not present in recorded WAV.
- Take metadata includes duration in samples.
- Recording stop finalizes a valid WAV file.
- Existing take workflow can display the native-recorded take.

## 11. Milestone 5: Timeline-Aware Take Review

### 11.1 Build Goals

- Load recorded take into native engine.
- Align take playback to cue/timeline offset.
- Route review to outputs 1-2 by default.
- Keep outputs 3-4 silent for review unless explicitly enabled later.
- Sync Electron picture to engine transport events.

### 11.2 Acceptance Criteria

- Operator can review a take in sync with picture.
- Take review is heard in control room.
- Take review is not heard in booth by default.
- Review can start with pre-roll.
- Review does not alter original take file.

## 12. Milestone 6: Native Monitoring and Advanced Mic Workflows

### 12.1 Build Goals

- Add optional ADR Mic 1 self-monitoring to booth.
- Add monitor gain.
- Add ADR Mic 2 monitoring support.
- Add per-lane monitor controls if needed.
- Confirm one-file-per-armed-lane export strategy.
- Add tests for monitor route separation.

### 12.2 Acceptance Criteria

- Actor can hear ADR Mic 1 through booth feed when monitoring is enabled.
- Monitoring remains low latency on supported hardware.
- Monitor path is not exported.
- Mic 1 and Mic 2 can be armed independently.
- Mic lanes remain grouped at the take/pass selection level.

## 13. Testing Strategy

### 13.1 Unit Tests

Native engine unit tests should cover:

- Routing profile channel mapping
- Professional capability validation
- Talkback route cannot enter record bus
- Record bus includes only armed logical ADR lanes
- Logical ADR lanes can map to arbitrary physical input channels
- Review route defaults to control room only
- Protocol message parsing and validation

### 13.2 Integration Tests

Electron/native integration tests should cover:

- Engine launch
- Protocol handshake
- Device list request/response
- Device open failure
- Device open success with mocked or test backend where possible
- Renderer receives status events through main process

### 13.3 Hardware Tests

Maintain a manual hardware checklist:

- Interface name and driver/backend
- OS version
- Sample rate
- Buffer size
- Input 1 meter
- Input 2 meter
- Input 3 meter
- Output 1-2 signal
- Output 3-4 signal
- Talkback isolation
- Recording isolation
- Take review routing
- Xrun behavior over 30 minutes

## 14. Immediate Next Tasks

The next concrete tasks, in order:

1. Review and approve the architecture document.
2. Review and approve this implementation plan.
3. Decide JUCE dependency strategy: submodule, vendored source, or external path.
4. Decide first IPC transport: WebSocket/TCP vs named pipe.
5. Add native engine skeleton only.
6. Add Electron engine process supervisor.
7. Add device list handshake.
8. Add professional routing validation.
9. Add metering.

Do not begin recording implementation until Milestone 1 has been proven against real hardware.

## 15. Decisions Still Needed

- Preferred Windows first backend: ASIO-only professional mode, or ASIO preferred with WASAPI diagnostic fallback.
- JUCE dependency management strategy.
- First target interface for hardware validation.
- Whether the first engine IPC uses WebSocket, plain TCP JSON lines, or named pipes.
- Whether guide audio extraction remains exactly as-is or gets formalized before native guide playback.
- Whether advanced exports later should add stereo WAV or poly WAV/BWF in addition to the default separate mono mic files.

## 16. Stop Conditions

Pause implementation and reassess if:

- The selected audio interface cannot expose 3 inputs and 4 outputs through JUCE.
- The engine cannot open the device at 48 kHz.
- Metering does not prove channel identity clearly.
- Electron cannot supervise/restart the native process reliably.
- The design starts routing audio through browser APIs for professional mode.
