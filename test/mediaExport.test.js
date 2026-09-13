'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateWaveformPeaks } = require('../src/services/media/ffmpeg');
const { buildCueVideoArgs } = require('../src/services/export/cueVideo');

function write16BitWav(filePath) {
  const samples = Buffer.alloc(4800 * 2);
  for (let index = 0; index < 4800; index += 1) {
    samples.writeInt16LE(index < 2400 ? 12000 : -12000, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, samples]));
}

test('take waveform generation returns a bounded set of real peaks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-adr-wave-'));
  try {
    const wavPath = path.join(root, 'take.wav');
    write16BitWav(wavPath);
    const result = generateWaveformPeaks({ wavPath, peakBuckets: 120 });
    assert.equal(result.success, true);
    assert.ok(result.peaks.peaks.length <= 120);
    assert.ok(result.peaks.peaks.some(peak => peak > 0.3));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cue video export uses exact duration re-encoding and keeps optional audio', () => {
  const args = buildCueVideoArgs({
    videoPath: 'picture.mov',
    startSeconds: 10,
    durationSeconds: 2.5,
    outputPath: 'cue.mp4',
  });
  assert.deepEqual(args.slice(0, 7), ['-y', '-ss', '10.000000', '-i', 'picture.mov', '-t', '2.500000']);
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('yuv420p'));
  assert.ok(args.includes('0:a?'));
  assert.equal(args.at(-1), 'cue.mp4');
});
