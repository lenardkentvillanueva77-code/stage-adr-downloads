# Post ADR Pro Professional Audio Backend Architecture

Status: Draft architecture direction  
Scope: Native professional audio backend for professional ADR studio routing  
Non-goal: This document does not specify a browser/Web Audio implementation.

## 1. Executive Summary

Post ADR Pro must become professional ADR software, not an Electron app that happens to record audio. The final audio architecture must be built around real studio hardware: a multichannel external audio interface with deterministic input and output channel routing.

The Electron renderer should remain UI only. The Electron main process should orchestrate app state and bridge commands. All real-time audio responsibilities should move into a native audio engine, with JUCE as the recommended foundation.

The native engine owns:

- Audio device enumeration and selection
- Channel-level input/output activation
- Fixed studio routing
- Recording
- Playback
- Guide audio
- Cue beeps and countdown
- Talkback
- Optional native monitoring
- Metering
- Take review playback
- Latency measurement and compensation

The browser audio path currently in the app should be treated as transitional. It is acceptable for early development, but it must not become the final professional architecture because it cannot reliably address hardware channels 1-4, cannot provide professional talkback routing, and cannot guarantee low-latency monitoring behavior.

## 2. Core Architecture Decision

Use a standalone native JUCE audio engine process controlled by Electron.

Recommended process model:

```text
Electron renderer
  UI only
  |
  v
Electron main
  project orchestration, IPC bridge, engine lifecycle
  |
  v
JUCE audio engine process
  real-time audio graph, device routing, recording, playback
  |
  v
Professional audio interface
  inputs 1-3, outputs 1-4
```

A standalone process is preferred over a Node native addon for the first professional implementation because it provides better crash isolation, clearer real-time boundaries, easier diagnostics, and lower coupling to Electron and Node runtime behavior.

Electron may crash or reload the renderer without corrupting the audio engine state. The audio engine may crash or fail device initialization without bringing down the whole UI.

## 3. Why JUCE

JUCE is the recommended native audio foundation because it provides a mature cross-platform audio device abstraction and direct access to professional audio APIs such as ASIO on Windows and CoreAudio on macOS.

Relevant JUCE concepts:

- `AudioDeviceManager`: device selection, open/close, callbacks, sample rate, buffer size
- `AudioIODevice`: device type, channel names, active input/output channel masks
- `AudioIODeviceCallback`: high-priority real-time audio callback
- `AudioFormatReader` / `AudioFormatWriter`: guide audio and WAV take IO
- `WavAudioFormat`: production WAV output, with Broadcast WAV extension possible later

JUCE should not be used as a GUI layer here. Post ADR Pro already has an Electron UI. JUCE should be the native audio subsystem.

## 4. Studio Routing Model

The first professional routing profile should ship with an explicit default preset, but the engine must not be limited to hardwired physical channels. Post ADR Pro should separate logical software lanes from physical interface channels.

The default preset is:

- ADR Mic 1 logical lane -> physical input 1
- ADR Mic 2 logical lane -> physical input 2
- Talkback logical lane -> physical input 3
- Control Room -> physical outputs 1-2
- Booth -> physical outputs 3-4

This default matches the expected studio setup, but an operator must be able to remap the logical lanes to other physical channels exposed by the selected interface. For example, ADR Mic 1 may be sourced from physical input 7 on a larger interface.

### 4.1 Inputs

| Software lane | Default hardware channel | Engine source | Purpose |
|---|---:|---:|---|
| ADR Mic 1 | Input 1 | configurable input channel | Record lane, armable |
| ADR Mic 2 | Input 2 | configurable input channel | Optional second record lane, armable |
| Talkback Mic | Input 3 | configurable input channel | Booth communication only |

### 4.2 Outputs

| Software output | Default hardware channel | Engine destination | Purpose |
|---|---:|---:|---|
| Control Room L | Output 1 | configurable output channel | Operator/director left |
| Control Room R | Output 2 | configurable output channel | Operator/director right |
| Booth L | Output 3 | configurable output channel | Actor headphone left |
| Booth R | Output 4 | configurable output channel | Actor headphone right |

### 4.3 Record Arming

Recording is controlled by logical lane arming:

