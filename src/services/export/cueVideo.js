'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const { resolveFfmpegPath } = require('../media/ffmpeg');

function buildCueVideoArgs({ videoPath, startSeconds, durationSeconds, outputPath }) {
  return [
    '-y',
    '-ss', Number(startSeconds).toFixed(6),
    '-i', videoPath,
    '-t', Number(durationSeconds).toFixed(6),
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ];
}

function exportCueVideo({ videoPath, startSeconds, durationSeconds, outputPath }) {
  return new Promise((resolve, reject) => {
    if (!videoPath || !fs.existsSync(videoPath)) {
      reject(new Error('Linked project video was not found. Relink the video first.'));
      return;
    }
    if (!(Number(durationSeconds) > 0)) {
      reject(new Error('Cue duration must be greater than zero.'));
      return;
    }
    const args = buildCueVideoArgs({ videoPath, startSeconds, durationSeconds, outputPath });
    execFile(resolveFfmpegPath(), args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolve({ filePath: outputPath });
    });
  });
}

module.exports = { buildCueVideoArgs, exportCueVideo };
