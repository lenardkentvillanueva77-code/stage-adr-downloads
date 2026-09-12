'use strict';

/**
 * core/projectState.js
 *
 * Pure state management for the in-memory project.
 * Every function takes a project object and returns a new project object.
 * No mutation. No I/O. No Electron deps.
 *
 * The persistence layer (services/persistence/localStore.js) is responsible
 * for serializing the result to disk. This module knows nothing about that.
 */

const { deepClone, nowISO } = require('./utils');
const { isFrameRateLocked, touchProject } = require('./models/Project');

// ── Video ─────────────────────────────────────────────────────────────────────

/**
 * Attach video metadata to the project.
 * Also sets settings.frameRate if it is not yet locked.
 *
 * @param {object} project
 * @param {object} videoMeta — shape matching project.video
 * @returns {object} new project
 */
function setVideo(project, videoMeta) {
  const next = deepClone(project);
  next.video = { ...videoMeta };

  // Set frame rate from video if not yet locked by cues
  if (!isFrameRateLocked(next) && videoMeta.frameRate) {
    next.settings.frameRate = videoMeta.frameRate;
  }

  return touchProject(next);
}

/**
 * Clear the video from the project (e.g. file not found on open).
 * Does not clear settings.frameRate — that is locked once cues exist.
 *
 * @param {object} project
 * @returns {object} new project
 */
function clearVideo(project) {
  const next = deepClone(project);
  next.video = null;
  return touchProject(next);
}

// ── Settings ──────────────────────────────────────────────────────────────────

/**
 * Update project settings.
 * Frame rate update is rejected if cues exist (immutability rule).
 *
 * @param {object} project
 * @param {object} settingsPatch — partial settings object
 * @returns {{ project: object, warning?: string }}
 */
function updateSettings(project, settingsPatch) {
  const next = deepClone(project);
  let warning;

  if ('frameRate' in settingsPatch && isFrameRateLocked(project)) {
    warning = 'Frame rate cannot be changed after cues have been created.';
    delete settingsPatch.frameRate;
  }

  next.settings = { ...next.settings, ...settingsPatch };
  return { project: touchProject(next), warning };
}

// ── Actors ────────────────────────────────────────────────────────────────────

/**
 * Add an actor to the project.
 * Caller is responsible for pre-validating uniqueness and email format.
 * @param {object} project
 * @param {object} actor — from createActor()
 * @returns {object} new project
 */
function addActor(project, actor) {
  const next = deepClone(project);
  next.actors = [...(next.actors || []), actor];
  return touchProject(next);
}

/**
 * Update an actor by actorId.
 * @param {object} project
 * @param {string} actorId
 * @param {object} patch   — { name?, email? }; remoteEnabled not patchable in Phase 1
 * @returns {object} new project
 */
function updateActor(project, actorId, patch) {
  const next = deepClone(project);
  next.actors = (next.actors || []).map(a =>
    a.actorId === actorId ? { ...a, ...patch } : a
  );
  return touchProject(next);
}

/**
 * Remove an actor. All cues referencing this actor have actorId set to null.
 * @param {object} project
 * @param {string} actorId
 * @returns {object} new project
 */
function removeActor(project, actorId) {
  const next = deepClone(project);
  next.actors = (next.actors || []).filter(a => a.actorId !== actorId);
  // De-reference from all cues
  next.cues = next.cues.map(c =>
    c.actorId === actorId ? { ...c, actorId: null } : c
  );
  return touchProject(next);
}

/**
 * Assign an actor to a cue. Passing null clears the assignment.
 * Validates that actorId exists in project.actors unless null.
 * @param {object}      project
 * @param {string}      cueId
 * @param {string|null} actorId
 * @returns {{ project: object, error?: string }}
 */
function assignActorToCue(project, cueId, actorId) {
  if (actorId !== null) {
    const actorExists = (project.actors || []).some(a => a.actorId === actorId);
    if (!actorExists) {
      return { project, error: `Actor ${actorId} not found in project.` };
    }
  }
  const next = deepClone(project);
  next.cues = next.cues.map(c =>
    c.cueId === cueId ? { ...c, actorId: actorId || null, updatedAt: nowISO() } : c
  );
  return { project: touchProject(next) };
}

/**
 * Find an actor by actorId, or null.
 * @param {object} project
 * @param {string} actorId
 * @returns {object|null}
 */
function findActor(project, actorId) {
  return (project.actors || []).find(a => a.actorId === actorId) || null;
}

