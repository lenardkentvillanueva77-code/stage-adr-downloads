'use strict';

/**
 * src/ipc/recordingHandlers.js
 *
 * Main-process IPC handlers for the recording engine.
 * Receives PCM data from the renderer, assembles WAV files, returns take metadata.
 *
 * IPC channels (all invoke/handle):
 *   recording:finalise  — write WAV, return take path + duration
 *   recording:abort     — no-op in R3a (no temp files); kept for API consistency
 *
 * WAV spec: 48000 Hz, 24-bit PCM, mono, little-endian.
 */

const fs   = require('fs');
const path = require('path');

// ── WAV constants ─────────────────────────────────────────────────────────────

const SAMPLE_RATE  = 48000;
const BIT_DEPTH    = 24;
const CHANNELS     = 1;
const BYTES_PER_SAMPLE = BIT_DEPTH / 8;           // 3
const BYTE_RATE        = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;  // 144000
const BLOCK_ALIGN      = CHANNELS * BYTES_PER_SAMPLE;                // 3

// ── WAV header ────────────────────────────────────────────────────────────────

/**
 * Build a 44-byte WAV header for the given number of PCM data bytes.
 * @param {number} dataByteCount
 * @returns {Buffer}
 */
function buildWavHeader(dataByteCount) {
  const fileSize = 36 + dataByteCount;   // RIFF chunk size = 36 + data
  const buf = Buffer.alloc(44);
  let offset = 0;

  // RIFF chunk descriptor
  buf.write('RIFF', offset);            offset += 4;
  buf.writeUInt32LE(fileSize, offset);  offset += 4;
  buf.write('WAVE', offset);            offset += 4;

  // fmt sub-chunk
  buf.write('fmt ', offset);            offset += 4;
  buf.writeUInt32LE(16, offset);        offset += 4;   // sub-chunk size = 16 for PCM
  buf.writeUInt16LE(1, offset);         offset += 2;   // audio format = 1 (PCM)
  buf.writeUInt16LE(CHANNELS, offset);  offset += 2;
  buf.writeUInt32LE(SAMPLE_RATE, offset); offset += 4;
  buf.writeUInt32LE(BYTE_RATE, offset);   offset += 4;
  buf.writeUInt16LE(BLOCK_ALIGN, offset); offset += 2;
  buf.writeUInt16LE(BIT_DEPTH, offset);   offset += 2;

  // data sub-chunk
  buf.write('data', offset);             offset += 4;
  buf.writeUInt32LE(dataByteCount, offset);

  return buf;
}

// ── Float32 → 24-bit PCM conversion ──────────────────────────────────────────

/**
 * Convert a Float32Array of PCM samples (range [-1, 1]) to a Buffer of
 * 24-bit little-endian integer PCM samples.
 * @param {Float32Array} float32Samples
 * @returns {Buffer}
 */
function float32To24BitPcm(float32Samples) {
  const pcmBuf = Buffer.alloc(float32Samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < float32Samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32Samples[i]));
    // Scale to 24-bit signed integer range
    const int32   = Math.round(clamped < 0
      ? clamped * 8388608    // 2^23
      : clamped * 8388607);  // 2^23 - 1
    const offset  = i * BYTES_PER_SAMPLE;
    pcmBuf[offset]     =  int32 & 0xFF;
    pcmBuf[offset + 1] = (int32 >> 8)  & 0xFF;
    pcmBuf[offset + 2] = (int32 >> 16) & 0xFF;
  }
  return pcmBuf;
}

// ── File path helpers ─────────────────────────────────────────────────────────

/**
 * Compute the WAV destination path for a take.
 * Creates the cue directory if it does not exist.
 * If the computed path already exists (crash-recovery edge case), appends '_r'.
 *
 * @param {string} projectMediaPath  — e.g. /path/MyProject_media
 * @param {string} cueNumber         — e.g. "ADR-001"
 * @param {number} takeNumber        — 1-based
 * @returns {string}  absolute path to .wav
 */
function resolveTakePath(projectMediaPath, cueNumber, takeNumber) {
  const safeCue = cueNumber.replace(/[^a-zA-Z0-9\-_]/g, '_');
  const cueDir  = path.join(projectMediaPath, 'takes', safeCue);
  if (!fs.existsSync(cueDir)) {
    fs.mkdirSync(cueDir, { recursive: true });
  }

  const numStr   = String(takeNumber).padStart(3, '0');
  let   wavPath  = path.join(cueDir, `take_${numStr}.wav`);

  // Collision guard — should never happen in normal operation
  if (fs.existsSync(wavPath)) {
    wavPath = path.join(cueDir, `take_${numStr}_r.wav`);
    console.warn('[recording] Path collision — using recovery name:', wavPath);
  }

  return wavPath;
}

// ── IPC handler registration ──────────────────────────────────────────────────

function register(ipcMain) {
  /**
   * recording:finalise
   *
   * Receives Float32 PCM from the renderer, converts to 24-bit WAV, writes to disk.
   * Returns the resolved take path and duration in seconds.
   *
   * payload.pcmBuffer — ArrayBuffer containing Float32 mono PCM samples at 48kHz
   * payload.cueNumber — for directory naming
   * payload.takeNumber
   * payload.projectMediaPath — absolute path to the project _media folder
   */
  ipcMain.handle('recording:finalise', async (_event, payload) => {
    const { pcmBuffer, cueNumber, takeNumber, projectMediaPath } = payload;

    if (!pcmBuffer || !projectMediaPath || !cueNumber || takeNumber == null) {
      return { success: false, error: 'recording:finalise — missing required fields.' };
    }

    // Reconstruct Float32Array from the transferred ArrayBuffer
    const float32Samples = new Float32Array(pcmBuffer);

    if (float32Samples.length === 0) {
      return { success: false, error: 'zero_samples' };
    }

    const durationSecs = float32Samples.length / SAMPLE_RATE;

    try {
      const wavPath  = resolveTakePath(projectMediaPath, cueNumber, takeNumber);
      const pcmData  = float32To24BitPcm(float32Samples);
      const wavHeader = buildWavHeader(pcmData.length);
      const wavFile   = Buffer.concat([wavHeader, pcmData]);

      fs.writeFileSync(wavPath, wavFile);
      console.log(`[recording] WAV written: ${wavPath} (${durationSecs.toFixed(2)}s)`);

      return { success: true, filePath: wavPath, durationSecs };
    } catch (err) {
      console.error('[recording] WAV write failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * recording:readFile
   * Read a local file as a Buffer and return it as an ArrayBuffer.
   * Used as a fallback when fetch('file://...') is blocked by Electron CSP.
   * @param {{ filePath: string }}
   * @returns {{ success: boolean, buffer?: ArrayBuffer, error?: string }}
   */
  /**
   * recording:abort
   * No temp files exist in R3a — PCM is accumulated in the AudioWorklet.
   * Kept for API consistency and future R3b use.
   */
  ipcMain.handle('recording:abort', async () => {
    return { success: true };
  });
}

module.exports = { register };