- ADR Mic 1 has a physical source selector and an arm toggle.
- ADR Mic 2 has a physical source selector and an arm toggle.
- Only armed ADR lanes are recorded.
- At least one ADR lane must be armed before recording.
- Talkback is never an armable record lane.

A take/pass records one file per armed logical mic lane. If only ADR Mic 1 is armed, the pass creates one mic file. If ADR Mic 1 and ADR Mic 2 are armed, the pass creates two linked mic files.

### 4.4 Device Validation

Professional routing mode must require one full-duplex device exposing at least:

- 3 active input channels
- 4 active output channels
- The selected session sample rate, initially 48000 Hz
- A buffer size appropriate for talkback and monitoring

If a device cannot expose these channels, the app must not silently degrade into a consumer audio mode. The UI should show a clear "Professional routing unavailable" state and ask the operator to choose a suitable interface or driver.

Diagnostic mode may open smaller interfaces, such as a 2-in / 2-out interface, for testing metering and recording. Diagnostic mode must remain visually distinct from professional routing mode.

## 5. Engine Responsibilities

The native engine owns the real-time audio graph.

Primary engine modules:

- `DeviceManager`: wraps JUCE device enumeration, selection, validation, sample rate, and buffer size.
- `StudioRoutingProfile`: defines the default studio preset and operator-confirmed logical lane mapping.
- `AudioGraph`: deterministic low-latency mixer and router.
- `TransportClock`: sample-based audio timeline and sync reference.
- `GuidePlayer`: native guide audio playback.
- `BeepGenerator`: cue beeps and countdown tones.
- `RecordCapture`: ADR input capture into take files.
- `TalkbackRouter`: push-to-talk route from input 3 to booth only.
- `MonitorRouter`: optional ADR mic monitoring to booth.
- `TakePlayer`: timeline-aware recorded take playback.
- `Metering`: low-rate meter snapshots for UI display.
- `EngineIPC`: command/event protocol with Electron main.
- `Diagnostics`: logs device state, channel activation, xruns, and recording events.

## 6. Internal Audio Matrix

The engine should use an explicit routing matrix. Do not mix sources opportunistically in UI code.

Default preset routing:

| Source | Control 1-2 | Booth 3-4 | Record bus | Export |
|---|---:|---:|---:|---:|
| Guide audio | yes | yes | no | no |
| Cue beeps/countdown | yes | yes | no | no |
| Armed ADR Mic 1 lane | optional meter/monitor | optional monitor | yes, when armed | as recorded take |
| Armed ADR Mic 2 lane | optional meter/monitor | optional monitor | yes, when armed | as recorded take |
| Talkback Mic | no | push-to-talk only | never | never |
| Take review | yes | no by default | no | no |

Important invariant: talkback is never connected to the record bus. This should be true structurally in the graph, not enforced by fragile UI state.

## 7. Electron to JUCE Communication

Electron should communicate with the JUCE engine through a versioned command/event protocol.

Recommended first transport:

- Localhost TCP or WebSocket for portability and easy inspection
- Named pipe / Unix domain socket can be considered later
- JSON messages for control and events
- No live audio buffers over IPC

The Electron main process should launch, monitor, and restart the engine. The renderer should never talk directly to the native process.

### 7.1 Command Examples

Electron to engine:

```json
{ "type": "engine.start", "protocolVersion": 1 }
{ "type": "device.list" }
{ "type": "device.open", "deviceId": "...", "sampleRate": 48000, "bufferSize": 128 }
{ "type": "session.load", "projectId": "...", "guideAudioPath": "..." }
{ "type": "cue.arm", "cueId": "...", "inFrame": 12345, "outFrame": 12420, "frameRate": 24 }
{ "type": "transport.play", "startFrame": 12321 }
{ "type": "record.start", "cueId": "...", "takeId": "...", "input": "adrMic1" }
{ "type": "record.stop" }
{ "type": "talkback.set", "active": true }
{ "type": "take.review", "takeId": "...", "sendToBooth": false }
```

Engine to Electron:

```json
{ "type": "engine.ready", "protocolVersion": 1 }
{ "type": "device.list.result", "devices": [] }
{ "type": "device.opened", "sampleRate": 48000, "bufferSize": 128, "inputs": [], "outputs": [] }
{ "type": "meter.snapshot", "inputs": [], "outputs": [] }
{ "type": "transport.position", "sample": 123456, "frame": 12345 }
{ "type": "record.completed", "takeId": "...", "filePath": "...", "durationSamples": 96000 }
{ "type": "engine.error", "code": "device_lost", "message": "..." }
```

