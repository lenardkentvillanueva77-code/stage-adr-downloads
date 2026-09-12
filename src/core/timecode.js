'use strict';

/**
 * core/timecode.js
 *
 * The single authoritative module for all frame ↔ timecode conversions.
 * Nothing else in the codebase does timecode arithmetic.
 *
 * Frame rates are represented as exact rational numbers to avoid
 * floating-point drift in drop-frame calculations.
 *
 * Supported frame rates: 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60
 */

// ── Frame rate normalization ──────────────────────────────────────────────────

const FRAME_RATE_MAP = {
  '23.976': { num: 24000, den: 1001, drop: false, nominal: 24 },
  '23.98':  { num: 24000, den: 1001, drop: false, nominal: 24 },
  '24':     { num: 24,    den: 1,    drop: false, nominal: 24 },
  '25':     { num: 25,    den: 1,    drop: false, nominal: 25 },
  '29.97':  { num: 30000, den: 1001, drop: true,  nominal: 30 },
  '30':     { num: 30,    den: 1,    drop: false, nominal: 30 },
  '48':     { num: 48,    den: 1,    drop: false, nominal: 48 },
  '50':     { num: 50,    den: 1,    drop: false, nominal: 50 },
  '59.94':  { num: 60000, den: 1001, drop: true,  nominal: 60 },
  '60':     { num: 60,    den: 1,    drop: false, nominal: 60 },
};

/**
 * Parse a frame rate string from ffprobe (e.g. "24000/1001", "25/1", "24")
 * into a canonical key usable with FRAME_RATE_MAP.
 *
 * @param {string} frStr — frame rate string from ffprobe or project settings
 * @returns {{ key: string, fps: number, info: object } | null}
 */
function parseFrameRate(frStr) {
  if (!frStr || typeof frStr !== 'string') return null;

  let fps;

  if (frStr.includes('/')) {
    const [num, den] = frStr.split('/').map(Number);
    if (!den || isNaN(num) || isNaN(den)) return null;
    fps = num / den;
  } else {
    fps = parseFloat(frStr);
  }

  if (!isFinite(fps) || fps <= 0) return null;

  // Match to known frame rates within tolerance
  const candidates = Object.entries(FRAME_RATE_MAP);
  for (const [key, info] of candidates) {
    const nominal = info.num / info.den;
    if (Math.abs(fps - nominal) < 0.01) {
      return { key, fps: nominal, info };
    }
  }

  // Unknown frame rate — return a non-drop approximation
  const rounded = Math.round(fps);
  return {
    key: String(fps),
    fps,
    info: { num: Math.round(fps * 1000), den: 1000, drop: false, nominal: rounded },
  };
}

/**
 * Convert a frame count to a SMPTE timecode string.
 *
 * @param {number} frames  — total frame count from zero
 * @param {string} frameRateStr — project frame rate string
 * @returns {string} — "HH:MM:SS:FF" (non-drop) or "HH:MM:SS;FF" (drop-frame)
 */
function framesToTimecode(frames, frameRateStr) {
  if (frames == null || !isFinite(frames)) return '00:00:00:00';

  const parsed = parseFrameRate(frameRateStr);
  if (!parsed) return '00:00:00:00';

  const { info } = parsed;
  const nomFps = info.nominal;
  const isDropFrame = info.drop;

  let totalFrames = Math.max(0, Math.round(frames));

  if (isDropFrame) {
    // SMPTE drop-frame calculation (29.97 and 59.94)
    const dropFrames = nomFps === 30 ? 2 : 4;
    const framesPerMin = nomFps * 60 - dropFrames;
    const framesPer10Min = nomFps * 600 - dropFrames * 9;

    const d = Math.floor(totalFrames / framesPer10Min);
    const m = totalFrames % framesPer10Min;
    const adj = dropFrames * 9 * d + dropFrames * Math.max(0, Math.floor((m - dropFrames) / framesPerMin));
    totalFrames += adj;

    const ff = totalFrames % nomFps;
    const ss = Math.floor(totalFrames / nomFps) % 60;
    const mm = Math.floor(totalFrames / (nomFps * 60)) % 60;
    const hh = Math.floor(totalFrames / (nomFps * 3600));

    return `${pad(hh)}:${pad(mm)}:${pad(ss)};${pad(ff)}`;
  } else {
    const ff = totalFrames % nomFps;
    const ss = Math.floor(totalFrames / nomFps) % 60;
    const mm = Math.floor(totalFrames / (nomFps * 60)) % 60;
    const hh = Math.floor(totalFrames / (nomFps * 3600));

    return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  }
}

