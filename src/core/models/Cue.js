'use strict';

/**
 * core/models/Cue.js
 *
 * Cue factory. Pure functions. No I/O. No Electron deps.
 *
 * Timing is always stored as frame counts (inFrames, outFrames).
 * Timecode strings are display-only and are never persisted.
 */

const { generateId, nowISO } = require('../utils');

const CUE_STATUSES = ['open', 'recorded', 'approved', 'omit'];

/**
 * Create a new cue.
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.characterId
 * @param {string} opts.cueNumber
 * @param {string} [opts.scene]
 * @param {string} [opts.dialogue]
 * @param {number} opts.inFrames
 * @param {number} opts.outFrames
 * @param {number|null} [opts.streamerStartFrames]
 * @param {number[]|null} [opts.streamerTargetFrames]
 * @param {string} [opts.notes]
 * @param {string|null} [opts.actorId]
 * @returns {object}
 */
function createCue({
  projectId,
  characterId,
  cueNumber,
  scene = '',
  dialogue = '',
  inFrames,
  outFrames,
  streamerStartFrames = null,
  streamerTargetFrames = null,
  notes = '',
  actorId = null,
}) {
  const now = nowISO();
  const normalizedStreamerTargets = Array.isArray(streamerTargetFrames)
    ? [...new Set(
        streamerTargetFrames
          .filter(frame => typeof frame === 'number' && Number.isFinite(frame))
          .map(frame => Math.max(0, Math.round(frame)))
      )].sort((a, b) => a - b)
    : (typeof streamerStartFrames === 'number' ? [Math.max(0, Math.round(streamerStartFrames))] : []);

  return {
    cueId: generateId(),
    projectId,
    characterId,
    cueNumber: (cueNumber || '').trim(),

    scene: (scene || '').trim(),
    dialogue: (dialogue || '').trim(),

    inFrames: Math.max(0, Math.round(inFrames ?? 0)),
    outFrames: Math.max(0, Math.round(outFrames ?? 0)),
    streamerStartFrames: normalizedStreamerTargets.length ? normalizedStreamerTargets[0] : null,
    streamerTargetFrames: normalizedStreamerTargets,

    status: 'open',
    notes: (notes || '').trim(),

    actorId: actorId || null,

    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Validate a cue object shape.
 * @param {any} obj
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateCueShape(obj) {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, reason: 'Cue is not an object.' };
  }
  if (!obj.cueId) return { valid: false, reason: 'Cue missing cueId.' };
  if (!obj.projectId) return { valid: false, reason: 'Cue missing projectId.' };
  if (!obj.characterId) return { valid: false, reason: 'Cue missing characterId.' };
  if (typeof obj.inFrames !== 'number') return { valid: false, reason: 'Cue missing inFrames.' };
  if (typeof obj.outFrames !== 'number') return { valid: false, reason: 'Cue missing outFrames.' };
  if (obj.streamerStartFrames !== undefined && obj.streamerStartFrames !== null && typeof obj.streamerStartFrames !== 'number') {
    return { valid: false, reason: 'Cue streamerStartFrames must be null or a number.' };
  }
  if (obj.streamerTargetFrames !== undefined && obj.streamerTargetFrames !== null) {
    if (!Array.isArray(obj.streamerTargetFrames)) {
      return { valid: false, reason: 'Cue streamerTargetFrames must be null or an array.' };
    }
    if (!obj.streamerTargetFrames.every(frame => typeof frame === 'number')) {
      return { valid: false, reason: 'Cue streamerTargetFrames entries must all be numbers.' };
    }
  }
  if (!CUE_STATUSES.includes(obj.status)) {
    return { valid: false, reason: `Cue has invalid status: ${obj.status}` };
  }
  if (obj.actorId !== undefined && obj.actorId !== null && typeof obj.actorId !== 'string') {
    return { valid: false, reason: 'Cue actorId must be null or a string.' };
  }
  return { valid: true };
}

module.exports = {
  createCue,
  validateCueShape,
  CUE_STATUSES,
};
