'use strict';

/**
 * ipc/dialogHandlers.js
 *
 * Generic dialog IPC handlers.
 * Keeps dialog logic out of projectHandlers and mediaHandlers
 * for cases where the renderer needs to trigger a dialog independently.
 */

const { dialog } = require('electron');

function register(ipcMain, getWindow) {

  // ── Show error dialog ───────────────────────────────────────────────────────
  ipcMain.handle('dialog:showError', async (_event, { title, message }) => {
    const win = getWindow();
    await dialog.showMessageBox(win, {
      type: 'error',
      title: title || 'Error',
      message,
      buttons: ['OK'],
    });
  });

  // ── Show warning dialog ─────────────────────────────────────────────────────
  ipcMain.handle('dialog:showWarning', async (_event, { title, message }) => {
    const win = getWindow();
    await dialog.showMessageBox(win, {
      type: 'warning',
      title: title || 'Warning',
      message,
      buttons: ['OK'],
    });
  });

  // ── Show info dialog ────────────────────────────────────────────────────────
  ipcMain.handle('dialog:showInfo', async (_event, { title, message }) => {
    const win = getWindow();
    await dialog.showMessageBox(win, {
      type: 'info',
      title: title || 'Information',
      message,
      buttons: ['OK'],
    });
  });

  // ── Show confirm dialog (Yes/No) ────────────────────────────────────────────
  ipcMain.handle('dialog:confirm', async (_event, { title, message }) => {
    const win = getWindow();
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      title: title || 'Confirm',
      message,
      buttons: ['Cancel', 'OK'],
      defaultId: 1,
      cancelId: 0,
    });
    return { confirmed: result.response === 1 };
  });

  // ── Close confirmation — Save / Don't Save / Cancel ──────────────────────────
  // Returns { buttonIndex: 0|1|2 }
  //   0 = Save
  //   1 = Don't Save
  //   2 = Cancel
  ipcMain.handle('dialog:closeConfirm', async (_event, { title, message }) => {
    const win = getWindow();
    const result = await dialog.showMessageBox(win, {
      type:      'warning',
      title:     title || 'Unsaved Changes',
      message:   message || 'Save changes before closing?',
      buttons:   ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId:  2,
    });
    return { buttonIndex: result.response };
  });
}

module.exports = { register };
