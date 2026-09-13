'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildCueMap, importCueMap, CUE_MAP_SCHEMA } = require('../src/services/export/cueMap');

function project(overrides = {}) {
  return {
    projectId: 'project-a',
    projectName: 'Source',
    filmTitle: 'Film',
    updatedAt: 'before',
    settings: { frameRate: '25', startTimecode: '00:59:50:00', startFrameOffset: 89750 },
    characters: [{ characterId: 'char-a', name: 'MINA', description: 'Lead' }],
    actors: [],
    cues: [{
      cueId: 'cue-a',
      projectId: 'project-a',
      cueNumber: 'ADR-001',
      characterId: 'char-a',
      actorId: null,
      scene: '12',
      dialogue: 'Line',
      notes: 'Note',
      status: 'open',
      inFrames: 25,
      outFrames: 75,
      streamerTargetFrames: [50],
    }],
    takes: [{ takeId: 'take-a', cueId: 'cue-a', filePath: 'never-export-this.wav' }],
    ...overrides,
  };
}

test('cue map exports timing and character data without take audio', () => {
  const cueMap = buildCueMap(project());
  assert.equal(cueMap.schema, CUE_MAP_SCHEMA);
  assert.equal(cueMap.containsAudio, false);
  assert.equal(cueMap.cues[0].inTimecode, '00:59:51:00');
  assert.equal(cueMap.cues[0].outTimecode, '00:59:53:00');
  assert.equal(cueMap.cues[0].streamerTargetFrames[0], 50);
  assert.equal(JSON.stringify(cueMap).includes('never-export-this.wav'), false);
});

test('cue map import appends cues, creates characters, and skips the same source cue on reimport', () => {
  const cueMap = buildCueMap(project());
  const target = project({
    projectId: 'project-b',
    projectName: 'Target',
    characters: [],
    cues: [],
    takes: [],
  });
  const first = importCueMap(target, cueMap);
  assert.equal(first.summary.importedCount, 1);
  assert.equal(first.summary.charactersCreated, 1);
  assert.equal(first.project.cues[0].inFrames, 25);
  assert.equal(first.project.cues[0].projectId, 'project-b');
  assert.equal(first.project.takes.length, 0);

  const second = importCueMap(first.project, cueMap);
  assert.equal(second.summary.importedCount, 0);
  assert.equal(second.summary.skippedCount, 1);
  assert.equal(second.project.cues.length, 1);
});

test('cue map import rejects a different frame rate', () => {
  const cueMap = buildCueMap(project());
  const target = project({ projectId: 'project-b', settings: { frameRate: '24' }, cues: [], takes: [] });
  assert.throws(() => importCueMap(target, cueMap), /does not match/);
});
