# Post ADR Pro Native Audio Engine

Status: Release engine packaged with the Electron app
Purpose: Standalone JUCE process for professional 3-input / 4-output ADR routing

This engine is intentionally separate from Electron. Electron owns UI and project orchestration; this process owns professional audio device access and real-time routing.

## Milestone 1 Scope

The first build of this engine should do only this:

- Start as a standalone process.
- Expose an engine protocol version.
- Enumerate audio devices through JUCE.
- Validate whether a device can support 3 inputs and 4 outputs.
- Open a selected device at 48 kHz.
- Emit meter snapshots for inputs/outputs.

Recording, talkback routing, guide playback, beeps, monitoring, and take review are intentionally later milestones.

## Dependency Strategy

This scaffold expects JUCE to be available at:

```text
native/audio-engine/JUCE/
```

Recommended setup once native tools are installed:

```powershell
cd native/audio-engine
git clone https://github.com/juce-framework/JUCE.git JUCE
```

For a production repo, pin JUCE to a known commit or vendor it explicitly. Do not depend on an unpinned global JUCE install for release builds.

## Build Requirements

Windows:

- CMake
- Visual Studio Build Tools with C++ workload
- A professional audio interface and ASIO driver for real routing validation

macOS:

- CMake
- Xcode command line tools
- CoreAudio-compatible multichannel interface

## Intended Build Commands

```powershell
cmake -S native/audio-engine -B native/audio-engine/build
cmake --build native/audio-engine/build --config Debug
```

The current local machine must have CMake, a C++ compiler, and JUCE before this can compile.

## Verified Windows Build Command

On this machine, the working path is the Visual Studio developer environment with the NMake generator:

```powershell
cmd.exe /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && "C:\Program Files\CMake\bin\cmake.exe" -S native\audio-engine -B native\audio-engine\build-nmake2 -G "NMake Makefiles"'
cmd.exe /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && "C:\Program Files\CMake\bin\cmake.exe" --build native\audio-engine\build-nmake2'
native\audio-engine\build-nmake2\PostAdrAudioEngine_artefacts\Debug\PostAdrAudioEngine.exe
```

Release packaging uses a Release build copied to:

```text
native/audio-engine/bin/PostAdrAudioEngine.exe
```

The executable currently emits:

```json
{"type":"engine.ready","protocolVersion":1,"payload":{"engineVersion":"0.1.0"}}
```

## Verified Protocol Smoke Test

The engine now stays alive and reads one JSON command per stdin line.

```powershell
@(
  '{"id":"1","type":"engine.ping","protocolVersion":1,"payload":{}}',
  '{"id":"2","type":"device.list","protocolVersion":1,"payload":{}}',
  '{"id":"3","type":"engine.quit","protocolVersion":1,"payload":{}}'
) | native\audio-engine\build-nmake2\PostAdrAudioEngine_artefacts\Debug\PostAdrAudioEngine.exe
```

Expected behavior:

- Emits `engine.ready` on startup.
- Responds to `engine.ping` with `engine.pong`.
- Responds to `device.list` with `device.list.result`.
- Marks devices with fewer than 3 inputs or 4 outputs as `isProfessionalRoutingCapable: false`.

## Protocol Direction

The engine will communicate with Electron main over a versioned local IPC protocol. The first implementation should use TCP JSON-lines or WebSocket. No live audio buffers should cross this protocol.

Initial message types:

- `engine.ping`
- `engine.pong`
- `device.list`
- `device.list.result`
- `device.open`
- `device.open.result`
- `device.close`
- `meter.snapshot`
- `engine.error`

## Professional Routing Profile

Logical mapping:

```text
adrMic1      -> input[0]
adrMic2      -> input[1]
talkbackMic  -> input[2]
controlL     -> output[0]
controlR     -> output[1]
boothL       -> output[2]
boothR       -> output[3]
```

Professional mode requires at least 3 inputs and 4 outputs on one full-duplex device.
