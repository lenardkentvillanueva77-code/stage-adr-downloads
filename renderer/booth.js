'use strict';

const video = document.getElementById('booth-video');
const idle = document.getElementById('idle');
const charBadge = document.getElementById('char-badge');
const dlgOverlay = document.getElementById('dialogue-overlay');
const dlgAnchor = document.getElementById('dialogue-anchor');
const dlgLine1 = document.getElementById('dialogue-line1');
const dlgLine2 = document.getElementById('dialogue-line2');
const tcOverlay = document.getElementById('timecode-overlay');
const countdownDots = document.getElementById('countdown-dots');
const streamerBar = document.getElementById('streamer-bar');
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
let streamerHitGeneration = -1;

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
  const totalFrames = Math.max(0, Math.round((seconds || 0) * fps));
  const hh = Math.floor(totalFrames / (nominal * 3600));
  const mm = Math.floor(totalFrames / (nominal * 60)) % 60;
  const ss = Math.floor(totalFrames / nominal) % 60;
  const ff = totalFrames % nominal;
  const sep = (fps > 29.9 && fps < 30.0) || (fps > 59.9 && fps < 60.0) ? ';' : ':';
  return [hh, mm, ss].map(v => String(v).padStart(2, '0')).join(':') + sep + String(ff).padStart(2, '0');
}

function applyDisplaySettings(msg) {
  if ('frameRate' in msg) boothFps = parseFrameRate(msg.frameRate);
  if ('showTimecode' in msg) showTimecode = !!msg.showTimecode;
  if ('overlayColor' in msg && msg.overlayColor) currentOverlayColor = msg.overlayColor;
  if ('overlayFontSize' in msg && msg.overlayFontSize) currentOverlayFontSize = msg.overlayFontSize;
  tcOverlay.classList.toggle('visible', showTimecode);
  tcOverlay.textContent = secondsToTC(video.currentTime || 0);
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
  streamerHitGeneration = -1;
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

function splitDialogueLines(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { line1: '', line2: '' };
  const words = trimmed.split(/\s+/);
  const anchorX = window.innerWidth * 0.5;
  const maxLine1Width = Math.max(160, Math.min(window.innerWidth * 0.42, window.innerWidth - anchorX - window.innerWidth * 0.04));
  const style = getComputedStyle(dlgLine1);
  const canvas = splitDialogueLines._canvas || (splitDialogueLines._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

  let line1 = words[0] || '';
  let index = 1;
  while (index < words.length) {
    const candidate = `${line1} ${words[index]}`;
    if (ctx.measureText(candidate).width > maxLine1Width) break;
    line1 = candidate;
    index += 1;
  }

  const line2 = words.slice(index).join(' ');
  return { line1, line2 };
}

function renderDialogue() {
  dlgOverlay.style.color = currentOverlayColor;
  dlgOverlay.classList.remove('size-small', 'size-medium', 'size-large');
  dlgOverlay.classList.add(`size-${currentOverlayFontSize || 'medium'}`);

  const trimmed = String(currentDialogue || '').trim();
  if (!hasCue || !trimmed) {
    dlgLine1.textContent = '';
    dlgLine2.textContent = '';
    dlgOverlay.classList.remove('visible');
    return;
  }

  const { line1, line2 } = splitDialogueLines(trimmed);
  dlgLine1.textContent = line1;
  dlgLine2.textContent = line2;
  dlgOverlay.classList.add('visible');
}

function hideStreamer() {
  streamerBar.classList.remove('visible');
  streamerHitFlash.classList.remove('visible');
}

function flashStreamerHit(anchorX) {
  streamerHitFlash.style.left = `${anchorX}px`;
  streamerHitFlash.classList.add('visible');
  setTimeout(() => {
    streamerHitFlash.classList.remove('visible');
  }, 120);
}

function updateStreamer() {
  const targetTime = streamerTargetTime;
  if (
    !hasCue ||
    typeof targetTime !== 'number' ||
    !isFinite(targetTime) ||
    !(targetTime > cueInTime) ||
    video.paused
  ) {
    hideStreamer();
    requestAnimationFrame(updateStreamer);
    return;
  }

  const anchorX = window.innerWidth * 0.5;
  const elapsed = Math.max(0, (video.currentTime || 0) - cueInTime);
  const targetLeadSeconds = targetTime - cueInTime;
  const pixelsPerSecond = anchorX / targetLeadSeconds;
  const barWidth = streamerBar.offsetWidth || 18;
  const leadingX = elapsed * pixelsPerSecond;
  const left = leadingX - barWidth;

  if (leadingX < -barWidth || left > window.innerWidth) {
    hideStreamer();
    requestAnimationFrame(updateStreamer);
    return;
  }

  streamerBar.style.transform = `translateX(${left}px)`;
  streamerBar.classList.add('visible');

  if (leadingX >= anchorX && streamerHitGeneration !== transportGeneration) {
    streamerHitGeneration = transportGeneration;
    flashStreamerHit(anchorX);
  }

  requestAnimationFrame(updateStreamer);
}
requestAnimationFrame(updateStreamer);

window.addEventListener('resize', () => {
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
