'use strict';

/**
 * src/ipc/actorHandlers.js
 *
 * IPC handlers for Actor management and cue-actor assignment.
 * Thin wiring layer — all business logic lives in projectState.js and Actor.js.
 *
 * Channels:
 *   actor:addActor      ({ name, email }) → { success, project, actor? }
 *   actor:updateActor   ({ actorId, patch }) → { success, project }
 *   actor:deleteActor   ({ actorId }) → { success, project }
 *   actor:assignToCue   ({ cueId, actorId }) → { success, project }
 */

const { createActor, validateEmail, isEmailTaken } = require('../core/models/Actor');
const { addActor, updateActor, removeActor, assignActorToCue } = require('../core/projectState');

function register(ipcMain, getWindow, projectHandlerExports) {
  const getProject  = projectHandlerExports.getProject;
  const _setProject = projectHandlerExports._setProject;

  // ── Add Actor ───────────────────────────────────────────────────────────────
  ipcMain.handle('actor:addActor', async (_event, { name, email }) => {
    let project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };

    // Name validation
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      return { success: false, error: 'Actor name is required.' };
    }

    // Email validation — required and must be valid format
    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) {
      return { success: false, error: emailCheck.reason };
    }

    // Email uniqueness — case-insensitive within project
    if (isEmailTaken(project.actors || [], emailCheck.normalised)) {
      return { success: false, error: `An actor with email "${emailCheck.normalised}" already exists in this project.` };
    }

    const actor = createActor({ name: trimmedName, email: emailCheck.normalised });
    project = addActor(project, actor);
    _setProject(project);

    return { success: true, project, actor };
  });

  // ── Update Actor ────────────────────────────────────────────────────────────
  ipcMain.handle('actor:updateActor', async (_event, { actorId, patch }) => {
    let project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };

    const existing = (project.actors || []).find(a => a.actorId === actorId);
    if (!existing) return { success: false, error: `Actor ${actorId} not found.` };

    const safePatch = {};

    if ('name' in patch) {
      const trimmedName = (patch.name || '').trim();
      if (!trimmedName) return { success: false, error: 'Actor name cannot be empty.' };
      safePatch.name = trimmedName;
    }

    if ('email' in patch) {
      const emailCheck = validateEmail(patch.email);
      if (!emailCheck.valid) return { success: false, error: emailCheck.reason };
      if (isEmailTaken(project.actors || [], emailCheck.normalised, actorId)) {
        return { success: false, error: `An actor with email "${emailCheck.normalised}" already exists in this project.` };
      }
      safePatch.email = emailCheck.normalised;
    }

    // remoteEnabled is not patchable in Phase 1
    project = updateActor(project, actorId, safePatch);
    _setProject(project);

    return { success: true, project };
  });

  // ── Delete Actor ────────────────────────────────────────────────────────────
  // Removes the actor and de-references from all cues (sets actorId → null).
  ipcMain.handle('actor:deleteActor', async (_event, { actorId }) => {
    let project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };

    const existing = (project.actors || []).find(a => a.actorId === actorId);
    if (!existing) return { success: false, error: `Actor ${actorId} not found.` };

    project = removeActor(project, actorId);
    _setProject(project);

    return { success: true, project };
  });

  // ── Assign Actor to Cue ─────────────────────────────────────────────────────
  // actorId may be null to clear the assignment.
  ipcMain.handle('actor:assignToCue', async (_event, { cueId, actorId }) => {
    let project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };

    if (!cueId) return { success: false, error: 'cueId is required.' };

    const cueExists = project.cues.some(c => c.cueId === cueId);
    if (!cueExists) return { success: false, error: `Cue ${cueId} not found.` };

    // actorId must be null or reference an existing actor
    const result = assignActorToCue(project, cueId, actorId || null);
    if (result.error) return { success: false, error: result.error };

    project = result.project;
    _setProject(project);

    return { success: true, project };
  });
}

module.exports = { register };
