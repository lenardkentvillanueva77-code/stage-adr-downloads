'use strict';

const video = document.getElementById('booth-video');
const idle = document.getElementById('idle');
const charBadge = document.getElementById('char-badge');
const dlgOverlay = document.getElementById('dialogue-overlay');
const dlgAnchor = document.getElementById('dialogue-anchor');
const dlgPrev = document.getElementById('dialogue-line-prev');
const dlgLine1 = document.getElementById('dialogue-line1');
const dlgLine2 = document.getElementById('dialogue-line2');
const tcOverlay = document.getElementById('timecode-overlay');
const countdownDots = document.getElementById('countdown-dots');
const streamerBar = document.getElementById('streamer-bar');
const streamerStartLine = document.getElementById('streamer-start-line');
const streamerTargetLine = document.getElementById('streamer-target-line');
const streamerHitFlash = document.getElementById('streamer-hit-flash');
const cdots = [
  document.getElementById('cdot-1'),
  document.getElementById('cdot-2'),
  document.getElementById('cdot-3'),
];

video.muted = true;

let hasCue = false;
let showTimecode = false;
let boothFps = 25;
let transportGeneration = 0;

let currentDialogue = '';
let currentOverlayColor = '#f5e642';
let currentOverlayFontSize = 'medium';
let cueInTime = 0;
let cueOutTime = 0;
let streamerTargetTime = null;
let streamerTargetTimes = [];
let streamerHitIndex = -1;
let streamerStartPositionRatio = 0.12;
let streamerHitPositionRatio = 0.72;
let startFrameOffset = 0;

function showIdle() {
  idle.classList.remove('hidden');
  charBadge.classList.remove('visible');
  dlgOverlay.classList.remove('visible');
}

function hideIdle() {
  idle.classList.add('hidden');
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
  const totalFrames = Math.max(0, Math.round((seconds || 0) * fps) + startFrameOffset);
  const hh = Math.floor(totalFrames / (nominal * 3600));
  const mm = Math.floor(totalFrames / (nominal * 60)) % 60;
  const ss = Math.floor(totalFrames / nominal) % 60;
  const ff = totalFrames % nominal;
  const sep = (fps > 29.9 && fps < 30.0) || (fps > 59.9 && fps < 60.0) ? ';' : ':';
  return [hh, mm, ss].map(v => String(v).padStart(2, '0')).join(':') + sep + String(ff).padStart(2, '0');
}

function applyDisplaySettings(msg) {
  if ('frameRate' in msg) boothFps = parseFrameRate(msg.frameRate);
  if ('startFrameOffset' in msg) {
    const offset = Number(msg.startFrameOffset);
    startFrameOffset = Number.isFinite(offset) && offset >= 0 ? Math.round(offset) : 0;
  }
  if ('showTimecode' in msg) showTimecode = !!msg.showTimecode;
  if ('overlayColor' in msg && msg.overlayColor) currentOverlayColor = msg.overlayColor;
  if ('overlayFontSize' in msg && msg.overlayFontSize) currentOverlayFontSize = msg.overlayFontSize;
  if ('streamerHitPositionRatio' in msg) {
    const ratio = Number(msg.streamerHitPositionRatio);
    if (Number.isFinite(ratio)) streamerHitPositionRatio = Math.max(0.30, Math.min(0.95, ratio));
  }
  if ('streamerStartPositionRatio' in msg) {
    const ratio = Number(msg.streamerStartPositionRatio);
    if (Number.isFinite(ratio)) streamerStartPositionRatio = Math.max(0.02, Math.min(0.85, ratio));
  }
  if (streamerStartPositionRatio >= streamerHitPositionRatio - 0.05) {
    streamerStartPositionRatio = Math.max(0.02, streamerHitPositionRatio - 0.05);
  }
  tcOverlay.classList.toggle('visible', showTimecode);
  tcOverlay.textContent = secondsToTC(video.currentTime || 0);
  updateStreamerTargetLine();
  renderDialogue();
}

function tickTimecode() {
  if (showTimecode) {
    tcOverlay.textContent = secondsToTC(video.currentTime || 0);
  }
  requestAnimationFrame(tickTimecode);
}
requestAnimationFrame(tickTimecode);

function cancelPlay() {
  transportGeneration += 1;
  hideStreamer();
}

function clearCountdown() {
  countdownDots.classList.remove('visible');
  cdots.forEach(d => d.classList.remove('lit'));
}

function nextTransportGeneration(msg) {
  if (Number.isFinite(msg?.commandId)) {
    transportGeneration = Math.max(transportGeneration + 1, msg.commandId);
  } else {
    transportGeneration += 1;
  }
  streamerHitIndex = -1;
  return transportGeneration;
}

function seekTo(targetTime) {
  if (typeof targetTime !== 'number' || !isFinite(targetTime)) return;
  try {
    video.currentTime = targetTime;
  } catch (err) {
    console.warn('[booth] seek failed:', err?.message || err);
  }
}

function reportReady(msg, reason = 'ready') {
  if (!Number.isFinite(msg?.commandId)) return;
  window.booth.sendStatus({ type: 'ready', commandId: msg.commandId, reason });
}

