'use strict';

/**
 * main.js — Post ADR Pro
 *
 * Electron main process entry point.
 * Window creation, menu, IPC handler registration.
 *
 * _allowClose state is now owned by projectHandlers (via getAllowClose /
 * setAllowClose) so the app:confirmClose handler can gate clean-quit cleanup.
 */

const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const projectHandlers  = require('./src/ipc/projectHandlers');
const mediaHandlers    = require('./src/ipc/mediaHandlers');
const dialogHandlers   = require('./src/ipc/dialogHandlers');
const waveformHandlers = require('./src/ipc/waveformHandlers');
const cueHandlers      = require('./src/ipc/cueHandlers');
const exportHandlers   = require('./src/ipc/exportHandlers');
const actorHandlers    = require('./src/ipc/actorHandlers');
const recordingHandlers = require('./src/ipc/recordingHandlers');
const audioEngineHandlers = require('./src/ipc/audioEngineHandlers');
const { client: audioEngineClient } = require('./src/services/audioEngine');
const recentProjects = require('./src/services/persistence/recentProjects');

const { checkFfprobeAvailability } = require('./src/services/media/ffprobe');
const { checkFfmpegAvailability }  = require('./src/services/media/ffmpeg');

function isBrokenPipeError(err) {
  return err && (err.code === 'EPIPE' || /EPIPE|broken pipe/i.test(String(err.message || err)));
}

function installSafeConsole() {
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on?.('error', (err) => {
      if (!isBrokenPipeError(err)) throw err;
    });
  }

  for (const method of ['log', 'warn', 'error', 'info']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      try {
        original(...args);
      } catch (err) {
        if (!isBrokenPipeError(err)) throw err;
      }
    };
  }
}

installSafeConsole();

let mainWindow  = null;
let boothWindow = null;
let splashWindow = null;
let splashOpenedAt = 0;

const SPLASH_MIN_DURATION_MS = 1200;

function getWindow()      { return mainWindow;  }
function getBoothWindow() { return boothWindow; }