// ── Characters ────────────────────────────────────────────────────────────────

/**
 * Add a character to the project.
 * @param {object} project
 * @param {object} character — from createCharacter()
 * @returns {object} new project
 */
function addCharacter(project, character) {
  const next = deepClone(project);
  next.characters = [...next.characters, character];
  return touchProject(next);
}

/**
 * Update a character by characterId.
 * @param {object} project
 * @param {string} characterId
 * @param {object} patch
 * @returns {object} new project
 */
function updateCharacter(project, characterId, patch) {
  const next = deepClone(project);
  next.characters = next.characters.map((c) =>
    c.characterId === characterId ? { ...c, ...patch } : c
  );
  return touchProject(next);
}

/**
 * Remove a character. Rejected if any cue references this character.
 * @param {object} project
 * @param {string} characterId
 * @returns {{ project: object, error?: string }}
 */
function removeCharacter(project, characterId) {
  const inUse = project.cues.some((cue) => cue.characterId === characterId);
  if (inUse) {
    return {
      project,
      error: 'Cannot remove a character that has cues assigned.',
    };
  }
  const next = deepClone(project);
  next.characters = next.characters.filter((c) => c.characterId !== characterId);
  return { project: touchProject(next) };
}

// ── Cues ──────────────────────────────────────────────────────────────────────

/**
 * Add a cue to the project.
 * @param {object} project
 * @param {object} cue — from createCue()
 * @returns {object} new project
 */
function addCue(project, cue) {
  const next = deepClone(project);
  next.cues = [...next.cues, cue];
  return touchProject(next);
}

/**
 * Update a cue by cueId.
 * Frame rate lock is enforced here — timing fields follow whatever
 * settings.frameRate is already set.
 * @param {object} project
 * @param {string} cueId
 * @param {object} patch
 * @returns {object} new project
 */
function updateCue(project, cueId, patch) {
  const now = nowISO();
  const next = deepClone(project);
  next.cues = next.cues.map((c) =>
    c.cueId === cueId ? { ...c, ...patch, updatedAt: now } : c
  );
  return touchProject(next);
}

