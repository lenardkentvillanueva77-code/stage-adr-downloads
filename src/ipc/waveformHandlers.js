'use strict';

/**
 * ipc/waveformHandlers.js
 *
 * IPC handlers for guide audio extraction and waveform peak generation.
 * All heavy work (ffmpeg processes, file I/O) stays in the main process.
 * Renderer receives only progress events and the final compact peaks JSON.
 *
 * IPC channels registered:
 *   waveform:extract    — extract guide audio + generate peaks for current project
 *   waveform:load       — load existing peaks from cache (project reopen)
 *   waveform:status     — check if cached files exist for current project
 *
 * Push events sent to renderer:
 *   waveform:progress   — { stage: string, percent: number }
 */

const path = require('path');
const fs = require('fs');
const {
  getMediaFolder,
  ensureMediaFolder,
  extractGuideAudio,
  generateWaveformPeaks,
  writePeaksFile,
  readPeaksFile,
  checkFfmpegAvailability,
} = require('../services/media/ffmpeg');
const { getProject, getProjectFilePath } = require('./projectHandlers');

const GUIDE_AUDIO_FILENAME = 'guide_audio.wav';
const PEAKS_FILENAME = 'waveform_peaks.json';

/**
 * Derive media folder and file paths from the current project state.
 * Returns null if no project file path is set (unsaved project).
 *
 * @returns {{ mediaFolder, guideAudioPath, peaksPath } | null}
 */
function resolveMediaPaths() {
  const projectFilePath = getProjectFilePath();
  if (!projectFilePath) return null;

  const mediaFolder = getMediaFolder(projectFilePath);
  return {
    mediaFolder,
    guideAudioPath: path.join(mediaFolder, GUIDE_AUDIO_FILENAME),
    peaksPath: path.join(mediaFolder, PEAKS_FILENAME),
  };
}

