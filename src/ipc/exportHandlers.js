'use strict';

/**
 * src/ipc/exportHandlers.js
 *
 * IPC handlers for document export operations.
 * Thin wiring layer: handles file dialogs, path construction, and
 * delegates generation to service modules.
 *
 * Channels registered:
 *   export:adrListPdf   — export the ADR cue sheet as a PDF
 *   export:adrListCsv   — export the ADR cue sheet as a CSV
 */

const { dialog } = require('electron');
const path        = require('path');
const fs          = require('fs');

const { generateCueSheetPdf } = require('../services/export/cueSheetPdf');
const { generateCueSheetCsv } = require('../services/export/cueSheetCsv');
const {
  generateAdrSessionReportCsv,
  generateAdrSessionReportJson,
} = require('../services/export/adrSessionReport');
const {
  generateRemoteCueManifestCsv,
  generateRemoteCueManifestJson,
} = require('../services/export/remoteCueManifest');
const {
  exportGoodTakesPackage,
  exportTimelineTakesPackage,
} = require('../services/export/goodTakesPackage');
const { getProject }          = require('./projectHandlers');

function safeName(value, fallback) {
  return (value || fallback).replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || fallback;
}

function getExportsPath(project) {
  return project?.settings?.projectFolders?.exportsPath || null;
}

