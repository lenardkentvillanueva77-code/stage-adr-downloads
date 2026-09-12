'use strict';

/**
 * ipc/projectHandlers.js
 *
 * Registers IPC handlers for project CRUD operations.
 * Thin wiring layer — calls core and service modules.
 *
 * Autosave redesign:
 *   - Recovery files stored in {userData}/autosaves/, not alongside projects.
 *   - Keyed by SHA-1 of project file path (saved) or projectId (unsaved).
 *   - autosave.init() must be called once with userData path before register().
 *   - restore immediately deletes the recovery file.
 *   - Save As clears old path's recovery before updating path.
 *   - app:confirmClose accepts { hasUnsavedChanges } to gate quit-time cleanup.
 */

const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { createProject, touchProject } = require('../core/models/Project');
const { setVideo, updateSettings }    = require('../core/projectState');
const {
  writeProject,
  readProject,
  ensureExtension,
  PROJECT_EXTENSION,
} = require('../services/persistence/localStore');
const autosave = require('../services/persistence/autosave');
const recentProjects = require('../services/persistence/recentProjects');
const { relinkProjectFiles } = require('../services/media/relinkProjectFiles');
const { isValidTimecode } = require('../core/timecode');

// ── Module init ───────────────────────────────────────────────────────────────

// Initialise autosave with the Electron userData path.
// Must happen before any autosave function is called.
autosave.init(app.getPath('userData'));
recentProjects.init(app.getPath('userData'));

// ── Shared in-memory state ────────────────────────────────────────────────────

let _project         = null;
let _projectFilePath = null;

function getProject()         { return _project; }
function getProjectFilePath() { return _projectFilePath; }
function _setProject(project) { _project = project; }
function _projectId()         { return _project?.projectId || null; }

