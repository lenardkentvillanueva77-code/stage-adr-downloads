'use strict';

/**
 * core/models/Actor.js
 *
 * Actor factory and validation. Pure functions. No I/O. No Electron deps.
 *
 * An Actor is a named performer who can be assigned to cues.
 * The email field is required — it is the stable identity key for future
 * authentication, remote workflow, and subscription-tier enforcement.
 *
 * Actor ≠ Character. The same actor may voice multiple characters.
 * The same character may be re-cast to different actors across cues.
 * Assignment lives on Cue.actorId, not on Character.
 */

const { generateId, nowISO } = require('../utils');

// Basic email format — requires local-part, @, domain with at least one dot.
// Intentionally permissive: we validate presence and shape, not deliverability.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate and normalise an email string.
 * @param {string} email
 * @returns {{ valid: boolean, normalised?: string, reason?: string }}
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, reason: 'Actor email is required.' };
  }
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) {
    return { valid: false, reason: 'Actor email cannot be empty.' };
  }
  if (!EMAIL_RE.test(trimmed)) {
    return { valid: false, reason: `"${trimmed}" is not a valid email address.` };
  }
  return { valid: true, normalised: trimmed };
}

/**
 * Check whether an email is already used by another actor in the project.
 * Comparison is case-insensitive.
 *
 * @param {object[]} actors    — existing project.actors array
 * @param {string}   email     — already normalised (lowercase)
 * @param {string}   [excludeActorId]  — skip this actor (for update checks)
 * @returns {boolean}
 */
function isEmailTaken(actors, email, excludeActorId) {
  return actors.some(
    (a) => a.email.toLowerCase() === email &&
           (!excludeActorId || a.actorId !== excludeActorId)
  );
}

/**
 * Create a new Actor object.
 *
 * @param {object} opts
 * @param {string} opts.name   — display name, e.g. "Jane Doe" (required, non-empty)
 * @param {string} opts.email  — required; stored normalised (lowercase, trimmed)
 * @returns {object}
 */
function createActor({ name, email }) {
  return {
    actorId:       generateId(),
    name:          (name  || '').trim(),
    email:         (email || '').trim().toLowerCase(),
    remoteEnabled: false,    // placeholder; functional in a future remote phase
    createdAt:     nowISO(),
  };
}

/**
 * Validate an actor object shape.
 * @param {any} obj
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateActorShape(obj) {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, reason: 'Actor is not an object.' };
  }
  if (!obj.actorId) {
    return { valid: false, reason: 'Actor missing actorId.' };
  }
  if (!obj.name || typeof obj.name !== 'string' || !obj.name.trim()) {
    return { valid: false, reason: 'Actor missing name.' };
  }
  const emailCheck = validateEmail(obj.email);
  if (!emailCheck.valid) return emailCheck;
  return { valid: true };
}

module.exports = {
  createActor,
  validateActorShape,
  validateEmail,
  isEmailTaken,
};
