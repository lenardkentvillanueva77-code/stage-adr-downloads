# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-09-12
- Primary product surfaces: ADR timeline, cue inspector, takes monitor, Sync/Comp Editor, audio console, actor booth.
- Evidence reviewed: `renderer/index.html`, `renderer/styles.css`, `renderer/app.js`, `docs/adr-take-review-and-character-comp-export.md`, and the native audio routing documentation under `docs/`.

## Brand
- Personality: Professional, focused, technical, and calm under session pressure.
- Trust signals: Deterministic controls, clear active states, visible timing values, non-destructive edits, and explicit save feedback.
- Avoid: Marketing layouts, oversized display text, decorative gradients, playful copy, ambiguous transport states, and deeply rounded surfaces.

## Product goals
- Goals: Make ADR spotting, recording, sync correction, take comparison, and comp creation usable in one desktop workflow.
- Non-goals: Reproduce a full DAW, replace detailed mix automation, or add destructive source-file editing.
- Success signals: Operators can correct a take without leaving the app, A/B sources quickly, create a clearly marked comp take, and recover all edits from the project file.

## Personas and jobs
- Primary personas: ADR recordists, dialogue editors, supervising sound editors, and small post-production teams.
- User jobs: Record performances, align them to picture, compare takes, choose source regions, create a comp, and export dependable deliverables.
- Key contexts of use: Dark control rooms, time-pressured sessions, mouse-and-keyboard operation, and multi-monitor desktop setups.

## Information architecture
- Primary navigation: Persistent timeline workspace with cue and take sidebars; modal work surfaces for focused editing and project-level tasks.
- Core routes/screens: Main ADR workspace, Sync/Comp Editor, actor booth display, project/export dialogs.
- Content hierarchy: Picture and transport first; active cue and take state second; detailed editing and project setup third.

## Design principles
- Session speed: Frequent actions stay one click away and preserve the operator's selected cue and playback context.
- State clarity: Audible lane, selected source range, saved edit, and created take status must always be visible.
- Non-destructive by default: Sync and comp decisions are project metadata; source recordings remain unchanged.
- Tradeoffs: Prefer a focused region editor over broad DAW-style tooling, and prefer predictable controls over animation.

## Visual language
- Color: Neutral black/charcoal workspace with existing blue selection, green approval, amber audition, and red record/action accents.
- Typography: Existing system UI font with monospace timing and technical values.
- Spacing/layout rhythm: Dense 4/6/8/12/16px rhythm suitable for repeated editing work.
- Shape/radius/elevation: 3-8px radii, fine borders, minimal elevation, and no nested decorative cards.
- Motion: Short state transitions only; editing must not depend on motion.
- Imagery/iconography: Picture and waveform content carry the visual surface; use familiar symbols and existing text controls where icon infrastructure is absent.

## Components
- Existing components to reuse: Buttons, segmented controls, modal overlay, take groups, lane monitor states, status bar, and timing inputs.
- New/changed components: Full-width Sync/Comp Editor, mode tabs, editor ruler, main lane, source lane, region block, range handles, source checklist, and created-take marker.
- Variants and states: Sync/Comp mode, audible/muted source, selected/unselected source, saved/dirty editor, recorded/created take, empty comp lane, and invalid range.
- Token/component ownership: Reuse `renderer/styles.css` root tokens and keep editor-specific rules under one Sync/Comp Editor section.

## Accessibility
- Target standard: Practical WCAG 2.1 AA for desktop controls and text.
- Keyboard/focus behavior: Native inputs and buttons remain keyboard reachable; Escape closes the editor; range inputs expose numeric alternatives.
- Contrast/readability: Technical labels use existing high-contrast palette; state is shown with both color and text.
- Screen-reader semantics: Mode and audition buttons expose pressed/selected state; source selection uses native checkboxes.
- Reduced motion and sensory considerations: No required animation; editor state changes are immediate.

## Responsive behavior
- Supported breakpoints/devices: Desktop Electron window from the existing 960x680 minimum through wide multi-monitor layouts.
- Layout adaptations: Editor lanes remain horizontally scrollable at narrow widths; controls wrap without changing lane geometry.
- Touch/hover differences: Desktop mouse and keyboard are primary; controls retain usable pointer targets without relying on hover.

## Interaction states
- Loading: Disable save/audition while a comp render is running and show status text.
- Empty: Explain that Comp Mode needs at least one source take and that the main lane has no regions yet.
- Error: Keep the editor open, preserve decisions, and show the failure in the app status bar and editor status.
- Success: Refresh the takes list and identify the saved take number.
- Disabled: Unavailable audition and save actions are visibly disabled.
- Offline/slow network, if applicable: All editor behavior is local and does not require a network.

## Content voice
- Tone: Concise, operational, and specific.
- Terminology: Use cue, take, mic lane, source, range, offset, trim, comp, audition, and created take consistently.
- Microcopy rules: State the action and object; avoid tutorials inside the work surface.

## Implementation constraints
- Framework/styling system: Plain Electron renderer HTML/CSS/JavaScript with CommonJS main-process modules.
- Design-token constraints: Extend existing CSS custom properties; do not introduce a second token system.
- Performance constraints: Keep editor rendering DOM-based and bounded to takes for the selected cue; render audio off the renderer thread through IPC.
- Compatibility constraints: Existing project files and recorded takes must load without migration; new edit fields are optional.
- Test/screenshot expectations: Run syntax checks and focused model/audio tests; smoke-test the Electron UI when the environment permits.

## Open questions
- [ ] Confirm whether a future release should support sample-level waveform editing instead of the current millisecond-level region controls.
- [ ] Decide whether created comp takes should inherit Good Take status automatically or remain unselected.
- [ ] Define long-term undo/redo scope across editor saves and project sessions.
