'use strict';

/**
 * core/models/Project.js
 *
 * Project factory. Pure functions. No I/O. No Electron deps.
 */

const { generateId, nowISO } = require('../utils');

const SCHEMA_VERSION = '1.1.0';   // schema version for actor assignment foundation
const APP_VERSION    = '1.2.1';   // stamped into project JSON on creation; diagnostic only

/**
 * Create a new in-memory project.
 *
 * @param {object} opts
 * @param {string} opts.filmTitle
 * @param {string} opts.projectName
 * @returns {object} — project object matching the .stageadr schema
 */
function createProject({ filmTitle, projectName }) {
  const now = nowISO();

  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    projectType: 'stage-post-adr',

    projectId: generateId(),
    filmTitle: (filmTitle || '').trim(),
    projectName: (projectName || '').trim(),
    createdAt: now,
    updatedAt: now,

    settings: {
      frameRate: '',
      sampleRate: '48000',
      bitDepth: '24',
      defaultCountInFrames: 8,
      micLabels: ['Boom', 'Lav'],
    },

    video: null,

    actors:     [],   // Actor[] — new in schema 1.1.0
    characters: [],
    cues:       [],
    takes:      [],
  };
}

/**
 * Return a copy of the project with updatedAt refreshed.
 *
 * @param {object} project
 * @returns {object}
 */
function touchProject(project) {
  return { ...project, updatedAt: nowISO() };
}

/**
 * Validate that a parsed object looks like a stage-post-adr project.
 * Returns { valid: true } or { valid: false, reason: string }.
 *
 * @param {any} obj
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateProjectShape(obj) {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, reason: 'File is not a valid JSON object.' };
  }
  if (obj.projectType !== 'stage-post-adr') {
    return { valid: false, reason: 'Not a Stage Post ADR project file.' };
  }
  if (!obj.projectId) {
    return { valid: false, reason: 'Project file is missing projectId.' };
  }
  if (!obj.schemaVersion) {
    return { valid: false, reason: 'Project file is missing schemaVersion.' };
  }
  return { valid: true };
}

/**
 * Returns true if the project has at least one cue, meaning frame rate
 * is now immutable.
 *
 * @param {object} project
 * @returns {boolean}
 */
function isFrameRateLocked(project) {
  return Array.isArray(project.cues) && project.cues.length > 0;
}

module.exports = {
  createProject,
  touchProject,
  validateProjectShape,
  isFrameRateLocked,
  SCHEMA_VERSION,
  APP_VERSION,
};
