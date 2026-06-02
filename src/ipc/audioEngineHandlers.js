'use strict';

/**
 * ipc/audioEngineHandlers.js
 *
 * Thin IPC wiring for the native professional audio engine.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { client, resolveEnginePath } = require('../services/audioEngine');

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeSegment(value, fallback) {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || fallback;
}

function resolveNativeRecordingPath(opts = {}) {
  if (opts.filePath && path.isAbsolute(opts.filePath)) {
    fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
    return opts.filePath;
  }

  const baseDir = opts.directory && path.isAbsolute(opts.directory)
    ? opts.directory
    : path.join(app.getPath('documents'), 'Post ADR Pro', 'Native Takes');

  fs.mkdirSync(baseDir, { recursive: true });
  return path.join(baseDir, `native_input1_${timestampForFile()}.wav`);
}

function resolveNativeRecordingLanes(opts = {}) {
  const armed = Array.isArray(opts.lanes) ? opts.lanes.filter((lane) => lane && lane.armed) : [];
  if (!armed.length) return null;

  const baseDir = opts.directory && path.isAbsolute(opts.directory)
    ? opts.directory
    : path.join(app.getPath('documents'), 'Post ADR Pro', 'Native Takes');

  const takeDir = opts.takeDirectory && path.isAbsolute(opts.takeDirectory)
    ? opts.takeDirectory
    : path.join(baseDir, `take_${timestampForFile()}`);
  fs.mkdirSync(takeDir, { recursive: true });

  const usedNames = new Set();
  return armed.map((lane) => {
    const laneId = safeSegment(lane.laneId, 'mic');
    const baseName = safeSegment(lane.label, laneId);
    let fileName = baseName;
    if (usedNames.has(fileName.toLowerCase())) fileName = `${baseName}_${laneId}`;
    usedNames.add(fileName.toLowerCase());
    const physicalInput = Number(lane.physicalInput);
    return {
      laneId,
      label: lane.label || laneId,
      physicalInput,
      filePath: path.join(takeDir, `${fileName}.wav`),
    };
  }).filter((lane) => Number.isInteger(lane.physicalInput) && lane.physicalInput >= 0);
}

function register(ipcMain) {
  ipcMain.handle('audioEngine:status', async () => {
    const enginePath = resolveEnginePath();
    return {
      success: true,
      enginePath,
      engineExists: fs.existsSync(enginePath),
      ready: client.ready,
      engine: client.lastReadyPayload,
    };
  });

  ipcMain.handle('audioEngine:ping', async () => {
    try {
      const response = await client.ping();
      return { success: true, response };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:restart', async () => {
    try {
      client.restart();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:listDevices', async () => {
    try {
      const devices = await client.listDevices();
      return { success: true, devices };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:openDevice', async (_event, opts = {}) => {
    try {
      const result = await client.openDevice(opts);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:openDiagnosticDevice', async (_event, opts = {}) => {
    try {
      const result = await client.openDiagnosticDevice(opts);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:meterSnapshot', async () => {
    try {
      const meters = await client.meterSnapshot();
      return { success: true, meters };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:configureMonitoring', async (_event, opts = {}) => {
    try {
      const result = await client.configureMonitoring(opts);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:configureRouting', async (_event, opts = {}) => {
    try {
      const result = await client.configureRouting(opts);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:configureTalkback', async (_event, opts = {}) => {
    try {
      const result = await client.configureTalkback(opts);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:startPlayback', async (_event, opts = {}) => {
    try {
      const result = await client.startPlayback(opts);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:preparePlayback', async (_event, opts = {}) => {
    try {
      const result = await client.preparePlayback(opts);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:stopPlayback', async (_event, opts = {}) => {
    try {
      const result = await client.stopPlayback(opts);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:scheduleTone', async (_event, opts = {}) => {
    try {
      const result = await client.scheduleTone(opts);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:stopTone', async (_event, opts = {}) => {
    try {
      const result = await client.stopTone(opts);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:startRecording', async (_event, opts = {}) => {
    try {
      const lanes = resolveNativeRecordingLanes(opts);
      const result = lanes
        ? await client.startRecording({ lanes })
        : await client.startRecording({ filePath: resolveNativeRecordingPath(opts) });
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:stopRecording', async () => {
    try {
      const result = await client.stopRecording();
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audioEngine:inspectRouting', async () => {
    try {
      const routing = await client.inspectRouting();
      return { success: true, routing };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { register };
