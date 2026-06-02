'use strict';

/**
 * renderer/booth.js — Actor Booth Display
 *
 * Display-only window controller.
 * NO require(). NO Node.js APIs. NO IPC invoke calls.
 * Receives state pushes from the main renderer via window.booth.onUpdate().
 *
 * Message types handled:
 *   videoSource       — load video file into booth player
 *   cueSelected       — show cue text/character, exit idle
 *   cuePrimed         — seek video to cue in-point, buffer for first pass
 *   cueDeselected     — stop video, show idle, clear all overlays
 *   dialogueChanged   — update dialogue text
 *   overlaySettings   — update text color / size
 *   cuePlaybackStart  — seek to in-point and play (muted, autoplay-safe)
 *   cuePlaybackStop   — pause video, return to in-point
 *   cueCountdownStart — pause video, show countdown dot overlay (all dim)
 *   cueCountdownTick  — light nth dot (0-based); -1 hides all
 *   cueCountdownClear — hide dots immediately (any stop/cancel)
 */

// ── DOM refs ──────────────────────────────────────────────────────────────────

const video         = document.getElementById('booth-video');
const idle          = document.getElementById('idle');
const charBadge     = document.getElementById('char-badge');
const dlgOverlay    = document.getElementById('dialogue-overlay');
const tcOverlay     = document.getElementById('timecode-overlay');
const countdownDots = document.getElementById('countdown-dots');
const cdots         = [
  document.getElementById('cdot-1'),
  document.getElementById('cdot-2'),
  document.getElementById('cdot-3'),
];

// Muted required for autoplay in a window with no prior user gesture.
video.muted = true;

// ── State ─────────────────────────────────────────────────────────────────────

let hasCue    = false;
let playTimer = null;   // handle for pending 100ms play() setTimeout
let showTimecode = false;
let boothFps = 25;

// ── Helpers ───────────────────────────────────────────────────────────────────

function showIdle() {
  idle.classList.remove('hidden');
  charBadge.classList.remove('visible');
  dlgOverlay.classList.remove('visible');
}

function hideIdle() {
  idle.classList.add('hidden');
}

function applyDialogue(text, color, size) {
  dlgOverlay.textContent = text || '';
  if (color) dlgOverlay.style.color = color;
  dlgOverlay.classList.remove('size-small', 'size-medium', 'size-large');
  dlgOverlay.classList.add('size-' + (size || 'medium'));
  dlgOverlay.classList.toggle('visible', hasCue && (text || '').trim().length > 0);
}

function parseFrameRate(value) {
  if (typeof value === 'number' && isFinite(value) && value > 0) return value;
  const s = String(value || '').trim();
  if (s.includes('/')) {
    const [num, den] = s.split('/').map(Number);
    if (num > 0 && den > 0) return num / den;
  }
  const parsed = parseFloat(s);
  return parsed > 0 ? parsed : 25;
}

function secondsToTC(seconds) {
  const fps = boothFps || 25;
  const nominal = Math.round(fps);
  const totalFrames = Math.max(0, Math.round((seconds || 0) * fps));
  const hh = Math.floor(totalFrames / (nominal * 3600));
  const mm = Math.floor(totalFrames / (nominal * 60)) % 60;
  const ss = Math.floor(totalFrames / nominal) % 60;
  const ff = totalFrames % nominal;
  const sep = (fps > 29.9 && fps < 30.0) || (fps > 59.9 && fps < 60.0) ? ';' : ':';
  return [hh, mm, ss].map(v => String(v).padStart(2, '0')).join(':') +
         sep + String(ff).padStart(2, '0');
}

function applyDisplaySettings(msg) {
  if ('frameRate' in msg) boothFps = parseFrameRate(msg.frameRate);
  if ('showTimecode' in msg) showTimecode = !!msg.showTimecode;
  tcOverlay.classList.toggle('visible', showTimecode);
  tcOverlay.textContent = secondsToTC(video.currentTime || 0);
}