function roundSeconds(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Move every recorded take for a cue by the same metadata offset.
 * Used when cue In changes so the take audio stays in the same absolute
 * timeline position while the cue boundary itself moves.
 *
 * @param {object} project
 * @param {string} cueId
 * @param {number} offsetDeltaSecs
 * @returns {object} new project
 */
function shiftCueTakeSyncOffsets(project, cueId, offsetDeltaSecs) {
  const delta = Number(offsetDeltaSecs);
  if (!cueId || !Number.isFinite(delta) || delta === 0) return project;

  const next = deepClone(project);
  let changed = false;
  const now = nowISO();

  next.takes = (next.takes || []).map((take) => {
    if (take.cueId !== cueId) return take;
    changed = true;
    const source = take.syncEdit && typeof take.syncEdit === 'object' ? take.syncEdit : {};
    return {
      ...take,
      updatedAt: now,
      syncEdit: {
        offsetSecs: roundSeconds((Number(source.offsetSecs) || 0) + delta),
        trimStartSecs: Number(source.trimStartSecs) || 0,
        trimEndSecs: Number(source.trimEndSecs) || 0,
        laneOffsets: { ...(source.laneOffsets || {}) },
        updatedAt: now,
      },
    };
  });

  return changed ? touchProject(next) : project;
}

/**
 * Remove a cue. Also removes all takes for that cue.
 * @param {object} project
 * @param {string} cueId
 * @returns {object} new project
 */
function removeCue(project, cueId) {
  const next = deepClone(project);
  next.cues = next.cues.filter((c) => c.cueId !== cueId);
  next.takes = next.takes.filter((t) => t.cueId !== cueId);
  return touchProject(next);
}

// ── Takes ─────────────────────────────────────────────────────────────────────

/**
 * Add a take to the project.
 * takeNumber is computed automatically as (max existing takeNumber for cue) + 1.
 * @param {object} project
 * @param {object} take — from createTake(), takeNumber will be overwritten
 * @returns {object} new project
 */
function addTake(project, take) {
  const existingForCue = project.takes.filter((t) => t.cueId === take.cueId);
  const maxNumber = existingForCue.reduce((m, t) => Math.max(m, t.takeNumber), 0);
  const next = deepClone(project);
  const numbered = { ...take, takeNumber: maxNumber + 1 };
  next.takes = [...next.takes, numbered];
  return touchProject(next);
}

/**
 * Replace editable metadata on one take while preserving project immutability.
 * Callers are responsible for whitelisting the patch at the IPC boundary.
 */
function updateTake(project, takeId, patch) {
  if (!project.takes.some((take) => take.takeId === takeId)) {
    return { project, error: `Take ${takeId} not found.` };
  }
  const next = deepClone(project);
  next.takes = next.takes.map((take) => take.takeId === takeId
    ? { ...take, ...patch, updatedAt: nowISO() }
    : take);
  return { project: touchProject(next) };
}

/**
 * Select a take for a cue. Enforces the invariant:
 * exactly one take per cue may have isSelected: true.
 * Also prevents selecting a rejected take.
 *
 * @param {object} project
 * @param {string} cueId
 * @param {string} takeId
 * @returns {{ project: object, error?: string }}
 */
function selectTake(project, cueId, takeId) {
  const take = project.takes.find((t) => t.takeId === takeId);
  if (!take) {
    return { project, error: `Take ${takeId} not found.` };
  }
  if (take.rating === 'reject') {
    return { project, error: 'Cannot select a rejected take.' };
  }

  const next = deepClone(project);
  next.takes = next.takes.map((t) => {
    if (t.cueId !== cueId) return t;
    return { ...t, isSelected: t.takeId === takeId };
  });

  // Update cue status to "recorded" if it was "open"
  next.cues = next.cues.map((c) => {
    if (c.cueId !== cueId) return c;
    if (c.status === 'open') return { ...c, status: 'recorded', updatedAt: nowISO() };
    return c;
  });

  return { project: touchProject(next) };
}

/**
 * Deselect all takes for a cue.
 * @param {object} project
 * @param {string} cueId
 * @returns {object} new project
 */
function deselectAllTakes(project, cueId) {
  const next = deepClone(project);
  next.takes = next.takes.map((t) =>
    t.cueId === cueId ? { ...t, isSelected: false } : t
  );
  return touchProject(next);
}

/**
 * Rate a take. If rating is set to "reject" and the take was selected,
 * it is automatically deselected (caller must explicitly select a replacement).
 *
 * @param {object} project
 * @param {string} takeId
 * @param {'none'|'circle'|'reject'} rating
 * @returns {object} new project
 */
function rateTake(project, takeId, rating) {
  const next = deepClone(project);
  next.takes = next.takes.map((t) => {
    if (t.takeId !== takeId) return t;
    const updated = { ...t, rating };
    if (rating === 'reject' && t.isSelected) {
      updated.isSelected = false;
    }
    return updated;
  });
  return touchProject(next);
}

/**
 * Remove a take by takeId.
 * @param {object} project
 * @param {string} takeId
 * @returns {object} new project
 */
function removeTake(project, takeId) {
  const next = deepClone(project);
  next.takes = next.takes.filter((t) => t.takeId !== takeId);
  return touchProject(next);
}

// ── Queries (read-only, no mutation) ─────────────────────────────────────────

/**
 * Return all takes for a given cueId, sorted by takeNumber.
 * @param {object} project
 * @param {string} cueId
 * @returns {object[]}
 */
function takesForCue(project, cueId) {
  return project.takes
    .filter((t) => t.cueId === cueId)
    .sort((a, b) => a.takeNumber - b.takeNumber);
}

/**
 * Return the selected take for a cue, or null.
 * @param {object} project
 * @param {string} cueId
 * @returns {object|null}
 */
function selectedTakeForCue(project, cueId) {
  return project.takes.find((t) => t.cueId === cueId && t.isSelected) || null;
}

/**
 * Return the character object for a characterId, or null.
 * @param {object} project
 * @param {string} characterId
 * @returns {object|null}
 */
function findCharacter(project, characterId) {
  return project.characters.find((c) => c.characterId === characterId) || null;
}

module.exports = {
  // Video
  setVideo,
  clearVideo,
  // Settings
  updateSettings,
  // Actors
  addActor,
  updateActor,
  removeActor,
  assignActorToCue,
  findActor,
  // Characters
  addCharacter,
  updateCharacter,
  removeCharacter,
  // Cues
  addCue,
  updateCue,
  shiftCueTakeSyncOffsets,
  removeCue,
  // Takes
  addTake,
  updateTake,
  selectTake,
  deselectAllTakes,
  rateTake,
  removeTake,
  // Queries
  takesForCue,
  selectedTakeForCue,
  findCharacter,
};
