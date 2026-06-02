'use strict';

/**
 * ipc/mediaHandlers.js
 *
 * Registers IPC handlers for video file selection and metadata probing.
 *
 * Architectural rule enforced here:
 * HTML video is for DISPLAY ONLY. ffprobe is the sole source of
 * metadata truth. The renderer never calls ffprobe directly.
 * Video src is supplied as a file:// URL for the <video> element.
 */

const { dialog } = require('electron');
const path = require('path');
const url = require('url');
const { probeVideo, checkFfprobeAvailability } = require('../services/media/ffprobe');
const { normalizeFrameRateDisplay } = require('../core/timecode');

const VIDEO_EXTENSIONS = ['mov', 'mp4', 'mxf', 'mkv', 'm4v', 'avi', 'mts', 'm2ts'];

function register(ipcMain, getWindow) {

  // ── Check ffprobe availability ──────────────────────────────────────────────
  ipcMain.handle('media:checkFfprobe', async () => {
    return checkFfprobeAvailability();
  });

  // ── Load Video ──────────────────────────────────────────────────────────────
  ipcMain.handle('media:loadVideo', async (_event) => {
    const win = getWindow();

    const result = await dialog.showOpenDialog(win, {
      title: 'Load Video',
      filters: [
        {
          name: 'Video Files',
          extensions: VIDEO_EXTENSIONS,
        },
      ],
      properties: ['openFile'],
    });

    if (result.canceled || !result.filePaths.length) {
      return { success: false, error: 'No file selected.' };
    }

    const filePath = result.filePaths[0];
    const fileName = path.basename(filePath);

    // Run ffprobe on the selected file
    const probeResult = await probeVideo(filePath);

    if (!probeResult.success) {
      return {
        success: false,
        error: probeResult.error,
        // Still return the file path so the caller can display it
        filePath,
        fileName,
      };
    }

    const meta = probeResult.meta;

    // Populate path fields (ffprobe.js leaves these blank intentionally)
    meta.localPath = filePath;
    meta.fileName = fileName;

    // Normalize frame rate for display / storage
    // The raw fractional string (e.g. "24000/1001") is kept in meta.frameRate
    // for arithmetic use; displayFrameRate is the human-readable version.
    meta.displayFrameRate = normalizeFrameRateDisplay(meta.frameRate);

    // Build a file:// URL for the renderer's <video> element.
    // The renderer MUST use this URL — it must not construct its own from localPath.
    const videoSrc = url.pathToFileURL(filePath).href;

    return {
      success: true,
      meta,
      videoSrc, // file:// URL for display — NOT a timing source
    };
  });

  // ── Reload Video from Stored Path ───────────────────────────────────────────
  // Called when opening a project that already has a video path
  ipcMain.handle('media:resolveVideo', async (_event, localPath) => {
    if (!localPath) {
      return { success: false, error: 'No video path provided.' };
    }

    const fs = require('fs');
    if (!fs.existsSync(localPath)) {
      return {
        success: false,
        error: `Video file not found at: ${localPath}`,
      };
    }

    const videoSrc = url.pathToFileURL(localPath).href;
    return { success: true, videoSrc };
  });

  ipcMain.handle('media:resolveFileUrl', async (_event, localPath) => {
    if (!localPath) {
      return { success: false, error: 'No file path provided.' };
    }

    const fs = require('fs');
    if (!fs.existsSync(localPath)) {
      return { success: false, error: `File not found at: ${localPath}` };
    }

    return { success: true, fileUrl: url.pathToFileURL(localPath).href };
  });
}

module.exports = { register };
