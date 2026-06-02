'use strict';

/**
 * services/persistence/localStore.js
 *
 * Reads and writes .stageadr project files to disk.
 * Implements the implicit store interface (store.interface.js).
 *
 * This is the Phase 1 & 2 persistence implementation.
 * In Phase 3, a cloudStore.js will be added alongside this module —
 * not replacing it — so offline work continues to function.
 *
 * All functions are async for interface compatibility with the future
 * cloud store, even where the current implementation is synchronous.
 */

const fs = require('fs');
const path = require('path');
const { safeJsonParse, nowISO } = require('../../core/utils');
const { validateProjectShape } = require('../../core/models/Project');
const { migrateProject, needsMigration } = require('../../core/schemaVersion');

const PROJECT_EXTENSION = '.stageadr';

/**
 * Write a project object to disk as a .stageadr file.
 *
 * @param {object} project — current in-memory project
 * @param {string} filePath — absolute path including filename and extension
 * @returns {Promise<{ success: true } | { success: false, error: string }>}
 */
async function writeProject(project, filePath) {
  try {
    // Ensure correct extension
    if (!filePath.endsWith(PROJECT_EXTENSION)) {
      filePath = filePath + PROJECT_EXTENSION;
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const updated = { ...project, updatedAt: nowISO() };
    const json = JSON.stringify(updated, null, 2);
    fs.writeFileSync(filePath, json, 'utf8');

    return { success: true };
  } catch (err) {
    console.error('[localStore] Write failed:', err.message);
    return { success: false, error: `Could not save project: ${err.message}` };
  }
}

/**
 * Read and parse a .stageadr project file from disk.
 * Applies schema migrations if needed.
 *
 * @param {string} filePath — absolute path to .stageadr file
 * @returns {Promise<{
 *   success: true,
 *   project: object,
 *   migrationsApplied: string[],
 *   warnings: string[]
 * } | {
 *   success: false,
 *   error: string
 * }>}
 */
async function readProject(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `Project file not found: ${filePath}` };
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = safeJsonParse(raw);

    if (!parsed) {
      return { success: false, error: 'Project file is not valid JSON.' };
    }

    // Validate basic shape before migration
    const { valid, reason } = validateProjectShape(parsed);
    if (!valid) {
      return { success: false, error: reason };
    }

    // Apply migrations
    const { project, migrationsApplied } = migrateProject(parsed);
    const warnings = [];

    // Check if video file still exists on disk
    if (project.video && project.video.localPath) {
      if (!fs.existsSync(project.video.localPath)) {
        warnings.push(
          `Video file not found at stored path: "${project.video.localPath}". ` +
          `You can reload the video using Load Video.`
        );
        // Clear the localPath so the video player doesn't try to load a dead path
        project.video = { ...project.video, localPath: '' };
      }
    }

    return {
      success: true,
      project,
      migrationsApplied,
      warnings,
    };
  } catch (err) {
    console.error('[localStore] Read failed:', err.message);
    return { success: false, error: `Could not open project: ${err.message}` };
  }
}

/**
 * Check whether a file path already has the project extension.
 * @param {string} filePath
 * @returns {string} — path with .stageadr extension guaranteed
 */
function ensureExtension(filePath) {
  return filePath.endsWith(PROJECT_EXTENSION)
    ? filePath
    : filePath + PROJECT_EXTENSION;
}

module.exports = {
  writeProject,
  readProject,
  ensureExtension,
  PROJECT_EXTENSION,
};
