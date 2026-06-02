'use strict';

/**
 * ipc/cueHandlers.js
 *
 * IPC handlers for character and cue management.
 * Thin wiring layer — all business logic is in core/projectState.js
 * and core/models/*.  No business logic lives here.
 *
 * Channels registered:
 *   cue:addCharacter    ({ name, description? })
 *   cue:createCue       ({ characterId, inFrames, outFrames, dialogue?, notes? })
 *   cue:updateCue       ({ cueId, patch })
 *   cue:deleteCue       ({ cueId })
 *
 * Every handler that mutates project state returns:
 *   { success: true, project: <full project copy> }
 * or
 *   { success: false, error: string }
 *
 * The renderer always replaces its local project copy with the returned project.
 * It never patches state directly.
 */

const { createCharacter } = require('../core/models/Character');
const { createCue }       = require('../core/models/Cue');
const {
  addCharacter,
  addCue,
  updateCue,
  removeCue,
  findCharacter,
} = require('../core/projectState');
const { getProject, getProjectFilePath } = require('./projectHandlers');

/**
 * Compute the next ADR cue number from the current cue list.
 * Finds the highest trailing integer across all existing cue numbers
 * and returns max + 1 formatted as "ADR-NNN".
 * Never fills gaps — deletion does not renumber.
 *
 * @param {object[]} cues
 * @returns {string}  e.g. "ADR-001"
 */
function nextCueNumber(cues) {
  let max = 0;
  for (const c of cues) {
    const m = (c.cueNumber || '').match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'ADR-' + String(max + 1).padStart(3, '0');
}

/**
 * Get the mutable project reference from projectHandlers.
 * We call getProject() each time rather than caching, so we always
 * have the current state after any other handler has run.
 */
function _getProject(ipcHandlers) {
  return ipcHandlers._project;
}

function register(ipcMain, _getWindow, projectHandlerExports) {
  // projectHandlerExports exposes { getProject, getProjectFilePath }
  // so cueHandlers can read and write _project without duplicating state.
  // We import projectHandlers separately at the top to avoid circular deps.

  // ── Add Character ─────────────────────────────────────────────────────────
  ipcMain.handle('cue:addCharacter', async (_event, { name, description }) => {
    let project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };

    const trimmed = (name || '').trim();
    if (!trimmed) return { success: false, error: 'Character name is required.' };

    // Check for duplicate name (case-insensitive)
    const duplicate = project.characters.find(
      (c) => c.name.toUpperCase() === trimmed.toUpperCase()
    );
    if (duplicate) {
      return { success: false, error: `Character "${trimmed.toUpperCase()}" already exists.` };
    }

    const character = createCharacter({ name: trimmed, description: description || '' });
    project = addCharacter(project, character);

    // Persist the new state back through projectHandlers' reference
    projectHandlerExports._setProject(project);

    return { success: true, project, character };
  });

  // ── Create Cue ────────────────────────────────────────────────────────────
  ipcMain.handle('cue:createCue', async (_event, {
    characterId, inFrames, outFrames, dialogue, notes,
  }) => {
    let project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };

    // Validation
    if (!characterId) {
      return { success: false, error: 'A character must be selected before creating a cue.' };
    }
    if (typeof inFrames !== 'number' || typeof outFrames !== 'number') {
      return { success: false, error: 'inFrames and outFrames are required.' };
    }
    if (outFrames <= inFrames) {
      return { success: false, error: 'Out point must be after In point.' };
    }
    if (!findCharacter(project, characterId)) {
      return { success: false, error: 'Character not found in this project.' };
    }
    if (!project.settings.frameRate) {
      return { success: false, error: 'Project frame rate is not set. Load a video first.' };
    }

    const cueNumber = nextCueNumber(project.cues);

    const cue = createCue({
      projectId:   project.projectId,
      characterId,
      cueNumber,
      dialogue:    dialogue || '',
      notes:       notes    || '',
      inFrames,
      outFrames,
    });

    project = addCue(project, cue);
    projectHandlerExports._setProject(project);

    return { success: true, project, cue };
  });

  // ── Update Cue ────────────────────────────────────────────────────────────
  // patch may contain: { dialogue, notes, characterId, status }
  // Timing (inFrames/outFrames) is not editable in this phase.
  ipcMain.handle('cue:updateCue', async (_event, { cueId, patch }) => {
    let project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };
    if (!cueId)   return { success: false, error: 'cueId is required.' };

    const exists = project.cues.find((c) => c.cueId === cueId);
    if (!exists)  return { success: false, error: `Cue ${cueId} not found.` };

    // Whitelist the fields that can be patched
    // actorId is explicit — not a pass-through unknown field
    const allowed = ['dialogue', 'notes', 'characterId', 'status', 'actorId'];
    const safePatch = {};
    for (const key of allowed) {
      if (key in patch) safePatch[key] = patch[key];
    }

    // Validate characterId if changing
    if (safePatch.characterId && !findCharacter(project, safePatch.characterId)) {
      return { success: false, error: 'Character not found.' };
    }

    // Validate actorId if changing — must be null or reference a known actor
    if ('actorId' in safePatch) {
      const newActorId = safePatch.actorId;
      if (newActorId !== null && newActorId !== undefined) {
        const actorExists = (project.actors || []).some(a => a.actorId === newActorId);
        if (!actorExists) {
          return { success: false, error: `Actor ${newActorId} not found in project.` };
        }
      } else {
        safePatch.actorId = null;   // normalise undefined → null
      }
    }

    project = updateCue(project, cueId, safePatch);
    projectHandlerExports._setProject(project);

    return { success: true, project };
  });

  // ── Delete Cue ────────────────────────────────────────────────────────────
  ipcMain.handle('cue:deleteCue', async (_event, { cueId }) => {
    let project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };
    if (!cueId)   return { success: false, error: 'cueId is required.' };

    const exists = project.cues.find((c) => c.cueId === cueId);
    if (!exists)  return { success: false, error: `Cue ${cueId} not found.` };

    // removeCue also removes all takes for that cue
    project = removeCue(project, cueId);
    projectHandlerExports._setProject(project);

    return { success: true, project };
  });

  // ── Add recorded take to project ─────────────────────────────────────────────
  ipcMain.handle('cue:addTake', async (_event, { take }) => {
    let project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };
    if (!take)    return { success: false, error: 'take object is required.' };

    const cue = project.cues.find(c => c.cueId === take.cueId);
    if (!cue)     return { success: false, error: `Cue ${take.cueId} not found.` };

    // addTake auto-assigns takeNumber based on existing takes for this cue
    const { addTake } = require('../core/projectState');
    project = addTake(project, take);
    projectHandlerExports._setProject(project);

    return { success: true, project };
  });

  ipcMain.handle('cue:selectTake', async (_event, { cueId, takeId }) => {
    let project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };
    if (!cueId)   return { success: false, error: 'cueId is required.' };

    const { selectTake, deselectAllTakes } = require('../core/projectState');
    if (!takeId) {
      project = deselectAllTakes(project, cueId);
      projectHandlerExports._setProject(project);
      return { success: true, project };
    }

    const result = selectTake(project, cueId, takeId);
    if (result.error) return { success: false, error: result.error };

    projectHandlerExports._setProject(result.project);
    return { success: true, project: result.project };
  });
}

module.exports = { register, nextCueNumber };
