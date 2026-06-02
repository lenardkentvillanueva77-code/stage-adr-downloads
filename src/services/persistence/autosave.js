'use strict';

/**
 * src/services/persistence/autosave.js
 *
 * Autosave / crash-recovery service for Post ADR Pro.
 *
 * ── Storage model ─────────────────────────────────────────────────────────────
 *
 * Recovery files live in the Electron userData directory, never alongside
 * project files. This prevents operator confusion and eliminates the
 * recursive-chain bug (where autosave files in the project folder were opened
 * as normal projects, then re-autosaved with compounding extensions).
 *
 *   {userData}/autosaves/{key}.recovery
 *
 * Key derivation:
 *   - Saved project:   SHA-1 of the absolute, normalised project file path.
 *   - Unsaved project: "unsaved_" + project.projectId
 *
 * The .recovery extension is never included in showOpenDialog filters
 * (which require .stageadr), so these files cannot be opened as projects.
 *
 * ── Anti-recursion guarantees ─────────────────────────────────────────────────
 *
 * 1. Storage location is private — operator cannot open .recovery files.
 * 2. Key is a hash of the path, not a filename transformation — cannot chain.
 * 3. write() asserts projectFilePath ends with '.stageadr' if provided.
 *
 * ── Lifecycle ─────────────────────────────────────────────────────────────────
 *
 * Written:   every 60 seconds when _hasUnsavedChanges is true
 * Cleared:   on explicit save, on Save As (old path), on Restore, on Ignore,
 *            on clean quit (no unsaved changes), on new project (clears old)
 * Kept:      on dirty quit (unsaved changes exist at close time)
 *
 * ── Legacy migration ──────────────────────────────────────────────────────────
 *
 * Existing .autosave.stageadr files alongside project files are detected,
 * offered for recovery if newer, then deleted. They are never written again.
 *
 * ── Stale file sweep ──────────────────────────────────────────────────────────
 *
 * On startup, .recovery files older than STALE_DAYS days are deleted.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const RECOVERY_DIR  = 'autosaves';
const RECOVERY_EXT  = '.recovery';
const STALE_DAYS    = 30;

// Legacy suffix — read-only (for migration); never written
const LEGACY_SUFFIX = '.autosave.stageadr';

// ── Initialise the recovery directory ────────────────────────────────────────

let _recoveryDir = null;

/**
 * Must be called once at startup with the Electron userData path.
 * @param {string} userDataPath  — app.getPath('userData')
 */
function init(userDataPath) {
  _recoveryDir = path.join(userDataPath, RECOVERY_DIR);
  if (!fs.existsSync(_recoveryDir)) {
    fs.mkdirSync(_recoveryDir, { recursive: true });
  }
  _sweepStale();
}