function register(ipcMain, getWindow) {

  // ── PDF export ────────────────────────────────────────────────────────────────

  ipcMain.handle('export:adrListPdf', async (_event, { preparedBy }) => {
    const project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };

    const safeName    = (project.projectName || 'ADR_List').replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim();
    const defaultName = `${safeName}_ADR_List.pdf`;

    const win        = getWindow();
    const saveResult = await dialog.showSaveDialog(win, {
      title:       'Export ADR List PDF',
      defaultPath: getExportsPath(project) ? path.join(getExportsPath(project), defaultName) : defaultName,
      filters:     [{ name: 'PDF Document', extensions: ['pdf'] }],
    });
    if (saveResult.canceled || !saveResult.filePath) return { success: false, error: 'Export cancelled.' };

    const destPath = saveResult.filePath.endsWith('.pdf') ? saveResult.filePath : saveResult.filePath + '.pdf';

    let pdfBuffer;
    try {
      pdfBuffer = await generateCueSheetPdf({ project, preparedBy: preparedBy || '' });
    } catch (err) {
      console.error('[exportHandlers] PDF generation failed:', err);
      return { success: false, error: `PDF generation failed: ${err.message}` };
    }

    try {
      fs.writeFileSync(destPath, pdfBuffer);
    } catch (err) {
      console.error('[exportHandlers] Failed to write PDF:', err);
      return { success: false, error: `Could not write PDF: ${err.message}` };
    }

    return { success: true, filePath: destPath };
  });

  // ── CSV export ────────────────────────────────────────────────────────────────

  ipcMain.handle('export:adrListCsv', async (_event) => {
    const project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };

    const safeName    = (project.projectName || 'ADR_List').replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim();
    const defaultName = `${safeName}_ADR_List.csv`;

    const win        = getWindow();
    const saveResult = await dialog.showSaveDialog(win, {
      title:       'Export ADR List CSV',
      defaultPath: getExportsPath(project) ? path.join(getExportsPath(project), defaultName) : defaultName,
      filters:     [{ name: 'CSV File', extensions: ['csv'] }],
    });
    if (saveResult.canceled || !saveResult.filePath) return { success: false, error: 'Export cancelled.' };

    const destPath = saveResult.filePath.endsWith('.csv') ? saveResult.filePath : saveResult.filePath + '.csv';

    let csvBuffer;
    try {
      csvBuffer = generateCueSheetCsv({ project });
    } catch (err) {
      console.error('[exportHandlers] CSV generation failed:', err);
      return { success: false, error: `CSV generation failed: ${err.message}` };
    }

    try {
      fs.writeFileSync(destPath, csvBuffer);
    } catch (err) {
      console.error('[exportHandlers] Failed to write CSV:', err);
      return { success: false, error: `Could not write CSV: ${err.message}` };
    }

    return { success: true, filePath: destPath };
  });

  ipcMain.handle('export:adrSessionReport', async (_event) => {
    const project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };

    const projectName = safeName(project.projectName, 'ADR_Project');
    const win = getWindow();
    const saveResult = await dialog.showOpenDialog(win, {
      title: 'Export ADR Session Report Folder',
      defaultPath: getExportsPath(project) || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (saveResult.canceled || !saveResult.filePaths?.[0]) {
      return { success: false, error: 'Export cancelled.' };
    }

    const reportDir = path.join(saveResult.filePaths[0], `${projectName}_ADR_Report`);
    fs.mkdirSync(reportDir, { recursive: true });

    const csvPath = path.join(reportDir, `${projectName}_ADR_Report.csv`);
    const jsonPath = path.join(reportDir, `${projectName}_ADR_Report.json`);

    try {
      fs.writeFileSync(csvPath, generateAdrSessionReportCsv({ project }));
      fs.writeFileSync(jsonPath, generateAdrSessionReportJson({ project }));
    } catch (err) {
      console.error('[exportHandlers] ADR session report failed:', err);
      return { success: false, error: `ADR session report failed: ${err.message}` };
    }

    return { success: true, folderPath: reportDir, csvPath, jsonPath };
  });

  ipcMain.handle('export:remoteCueManifest', async (_event) => {
    const project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };

    const projectName = safeName(project.projectName, 'ADR_Project');
    const win = getWindow();
    const saveResult = await dialog.showOpenDialog(win, {
      title: 'Export Remote Cue Manifest Folder',
      defaultPath: getExportsPath(project) || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (saveResult.canceled || !saveResult.filePaths?.[0]) {
      return { success: false, error: 'Export cancelled.' };
    }

    const manifestDir = path.join(saveResult.filePaths[0], `${projectName}_Remote_Cue_Manifest`);
    fs.mkdirSync(manifestDir, { recursive: true });

    const csvPath = path.join(manifestDir, `${projectName}_Remote_Cue_Manifest.csv`);
    const jsonPath = path.join(manifestDir, `${projectName}_Remote_Cue_Manifest.json`);

    try {
      fs.writeFileSync(csvPath, generateRemoteCueManifestCsv({ project }));
      fs.writeFileSync(jsonPath, generateRemoteCueManifestJson({ project }));
    } catch (err) {
      console.error('[exportHandlers] Remote cue manifest failed:', err);
      return { success: false, error: `Remote cue manifest failed: ${err.message}` };
    }

    const assignedCueCount = (project.cues || []).filter(cue => {
      const actor = (project.actors || []).find(item => item.actorId === cue.actorId);
      return !!actor?.email;
    }).length;

    return {
      success: true,
      folderPath: manifestDir,
      csvPath,
      jsonPath,
      cueCount: (project.cues || []).length,
      assignedCueCount,
    };
  });

  ipcMain.handle('export:goodTakesPackage', async (_event, opts = {}) => {
    const project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };
    const exportRecordingOffsetMs = Number(opts.recordingOffsetMs);
    const characterId = typeof opts.characterId === 'string' && opts.characterId.trim()
      ? opts.characterId.trim()
      : null;
    const projectForExport = Number.isFinite(exportRecordingOffsetMs)
      ? {
          ...project,
          settings: {
            ...(project.settings || {}),
            workspace: {
              ...(project.settings?.workspace || {}),
              recordingOffsetMs: exportRecordingOffsetMs,
            },
          },
        }
      : project;

    const cueById = new Map((projectForExport.cues || []).map(cue => [cue.cueId, cue]));
    const selectedCount = (projectForExport.takes || []).filter(take => {
      if (!take.isSelected) return false;
      if (!characterId) return true;
      return cueById.get(take.cueId)?.characterId === characterId;
    }).length;
    if (!selectedCount) {
      return { success: false, error: characterId ? 'No good takes are selected for that character.' : 'No good takes are selected.' };
    }

    const win = getWindow();
    const saveResult = await dialog.showOpenDialog(win, {
      title: 'Export Full-Length Good Takes Folder',
      defaultPath: getExportsPath(project) || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (saveResult.canceled || !saveResult.filePaths?.[0]) {
      return { success: false, error: 'Export cancelled.' };
    }

    try {
      const result = exportGoodTakesPackage({
        project: projectForExport,
        destinationRoot: saveResult.filePaths[0],
        characterId,
      });
      return { success: true, ...result };
    } catch (err) {
      console.error('[exportHandlers] Good takes package failed:', err);
      return { success: false, error: `Good takes package failed: ${err.message}` };
    }
  });

  ipcMain.handle('export:timelineTakesPackage', async (_event, opts = {}) => {
    const project = getProject();
    if (!project) return { success: false, error: 'No project is open.' };
    const exportRecordingOffsetMs = Number(opts.recordingOffsetMs);
    const characterId = typeof opts.characterId === 'string' && opts.characterId.trim()
      ? opts.characterId.trim()
      : null;
    const projectForExport = Number.isFinite(exportRecordingOffsetMs)
      ? {
          ...project,
          settings: {
            ...(project.settings || {}),
            workspace: {
              ...(project.settings?.workspace || {}),
              recordingOffsetMs: exportRecordingOffsetMs,
            },
          },
        }
      : project;

    const cueById = new Map((projectForExport.cues || []).map(cue => [cue.cueId, cue]));
    const takeCount = (projectForExport.takes || []).filter(take => {
      if (!characterId) return true;
      return cueById.get(take.cueId)?.characterId === characterId;
    }).length;
    if (!takeCount) {
      return { success: false, error: characterId ? 'No takes are available for that character.' : 'No takes are available.' };
    }

    const win = getWindow();
    const saveResult = await dialog.showOpenDialog(win, {
      title: 'Export Timeline Takes Folder',
      defaultPath: getExportsPath(project) || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (saveResult.canceled || !saveResult.filePaths?.[0]) {
      return { success: false, error: 'Export cancelled.' };
    }

    try {
      const result = exportTimelineTakesPackage({
        project: projectForExport,
        destinationRoot: saveResult.filePaths[0],
        characterId,
      });
      return { success: true, ...result };
    } catch (err) {
      console.error('[exportHandlers] Timeline takes package failed:', err);
      return { success: false, error: `Timeline takes package failed: ${err.message}` };
    }
  });
}

module.exports = { register };
