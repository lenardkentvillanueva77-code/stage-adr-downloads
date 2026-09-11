'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PEAK_BUCKETS = 20000;

function resolveFfmpegPath() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) return ffmpegStatic;
  } catch {}
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function checkFfmpegAvailability() {
  const ffmpegPath = resolveFfmpegPath();
  const isBundledPath = /[\\/]/.test(ffmpegPath);
  return {
    available: !isBundledPath || fs.existsSync(ffmpegPath),
    path: ffmpegPath,
    source: isBundledPath ? 'ffmpeg-static' : 'system',
  };
}

function getMediaFolder(projectFilePath) {
  const dir = path.dirname(projectFilePath);
  const base = path.basename(projectFilePath, path.extname(projectFilePath));
  return path.join(dir, `${base}.media`);
}

function ensureMediaFolder(mediaFolder) {
  fs.mkdirSync(mediaFolder, { recursive: true });
  return mediaFolder;
}

function parseFfmpegProgress(line) {
  const match = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  if (!match) return null;
  const [, hh, mm, ss] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
}

function extractGuideAudio({ videoPath, outputPath, onProgress }) {
  return new Promise((resolve) => {
    if (!videoPath || !fs.existsSync(videoPath)) {
      resolve({ success: false, error: 'Video file not found.' });
      return;
    }

    const args = [
      '-y',
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', '48000',
      '-acodec', 'pcm_s16le',
      outputPath,
    ];
    const child = execFile(resolveFfmpegPath(), args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr?.trim() || error.message });
        return;
      }
      onProgress?.(100);
      resolve({ success: true, outputPath });
    });

    child.stderr?.on('data', (chunk) => {
      const seconds = parseFfmpegProgress(String(chunk));
      if (seconds != null) onProgress?.(Math.max(1, Math.min(99, Math.round(seconds))));
    });
  });
}

function readFourCC(buffer, offset) {
  return buffer.toString('ascii', offset, offset + 4);
}

function parseWavFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    if (readFourCC(header, 0) !== 'RIFF' || readFourCC(header, 8) !== 'WAVE') {
      throw new Error('Not a RIFF/WAVE file.');
    }

    let position = 12;
    let fmt = null;
    let data = null;
    const chunkHeader = Buffer.alloc(8);

    while (fs.readSync(fd, chunkHeader, 0, 8, position) === 8) {
      const id = readFourCC(chunkHeader, 0);
      const size = chunkHeader.readUInt32LE(4);
      const payloadPosition = position + 8;

      if (id === 'fmt ') {
        const fmtBuffer = Buffer.alloc(size);
        fs.readSync(fd, fmtBuffer, 0, size, payloadPosition);
        fmt = {
          audioFormat: fmtBuffer.readUInt16LE(0),
          channels: fmtBuffer.readUInt16LE(2),
          sampleRate: fmtBuffer.readUInt32LE(4),
          bitsPerSample: fmtBuffer.readUInt16LE(14),
        };
      } else if (id === 'data') {
        data = { offset: payloadPosition, size };
        break;
      }

      position = payloadPosition + size + (size % 2);
    }

    if (!fmt || !data) throw new Error('WAV fmt/data chunk missing.');
    if (fmt.audioFormat !== 1) throw new Error('Only PCM WAV files are supported.');
    if (![16, 24, 32].includes(fmt.bitsPerSample)) throw new Error(`Unsupported bit depth ${fmt.bitsPerSample}.`);
    return { ...fmt, dataOffset: data.offset, dataSize: data.size };
  } finally {
    fs.closeSync(fd);
  }
}

function readSample(buffer, offset, bitsPerSample) {
  if (bitsPerSample === 16) return buffer.readInt16LE(offset) / 32768;
  if (bitsPerSample === 24) return buffer.readIntLE(offset, 3) / 8388608;
  return buffer.readInt32LE(offset) / 2147483648;
}

function generateWaveformPeaks({ wavPath, onProgress }) {
  try {
    if (!wavPath || !fs.existsSync(wavPath)) {
      return { success: false, error: 'Guide audio WAV not found.' };
    }

    const info = parseWavFile(wavPath);
    const bytesPerSample = info.bitsPerSample / 8;
    const frameBytes = bytesPerSample * info.channels;
    const totalFrames = Math.floor(info.dataSize / frameBytes);
    const peakCount = Math.max(1, Math.min(PEAK_BUCKETS, totalFrames));
    const framesPerPeak = Math.max(1, Math.ceil(totalFrames / peakCount));
    const peaks = [];
    const fd = fs.openSync(wavPath, 'r');

    try {
      const chunkFrames = Math.max(framesPerPeak, 4096);
      const buffer = Buffer.alloc(chunkFrames * frameBytes);
      let framesReadTotal = 0;
      let bucketMax = 0;
      let bucketFrames = 0;

      while (framesReadTotal < totalFrames) {
        const framesToRead = Math.min(chunkFrames, totalFrames - framesReadTotal);
        const bytesToRead = framesToRead * frameBytes;
        const position = info.dataOffset + framesReadTotal * frameBytes;
        fs.readSync(fd, buffer, 0, bytesToRead, position);

        for (let frame = 0; frame < framesToRead; frame += 1) {
          let frameMax = 0;
          for (let ch = 0; ch < info.channels; ch += 1) {
            const sampleOffset = frame * frameBytes + ch * bytesPerSample;
            frameMax = Math.max(frameMax, Math.abs(readSample(buffer, sampleOffset, info.bitsPerSample)));
          }
          bucketMax = Math.max(bucketMax, frameMax);
          bucketFrames += 1;
          if (bucketFrames >= framesPerPeak) {
            peaks.push(Math.min(1, bucketMax));
            bucketMax = 0;
            bucketFrames = 0;
          }
        }

        framesReadTotal += framesToRead;
        onProgress?.(Math.min(99, Math.round((framesReadTotal / totalFrames) * 100)));
      }

      if (bucketFrames > 0) peaks.push(Math.min(1, bucketMax));
    } finally {
      fs.closeSync(fd);
    }

    onProgress?.(100);
    return {
      success: true,
      peaks: {
        durationSeconds: totalFrames / info.sampleRate,
        sampleRate: info.sampleRate,
        channels: info.channels,
        samplesPerPeak: framesPerPeak,
        peaks,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function writePeaksFile(peaks, peaksPath) {
  try {
    fs.writeFileSync(peaksPath, Buffer.from(JSON.stringify(peaks), 'utf8'));
    return { success: true, peaksPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function readPeaksFile(peaksPath) {
  try {
    return { success: true, peaks: JSON.parse(fs.readFileSync(peaksPath, 'utf8')) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  getMediaFolder,
  ensureMediaFolder,
  extractGuideAudio,
  generateWaveformPeaks,
  writePeaksFile,
  readPeaksFile,
  checkFfmpegAvailability,
};