function closeSplashWindow() {
  if (!splashWindow || splashWindow.isDestroyed()) {
    splashWindow = null;
    return;
  }

  splashWindow.destroy();
  splashWindow = null;
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

// ── Main window ───────────────────────────────────────────────────────────────

function createSplashWindow() {
  splashOpenedAt = Date.now();
  splashWindow = new BrowserWindow({
    width: 640,
    height: 360,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    show: true,
    backgroundColor: '#0b0b0b',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1400,
    height:          900,
    minWidth:        960,
    minHeight:       680,
    backgroundColor: '#111111',
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title:           'Post ADR Pro',
    show:            false,
    webPreferences:  {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const revealMainWindow = () => {
    const waitMs = Math.max(0, SPLASH_MIN_DURATION_MS - (Date.now() - splashOpenedAt));
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      closeSplashWindow();
      if (mainWindow.isVisible()) return;
      mainWindow.show();
      mainWindow.focus();
    }, waitMs);
  };

  mainWindow.once('ready-to-show', revealMainWindow);
  mainWindow.webContents.once('did-finish-load', revealMainWindow);

  // Intercept close: ask renderer to handle unsaved-changes prompt first.
  // _allowClose is managed by projectHandlers.getAllowClose().
  mainWindow.on('close', (e) => {
    if (!projectHandlers.getAllowClose()) {
      e.preventDefault();
      mainWindow.webContents.send('app:close-requested');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    closeSplashWindow();
    projectHandlers.setAllowClose(false);
    if (boothWindow && !boothWindow.isDestroyed()) {
      boothWindow.destroy();
      boothWindow = null;
    }
  });
}

// ── Booth window ──────────────────────────────────────────────────────────────

function createBoothWindow() {
  if (boothWindow && !boothWindow.isDestroyed()) {
    boothWindow.focus();
    return;
  }

  boothWindow = new BrowserWindow({
    width:           1280,
    height:          720,
    minWidth:        640,
    minHeight:       360,
    backgroundColor: '#000000',
    title:           'Post ADR Pro — Actor Booth',
    autoHideMenuBar: true,
    webPreferences:  {
      preload:          path.join(__dirname, 'renderer', 'booth-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  });

  boothWindow.setMenu(null);
  boothWindow.loadFile(path.join(__dirname, 'renderer', 'booth.html'));

  boothWindow.on('closed', () => {
    boothWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('booth:closed');
    }
  });
}

function toggleBoothFullscreen() {
  if (!boothWindow || boothWindow.isDestroyed()) return;
  boothWindow.setFullScreen(!boothWindow.isFullScreen());
}

ipcMain.handle('app:revealInFolder', async (_event, filePath) => {
  const resolvedPath = String(filePath || '').trim();
  if (!resolvedPath) {
    return { success: false, error: 'No file path provided.' };
  }
  if (!fs.existsSync(resolvedPath)) {
    return { success: false, error: `Recorded file not found: ${resolvedPath}` };
  }
  shell.showItemInFolder(resolvedPath);
  return { success: true };
});

// ── Application menu ──────────────────────────────────────────────────────────

function buildOpenRecentSubmenu() {
  const recentProjectItems = recentProjects.readRecentProjects().map(entry => {
    const labelBase = entry.projectName || path.basename(entry.filePath);
    const label = entry.filmTitle ? `${entry.filmTitle} / ${labelBase}` : labelBase;
    return {
      label,
      sublabel: entry.filePath,
      click: () => mainWindow?.webContents.send('menu:open-recent-project', entry.filePath),
    };
  });

  return [
    ...(recentProjectItems.length
      ? recentProjectItems
      : [{ label: 'No Recent Projects', enabled: false }]),
    { type: 'separator' },
    {
      label: 'Clear Recent Projects',
      enabled: recentProjectItems.length > 0,
      click: () => {
        recentProjects.clearRecentProjects();
        buildMenu();
      },
    },
  ];
}

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' }, { role: 'services' },
        { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' },
        { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project',      accelerator: 'CmdOrCtrl+N',       click: () => mainWindow?.webContents.send('menu:new-project') },
        { label: 'Open Project…',    accelerator: 'CmdOrCtrl+O',       click: () => mainWindow?.webContents.send('menu:open-project') },
        { label: 'Open Recent', submenu: buildOpenRecentSubmenu() },
        { type: 'separator' },
        { label: 'Save Project',     accelerator: 'CmdOrCtrl+S',       click: () => mainWindow?.webContents.send('menu:save-project') },
        { label: 'Save Project As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow?.webContents.send('menu:save-project-as') },
        { type: 'separator' },
        { label: 'Load Video…',      accelerator: 'CmdOrCtrl+L',       click: () => mainWindow?.webContents.send('menu:load-video') },
        { label: 'Manage Actors…',   accelerator: 'CmdOrCtrl+M',       click: () => mainWindow?.webContents.send('menu:manage-actors') },
        { type: 'separator' },
        ...(isMac ? [] : [{ role: 'quit' }]),
      ],
    },
    {
      label: 'Export',
      submenu: [
        { label: 'Full-Length Good Takes...', click: () => mainWindow?.webContents.send('menu:export-good-takes-package') },
        { label: 'Full-Length Good Takes for Character...', click: () => mainWindow?.webContents.send('menu:export-good-takes-character') },
        { type: 'separator' },
        { label: 'Remote Cue Manifest...', click: () => mainWindow?.webContents.send('menu:export-remote-cue-manifest') },
        { type: 'separator' },
        { label: 'ADR Session Report...', click: () => mainWindow?.webContents.send('menu:export-report') },
        { type: 'separator' },
        { label: 'ADR List CSV...', click: () => mainWindow?.webContents.send('menu:export-csv') },
        { label: 'ADR List PDF...', click: () => mainWindow?.webContents.send('menu:export-pdf') },
      ],
    },
    {
      label: 'Options',
      submenu: [
        {
          label: 'Return to Start Position on Stop',
          type: 'checkbox',
          checked: true,
          click: item => mainWindow?.webContents.send('menu:return-to-start-on-stop', item.checked),
        },
        {
          label: 'Recording Mode',
          submenu: [
            { label: 'Normal', type: 'radio', checked: true, click: () => mainWindow?.webContents.send('menu:record-mode', 'normal') },
            { label: 'Punch-in', type: 'radio', click: () => mainWindow?.webContents.send('menu:record-mode', 'punch-in') },
          ],
        },
        { type: 'separator' },
        { label: 'Playback Settings...', click: () => mainWindow?.webContents.send('menu:show-playback-settings') },
        { label: 'Audio I/O...', click: () => mainWindow?.webContents.send('menu:show-audio-io') },
        { label: 'Session...', click: () => mainWindow?.webContents.send('menu:show-session-settings') },
        { type: 'separator' },
        { label: 'Keyboard Shortcuts...', click: () => mainWindow?.webContents.send('menu:show-keyboard-shortcuts') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC registration ──────────────────────────────────────────────────────────

function registerIpcHandlers() {
  // projectHandlers registers app:confirmClose internally (needs _allowClose)
  projectHandlers.register(ipcMain, getWindow, () => buildMenu());
  mediaHandlers.register(ipcMain, getWindow);
  dialogHandlers.register(ipcMain, getWindow);
  waveformHandlers.register(ipcMain, getWindow);
  cueHandlers.register(ipcMain, getWindow, projectHandlers);
  exportHandlers.register(ipcMain, getWindow);
  actorHandlers.register(ipcMain, getWindow, projectHandlers);
  recordingHandlers.register(ipcMain);
  audioEngineHandlers.register(ipcMain);

  // ── Booth window management ───────────────────────────────────────────────

  ipcMain.handle('booth:open', () => {
    createBoothWindow();
    return { success: true };
  });

  ipcMain.handle('booth:toggleFullscreen', () => {
    toggleBoothFullscreen();
    return { success: true };
  });

  ipcMain.handle('booth:isOpen', () => {
    return { isOpen: !!(boothWindow && !boothWindow.isDestroyed()) };
  });

  ipcMain.handle('booth:send', (_event, payload) => {
    if (boothWindow && !boothWindow.isDestroyed()) {
      boothWindow.webContents.send('booth:update', payload);
    }
    return { ok: true };
  });

  ipcMain.on('booth:transport-command', (_event, command) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('booth:transport-command', command || {});
    }
  });

  ipcMain.handle('booth:close', () => {
    if (boothWindow && !boothWindow.isDestroyed()) boothWindow.close();
    return { ok: true };
  });

  ipcMain.handle('app:setTitle', (_event, title) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(title || 'Post ADR Pro');
    }
    return { success: true };
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

// OS-level quit (dock, taskbar) bypasses the renderer close-prompt.
app.on('before-quit', () => {
  projectHandlers.setAllowClose(true);
  audioEngineClient.stop();
});

app.whenReady().then(() => {
  const ffprobeStatus = checkFfprobeAvailability();
  if (!ffprobeStatus.available) console.warn('[main] ffprobe not found.');
  else console.log('[main] ffprobe:', ffprobeStatus.path);

  const ffmpegStatus = checkFfmpegAvailability();
  if (!ffmpegStatus.available) console.warn('[main] ffmpeg not found.');
  else console.log('[main] ffmpeg:', ffmpegStatus.path, `(${ffmpegStatus.source})`);

  registerIpcHandlers();
  buildMenu();
  createSplashWindow();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
