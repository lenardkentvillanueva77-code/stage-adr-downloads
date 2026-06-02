'use strict';

/**
 * core/models/Character.js
 *
 * Character factory. Pure functions. No I/O. No Electron deps.
 */

const { generateId, nowISO } = require('../utils');

/**
 * Create a new character.
 *
 * @param {object} opts
 * @param {string} opts.name         — character name, e.g. "ELENA"
 * @param {string} [opts.description]
 * @returns {object}
 */
function createCharacter({ name, description = '' }) {
  return {
    characterId: generateId(),
    name: (name || '').trim().toUpperCase(),
    description: (description || '').trim(),

    // Future actor identity — null in MVP, populated in Phase 3
    actorName: null,
    actorEmail: null,
    actorUserId: null,

    createdAt: nowISO(),
  };
}

/**
 * Validate a character object shape.
 * @param {any} obj
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateCharacterShape(obj) {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, reason: 'Character is not an object.' };
  }
  if (!obj.characterId) {
    return { valid: false, reason: 'Character is missing characterId.' };
  }
  if (!obj.name || typeof obj.name !== 'string') {
    return { valid: false, reason: 'Character is missing name.' };
  }
  return { valid: true };
}

module.exports = {
  createCharacter,
  validateCharacterShape,
};
