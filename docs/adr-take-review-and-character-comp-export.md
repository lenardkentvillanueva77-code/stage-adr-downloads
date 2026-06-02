# ADR Take Review and Character Comp Export

Status: Draft product/audio workflow  
Scope: Multi-take ADR review, good-take selection, and per-character export

## 1. Purpose

Post ADR Pro must support the full ADR recording workflow, not only raw take capture.

The professional workflow is:

1. Spot cue.
2. Record multiple takes.
3. Audition takes against picture.
4. Select the good take for each cue.
5. Export selected takes as comped ADR tracks, one track per character.

This document defines that target so the native audio engine and project schema evolve toward the real post-production workflow.

## 2. Take Model Requirements

Each cue may have multiple takes:

- Take 1
- Take 2
- Take 3
- Additional takes as needed

Each take should remain available after recording unless explicitly deleted. Selecting a good take must not destroy or overwrite other takes.

In the native professional model, a take is a pass/group, not a single mic file. A pass may contain one or more recorded mic lane files depending on which logical ADR lanes were armed at record time.

Examples:

```text
Take 1
  Mic 1 file only

Take 2
  Mic 1 file
  Mic 2 file

Take 3
  Mic 2 file only
```

Mic lane availability is user-defined. The app provides logical lanes such as Mic 1 and Mic 2, but the operator maps each lane to a physical interface input and arms the lanes needed for that session or cue.

Current useful fields:

- `takeId`
- `cueId`
- `takeNumber`
- `filePath`
- `durationSecs`
- `startOffsetSecs`
- `actorId`
- `recordedAt`
- `isSelected`
- `rating`
- `notes`

Future sample-accurate fields should be added when native recording lands:

- `sampleRate`
- `bitDepth`
- `channelCount`
- `engineStartSample`
- `timelineStartFrame`
- `cueStartFrame`
- `startOffsetSamples`
- `durationSamples`
- `latencyCompensationSamples`
- `sourceInput`
- `deviceSnapshot`
- `takeGroupId`
- `recordedFiles[]`
- `recordedFiles[].laneId`
- `recordedFiles[].physicalInputChannel`
- `recordedFiles[].filePath`
- `recordedFiles[].durationSamples`

## 3. Good Take Selection

Each cue should allow exactly one selected good take.

Rules:

- A cue may have zero selected takes while work is in progress.
- Selecting one take clears `isSelected` from other takes for the same cue.
- Rejected takes cannot be selected.
- Selecting a take should move the cue status from `open` to `recorded` if needed.
- Good take selection is project metadata. It does not modify the take WAV.
- Selection happens at the take/pass group level, not at the individual mic-file level.
- If a selected take contains Mic 1 and Mic 2 files, both files remain linked as the selected performance.

Existing `projectState.selectTake()` already enforces the core one-selected-take-per-cue invariant and rejects selected rejected takes. Native recording/export should preserve that model.

## 4. Take Audition Workflow

Operators need to audition take 1, take 2, take 3, etc. against picture.

Required behavior:

- Select a cue.
- See all takes for that cue.
- Audition any take.
- Hear the take in sync with picture.
- Compare takes quickly.
- Mark one take as selected/good.
- Optionally rate takes as circle/reject.

Take audition must be timeline-aware. It is not enough to play the WAV file from the beginning without picture sync.

## 5. Timeline-Aware Take Review

The native audio engine should own take review timing.

Review behavior:

- Picture starts from the chosen review position, usually with pre-roll.
- The take plays at the correct cue timeline position.
- `startOffsetSecs` / future `startOffsetSamples` determines any offset between cue in-point and actual recording start.
- Review routes to Control Room outputs 1-2 by default.
- Booth outputs 3-4 do not receive review unless explicitly enabled later.

Default review routing:

| Source | Control 1-2 | Booth 3-4 |
|---|---:|---:|
| Selected take review | yes | no |
| Non-selected take audition | yes | no |
| Guide audio during review | optional | optional later |
| Talkback | no | push-to-talk only |