function reportReadyWhenSeekSettles(msg) {
  if (!Number.isFinite(msg?.commandId)) return;
  if (video.readyState >= 2 && !video.seeking) {
    reportReady(msg);
    return;
  }
  let settled = false;
  const done = (reason) => {
    if (settled) return;
    settled = true;
    video.removeEventListener('seeked', onSeeked);
    video.removeEventListener('canplay', onCanPlay);
    reportReady(msg, reason);
  };
  const onSeeked = () => done('seeked');
  const onCanPlay = () => done('canplay');
  video.addEventListener('seeked', onSeeked, { once: true });
  video.addEventListener('canplay', onCanPlay, { once: true });
  setTimeout(() => done('timeout'), 250);
}

function stopVideoAt(targetTime, msg) {
  nextTransportGeneration(msg);
  video.pause();
  video.muted = true;
  seekTo(targetTime);
  hideStreamer();
}

function playSynced(targetTime, msg) {
  const generation = nextTransportGeneration(msg);
  video.pause();
  video.preload = 'auto';
  video.muted = true;
  seekTo(targetTime);
  const playPromise = video.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch((err) => {
      if (generation !== transportGeneration) return;
      console.warn('[booth] video.play() failed:', err?.message || err);
    });
  }
  requestAnimationFrame(() => {
    if (generation !== transportGeneration) return;
    video.muted = true;
  });
}

function getDialogueSegments(text) {
  return String(text || '')
    .split('//')
    .map(part => part.trim())
    .filter(Boolean);
}

function normalizeStreamerTargetTimes(times) {
  if (!Array.isArray(times)) return [];
  return [...new Set(
    times
      .filter(time => typeof time === 'number' && Number.isFinite(time))
      .map(time => Math.max(0, time))
  )].sort((a, b) => a - b);
}

function getStreamerSequenceState() {
  const dialogueSegments = getDialogueSegments(currentDialogue);
  const fallbackText = String(currentDialogue || '').replaceAll('//', ' ').trim();
  const fallbackSegments = fallbackText ? [fallbackText] : [];
  const targets = Array.isArray(streamerTargetTimes) && streamerTargetTimes.length
    ? normalizeStreamerTargetTimes(streamerTargetTimes)
    : (Number.isFinite(streamerTargetTime) ? [streamerTargetTime] : []);

  if (targets.length >= 1 && dialogueSegments.length >= 1 && targets.length <= dialogueSegments.length) {
    return {
      enabled: true,
      segments: dialogueSegments,
      targets,
    };
  }

  return {
    enabled: false,
    segments: fallbackSegments,
    targets: [],
  };
}

function getDialogueDisplayState() {
  const state = getStreamerSequenceState();
  if (!state.segments.length) return { previousText: '', currentText: '', nextText: '' };
  if (!state.enabled || !state.targets.length) {
    return { previousText: '', currentText: state.segments[0], nextText: '' };
  }
  const playbackTime = video.currentTime || 0;
  const completedHits = state.targets.filter(time => playbackTime >= time).length;
  const segmentIndex = Math.min(completedHits, state.segments.length - 1);
  return {
    previousText: segmentIndex > 0 ? state.segments[segmentIndex - 1] : '',
    currentText: state.segments[segmentIndex] || state.segments[0],
    nextText: state.segments[segmentIndex + 1] || '',
  };
}

function renderDialogue() {
  dlgOverlay.style.color = currentOverlayColor;
  dlgOverlay.classList.remove('size-small', 'size-medium', 'size-large');
  dlgOverlay.classList.add(`size-${currentOverlayFontSize || 'medium'}`);

  const display = getDialogueDisplayState();
  const previousText = display.previousText.trim();
  const currentText = display.currentText.trim();
  const nextText = display.nextText.trim();
  if (!hasCue || !currentText) {
    dlgPrev.textContent = '';
    dlgLine1.textContent = '';
    dlgLine2.textContent = '';
    dlgOverlay.classList.remove('visible');
    return;
  }

  dlgPrev.textContent = previousText;
  dlgLine1.textContent = currentText;
  dlgLine2.textContent = nextText;
  dlgOverlay.classList.add('visible');
}

function hideMovingStreamer() {
  streamerBar.classList.remove('visible');
  streamerHitFlash.classList.remove('visible');
}

function hideStreamer() {
  hideMovingStreamer();
  streamerStartLine.classList.remove('visible');
  streamerTargetLine.classList.remove('visible');
}

function getStreamerHitX() {
  return window.innerWidth * streamerHitPositionRatio;
}

function getStreamerStartX() {
  return window.innerWidth * streamerStartPositionRatio;
}

function updateStreamerTargetLine() {
  const sequence = getStreamerSequenceState();
  if (!hasCue || !sequence.enabled || !sequence.targets.length) {
    streamerStartLine.classList.remove('visible');
    streamerTargetLine.classList.remove('visible');
    return;
  }
  streamerStartLine.style.left = `${getStreamerStartX()}px`;
  streamerTargetLine.style.left = `${getStreamerHitX()}px`;
  streamerStartLine.classList.add('visible');
  streamerTargetLine.classList.add('visible');
}

