'use strict';

/**
 * services/audioEngine/engineClient.js
 *
 * Main-process client for the standalone native audio engine.
 * Protocol is JSON-lines over stdin/stdout. Renderer never talks to this
 * process directly.
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 5000;
const DEVICE_LIST_TIMEOUT_MS = 15000;
const PLAYBACK_START_TIMEOUT_MS = 60000;

function resolveEnginePath() {
  const exeName = process.platform === 'win32'
    ? 'PostAdrAudioEngine.exe'
    : 'PostAdrAudioEngine';

  if (process.resourcesPath) {
    const packagedPath = path.join(process.resourcesPath, 'native-audio', exeName);
    try {
      if (require('fs').existsSync(packagedPath)) return packagedPath;
    } catch {}
  }

  return path.join(__dirname, '..', '..', '..', 'native', 'audio-engine', 'bin', exeName);
}

class AudioEngineClient {
  constructor(opts = {}) {
    this.enginePath = opts.enginePath || resolveEnginePath();
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.lastReadyPayload = null;
  }

  start() {
    if (this.child) return;

    this.child = spawn(this.enginePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const child = this.child;

    const stdout = readline.createInterface({ input: child.stdout });

    stdout.on('line', (line) => this.#handleLine(line, child));

    child.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.warn('[audio-engine:stderr]', msg);
    });

    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.ready = false;
      this.child = null;
      const error = new Error(`Audio engine exited (${signal || code}).`);
      this.#rejectPending(error);
    });

    child.on('error', (err) => {
      if (this.child !== child) return;
      this.ready = false;
      this.child = null;
      this.#rejectPending(err);
    });
  }

  async request(type, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS, opts = {}) {
    this.start();

    if (!this.child || !this.child.stdin.writable) {
      throw new Error('Audio engine process is not writable.');
    }

    const id = String(this.nextId++);
    const message = {
      id,
      type,
      protocolVersion: PROTOCOL_VERSION,
      payload,
    };

    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`Audio engine request timed out: ${type}`);
        err.code = 'AUDIO_ENGINE_TIMEOUT';
        if (opts.terminateOnTimeout !== false) this.#terminateChild();
        reject(err);
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });

    this.#writeToEngine(`${JSON.stringify(message)}\n`);
    return responsePromise;
  }

  async listDevices() {
    const response = await this.request('device.list', {}, DEVICE_LIST_TIMEOUT_MS);
    return response.payload?.devices || [];
  }

  async openDevice({ deviceId, sampleRate = 48000, bufferSize = 128 }) {
    const response = await this.request('device.open', { deviceId, sampleRate, bufferSize });
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async openDiagnosticDevice({ deviceId, sampleRate = 48000, bufferSize = 128 }) {
    const response = await this.request('device.openDiagnostic', { deviceId, sampleRate, bufferSize });
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async meterSnapshot() {
    const response = await this.request(
      'meter.snapshot',
      {},
      2000,
      { terminateOnTimeout: false }
    );
    return response.payload || { inputs: [], outputs: [] };
  }

  async configureMonitoring({ lanes } = {}) {
    const response = await this.request('monitor.configure', { lanes: lanes || [] });
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async configureRouting({ outputs } = {}) {
    const response = await this.request('routing.configure', { outputs: outputs || {} });
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async configureTalkback({ enabled = false, physicalInput = -1, gain = 1.0 } = {}) {
    const response = await this.request('talkback.configure', { enabled, physicalInput, gain });
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async startPlayback({ playbackId, filePath, offsetSeconds = 0, gain = 1.0, target = 'auto' } = {}) {
    const response = await this.request(
      'playback.start',
      { playbackId, filePath, offsetSeconds, gain, target },
      PLAYBACK_START_TIMEOUT_MS,
      { terminateOnTimeout: false }
    );
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async preparePlayback({ filePath } = {}) {
    const response = await this.request(
      'playback.prepare',
      { filePath },
      PLAYBACK_START_TIMEOUT_MS,
      { terminateOnTimeout: false }
    );
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async stopPlayback({ playbackId } = {}) {
    const response = await this.request('playback.stop', { playbackId });
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async scheduleTone({ toneId, delaySeconds = 0, frequencyHz = 1000, durationSeconds = 0.12, gain = 0.45, target = 'auto' } = {}) {
    const response = await this.request('tone.schedule', { toneId, delaySeconds, frequencyHz, durationSeconds, gain, target });
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async stopTone({ toneId } = {}) {
    const response = await this.request('tone.stop', { toneId });
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async startRecording({ filePath, lanes } = {}) {
    const response = await this.request('record.start', { filePath, lanes });
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async stopRecording() {
    const response = await this.request('record.stop');
    return response.payload || { ok: false, message: 'No response payload.' };
  }

  async inspectRouting() {
    const response = await this.request('routing.inspect');
    return response.payload || null;
  }

  async ping() {
    return this.request('engine.ping');
  }

  stop() {
    if (!this.child) return;

    try {
      const message = {
        id: String(this.nextId++),
        type: 'engine.quit',
        protocolVersion: PROTOCOL_VERSION,
        payload: {},
      };
      this.#writeToEngine(`${JSON.stringify(message)}\n`);
      this.child.stdin.end();
    } catch {
      this.child.kill();
    }
  }

  restart() {
    this.#rejectPending(new Error('Audio engine restarted.'));
    this.#terminateChild();
    this.start();
  }

  #rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  #terminateChild() {
    if (!this.child) return;

    const child = this.child;
    this.ready = false;
    this.lastReadyPayload = null;
    this.child = null;

    try {
      child.stdin?.destroy();
    } catch {}

    try {
      child.stdout?.destroy();
    } catch {}

    try {
      child.stderr?.destroy();
    } catch {}

    try {
      if (!child.killed) child.kill();
    } catch {}
  }

  #writeToEngine(serializedMessage) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('Audio engine process is not writable.');
    }

    const ok = this.child.stdin.write(serializedMessage, (err) => {
      if (!err) return;
      if (err.code === 'EPIPE') return;
      console.warn('[audio-engine] stdin write failed:', err.message);
    });

    if (!ok) {
      this.child.stdin.once('error', (err) => {
        if (err.code !== 'EPIPE') console.warn('[audio-engine] stdin error:', err.message);
      });
    }
  }

  #handleLine(line, sourceChild = this.child) {
    if (sourceChild && this.child !== sourceChild) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      console.warn('[audio-engine] Ignoring non-JSON stdout:', line);
      return;
    }

    if (message.type === 'engine.ready') {
      this.ready = true;
      this.lastReadyPayload = message.payload || {};
      return;
    }

    if (message.id && this.pending.has(String(message.id))) {
      const pending = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);

      if (message.type === 'engine.error') {
        pending.reject(new Error(message.payload?.message || 'Audio engine error.'));
      } else {
        pending.resolve(message);
      }
      return;
    }

    console.log('[audio-engine:event]', message);
  }
}

module.exports = {
  AudioEngineClient,
  resolveEnginePath,
};