function safePathSegment(value, fallback) {
  return (value || fallback)
    .replace(/[^a-zA-Z0-9_\-. ]/g, '_')
    .trim() || fallback;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function register(ipcMain, getWindow, onRecentProjectsChanged = () => {}) {
  const updateRecentProjects = (filePath, project) => {
    const recents = recentProjects.addRecentProject(filePath, project);
    onRecentProjectsChanged(recents);
  };

  const openProjectFromPath = async (filePath) => {
    if (!filePath || !path.isAbsolute(filePath)) {
      return { success: false, error: 'Project path is invalid.' };
    }

    const readResult = await readProject(filePath);
    if (!readResult.success) {
      if (!fs.existsSync(filePath)) {
        recentProjects.removeRecentProject(filePath);
        onRecentProjectsChanged(recentProjects.readRecentProjects());
      }
      return readResult;
    }

    _project = readResult.project;
    _projectFilePath = filePath;
    updateRecentProjects(_projectFilePath, _project);

    const recovery = autosave.check(_projectFilePath, _projectId());

    return {
      success: true,
      project: _project,
      filePath: _projectFilePath,
      warnings: readResult.warnings,
      migrationsApplied: readResult.migrationsApplied,
      recovery,
    };
  };

  ipcMain.handle('project:chooseParentFolder', async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose Parent Folder',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || !result.filePaths?.[0]) {
      return { success: false, error: 'Choose cancelled.' };
    }

    return { success: true, folderPath: result.filePaths[0] };
  });

  ipcMain.handle('project:relinkFiles', async () => {
    if (!_project) return { success: false, error: 'No project is open.' };

    const win = getWindow();
    const folders = _project.settings?.projectFolders || {};
    const defaultPath = folders.mediaPath || folders.rootPath || app.getPath('documents');
    const result = await dialog.showOpenDialog(win, {
      title: 'Relink Files',
      defaultPath,
      properties: ['openDirectory'],
    });

    if (result.canceled || !result.filePaths?.[0]) {
      return { success: false, error: 'Relink cancelled.' };
    }

    const relink = relinkProjectFiles(_project, result.filePaths[0]);
    if (relink.error) return { success: false, error: relink.error };

    _project = relink.project;
    return {
      success: true,
      project: _project,
      changed: relink.changed,
      ...relink.summary,
    };
  });

  // ── New Project ─────────────────────────────────────────────────────────────
  ipcMain.handle('project:new', async (_event, { filmTitle, projectName, parentDirectory }) => {
    if (!filmTitle || !projectName) {
      return { success: false, error: 'Film title and project name are required.' };
    }
    if (!parentDirectory || !path.isAbsolute(parentDirectory)) {
      return { success: false, error: 'Choose a parent folder before creating the project.' };
    }

    const sessionName = safePathSegment(projectName, 'ADR_Session');

    // Clear recovery for the outgoing project
    if (_project) autosave.clear(_projectFilePath, _projectId());

    const projectRoot = path.join(parentDirectory, sessionName);
    const projectFilePath = path.join(projectRoot, `${sessionName}${PROJECT_EXTENSION}`);
    const mediaPath = path.join(projectRoot, 'Media');
    const exportsPath = path.join(projectRoot, 'Exports');
    const audioPath = path.join(mediaPath, 'audio');

    if (fs.existsSync(projectRoot)) {
      return { success: false, error: `Project folder already exists: ${projectRoot}` };
    }

    fs.mkdirSync(audioPath, { recursive: true });
    fs.mkdirSync(exportsPath, { recursive: true });

    _project = touchProject(createProject({ filmTitle, projectName }));
    _project.settings = {
      ..._project.settings,
      projectFolders: {
        rootPath: projectRoot,
        mediaPath,
        audioPath,
        exportsPath,
      },
    };
    _projectFilePath = projectFilePath;

    const writeResult = await writeProject(_project, _projectFilePath);
    if (!writeResult.success) return writeResult;

    autosave.clear(_projectFilePath, _projectId());
    updateRecentProjects(_projectFilePath, _project);
    return {
      success: true,
      project: _project,
      filePath: _projectFilePath,
      projectRoot,
      mediaPath,
      exportsPath,
    };
  });

  // ── Save Project ────────────────────────────────────────────────────────────
  ipcMain.handle('project:save', async (_event) => {
    if (!_project) return { success: false, error: 'No project is open.' };

    if (!_projectFilePath) {
      const win    = getWindow();
      const result = await dialog.showSaveDialog(win, {
        title:       'Save Project',
        defaultPath: `${_project.projectName || 'untitled'}${PROJECT_EXTENSION}`,
        filters:     [{ name: 'Post ADR Pro Project', extensions: ['stageadr'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Save cancelled.' };
      }
      _projectFilePath = ensureExtension(result.filePath);
    }

    const writeResult = await writeProject(_project, _projectFilePath);
    if (!writeResult.success) return writeResult;

    _project = touchProject(_project);
    // Explicit save — recovery no longer needed
    autosave.clear(_projectFilePath, _projectId());
    updateRecentProjects(_projectFilePath, _project);

    return { success: true, project: _project, filePath: _projectFilePath };
  });

  // ── Save Project As ─────────────────────────────────────────────────────────
  ipcMain.handle('project:saveAs', async (_event) => {
    if (!_project) return { success: false, error: 'No project is open.' };

    const win    = getWindow();
    const result = await dialog.showSaveDialog(win, {
      title:       'Save Project As',
      defaultPath: `${_project.projectName || 'untitled'}${PROJECT_EXTENSION}`,
      filters:     [{ name: 'Post ADR Pro Project', extensions: ['stageadr'] }],
    });
    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Save cancelled.' };
    }

    // Clear recovery for the OLD path before updating the path reference.
    // Previously this happened after the path was updated, leaving the old
    // recovery file orphaned forever.
    const oldFilePath = _projectFilePath;
    autosave.clear(oldFilePath, _projectId());

    _projectFilePath  = ensureExtension(result.filePath);

    // Copy waveform peaks to new media folder location if they exist.
    // Delegated to waveformHandlers via a helper exported from there.
    // (waveformHandlers handles this on the 'project:saveAs' result in app.js)

    const writeResult = await writeProject(_project, _projectFilePath);
    if (!writeResult.success) return writeResult;

    _project = touchProject(_project);
    // Clear recovery for the new path too (fresh slate)
    autosave.clear(_projectFilePath, _projectId());
    updateRecentProjects(_projectFilePath, _project);

    return {
      success:         true,
      project:         _project,
      filePath:        _projectFilePath,
      oldFilePath,     // returned so renderer can trigger waveform migration
    };
  });

  // ── Open Project ────────────────────────────────────────────────────────────
  ipcMain.handle('project:open', async (_event) => {
    const win    = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title:      'Open Project',
      filters:    [{ name: 'Post ADR Pro Project', extensions: ['stageadr'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { success: false, error: 'Open cancelled.' };
    }

    return openProjectFromPath(result.filePaths[0]);
  });

  ipcMain.handle('project:openPath', async (_event, { filePath } = {}) => {
    return openProjectFromPath(filePath);
  });

  ipcMain.handle('project:recent:list', async () => {
    return { success: true, projects: recentProjects.readRecentProjects() };
  });

  ipcMain.handle('project:recent:clear', async () => {
    const recents = recentProjects.clearRecentProjects();
    onRecentProjectsChanged(recents);
    return { success: true };
  });

  // ── Get Current Project State (startup restore) ─────────────────────────────
  ipcMain.handle('project:getCurrent', async () => {
    const recovery = _project
      ? autosave.check(_projectFilePath, _projectId())
      : { hasRecovery: false };

    return {
      project:  _project,
      filePath: _projectFilePath,
      recovery,
    };
  });

  // ── Set Video ───────────────────────────────────────────────────────────────
  ipcMain.handle('project:setVideo', async (_event, videoMeta) => {
    if (!_project) return { success: false, error: 'No project is open.' };
    _project = setVideo(_project, videoMeta);
    return { success: true, project: _project };
  });

  ipcMain.handle('project:updateSettings', async (_event, settingsPatch = {}) => {
    if (!_project) return { success: false, error: 'No project is open.' };
    if (!settingsPatch || typeof settingsPatch !== 'object') {
      return { success: false, error: 'settingsPatch must be an object.' };
    }
    const allowed = ['startTimecode', 'startFrameOffset'];
    const safePatch = {};
    for (const key of allowed) {
      if (key in settingsPatch) safePatch[key] = settingsPatch[key];
    }
    if ('startTimecode' in safePatch && !isValidTimecode(safePatch.startTimecode)) {
      return { success: false, error: 'startTimecode must use HH:MM:SS:FF.' };
    }
    if ('startFrameOffset' in safePatch) {
      const offset = Number(safePatch.startFrameOffset);
      if (!Number.isFinite(offset) || offset < 0) {
        return { success: false, error: 'startFrameOffset must be a non-negative number.' };
      }
      safePatch.startFrameOffset = Math.round(offset);
    }
    const result = updateSettings(_project, safePatch);
    _project = result.project;
    return { success: true, project: _project, warning: result.warning };
  });

  ipcMain.handle('project:updateWorkspaceSettings', async (_event, payload = {}) => {
    if (!_project) return { success: false, error: 'No project is open.' };
    const workspace = payload.workspace || payload;
    const persist = !!payload.persist;
    _project = {
      ..._project,
      settings: {
        ...(_project.settings || {}),
        workspace: { ...workspace },
      },
    };
    if (persist && _projectFilePath) {
      _project = touchProject(_project);
      const writeResult = await writeProject(_project, _projectFilePath);
      if (!writeResult.success) return writeResult;
      autosave.clear(_projectFilePath, _projectId());
    }
    return { success: true, project: _project };
  });

  // ── Autosave write (renderer timer → main process) ──────────────────────────
  ipcMain.handle('project:autosave', async () => {
    if (!_project) return { success: false, error: 'No project loaded.' };
    const result = autosave.write(_project, _projectFilePath);
    if (result.success) {
      console.log('[autosave] Recovery snapshot written:', result.path);
    }
    return result;
  });

  // ── Restore Autosave ────────────────────────────────────────────────────────
  ipcMain.handle('project:restoreAutosave', async () => {
    if (!_project) return { success: false, error: 'No project loaded.' };

    const recovery = autosave.check(_projectFilePath, _projectId());
    if (!recovery.hasRecovery) return { success: false, error: 'No recovery file found.' };

    const recovered = autosave.read(recovery.recoveryPath);
    if (!recovered) return { success: false, error: 'Recovery file is corrupt or unreadable.' };

    _project = recovered;

    // IMMEDIATELY delete the recovery file — it has served its purpose.
    // _projectFilePath is unchanged; the original .stageadr remains authoritative.
    // markUnsaved() in the renderer will cause a fresh snapshot to be written
    // within 60s if the operator makes changes before saving.
    autosave.clear(_projectFilePath, _projectId());

    return { success: true, project: _project, filePath: _projectFilePath };
  });

  // ── Clear Autosave (explicit dismiss) ───────────────────────────────────────
  ipcMain.handle('project:clearAutosave', async () => {
    if (!_project) return { success: false };
    autosave.clear(_projectFilePath, _projectId());
    return { success: true };
  });

  // ── Confirm close (renderer has resolved the unsaved-changes prompt) ─────────
  // hasUnsavedChanges: if true, keep any existing recovery file (crash safety).
  //                    if false, delete it — clean exit, nothing to recover.
  ipcMain.handle('app:confirmClose', (_event, { hasUnsavedChanges } = {}) => {
    if (_project && !hasUnsavedChanges) {
      // Clean quit — no unsaved state — remove the recovery file
      autosave.clear(_projectFilePath, _projectId());
    }
    // Dirty quit (hasUnsavedChanges: true) — keep recovery file so the
    // operator can recover their work on next launch.
    _allowClose = true;
    const win = getWindow();
    if (win) win.close();
    return { success: true };
  });
}

// _allowClose must be visible to the window close handler in main.js.
// We export a setter so main.js can still own the variable.
let _allowClose = false;
function getAllowClose()    { return _allowClose; }
function setAllowClose(v)  { _allowClose = v; }

module.exports = { register, getProject, getProjectFilePath, _setProject, getAllowClose, setAllowClose };