### 7.2 Real-Time Rules

IPC must not block the audio callback. Commands from Electron should be received on a non-real-time thread and applied to the audio graph through lock-free or real-time-safe state handoff.

The audio callback must not:

- Allocate memory
- Perform file IO
- Wait on locks
- Make IPC calls
- Call Electron or Node
- Parse JSON

## 8. Channel Mapping

The engine should separate logical routes from physical hardware indices.

Logical profile default:

```text
adrMic1      -> input[0]
adrMic2      -> input[1]
talkbackMic  -> input[2]
controlL     -> output[0]
controlR     -> output[1]
boothL       -> output[2]
boothR       -> output[3]
```

Runtime channel map:

```json
{
  "recordLanes": [
    { "laneId": "adrMic1", "label": "Mic 1", "physicalInput": 6, "armed": true },
    { "laneId": "adrMic2", "label": "Mic 2", "physicalInput": 7, "armed": false }
  ],
  "talkback": { "physicalInput": 2 },
  "outputs": {
    "control": [0, 1],
    "booth": [2, 3]
  }
}
```

Persisted project/session settings should store:

- Logical routing profile name
- Selected device identity
- Sample rate
- Buffer size
- User-confirmed channel mapping

They should not rely only on fragile device array indices. Device names, backend type, channel names, and a stable device identifier where available should be stored for reattachment.

When the expected device is unavailable or channel counts differ, the app should require remapping before allowing professional recording.

## 9. Recording Architecture

Recording must be native and sample-based.

Initial professional behavior:

- Record from armed ADR logical lanes.
- Write one mono 48 kHz / 24-bit PCM WAV per armed lane.
- Use engine sample clock as the source of truth.
- Store sample-accurate take start and duration.
- Never record talkback.
- Never record guide audio or beeps into the take file.

### 9.1 Write Path

The audio callback pushes ADR samples into a lock-free FIFO or ring buffer. A writer thread drains the FIFO and writes the WAV file.

```text
Audio callback
  read configured physical inputs for armed ADR lanes
  copy each armed lane to its own record FIFO/writer
  continue rendering outputs

Writer thread
  drain lane FIFOs
  encode/write WAV files
  finalize file on stop
```

The writer thread may use JUCE `AudioFormatWriter` / `WavAudioFormat`. The real-time callback must never write to disk directly.

### 9.2 Take Metadata

Each take should persist:

- `takeId`
- `cueId`
- `filePath`
- `takeGroupId` / pass identity
- `laneId`: `adrMic1` or `adrMic2`
- `physicalInputChannel`
- `inputSourceLabel`
- `sampleRate`
- `bitDepth`
- `channelCount`
- `engineStartSample`
- `cueStartFrame`
- `startOffsetSamples`
- `durationSamples`
- `recordedAt`
- `latencyCompensationSamples`
- `deviceId` / device label snapshot

The default file strategy is one mono WAV per armed logical mic lane. Stereo or poly WAV/BWF can be considered later, but the primary ADR workflow should keep mic lanes independently exportable.

## 10. Talkback Architecture

Talkback is a native real-time route:

```text
input[2] -> talkback gain/ramp -> output[2]
                              -> output[3]
```

Rules:

- Push-to-talk controls whether this route is open.
- Talkback never routes to the record bus.
- Talkback never routes to export.
- Talkback does not go to control room by default.
- Gain changes should use short ramps to avoid clicks.
- Talkback should remain low latency under normal session load.

The initial push-to-talk trigger can come from Electron keyboard handling, but the engine owns the final state. Later, direct MIDI/HID footswitch support should be added inside the native engine for lower-latency and more reliable studio operation.

## 11. Booth and Control Room Routing

### 11.1 Control Room 1-2

Control room receives:

- Guide audio
- App playback
- Cue beeps/countdown
- Take review
- Optional operator ADR mic monitor, if explicitly enabled

Control room does not receive talkback by default.

### 11.2 Booth 3-4

Booth receives:

