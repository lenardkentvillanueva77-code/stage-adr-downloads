# Native Audio Routing Validation Matrix

Status: Active validation checklist
Scope: Studio routing, compact routing, live output changes, transport-time reroute, and native engine recovery
Depends on:
- `docs/professional-audio-backend-architecture.md`
- `docs/professional-audio-backend-implementation-plan.md`

## 1. Purpose

This document is the operator-facing validation matrix for Post ADR Pro's native audio path.

It exists to answer one question clearly:

Can the app behave like a dependable studio tool under real routing changes and failure conditions?

This is not a speculative QA wishlist. It is the concrete checklist for validating the current native engine behavior and for catching regressions before new routing features are layered on top.

## 2. Current Routing Policy

The current native playback policy is:

- Guide playback follows the shared cueing route.
- Pre-roll beeps follow the shared cueing route.
- Audition playback follows the shared cueing route.
- Good-take context playback follows the shared cueing route.
- Mic monitoring routes to every assigned playback pair that exists.
- Talkback routes to Booth only in `studio` mode.

Shared cueing route currently means:

- `both` when valid Control and Booth output pairs are both assigned
- `control` when only Control is assigned
- `booth` when only Booth is assigned
- `none` when neither pair is assigned

This is the intentionally approved behavior at the current product stage.

## 3. Test Setup

Before running this matrix:

1. Use a saved project with video, waveform, at least two cues, and at least one selected good take.
2. Include one overlapping-cue case so context playback can be checked under overlap.
3. Prepare one project with dual-mic takes if available.
4. Keep one compact-only device available if possible, or simulate compact mode by using a stereo-only device.
5. Keep notes per case:
   - actual route heard
   - whether playback stayed in sync
   - whether Refresh was required
   - whether UI state matched reality

Recommended hardware session labels:

- `Studio device`: multichannel ASIO/CoreAudio interface with separate Control and Booth pairs
- `Compact device`: stereo-only output device

## 4. Studio Mode Matrix

Expected mode:

- Native device opens as `Studio routing ready`
- Talkback available
- Control and Booth pair selectors enabled

### 4.1 Guide Playback

Case: Control assigned, Booth assigned
Expected:
- guide heard in Control
- guide heard in Booth
- status reads native guide to Control+Booth

Case: Control assigned, Booth none
Expected:
- guide heard in Control only
- guide silent in Booth

Case: Control none, Booth assigned
Expected:
- guide heard in Booth only
- guide silent in Control

Case: both none
Expected:
- native guide silent
- browser fallback must also be silent

### 4.2 Pre-roll Beeps

Case: loop recording with pre-roll enabled
Expected:
- beeps follow the same route as guide
- visual countdown still appears
- no stray beeps after cancel/stop

Case: stop during countdown
Expected:
- native tones stop immediately
- no late residual beep

### 4.3 Audition Playback

Case: selected cue, audition lane active, both outputs assigned
Expected:
- audition heard in Control
- audition heard in Booth
- audition stays in sync with picture

Case: Control only
Expected:
- audition heard in Control only

Case: Booth only
Expected:
- audition heard in Booth only

Case: neither assigned
Expected:
- audition intentionally silent

### 4.4 Good-Take Context Playback

Case: `Good` enabled, playback enters cue with selected good take
Expected:
- selected good take heard on shared cueing route
- if active audition lane exists, that lane is used consistently

Case: overlapping cues with selected good takes
Expected:
- selected good takes from overlapping cues can play in context
- routing follows shared cueing route

Case: `Good` disabled
Expected:
- only guide/video audio plays

### 4.5 Monitoring

Case: Mic 1 monitoring enabled
Expected:
- Mic 1 heard on all assigned playback pairs
- no monitoring on unassigned pairs

Case: Mic 2 monitoring enabled
Expected:
- Mic 2 heard on all assigned playback pairs

Case: both mic monitors enabled
Expected:
- both active inputs audible
- no talkback bleed into recording path

### 4.6 Talkback

Case: talkback hold pressed in studio mode
Expected:
- talkback heard in Booth only
- not heard in Control
- not recorded

Case: talkback latched by double-click
Expected:
- remains open until single-click release
- still routes Booth only

## 5. Compact Mode Matrix

Expected mode:

- Native device opens as `Compact routing ready`
- Talkback unavailable
- app remains usable for same-room or low-I/O setups

Case: only stereo output exists
Expected:
- shared cueing material follows available stereo output
- talkback disabled in UI
- no false studio messaging

Case: monitoring enabled
Expected:
- monitoring audible on available stereo output
- no phantom booth route behavior

Case: guide, beep, audition, and good playback
Expected:
- all follow the single available cueing route

## 6. Live Change Matrix

These are the cases most likely to reveal stale state.

### 6.1 Change Outputs While Playing

Case: change Control pair during playback
Expected:
- guide resyncs
- audition resyncs if active
- good-take context resyncs if enabled
- no hanging playback on old outputs

Case: change Booth pair during playback
Expected:
- same as above

Case: remove one route during playback
Expected:
- playback collapses cleanly to the remaining valid route

Case: remove both routes during playback
Expected:
- native playback becomes intentionally silent
- no ghost audio from stale engine state

### 6.2 Toggle Track Audibility While Playing

Case: mute video track
Expected:
- guide stops
- take playback remains if takes are audible

Case: unmute video track
Expected:
- guide resumes in sync

Case: mute takes track
Expected:
- audition stops
- good-take context stops

Case: unmute takes track
Expected:
- audition and good-take playback resync when applicable

### 6.3 Buffer Reopen

Case: change buffer size during playback
Expected:
- device reopen completes
- routing and playback resume cleanly
- no stale old-route playback remains

## 7. Recovery Matrix

### 7.1 Engine Loss

Case: native engine dies during playback, metering, routing, monitoring, or talkback
Expected:

- runtime state clears
- routing status becomes `Needs refresh`
- operator sees a clear recovery message
- app does not pretend native playback is still alive

### 7.2 Refresh Recovery

Case: press Refresh after engine loss
Expected:

- engine restarts
- selected device is rediscovered
- reopen occurs automatically when possible
- playback can resume without app restart

### 7.3 Device Replug

Case: unplug and replug interface
Expected:

- if engine loss occurs, state drops to `Needs refresh`
- Refresh returns the panel to a valid state
- no misleading meters or armed-state illusions remain

## 8. Pass / Fail Recording Template

Use this block for each real test session:

```text
Date:
Operator:
Device:
Mode: Studio / Compact
Project:

Case:
Expected:
Observed:
Pass/Fail:
Notes:
```

## 9. Exit Criteria For This Validation Phase

This routing phase is considered trustworthy when all of the following are true:

- Studio mode cases pass on a real multichannel interface
- Compact mode cases pass on a stereo-only device
- Live output changes do not leave stale playback behind
- Recovery behavior consistently lands in `Needs refresh` after native engine loss
- Refresh reliably restores a usable state without requiring an app relaunch

## 10. What This Matrix Does Not Yet Cover

Not covered yet:

- per-playback-class user-configurable routing policy
- separate audition-vs-guide routing preferences
- per-character mic-lane audition memory
- automated test harness for audio routing verification

Those are later improvements. This matrix is for validating the current professional routing model as it exists now.
