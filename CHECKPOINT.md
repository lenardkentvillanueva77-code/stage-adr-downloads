# Post ADR Pro - Stable Checkpoint

## Version: 1.1.0 - Compact Recording Recovery Build

**Date:** 2026-07-13  
**Status:** Verified on Focusrite 2i2 compact workflow

This checkpoint packages the current recovery build for portable testing on another Windows PC.

Confirmed in the current pass:

- Native compact-mode recording works on Focusrite 2i2.
- Talkback is correctly unavailable in compact 2-in / 2-out routing.
- Repeated recording passes complete successfully.
- Take audition, good-take playback, and export are synced.
- Booth first-pass playback sync fix is retained.
- Streamer feature is restored.
- Keyboard shortcuts and MIDI learn are restored.
- Native recorder hardening rejects/deletes zero-sample captures instead of treating them as valid takes.

Portable build output:

```text
release/Post ADR Pro Beta 1.1 Portable 1.1.0.exe
```

---

## Version: 1.0.0 - Stable Pre-Recording Foundation

**Date:** 2026-05-12  
**Status:** Verified - 47/47 checks pass

This is the approved stable restore point before the Actor Booth Display Mode feature phase.

---

## What is working at this checkpoint

### Project management
- New project / Open project / Save project / Save As
- Autosave (60-second interval, separate file, no primary file corruption)
- Autosave recovery prompt on reopen
- Unsaved changes protection (Save / Don't Save / Cancel on close)
- Schema migration support

### Video & waveform
- FFmpeg/FFprobe video loading and metadata extraction
- Guide audio extraction and waveform peak generation
- Waveform canvas rendering - O(viewport width), works at any film length

### Timeline navigation
- 6-level stepped zoom: Full / 10m / 5m / 3m / 2m / 1m
- Ctrl/Cmd + mouse wheel zoom, focused on cursor position
- Fit to Project / Zoom to Selection
- Horizontal pan (scrollbar drag, shift+wheel, arrow keys)
- Auto-scroll during playback (keeps playhead visible)
- Click-to-seek on ruler and waveform (frame-accurate at all zoom levels)
- **Ruler drag-select: click-drag on ruler creates In/Out range**

### Spotting & marking
- Mark In / Mark Out buttons (frame-accurate)
- Ruler drag-select enters clean spotting mode (auto-deselects active cue)
- Zoom to Selection frames the In/Out region

### Playback
- Play / Pause / Stop transport
- Loop playback within In/Out region
- Cue pre-roll: 3-count beep + visual dot countdown before loop playback
- Pre-roll fires only on cue loop, never on normal play
- Playback volume slider (session-only)
- Beep volume slider (session-only)

### Cue system
- Create cue from In/Out via modal (select existing or create new character)
- Auto-numbering: ADR-001, ADR-002 ... gap-safe on deletion
- Cue list sorted by in-point
- Cue list filter by character (ALL CHARACTERS or specific)
- Select cue -> seeks to in-point, restores loop region
- Escape (with cue selected) -> deselects cue + clears range
- Escape (no cue, range exists) -> clears range
- Escape (neutral) -> does nothing
- Edit dialogue and notes in cue detail editor
- Toggle cue status: OPEN <-> COMPLETED
- Per-item COMPLETED toggle in cue list (does not trigger cue selection)
- Delete cue with confirmation (no renumbering)
- Character management (name, case-normalised, duplicate prevention)

### Dialogue overlay
- HTML/CSS overlay over video - display-only, no burn-in
- Show/hide toggle
- 4 preset colours: White / Yellow / Red / Green
- 3 font sizes: Small / Medium / Large
- Updates live when selected cue changes or dialogue is edited

### UI organisation
- Collapsible left sidebar panels
- Playback Settings open by default; Project/Video/Session/Region closed by default
- POST ADR PRO branding

### Exports
- PDF export: ADR List with logo, project metadata, timecoded cue table, Prepared By footer
- CSV export: RFC 4180-compliant, UTF-8 with BOM, all 7 columns, timecodes formatted

---

## File manifest (29 source files)

```text
main.js
preload.js
package.json

renderer/
  index.html
  styles.css
  app.js
  assets/
    stagepost-logo.png

src/
  core/
    models/Character.js
    models/Cue.js
    models/Project.js
    models/Take.js
    projectState.js
    schemaVersion.js
    timecode.js
    utils.js
  ipc/
    cueHandlers.js
    dialogHandlers.js
    exportHandlers.js
    mediaHandlers.js
    projectHandlers.js
    waveformHandlers.js
  services/
    export/
      cueSheetCsv.js
      cueSheetPdf.js
    media/
      ffmpeg.js
      ffprobe.js
    persistence/
      autosave.js
      localStore.js
      store.interface.js
```

---

## Architecture invariants (must be preserved in all future phases)

- `renderer/app.js` has **no `require()` calls** - renderer never touches Node.js
- All IPC via `window.api` (preload contextBridge, contextIsolation: true)
- `<video>` element is **display only** - never used for recording trigger timing
- **Frame values** (`inFrames`, `outFrames`) are the timing source of truth; timecodes are display-only
- Waveform rendering is **O(canvas width)**, never O(peak count)
- Zoom is **viewport scaling only** - peak data is never regenerated per zoom
- Autosave writes to a **separate file** - never overwrites the primary `.stageadr`
- All business logic in `src/core/` and `src/services/` - IPC handlers are thin wiring only

---

## Next phase

**Actor Booth Display Mode** - a separate window for actor/operator showing the active cue's dialogue and countdown.

---

## Current recovery pipeline (post-recording regression)

This is the active revive order from the current stable recording/sync base.

### Protected base

The following must remain stable while reviving later work:

- Recording works again from the restored stable path
- First-pass booth sync delay fix remains intact
- Recorder/routing behavior must not be casually changed while reviving UI or control features

### Revive in this order

1. **Sunday feature recovery: media path rebasing on open**
   - Status: already present in the current base and verified against commit `0312353`
   - Restore the moved-project / other-machine reopen behavior from commit `0312353`
   - Verify reopened sessions still find recorded takes and project media correctly

2. **Sunday feature recovery: configurable shortcuts and MIDI learn**
   - Status: restored in code from commit `6cfd7b9`, pending runtime verification
   - Restore editable keyboard shortcuts from commit `6cfd7b9`
   - Restore MIDI learn / MIDI mapping from commit `6cfd7b9`
   - Verify shortcut focus handling does not interfere with transport, record, or dropdown behavior

3. **Streamer restore/rebuild**
   - Restore cue-level streamer target behavior
   - Restore booth streamer rendering
   - Match the approved booth design spec:
     - full-height green streamer
     - rectangular, not rounded
     - continues past center to the right edge
     - subtle transparency
     - center hit flash when it reaches the target
     - first dialogue line anchored so the streamer hits directly on the first line text
     - second line centered below
     - lower-screen placement, not vertical center
   - Verify streamer does not break recording, `L` rehearsal, `Space` playback, or booth sync

4. **Recording/routing hardening pass**
   - Repeated record starts/stops
   - Loop record across multiple passes
   - Booth/control output reassignment
   - Talkback hold/latch behavior
   - Reopen project, reopen device, record again

5. **Export verification pass**
   - Verify audition playback, timeline playback, and exported files all agree
   - Confirm recording offset remains consistent through export

### Rule for all recovery work

If a revive step threatens recording stability, stop and reassess against the stable base before continuing.
