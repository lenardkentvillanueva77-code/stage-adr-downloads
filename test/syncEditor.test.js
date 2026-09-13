'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { renderCompTake, parseWavFile } = require('../src/services/audio/compTakeRenderer');
const { updateTake, shiftCueTakeSyncOffsets, setTakeSelected } = require('../src/core/projectState');
const { relinkProjectFiles } = require('../src/services/media/relinkProjectFiles');
const { exportGoodTakesPackage } = require('../src/services/export/goodTakesPackage');

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

test('marking another good take keeps earlier good takes selected for later exports', () => {
  const project = {
    updatedAt: 'before',
    cues: [{ cueId: 'cue-1', status: 'open' }],
    takes: [
      { takeId: 'take-a', cueId: 'cue-1', rating: 'none', isSelected: true },
      { takeId: 'take-b', cueId: 'cue-1', rating: 'none', isSelected: false },
    ],
  };
  const result = setTakeSelected(project, 'cue-1', 'take-b', true);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.project.takes.map(take => take.isSelected), [true, true]);
  assert.deepEqual(project.takes.map(take => take.isSelected), [true, false]);
});

test('a second good-takes export includes a take marked after the first export', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'post-adr-good-export-'));
  try {
    const sourceA = path.join(tempRoot, 'take-a.wav');
    const sourceB = path.join(tempRoot, 'take-b.wav');
    writeConstantWav(sourceA, 0.1, 800000);
    writeConstantWav(sourceB, 0.1, -800000);
    const base = {
      projectId: 'project-1',
      projectName: 'Second Pass',
      filmTitle: 'Film',
      settings: { frameRate: '25', startTimecode: '00:00:00:00', startFrameOffset: 0, workspace: { recordingOffsetMs: 0 } },
      video: { durationSeconds: 0.2 },
      characters: [{ characterId: 'char-1', name: 'MINA' }],
      actors: [],
      cues: [{ cueId: 'cue-1', cueNumber: 'ADR-001', characterId: 'char-1', inFrames: 0, outFrames: 5, status: 'recorded' }],
      takes: [
        { takeId: 'take-a', cueId: 'cue-1', takeNumber: 1, filePath: sourceA, durationSecs: 0.1, startOffsetSecs: 0, rating: 'none', isSelected: true, tracks: [] },
        { takeId: 'take-b', cueId: 'cue-1', takeNumber: 2, filePath: sourceB, durationSecs: 0.1, startOffsetSecs: 0.1, rating: 'none', isSelected: false, tracks: [] },
      ],
    };

    const first = exportGoodTakesPackage({ project: base, destinationRoot: tempRoot });
    assert.equal(first.placements.length, 1);
    const marked = setTakeSelected(base, 'cue-1', 'take-b', true).project;
    const second = exportGoodTakesPackage({ project: marked, destinationRoot: tempRoot });
    assert.deepEqual(second.placements.map(item => item.takeId).sort(), ['take-a', 'take-b']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('shiftCueTakeSyncOffsets changes only takes for the edited cue', () => {
  const project = {
    updatedAt: 'before',
    takes: [
      {
        takeId: 'take-a',
        cueId: 'cue-1',
        syncEdit: { offsetSecs: 0.25, trimStartSecs: 0.1, trimEndSecs: 0.2, laneOffsets: { mic2: 0.03 } },
      },
      {
        takeId: 'take-b',
        cueId: 'cue-2',
        syncEdit: { offsetSecs: 1, trimStartSecs: 0, trimEndSecs: 0, laneOffsets: {} },
      },
    ],
  };

  const result = shiftCueTakeSyncOffsets(project, 'cue-1', -2);
  assert.equal(project.takes[0].syncEdit.offsetSecs, 0.25);
  assert.equal(result.takes[0].syncEdit.offsetSecs, -1.75);
  assert.equal(result.takes[0].syncEdit.trimStartSecs, 0.1);
  assert.equal(result.takes[0].syncEdit.laneOffsets.mic2, 0.03);
  assert.equal(result.takes[1].syncEdit.offsetSecs, 1);
  assert.notEqual(result.updatedAt, 'before');
});

test('relinkProjectFiles reconnects missing video, take, and mic-track paths', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'post-adr-relink-'));
  try {
    const oldRoot = path.join(tempRoot, 'old-station');
    const mediaRoot = path.join(tempRoot, 'new-station-media');
    fs.mkdirSync(mediaRoot, { recursive: true });
    const videoPath = path.join(mediaRoot, 'picture.mov');
    const takePath = path.join(mediaRoot, 'take_001.wav');
    const trackPath = path.join(mediaRoot, 'take_001_boom.wav');
    fs.writeFileSync(videoPath, '');
    fs.writeFileSync(takePath, '');
    fs.writeFileSync(trackPath, '');

    const project = {
      updatedAt: 'before',
      video: {
        fileName: 'picture.mov',
        localPath: path.join(oldRoot, 'picture.mov'),
      },
      takes: [
        {
          takeId: 'take-1',
          cueId: 'cue-1',
          takeNumber: 1,
          filePath: path.join(oldRoot, 'take_001.wav'),
          archiveDirectory: path.join(oldRoot, 'ADR-001'),
          tracks: [
            { laneId: 'mic1', label: 'Boom', filePath: path.join(oldRoot, 'take_001_boom.wav') },
          ],
        },
      ],
    };

    const result = relinkProjectFiles(project, mediaRoot);
    assert.equal(result.changed, true);
    assert.equal(result.summary.relinked, 3);
    assert.equal(result.project.video.localPath, videoPath);
    assert.equal(result.project.takes[0].filePath, takePath);
    assert.equal(result.project.takes[0].tracks[0].filePath, trackPath);
    assert.equal(result.project.takes[0].archiveDirectory, mediaRoot);
    assert.equal(project.video.localPath, path.join(oldRoot, 'picture.mov'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