function register(ipcMain, getWindow) {

  // ── Check ffmpeg availability ───────────────────────────────────────────────
  ipcMain.handle('waveform:checkFfmpeg', async () => {
    return checkFfmpegAvailability();
  });

  // ── Check cache status ──────────────────────────────────────────────────────
  // Returns whether guide audio and peaks files already exist for this project.
  ipcMain.handle('waveform:status', async () => {
    const paths = resolveMediaPaths();
    if (!paths) {
      return {
        ready: false,
        reason: 'Project must be saved before waveform can be generated.',
      };
    }

    const guideExists = fs.existsSync(paths.guideAudioPath);
    const peaksExist = fs.existsSync(paths.peaksPath);

    return {
      ready: guideExists && peaksExist,
      guideAudioPath: paths.guideAudioPath,
      peaksPath: paths.peaksPath,
      guideExists,
      peaksExist,
    };
  });

  // ── Extract guide audio and generate waveform peaks ─────────────────────────
  // Long-running. Sends waveform:progress events to renderer during processing.
  // Returns the final peaks data on completion.
  ipcMain.handle('waveform:extract', async (_event) => {
    const win = getWindow();
    const project = getProject();
    const paths = resolveMediaPaths();

    if (!project) {
      return { success: false, error: 'No project open.' };
    }

    if (!paths) {
      return {
        success: false,
        error: 'Project must be saved to disk before waveform can be generated. Save the project first.',
      };
    }

    const videoPath = project.video?.localPath;
    if (!videoPath || !fs.existsSync(videoPath)) {
      return { success: false, error: 'Video file not found. Load the video before generating waveform.' };
    }

    // Check ffmpeg
    const ffmpegStatus = checkFfmpegAvailability();
    if (!ffmpegStatus.available) {
      return { success: false, error: 'ffmpeg binary not found. Cannot extract guide audio.' };
    }

    ensureMediaFolder(paths.mediaFolder);

    const sendProgress = (stage, percent) => {
      win?.webContents.send('waveform:progress', { stage, percent });
    };

    // ── Stage 1: Extract guide audio ─────────────────────────────────────────
    sendProgress('extracting', 0);

    const extractResult = await extractGuideAudio({
      videoPath,
      outputPath: paths.guideAudioPath,
      onProgress: (pct) => sendProgress('extracting', pct),
    });

    if (!extractResult.success) {
      return { success: false, error: `Guide audio extraction failed: ${extractResult.error}` };
    }

    sendProgress('extracting', 100);

    // ── Stage 2: Generate waveform peaks ─────────────────────────────────────
    sendProgress('generating', 0);

    const peakResult = await generateWaveformPeaks({
      wavPath: paths.guideAudioPath,
      onProgress: (pct) => sendProgress('generating', pct),
    });

    if (!peakResult.success) {
      return { success: false, error: `Waveform generation failed: ${peakResult.error}` };
    }

    // ── Stage 3: Write peaks to cache ─────────────────────────────────────────
    const writeResult = writePeaksFile(peakResult.peaks, paths.peaksPath);
    if (!writeResult.success) {
      return { success: false, error: writeResult.error };
    }

    // ── Stage 4: Delete guide audio — no longer needed ────────────────────────
    // The guide WAV is only used as input to generateWaveformPeaks().
    // All runtime functionality (playback, waveform display) uses the original
    // video file and the peaks JSON respectively.
    // Deleting it immediately saves ~500MB–2GB per project.
    try {
      if (false && fs.existsSync(paths.guideAudioPath)) {
        fs.unlinkSync(paths.guideAudioPath);
        console.log('[waveform] Guide audio deleted after peak generation.');
      }
    } catch (err) {
      // Non-fatal — peaks are already written; log and continue.
      console.warn('[waveform] Could not delete guide audio:', err.message);
    }

    sendProgress('done', 100);

    return {
      success: true,
      peaks: peakResult.peaks,
      peaksPath: paths.peaksPath,
      guideAudioPath: paths.guideAudioPath,
    };
  });

  // ── Load existing peaks from cache ─────────────────────────────────────────
  // Called when opening a project that already has waveform cache files.
  ipcMain.handle('waveform:load', async () => {
    const paths = resolveMediaPaths();

    if (!paths) {
      return { success: false, error: 'No project file path — cannot locate media cache.' };
    }

    if (!fs.existsSync(paths.peaksPath)) {
      return { success: false, error: 'Waveform peaks file not found in project media folder.' };
    }

    const readResult = readPeaksFile(paths.peaksPath);
    if (!readResult.success) {
      return readResult;
    }

    return {
      success:   true,
      peaks:     readResult.peaks,
      peaksPath: paths.peaksPath,
      guideAudioPath: fs.existsSync(paths.guideAudioPath) ? paths.guideAudioPath : null,
    };
  });

  // ── Migrate waveform peaks after Save As ─────────────────────────────────
  // Called from the renderer after a successful Save As.
  // Copies waveform_peaks.json from the old media folder to the new one.
  // Guide audio is not copied (it is deleted after generation).
  // Failure is non-fatal — the operator can regenerate the waveform.
  ipcMain.handle('waveform:migrateOnSaveAs', async (_event, { oldFilePath }) => {
    if (!oldFilePath) return { success: false, error: 'oldFilePath required.' };

    const newPaths = resolveMediaPaths();
    if (!newPaths) return { success: false, error: 'No current project path.' };

    const oldMediaFolder = getMediaFolder(oldFilePath);
    const oldPeaksPath   = path.join(oldMediaFolder, PEAKS_FILENAME);

    if (!fs.existsSync(oldPeaksPath)) {
      // Nothing to migrate — not an error, just no waveform was generated yet
      return { success: true, migrated: false, reason: 'No peaks file at old path.' };
    }

    try {
      ensureMediaFolder(newPaths.mediaFolder);
      fs.copyFileSync(oldPeaksPath, newPaths.peaksPath);
      console.log('[waveform] Peaks copied to new media folder:', newPaths.peaksPath);
      return { success: true, migrated: true, peaksPath: newPaths.peaksPath };
    } catch (err) {
      console.warn('[waveform] Could not copy peaks on Save As:', err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { register };