function tickTimecode() {
  if (showTimecode) {
    tcOverlay.textContent = secondsToTC(video.currentTime || 0);
  }
  requestAnimationFrame(tickTimecode);
}
requestAnimationFrame(tickTimecode);

function cancelPlay() {
  if (playTimer !== null) { clearTimeout(playTimer); playTimer = null; }
}

function clearCountdown() {
  countdownDots.classList.remove('visible');
  cdots.forEach(d => d.classList.remove('lit'));
}

/**
 * Deterministic play sequence:
 *   cancelPlay → pause → mute → seek → 100ms delay → play()
 *
 * The 100ms delay lets the media engine settle after the seek before
 * play() is called, without requiring seeked-event chaining.
 */
function playAfterDelay(targetTime) {
  cancelPlay();
  video.pause();
  video.muted = true;
  if (typeof targetTime === 'number' && isFinite(targetTime)) {
    video.currentTime = targetTime;
  }
  playTimer = setTimeout(() => {
    playTimer = null;
    video.muted = true;
    video.play().catch((err) => {
      console.warn('[booth] video.play() failed:', err?.message || err);
    });
  }, 100);
}

// ── Update handler ────────────────────────────────────────────────────────────

window.booth.onUpdate((msg) => {
  switch (msg.type) {

    case 'videoSource': {
      const src = msg.src || '';
      if (!src || video.src === src) break;
      video.src     = src;
      video.preload = 'auto';
      video.muted   = true;
      video.load();
      video.classList.add('has-source');
      if (hasCue) hideIdle();
      break;
    }

    case 'cueSelected': {
      hasCue = true;
      hideIdle();
      charBadge.textContent = msg.characterName || '';
      charBadge.classList.toggle('visible', !!(msg.characterName || '').trim());
      applyDialogue(msg.dialogue, msg.overlayColor, msg.overlayFontSize);
      applyDisplaySettings(msg);
      break;
    }

    case 'cuePrimed': {
      cancelPlay();
      video.pause();
      video.preload = 'auto';
      video.muted   = true;
      if (typeof msg.currentTime === 'number' && isFinite(msg.currentTime)) {
        video.currentTime = msg.currentTime;
      }
      break;
    }

    case 'cueDeselected': {
      hasCue = false;
      cancelPlay();
      video.pause();
      clearCountdown();
      charBadge.classList.remove('visible');
      dlgOverlay.classList.remove('visible');
      showIdle();
      break;
    }

    case 'dialogueChanged': {
      applyDialogue(msg.dialogue, null, null);
      break;
    }

    case 'overlaySettings': {
      applyDialogue(dlgOverlay.textContent, msg.overlayColor, msg.overlayFontSize);
      applyDisplaySettings(msg);
      break;
    }

    case 'boothDisplaySettings': {
      applyDisplaySettings(msg);
      break;
    }

    case 'cuePlaybackStart': {
      clearCountdown();
      playAfterDelay(msg.currentTime);
      break;
    }

    case 'cuePlaybackStop': {
      cancelPlay();
      video.pause();
      if (typeof msg.currentTime === 'number' && isFinite(msg.currentTime)) {
        video.currentTime = msg.currentTime;
      }
      break;
    }

    case 'cueCountdownStart': {
      cancelPlay();
      video.pause();
      countdownDots.classList.add('visible');
      cdots.forEach(d => d.classList.remove('lit'));
      break;
    }

    case 'cueCountdownTick': {
      const idx = msg.dotIndex;
      cdots.forEach((d, i) => d.classList.toggle('lit', i === idx));
      if (idx === -1) clearCountdown();
      break;
    }

    case 'cueCountdownClear': {
      clearCountdown();
      break;
    }

    // No-op — no longer sent, kept for forward compatibility
    case 'cueLoopRestart':
      break;

    default:
      break;
  }
});
