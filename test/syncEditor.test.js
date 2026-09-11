'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { renderCompTake, parseWavFile } = require('../src/services/audio/compTakeRenderer');
const { updateTake } = require('../src/core/projectState');

const SAMPLE_RATE = 48000;

function wavHeader(dataBytes) {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 3, 28);
  buffer.writeUInt16LE(3, 32);
  buffer.writeUInt16LE(24, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function writeConstantWav(filePath, seconds, sampleValue) {
  const sampleCount = Math.round(seconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(sampleCount * 3);
  for (let index = 0; index < sampleCount; index += 1) {
    pcm.writeIntLE(sampleValue, index * 3, 3);
  }
  fs.writeFileSync(filePath, Buffer.concat([wavHeader(pcm.length), pcm]));
}

function read24BitSample(filePath, seconds) {
  const info = parseWavFile(filePath);
  const fd = fs.openSync(filePath, 'r');
  try {
    const sample = Buffer.alloc(3);
    fs.readSync(fd, sample, 0, 3, info.dataOffset + Math.round(seconds * SAMPLE_RATE) * 3);
    return sample.readIntLE(0, 3);
  } finally {
    fs.closeSync(fd);
  }
}

test('renderCompTake writes promoted regions into a normal created-take WAV', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'post-adr-comp-'));
  try {
    const sourceA = path.join(tempRoot, 'take-a.wav');
    const sourceB = path.join(tempRoot, 'take-b.wav');
    writeConstantWav(sourceA, 1, 1200000);
    writeConstantWav(sourceB, 1, -1200000);
    const cue = { cueId: 'cue-1', cueNumber: 'ADR-001', inFrames: 0, outFrames: 50 };
    const project = {
      settings: { frameRate: 25 },
      takes: [
        { takeId: 'take-a', cueId: 'cue-1', filePath: sourceA, durationSecs: 1, tracks: [], syncEdit: { laneOffsets: {} } },
        { takeId: 'take-b', cueId: 'cue-1', filePath: sourceB, durationSecs: 1, tracks: [], syncEdit: { laneOffsets: {} } },
      ],
    };

    const rendered = renderCompTake({
      project,
      cue,
      takeNumber: 3,
      projectMediaPath: tempRoot,
      segments: [
        { sourceTakeId: 'take-a', sourceLaneId: 'mic1', sourceStartSecs: 0, timelineStartSecs: 0, durationSecs: 0.5 },
        { sourceTakeId: 'take-b', sourceLaneId: 'mic1', sourceStartSecs: 0.25, timelineStartSecs: 0.5, durationSecs: 0.5 },
      ],
    });

    assert.equal(rendered.tracks.length, 1);
    assert.match(rendered.filePath, /take_003_created\.wav$/);
    assert.equal(parseWavFile(rendered.filePath).dataSize, 2 * SAMPLE_RATE * 3);
    assert.ok(read24BitSample(rendered.filePath, 0.25) > 0);
    assert.ok(read24BitSample(rendered.filePath, 0.75) < 0);
    assert.equal(read24BitSample(rendered.filePath, 1.5), 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('updateTake changes only the requested take and preserves the input project', () => {
  const project = {
    updatedAt: 'before',
    takes: [
      { takeId: 'take-a', syncEdit: { offsetSecs: 0 } },
      { takeId: 'take-b', syncEdit: { offsetSecs: 0 } },
    ],
  };
  const result = updateTake(project, 'take-a', { syncEdit: { offsetSecs: 0.125 } });
  assert.equal(project.takes[0].syncEdit.offsetSecs, 0);
  assert.equal(result.project.takes[0].syncEdit.offsetSecs, 0.125);
  assert.equal(result.project.takes[1].syncEdit.offsetSecs, 0);
  assert.notEqual(result.project.updatedAt, 'before');
});