function flashStreamerHit(anchorX) {
  streamerHitFlash.style.left = `${anchorX}px`;
  streamerHitFlash.classList.add('visible');
  setTimeout(() => {
    streamerHitFlash.classList.remove('visible');
  }, 120);
}

function updateStreamer() {
  const sequence = getStreamerSequenceState();
  renderDialogue();
  const playbackTime = video.currentTime || 0;
  const completedHits = sequence.targets.filter(time => playbackTime >= time).length;
  if (completedHits - 1 > streamerHitIndex) {
    streamerHitIndex = completedHits - 1;
    if (streamerHitIndex >= 0) flashStreamerHit(getStreamerHitX());
  }
  const nextTargetIndex = sequence.targets.findIndex(time => playbackTime < time);
  const targetTime = nextTargetIndex >= 0 ? sequence.targets[nextTargetIndex] : null;
  if (
    !hasCue ||
    !sequence.enabled ||
    typeof targetTime !== 'number' ||
    !isFinite(targetTime) ||
    video.paused
  ) {
    hideMovingStreamer();
    updateStreamerTargetLine();
    requestAnimationFrame(updateStreamer);
    return;
  }

  updateStreamerTargetLine();
  const startX = getStreamerStartX();
  const anchorX = getStreamerHitX();
  const segmentStartTime = nextTargetIndex === 0 ? cueInTime : sequence.targets[nextTargetIndex - 1];
  const elapsed = Math.max(0, playbackTime - segmentStartTime);
  const targetLeadSeconds = targetTime - segmentStartTime;
  if (!(targetLeadSeconds > 0)) {
    hideMovingStreamer();
    updateStreamerTargetLine();
    requestAnimationFrame(updateStreamer);
    return;
  }
  const pixelsPerSecond = (anchorX - startX) / targetLeadSeconds;
  const barWidth = streamerBar.offsetWidth || 18;
  const leadingX = startX + elapsed * pixelsPerSecond;
  const left = leadingX - barWidth;

  if (leadingX < startX - barWidth || left > window.innerWidth) {
    hideMovingStreamer();
    updateStreamerTargetLine();
    requestAnimationFrame(updateStreamer);
    return;
  }

  streamerBar.style.transform = `translateX(${left}px)`;
  streamerBar.classList.add('visible');

  requestAnimationFrame(updateStreamer);
}
requestAnimationFrame(updateStreamer);

window.addEventListener('resize', () => {
  updateStreamerTargetLine();
  renderDialogue();
});

window.booth.onUpdate((msg) => {
  switch (msg.type) {
    case 'videoSource': {
      const src = msg.src || '';
      if (!src || video.src === src) break;
      video.src = src;
      video.preload = 'auto';
      video.muted = true;
      video.load();
      video.classList.add('has-source');
      if (hasCue) hideIdle();
      break;
    }

    case 'cueSelected': {
      hasCue = true;
      hideIdle();
      currentDialogue = msg.dialogue || '';
      cueInTime = Number.isFinite(msg.inTime) ? msg.inTime : 0;
      cueOutTime = Number.isFinite(msg.outTime) ? msg.outTime : cueInTime;
      streamerTargetTime = Number.isFinite(msg.streamerTargetTime) ? msg.streamerTargetTime : null;
      streamerTargetTimes = Array.isArray(msg.streamerTargetTimes)
        ? msg.streamerTargetTimes.filter(time => Number.isFinite(time))
        : (Number.isFinite(streamerTargetTime) ? [streamerTargetTime] : []);
      charBadge.textContent = msg.characterName || '';
      charBadge.classList.toggle('visible', !!(msg.characterName || '').trim());
      applyDisplaySettings(msg);
      renderDialogue();
      break;
    }

    case 'cuePrimed': {
      cancelPlay();
      video.pause();
      video.preload = 'auto';
      video.muted = true;
      seekTo(msg.currentTime);
      reportReadyWhenSeekSettles(msg);
      break;
    }

    case 'cueDeselected': {
      hasCue = false;
      currentDialogue = '';
      cueInTime = 0;
      cueOutTime = 0;
      streamerTargetTime = null;
      streamerTargetTimes = [];
      cancelPlay();
      video.pause();
      clearCountdown();
      charBadge.classList.remove('visible');
      dlgOverlay.classList.remove('visible');
      showIdle();
      break;
    }

    case 'dialogueChanged': {
      currentDialogue = msg.dialogue || '';
      renderDialogue();
      break;
    }

    case 'overlaySettings': {
      applyDisplaySettings(msg);
      break;
    }

    case 'boothDisplaySettings': {
      applyDisplaySettings(msg);
      break;
    }

    case 'cuePlaybackStart': {
      clearCountdown();
      playSynced(msg.currentTime, msg);
      break;
    }

    case 'cuePlaybackStop': {
      stopVideoAt(msg.currentTime, msg);
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

    case 'cueLoopRestart':
      break;

    default:
      break;
  }
});