function framesToProjectTimecode(frames, frameRateStr, startFrameOffset = 0) {
  const offset = Number.isFinite(Number(startFrameOffset)) ? Math.max(0, Math.round(Number(startFrameOffset))) : 0;
  return framesToTimecode(Math.max(0, Math.round(frames || 0) + offset), frameRateStr);
}

function getProjectStartFrameOffset(projectOrSettings, frameRateStr) {
  const settings = projectOrSettings?.settings || projectOrSettings || {};
  const frameRate = frameRateStr || settings.frameRate || '25';
  const storedOffset = Number(settings.startFrameOffset);
  if (Number.isFinite(storedOffset) && storedOffset >= 0) return Math.round(storedOffset);
  if (isValidTimecode(settings.startTimecode)) return timecodeToFrames(settings.startTimecode, frameRate);
  return 0;
}

/**
 * Convert a SMPTE timecode string to a frame count.
 *
 * @param {string} tc  — "HH:MM:SS:FF" or "HH:MM:SS;FF"
 * @param {string} frameRateStr
 * @returns {number} — total frame count
 */
function timecodeToFrames(tc, frameRateStr) {
  if (!tc || typeof tc !== 'string') return 0;

  const parsed = parseFrameRate(frameRateStr);
  if (!parsed) return 0;

  const { info } = parsed;
  const nomFps = info.nominal;
  const isDropFrame = info.drop;

  // Accept both : and ; separators
  const parts = tc.replace(';', ':').split(':');
  if (parts.length !== 4) return 0;

  const [hh, mm, ss, ff] = parts.map(Number);
  if ([hh, mm, ss, ff].some(isNaN)) return 0;

  if (isDropFrame) {
    const dropFrames = nomFps === 30 ? 2 : 4;
    const totalMinutes = 60 * hh + mm;
    const frameCount =
      nomFps * 3600 * hh +
      nomFps * 60 * mm +
      nomFps * ss +
      ff -
      dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
    return Math.max(0, frameCount);
  } else {
    return hh * 3600 * nomFps + mm * 60 * nomFps + ss * nomFps + ff;
  }
}

/**
 * Convert frames to wall-clock seconds (for informational display only —
 * never use this as a timing source for recording).
 *
 * @param {number} frames
 * @param {string} frameRateStr
 * @returns {number}
 */
function framesToSeconds(frames, frameRateStr) {
  const parsed = parseFrameRate(frameRateStr);
  if (!parsed) return 0;
  return frames / parsed.fps;
}

/**
 * Convert seconds to the nearest frame count.
 * Used only for importing/detecting metadata — not for recording timing.
 *
 * @param {number} seconds
 * @param {string} frameRateStr
 * @returns {number}
 */
function secondsToFrames(seconds, frameRateStr) {
  const parsed = parseFrameRate(frameRateStr);
  if (!parsed) return 0;
  return Math.round(seconds * parsed.fps);
}

/**
 * Validate a timecode string format.
 * @param {string} tc
 * @returns {boolean}
 */
function isValidTimecode(tc) {
  if (!tc || typeof tc !== 'string') return false;
  return /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(tc);
}

/**
 * Normalize a frame rate string from ffprobe to a display string.
 * e.g. "24000/1001" → "23.976"
 * @param {string} frStr
 * @returns {string}
 */
function normalizeFrameRateDisplay(frStr) {
  const parsed = parseFrameRate(frStr);
  if (!parsed) return frStr || 'Unknown';
  return parsed.key;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(n) {
  return String(Math.floor(n)).padStart(2, '0');
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  parseFrameRate,
  framesToTimecode,
  framesToProjectTimecode,
  getProjectStartFrameOffset,
  timecodeToFrames,
  framesToSeconds,
  secondsToFrames,
  normalizeFrameRateDisplay,
  isValidTimecode,
};