- Guide audio
- Cue beeps/countdown
- Talkback when push-to-talk is active
- Optional ADR mic self-monitoring

Booth does not receive take review by default.

An explicit future option can allow "send review to booth." It should be visible and intentional.

## 12. Take Review

Take review must be timeline-aware. It is not enough to play a WAV file.

Required behavior:

- Start picture at the chosen review position.
- Play the take at its recorded cue/timeline offset.
- Route take review to control room outputs 1-2 by default.
- Do not route review to booth unless an explicit review-to-booth mode is enabled.
- Allow guide audio to be mixed or muted depending on review mode.

The audio engine should own review playback timing. Electron video should chase the engine transport position. This makes the native engine the audio clock, while Electron remains the picture/UI layer.

Longer-term, video sync should account for:

- Output device latency
- Video presentation delay
- Measured system offset
- User calibration

## 13. Guide Audio and Beep Routing

The app already extracts audio for waveform generation. The professional audio path should build on that by having JUCE play an extracted guide WAV.

Recommended flow:

1. Load video in Electron.
2. Extract guide audio to a project media file.
3. Load guide audio into the JUCE engine.
4. Mute Electron video audio.
5. Let JUCE render guide audio to control and booth.
6. Let JUCE generate beeps/countdown natively.

This avoids split routing and split clocks between browser media playback and native audio.

Beep generation should be sample-accurate and routed to:

- Control room 1-2
- Booth 3-4

Beeps should never be recorded into ADR take files.

## 14. Monitoring

Actors need a practical way to hear themselves.

Preferred professional options:

1. Hardware direct monitoring through the audio interface, configured outside Post ADR Pro.
2. Native in-app direct monitoring through the JUCE engine.

Do not rely on Web Audio monitoring as the final solution.

If Post ADR Pro implements native monitoring:

- ADR Mic 1 can route to booth 3-4 with operator-controlled gain.
- ADR Mic 2 can be added later.
- Monitoring should use the native callback path only.
- Monitoring latency should be tested against real ASIO/CoreAudio hardware.
- The monitor path must remain separate from talkback and record routing.

## 15. Latency Expectations

Professional target assumptions:

- Sample rate: 48000 Hz
- Buffer size: 64-256 samples
- Talkback perceived latency: ideally under 10 ms, acceptable under roughly 15 ms depending hardware
- Native monitoring: low enough for actor comfort, tested per hardware device
- Recording: sample-accurate capture with known latency compensation
- UI meters: may be lower priority and slightly delayed

The app should expose:

- Device sample rate
- Buffer size
- Reported input latency
- Reported output latency
- Xrun/dropout count
- Engine CPU usage

Future latency calibration should include a loopback test so Post ADR Pro can measure actual round-trip behavior rather than trusting driver-reported latency alone.

## 16. Platform Implications

### 16.1 Windows

Professional mode should prefer ASIO.

WASAPI may be useful for non-professional fallback, but ASIO is the expected path for reliable channel-level interface routing. Some interfaces only expose their full channel map through their ASIO driver.

Windows build implications:

- Ship a signed JUCE engine executable.
- Include or document the required Visual C++ runtime.
- Validate common ASIO interfaces.
- Provide clear error messages when ASIO drivers are missing.

### 16.2 macOS

Professional mode should use CoreAudio.

CoreAudio generally exposes multichannel interfaces well. Aggregate devices may work, but should not be the default recommendation for ADR recording unless tested.

macOS build implications:

- Sign and notarize the native engine with the Electron app.
- Handle microphone permission prompts.
- Store device identity robustly across launches.
- Test hardware reconnect behavior.

## 17. Build and Tooling

Recommended repo structure:

```text
native/
  audio-engine/
    CMakeLists.txt
    JUCE/
    src/
      main.cpp
      DeviceManager.*
      EngineIPC.*
      AudioGraph.*
      StudioRoutingProfile.*
      RecordCapture.*
      GuidePlayer.*
      BeepGenerator.*
      TalkbackRouter.*
      TakePlayer.*
      Metering.*
```

Recommended tooling:

- CMake for native builds
- JUCE as a submodule or pinned dependency
- Electron packaging step copies the platform-specific engine binary
- CI builds native engine and Electron app per platform
- Unit tests for routing matrix and state transitions
- Hardware smoke test checklist for actual studio interfaces

