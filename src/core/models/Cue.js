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
 * @param {string} opts.cueNumber    — e.g. "ADR-042" — human label, not the PK
 * @param {string} [opts.scene]
 * @param {string} [opts.dialogue]
 * @param {number} opts.inFrames     — canonical timing
 * @param {number} opts.outFrames    — canonical timing
 * @param {string} [opts.notes]
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
  notes = '',
  actorId = null,   // optional — assigned actor; null = unassigned
}) {
  const now = nowISO();

  return {
    cueId: generateId(),
    projectId,
    characterId,
    cueNumber: (cueNumber || '').trim(),

    scene: (scene || '').trim(),
    dialogue: (dialogue || '').trim(),

    inFrames: Math.max(0, Math.round(inFrames ?? 0)),
    outFrames: Math.max(0, Math.round(outFrames ?? 0)),

    status: 'open',
    notes: (notes || '').trim(),

    actorId: actorId || null,   // string | null — explicit field, not a pass-through

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
  if (!obj.cueId)       return { valid: false, reason: 'Cue missing cueId.' };
  if (!obj.projectId)   return { valid: false, reason: 'Cue missing projectId.' };
  if (!obj.characterId) return { valid: false, reason: 'Cue missing characterId.' };
  if (typeof obj.inFrames  !== 'number') return { valid: false, reason: 'Cue missing inFrames.' };
  if (typeof obj.outFrames !== 'number') return { valid: false, reason: 'Cue missing outFrames.' };
  if (!CUE_STATUSES.includes(obj.status)) {
    return { valid: false, reason: `Cue has invalid status: ${obj.status}` };
  }
  // actorId must be null, undefined, or a non-empty string
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
