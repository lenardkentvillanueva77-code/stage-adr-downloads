'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  framesToProjectTimecode,
  getProjectStartFrameOffset,
} = require('../src/core/timecode');
const { generateCueSheetCsv } = require('../src/services/export/cueSheetCsv');
const { buildRemoteCueManifest } = require('../src/services/export/remoteCueManifest');

function sampleProject() {
  return {
    projectId: 'project-1',
    projectName: 'Offset Session',
    filmTitle: 'Offset Film',
    schemaVersion: '1.1.0',
    appVersion: '1.3.0-alpha.1',
    settings: {
      frameRate: '25',
      sampleRate: '48000',
      bitDepth: '24',
      startTimecode: '00:59:50:00',
      startFrameOffset: 89750,
    },
    characters: [{ characterId: 'char-1', name: 'Mina' }],
    actors: [],
    cues: [{
      cueId: 'cue-1',
      cueNumber: 'ADR-001',
      characterId: 'char-1',
      inFrames: 25,
      outFrames: 75,
      dialogue: 'Production timecode, media frame timing.',
      notes: '',
      status: 'open',
    }],
    takes: [],
  };
}

test('framesToProjectTimecode applies display offset without changing media frames', () => {
  const project = sampleProject();
  const offset = getProjectStartFrameOffset(project, '25');

  assert.equal(offset, 89750);
  assert.equal(framesToProjectTimecode(0, '25', offset), '00:59:50:00');
  assert.equal(framesToProjectTimecode(25, '25', offset), '00:59:51:00');
});

test('cue sheet CSV exports production timecode and raw cue frames stay unchanged', () => {
  const csv = generateCueSheetCsv({ project: sampleProject() }).toString('utf8');

  assert.match(csv, /"ADR-001","Mina","00:59:51:00","00:59:53:00"/);
});

test('remote manifest includes project start timecode and offset cue labels', () => {
  const manifest = buildRemoteCueManifest(sampleProject());

  assert.equal(manifest.project.startTimecode, '00:59:50:00');
  assert.equal(manifest.project.startFrameOffset, 89750);
  assert.equal(manifest.cues[0].sourceTimeline.inFrames, 25);
  assert.equal(manifest.cues[0].sourceTimeline.inTimecode, '00:59:51:00');
});
