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

function normalisePathForCompare(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase();
}

function pathIsInside(childPath, parentPath) {
  const child = normalisePathForCompare(childPath);
  const parent = normalisePathForCompare(parentPath).replace(/\/+$/, '');
  return child === parent || child.startsWith(parent + '/');
}

function rebasePathIfMoved(filePath, oldRoot, newRoot) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  if (!oldRoot || !newRoot || normalisePathForCompare(oldRoot) === normalisePathForCompare(newRoot)) {
    return filePath;
  }
  if (!pathIsInside(filePath, oldRoot)) return filePath;

  const relative = path.relative(oldRoot, filePath);
  return path.join(newRoot, relative);
}

function rebaseProjectForCurrentLocation(project, projectFilePath) {
  const projectRoot = path.dirname(projectFilePath);
  const previousFolders = project.settings?.projectFolders || {};
  const previousRoot = previousFolders.rootPath
    || (previousFolders.mediaPath ? path.dirname(previousFolders.mediaPath) : null);

  const mediaPath = path.join(projectRoot, 'Media');
  const audioPath = path.join(mediaPath, 'audio');
  const exportsPath = path.join(projectRoot, 'Exports');

  const next = {
    ...project,
    settings: {
      ...(project.settings || {}),
      projectFolders: {
        rootPath: projectRoot,
        mediaPath,
        audioPath,
        exportsPath,
      },
    },
  };

  if (previousRoot) {
    if (next.video?.localPath) {
      next.video = {
        ...next.video,
        localPath: rebasePathIfMoved(next.video.localPath, previousRoot, projectRoot),
      };
    }

    next.takes = (next.takes || []).map(take => ({
      ...take,
      filePath: rebasePathIfMoved(take.filePath, previousRoot, projectRoot),
      archiveDirectory: rebasePathIfMoved(take.archiveDirectory, previousRoot, projectRoot),
      tracks: Array.isArray(take.tracks)
        ? take.tracks.map(track => ({
            ...track,
            filePath: rebasePathIfMoved(track.filePath, previousRoot, projectRoot),
          }))
        : take.tracks,
    }));
  }

  return next;
}

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
    const migrated = migrateProject(parsed);
    const project = rebaseProjectForCurrentLocation(migrated.project, filePath);
    const { migrationsApplied } = migrated;
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