function _assertInit() {
  if (!_recoveryDir) throw new Error('[autosave] init() must be called before any other autosave function.');
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Compute the recovery file key for a given project.
 *
 * @param {string|null} projectFilePath  — absolute .stageadr path, or null if unsaved
 * @param {string}      projectId        — from project.projectId (stable UUID)
 * @returns {string}  hex key (no extension)
 */
function _key(projectFilePath, projectId) {
  if (projectFilePath) {
    // Normalise path separators so the key is consistent across platforms
    const normalised = path.resolve(projectFilePath).replace(/\\/g, '/');
    return crypto.createHash('sha1').update(normalised).digest('hex');
  }
  // Unsaved project — use a stable prefix + projectId
  return 'unsaved_' + (projectId || 'unknown');
}

/**
 * Full path to the .recovery file for the given project.
 */
function _recoveryPath(projectFilePath, projectId) {
  _assertInit();
  return path.join(_recoveryDir, _key(projectFilePath, projectId) + RECOVERY_EXT);
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Write a recovery snapshot.
 *
 * @param {object}      project
 * @param {string|null} projectFilePath
 * @returns {{ success: boolean, path?: string, error?: string }}
 */
function write(project, projectFilePath) {
  if (!project) return { success: false, error: 'No project to autosave.' };

  // Anti-recursion guard: projectFilePath must end in exactly .stageadr
  // and must not contain .autosave (which would indicate a legacy autosave file
  // being treated as a project, causing recursive chaining).
  if (projectFilePath) {
    const isValidProject = projectFilePath.endsWith('.stageadr') &&
                           !projectFilePath.includes('.autosave');
    if (!isValidProject) {
      const msg = `[autosave] Refusing to autosave: path is not a valid project file: ${projectFilePath}`;
      console.error(msg);
      return { success: false, error: msg };
    }
  }

  const dest = _recoveryPath(projectFilePath, project.projectId);
  try {
    const snapshot = JSON.stringify(
      Object.assign({}, project, { _recoveryAt: new Date().toISOString() }),
      null, 2
    );
    fs.writeFileSync(dest, snapshot, 'utf8');
    return { success: true, path: dest };
  } catch (err) {
    console.error('[autosave] Write failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Check ─────────────────────────────────────────────────────────────────────

/**
 * Check whether a recovery file exists that is newer than the primary project file.
 *
 * Also checks for legacy .autosave.stageadr files alongside the project file
 * (one-time migration path). If found and newer, returns it as the recovery.
 *
 * @param {string|null} projectFilePath
 * @param {string}      projectId
 * @returns {{
 *   hasRecovery:    boolean,
 *   recoveryPath:   string|null,
 *   recoveryMtime:  Date|null,
 *   projectMtime:   Date|null,
 *   isLegacy:       boolean,
 * }}
 */
function check(projectFilePath, projectId) {
  const none = { hasRecovery: false, recoveryPath: null, recoveryMtime: null, projectMtime: null, isLegacy: false };

  // Get primary file mtime (null if not yet on disk)
  let projectMtime = null;
  if (projectFilePath && fs.existsSync(projectFilePath)) {
    projectMtime = fs.statSync(projectFilePath).mtime;
  }

  // ── 1. Check new-format .recovery file ───────────────────────────────────
  const rPath = _recoveryPath(projectFilePath, projectId);
  if (fs.existsSync(rPath)) {
    const rStat = fs.statSync(rPath);
    const isNewer = !projectMtime || rStat.mtime > projectMtime;
    if (isNewer) {
      return { hasRecovery: true, recoveryPath: rPath, recoveryMtime: rStat.mtime, projectMtime, isLegacy: false };
    }
    // Stale — clean it up
    _deleteFile(rPath);
  }

  // ── 2. Check legacy .autosave.stageadr alongside project file ────────────
  if (projectFilePath) {
    const legacyPath = projectFilePath.replace(/\.stageadr$/, '') + LEGACY_SUFFIX;
    if (fs.existsSync(legacyPath)) {
      const lStat = fs.statSync(legacyPath);
      const isNewer = !projectMtime || lStat.mtime > projectMtime;
      if (isNewer) {
        return { hasRecovery: true, recoveryPath: legacyPath, recoveryMtime: lStat.mtime, projectMtime, isLegacy: true };
      }
      // Legacy file is stale — clean it up
      _deleteFile(legacyPath);
    }
  }

  return none;
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Read and parse a recovery file. Returns null if missing or corrupt.
 * Strips internal metadata keys before returning the project object.
 * @param {string} recoveryPath
 * @returns {object|null}
 */
function read(recoveryPath) {
  try {
    if (!recoveryPath || !fs.existsSync(recoveryPath)) return null;
    const raw = fs.readFileSync(recoveryPath, 'utf8');
    const obj = JSON.parse(raw);
    // Strip internal metadata
    delete obj._recoveryAt;
    delete obj._autosaveAt;   // legacy key
    return obj;
  } catch (err) {
    console.error('[autosave] Read failed:', err.message);
    return null;
  }
}

// ── Clear ─────────────────────────────────────────────────────────────────────

/**
 * Delete the recovery file for the given project.
 * Safe to call even if the file does not exist.
 */
function clear(projectFilePath, projectId) {
  const rPath = _recoveryPath(projectFilePath, projectId);
  _deleteFile(rPath);

  // Also clean up any legacy file that may still exist alongside the project
  if (projectFilePath) {
    const legacyPath = projectFilePath.replace(/\.stageadr$/, '') + LEGACY_SUFFIX;
    _deleteFile(legacyPath);
  }
}

// ── Stale sweep ───────────────────────────────────────────────────────────────

/**
 * Delete .recovery files older than STALE_DAYS. Called once on init.
 */
function _sweepStale() {
  try {
    const cutoff = Date.now() - (STALE_DAYS * 24 * 60 * 60 * 1000);
    const entries = fs.readdirSync(_recoveryDir);
    for (const entry of entries) {
      if (!entry.endsWith(RECOVERY_EXT)) continue;
      const full = path.join(_recoveryDir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.mtime.getTime() < cutoff) {
          fs.unlinkSync(full);
          console.log('[autosave] Swept stale recovery file:', entry);
        }
      } catch (_) { /* individual file errors are non-fatal */ }
    }
  } catch (err) {
    console.warn('[autosave] Stale sweep failed:', err.message);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _deleteFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.warn('[autosave] Could not delete:', filePath, err.message);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { init, write, check, read, clear };