The first build should not attempt a full installer. Get deterministic local development and hardware validation first.

## 18. Risk Analysis

| Risk | Impact | Mitigation |
|---|---|---|
| Device channel names differ by driver | Wrong routing | Require operator channel confirmation and show meters |
| Windows non-ASIO mode is unreliable | Bad professional experience | Make ASIO the professional recommendation |
| Talkback accidentally recorded | Severe trust failure | Make talkback structurally absent from record bus |
| Audio callback blocks | Dropouts | Real-time-safe callback discipline and code review |
| Disk writing cannot keep up | Corrupt/dropout takes | FIFO plus writer thread plus underrun diagnostics |
| Electron video drifts from native audio | Bad ADR sync | Native engine as clock, video chases transport, later calibration |
| Device disconnect mid-session | Recording failure | Engine error events, safe stop, clear recovery UI |
| Packaging native binaries is complex | Release friction | Add native build pipeline early |
| Hardware testing is insufficient | False confidence | Maintain a real interface compatibility matrix |

## 19. Staged Implementation Roadmap

### Stage 1: Formal Design and Schema

- Adopt this architecture direction.
- Define the default Studio 3-in / 4-out routing preset and remappable logical lane model.
- Define project schema additions for professional audio settings.
- Define versioned engine IPC protocol.
- Decide where engine binaries live in packaged app builds.

### Stage 2: JUCE Engine Skeleton

- Create standalone JUCE engine process.
- Enumerate audio devices.
- Open selected device.
- Validate 3 inputs and 4 outputs.
- Report channel names, sample rate, buffer size, and active channels.
- Emit input/output meters.

Success criterion: Post ADR Pro can show a real interface and verify the default channel map plus user remapping without recording audio.

### Stage 3: Native Routing and Talkback

- Implement configurable output matrix with the default control/booth preset.
- Route talkback input 3 to booth outputs 3-4 only.
- Add push-to-talk command.
- Add gain ramps.
- Add tests proving talkback cannot enter record routing.

Success criterion: Operator can push-to-talk through a real interface with no browser audio dependency.

### Stage 4: Native Guide and Beeps

- Load extracted guide WAV into engine.
- Mute Electron video audio in professional mode.
- Generate cue beeps/countdown in JUCE.
- Route guide and beeps to control and booth.
- Make JUCE transport the audio clock.

Success criterion: Guide and cueing audio route correctly to outputs 1-2 and 3-4.

### Stage 5: Native ADR Recording

- Record armed ADR logical lanes to mono 48 kHz / 24-bit WAV files.
- Use writer thread and FIFO.
- Persist sample-accurate take metadata.
- Confirm talkback, guide, and beeps are absent from the WAV.

Success criterion: Takes are post-production-suitable WAV files captured from the armed logical lanes only.

### Stage 6: Timeline-Aware Take Review

- Play recorded takes in sync with picture.
- Route review to control room only by default.
- Add explicit internal flag for future booth review.

Success criterion: Operator can review a take against picture without sending it to booth.

### Stage 7: Monitoring and Dual Mic

- Add optional native ADR mic self-monitoring to booth.
- Add ADR Mic 2 support.
- Confirm one-mono-file-per-armed-lane workflow and add any needed advanced alternatives later.
- Add per-route gain controls.

Success criterion: Actor monitoring and independent Mic 1/Mic 2 arming exist without Web Audio.

### Stage 8: Production Hardening

- Add ASIO/CoreAudio hardware compatibility matrix.
- Add latency calibration.
- Add reconnect/error recovery.
- Add long-record soak tests.
- Add packaging, signing, and notarization.
- Add session diagnostics export.

Success criterion: Professional routing is stable enough for real ADR sessions.

## 20. Non-Negotiable Invariants

- Renderer is UI only.
- Main process bridges and orchestrates only.
- JUCE engine owns real-time audio.
- Talkback is never recorded.
- Talkback is never exported.
- Guide and beeps are never recorded into ADR takes.
- Output 1-2 and output 3-4 are addressed as hardware channel pairs.
- Recording uses sample-accurate native timing.
- Audio callback performs no blocking work.
- Browser/Web Audio is not part of the final professional routing path.
