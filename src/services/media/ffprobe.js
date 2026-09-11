'use strict';

const { execFile } = require('child_process');
const fs = require('fs');

function resolveFfprobePath() {
  try {
    const ffprobeStatic = require('ffprobe-static');
    if (ffprobeStatic?.path) return ffprobeStatic.path;
  } catch {}
  return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

function checkFfprobeAvailability() {
  const probePath = resolveFfprobePath();
  const isBundledPath = /[\\/]/.test(probePath);
  return {
    available: !isBundledPath || fs.existsSync(probePath),
    path: probePath,
    source: isBundledPath ? 'ffprobe-static' : 'system',
  };
}

function runFfprobe(args) {
  return new Promise((resolve) => {
    execFile(resolveFfprobePath(), args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr?.trim() || error.message });
        return;
      }
      resolve({ success: true, stdout });
    });
  });
}

function parseRatio(value) {
  if (!value || value === '0/0') return '';
  if (!String(value).includes('/')) return String(value);
  const [num, den] = String(value).split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return '';
  return `${num}/${den}`;
}

async function probeVideo(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'Video file not found.' };
  }

  const result = await runFfprobe([
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  if (!result.success) return result;

  try {
    const data = JSON.parse(result.stdout || '{}');
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const video = streams.find(stream => stream.codec_type === 'video') || {};
    const audio = streams.find(stream => stream.codec_type === 'audio') || {};
    const duration = Number(video.duration || data.format?.duration || 0);

    return {
      success: true,
      meta: {
        localPath: '',
        fileName: '',
        durationSeconds: Number.isFinite(duration) ? duration : 0,
        frameRate: parseRatio(video.avg_frame_rate) || parseRatio(video.r_frame_rate) || '',
        width: Number(video.width || 0),
        height: Number(video.height || 0),
        codec: video.codec_name || '',
        audioCodec: audio.codec_name || '',
        sampleRate: audio.sample_rate ? Number(audio.sample_rate) : null,
        channels: audio.channels != null ? Number(audio.channels) : null,
      },
    };
  } catch (err) {
    return { success: false, error: `Could not parse ffprobe output: ${err.message}` };
  }
}

module.exports = {
  probeVideo,
  checkFfprobeAvailability,
};
