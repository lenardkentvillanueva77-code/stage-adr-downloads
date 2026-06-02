'use strict';

/**
 * core/utils.js
 *
 * Shared pure utilities used across core modules.
 * No I/O. No Electron. No external dependencies.
 */

const { randomUUID } = require('crypto');

/**
 * Generate a UUID v4.
 * @returns {string}
 */
function generateId() {
  return randomUUID();
}

/**
 * Return current time as an ISO-8601 string.
 * @returns {string}
 */
function nowISO() {
  return new Date().toISOString();
}

/**
 * Deep-clone a plain object via JSON round-trip.
 * Only suitable for serialisable project data.
 * @param {object} obj
 * @returns {object}
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Safe JSON parse. Returns null on failure.
 * @param {string} str
 * @returns {any|null}
 */
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

module.exports = {
  generateId,
  nowISO,
  deepClone,
  safeJsonParse,
};
