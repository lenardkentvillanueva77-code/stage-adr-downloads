'use strict';

/**
 * core/models/Take.js
 *
 * Take factory. Pure functions. No I/O. No Electron deps.
 *
 * A Take represents one recording event for a Cue.
 * MVP: one WAV file per take (mono, 48kHz, 24-bit).
 * The `tracks` array is reserved for future multi-mic support.
 *
 * Selection state (isSelected) is deterministic and enforced by
 * projectState.js — not here.
 */

const { generateId, nowISO } = require('../utils');

const TAKE_RATINGS   = ['none', 'circle', 'reject'];
const SYNC_STATUSES  = ['local', 'pending', 'synced'];
const COMP_TAKE_COUNT = 3;   // hardcoded comp loop take count

/**
 * Create a new take.
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.cueId
 * @param {number} opts.takeNumber        — 1-based; managed by projectState.addTake()
 * @param {string} opts.filePath          — absolute path to .wav
 * @param {number} opts.durationSecs      — actual recorded duration in seconds
 * @param {number} [opts.startOffsetSecs] — seconds from cue In to recording start.
 *                                          0 for comp/direct, >0 for punch (R3b).
 * @param {string|null} [opts.actorId]    — FK → Actor; copied from cue at record time
 * @param {string} [opts.notes]
 * @returns {object}
 */
function createTake({
  projectId,
  cueId,
  takeNumber,
  filePath,
  durationSecs,
  startOffsetSecs = 0,
  actorId         = null,
  notes           = '',
}) {
  const now = nowISO();
  return {
    takeId:          generateId(),
    projectId,
    cueId,
    takeNumber,
    filePath,
    durationSecs,
    startOffsetSecs,
    actorId,
    recordedAt:      now,
    createdAt:       now,
    updatedAt:       now,
    isSelected:      false,   // Good Take — multiple takes may be selected for export
    rating:          'none',  // 'none' | 'circle' | 'reject'
    syncStatus:      'local', // future cloud sync field
    sourceType:      'recorded',
    syncEdit: {
      offsetSecs: 0,
      trimStartSecs: 0,
      trimEndSecs: 0,
      laneOffsets: {},
    },
    notes:           (notes || '').trim(),
    tracks:          [],      // reserved for future multi-mic
  };
}

/**
 * Validate a take object shape.
 * @param {any} obj
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateTakeShape(obj) {
  if (!obj || typeof obj !== 'object') return { valid: false, reason: 'Take is not an object.' };
  if (typeof obj.takeId     !== 'string' || !obj.takeId)     return { valid: false, reason: 'Take missing takeId.' };
  if (typeof obj.projectId  !== 'string' || !obj.projectId)  return { valid: false, reason: 'Take missing projectId.' };
  if (typeof obj.cueId      !== 'string' || !obj.cueId)      return { valid: false, reason: 'Take missing cueId.' };
  if (typeof obj.takeNumber !== 'number')                     return { valid: false, reason: 'Take missing takeNumber.' };
  if (typeof obj.filePath   !== 'string' || !obj.filePath)   return { valid: false, reason: 'Take missing filePath.' };
  if (typeof obj.durationSecs !== 'number')                   return { valid: false, reason: 'Take missing durationSecs.' };
  if (typeof obj.startOffsetSecs !== 'number')                return { valid: false, reason: 'Take missing startOffsetSecs.' };
  if (typeof obj.isSelected !== 'boolean')                    return { valid: false, reason: 'Take missing isSelected boolean.' };
  if (!TAKE_RATINGS.includes(obj.rating))                     return { valid: false, reason: `Take invalid rating: ${obj.rating}` };
  return { valid: true };
}

module.exports = {
  createTake,
  validateTakeShape,
  TAKE_RATINGS,
  SYNC_STATUSES,
  COMP_TAKE_COUNT,
};
