'use strict';

/**
 * renderer/booth-preload.js
 *
 * Minimal preload for the Actor Booth Display window.
 * Display-only: receives state pushes, cannot invoke anything.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('booth', {
  onUpdate: (cb) => {
    ipcRenderer.on('booth:update', (_event, payload) => cb(payload));
  },
  sendTransportCommand: (command) => {
    ipcRenderer.send('booth:transport-command', command);
  },
  sendStatus: (status) => {
    ipcRenderer.send('booth:transport-command', status);
  },
});