The first implementation may review with guide muted or mixed, but the mode must be explicit.

## 6. Character Comp Export

Post ADR Pro must export selected good takes as character comp tracks.

Target output:

- One folder per character.
- One WAV per exported mic lane inside that character folder.
- Contains only selected good takes for cues belonging to that character.
- Takes are placed at their correct timeline positions.
- Silence fills the gaps between cue placements.
- Export length should match the project/video timeline or an explicit export range.

Example:

```text
ELENA/
  ELENA_mic1.wav
    cue ADR-001 selected take Mic 1 placed at cue timeline position
    silence
    cue ADR-004 selected take Mic 1 placed at cue timeline position

  ELENA_mic2.wav
    cue ADR-001 selected take Mic 2 placed at cue timeline position, if present
    silence
    cue ADR-004 selected take Mic 2 placed at cue timeline position, if present

MARCUS/
  MARCUS_mic1.wav
  MARCUS_mic2.wav
```

If a character has no selected takes for a given mic lane, the exporter may omit that lane file or create an all-silence file only when explicitly requested.

## 7. Export Exclusions

Character comp exports must never include:

- Talkback
- Guide audio
- Cue beeps
- Countdown tones
- Control room monitor audio
- Booth monitor audio
- Non-selected takes
- Rejected takes

The export source is selected take WAV files only.

## 8. Export Format

Initial target:

- WAV
- 48 kHz
- 24-bit PCM
- Mono per exported mic lane

Future target:

- Broadcast WAV metadata
- Time reference / start time
- Project ID
- Film title
- Character name
- Cue/take provenance metadata where appropriate

## 9. Native Engine Responsibilities

For take review, the native engine should:

- Load take WAV files.
- Place them against the engine transport timeline.
- Route review audio to Control Room 1-2 by default.
- Emit review state events to Electron.

For character comp export, the native engine or a native offline renderer should:

- Read project cue/take metadata.
- Resolve selected takes per character.
- Create one character output folder.
- Create one timeline buffer/file per exported mic lane.
- Place each selected take lane file at the correct sample offset.
- Write final WAV files.

Offline export should not depend on renderer/browser audio.

## 10. Electron Responsibilities

Renderer:

- Display takes per cue.
- Provide audition controls.
- Provide selected/good take controls.
- Show export progress and result paths.

Main process:

- Send review/export commands to the native engine.
- Resolve file paths.
- Persist selected take metadata.
- Report export errors.

Renderer must not mix or render final character comp audio.

## 11. Required Future Commands

Potential native protocol commands:

```json
{ "type": "take.review", "payload": { "takeId": "...", "cueId": "...", "sendToBooth": false } }
{ "type": "take.review.stop", "payload": {} }
{ "type": "take.load", "payload": { "takeId": "...", "filePath": "..." } }
{ "type": "export.characterComps", "payload": { "projectId": "...", "outputDir": "...", "characters": "all", "micLanes": "available" } }
```

Potential engine events:

```json
{ "type": "take.review.started", "payload": { "takeId": "..." } }
{ "type": "take.review.stopped", "payload": { "takeId": "..." } }
{ "type": "export.characterComps.progress", "payload": { "current": 1, "total": 4 } }
{ "type": "export.characterComps.completed", "payload": { "files": [] } }
```

## 12. Acceptance Criteria

Take review is acceptable when:

- Operator can audition each take for a cue.
- Review is in sync with picture.
- Review routes to Control Room only by default.
- Operator can select exactly one good take per cue.

Character comp export is acceptable when:

- Each character receives an export folder.
- Each character folder contains separate WAV files per exported mic lane.
- Only selected takes for that character are included.
- Takes are placed at the correct timeline positions.
- Talkback, guide audio, beeps, and non-selected takes are absent.
- Output WAVs are valid post-production assets.
