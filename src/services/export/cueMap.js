'use strict';

const { createActor, validateEmail } = require('../../core/models/Actor');
const { createCharacter } = require('../../core/models/Character');
const { createCue, CUE_STATUSES } = require('../../core/models/Cue');
const { framesToProjectTimecode, getProjectStartFrameOffset } = require('../../core/timecode');
const { touchProject } = require('../../core/models/Project');

const CUE_MAP_SCHEMA = 'post-adr-cue-map-v1';

function parseFrameRate(value) {
  const text = String(value || '').trim();
  if (text.includes('/')) {
    const [numerator, denominator] = text.split('/').map(Number);
    if (numerator > 0 && denominator > 0) return numerator / denominator;
  }
  const parsed = Number(text);
  return parsed > 0 ? parsed : 0;
}

function nextCueNumber(cues) {
  let max = 0;
  for (const cue of cues || []) {
    const match = String(cue.cueNumber || '').match(/(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `ADR-${String(max + 1).padStart(3, '0')}`;
}

function buildCueMap(project, options = {}) {
  if (!project) throw new Error('No project is open.');
  const selectedIds = Array.isArray(options.cueIds) && options.cueIds.length
    ? new Set(options.cueIds)
    : null;
  const cues = (project.cues || []).filter(cue => !selectedIds || selectedIds.has(cue.cueId));
  if (!cues.length) throw new Error(selectedIds ? 'No selected cues are available.' : 'No cues are available.');

  const characterIds = new Set(cues.map(cue => cue.characterId).filter(Boolean));
  const actorIds = new Set(cues.map(cue => cue.actorId).filter(Boolean));
  const frameRate = project.settings?.frameRate || project.video?.frameRate || '25';
  const startFrameOffset = getProjectStartFrameOffset(project, frameRate);

  return {
    schema: CUE_MAP_SCHEMA,
    generatedAt: new Date().toISOString(),
    containsAudio: false,
    project: {
      projectId: project.projectId || '',
      projectName: project.projectName || '',
      filmTitle: project.filmTitle || '',
      frameRate: String(frameRate),
      startTimecode: project.settings?.startTimecode || framesToProjectTimecode(0, frameRate, startFrameOffset),
      startFrameOffset,
    },
    characters: (project.characters || [])
      .filter(character => characterIds.has(character.characterId))
      .map(character => ({
        characterId: character.characterId,
        name: character.name || '',
        description: character.description || '',
      })),
    actors: (project.actors || [])
      .filter(actor => actorIds.has(actor.actorId))
      .map(actor => ({ actorId: actor.actorId, name: actor.name || '', email: actor.email || '' })),
    cues: cues.map(cue => ({
      cueId: cue.cueId,
      cueNumber: cue.cueNumber || '',
      characterId: cue.characterId || '',
      actorId: cue.actorId || null,
      scene: cue.scene || '',
      dialogue: cue.dialogue || '',
      notes: cue.notes || '',
      status: cue.status || 'open',
      inFrames: cue.inFrames,
      outFrames: cue.outFrames,
      inTimecode: framesToProjectTimecode(cue.inFrames || 0, frameRate, startFrameOffset),
      outTimecode: framesToProjectTimecode(cue.outFrames || 0, frameRate, startFrameOffset),
      streamerTargetFrames: Array.isArray(cue.streamerTargetFrames)
        ? cue.streamerTargetFrames.slice()
        : (typeof cue.streamerStartFrames === 'number' ? [cue.streamerStartFrames] : []),
    })),
  };
}

function validateCueMap(cueMap) {
  if (!cueMap || typeof cueMap !== 'object') return 'Cue map must be a JSON object.';
  if (cueMap.schema !== CUE_MAP_SCHEMA) return `Unsupported cue map schema: ${cueMap.schema || 'missing'}.`;
  if (!Array.isArray(cueMap.cues) || !cueMap.cues.length) return 'Cue map contains no cues.';
  for (const cue of cueMap.cues) {
    if (!cue || typeof cue !== 'object') return 'Cue map contains an invalid cue.';
    if (!Number.isFinite(cue.inFrames) || !Number.isFinite(cue.outFrames) || cue.outFrames <= cue.inFrames) {
      return `Cue ${cue.cueNumber || cue.cueId || ''} has invalid frame bounds.`;
    }
  }
  return null;
}

function importCueMap(project, cueMap) {
  if (!project) throw new Error('No project is open.');
  const validationError = validateCueMap(cueMap);
  if (validationError) throw new Error(validationError);

  const sourceRate = parseFrameRate(cueMap.project?.frameRate);
  const targetRate = parseFrameRate(project.settings?.frameRate || project.video?.frameRate);
  if (sourceRate && targetRate && Math.abs(sourceRate - targetRate) > 0.001) {
    throw new Error(`Cue map frame rate ${cueMap.project.frameRate} does not match this project (${project.settings?.frameRate || project.video?.frameRate}).`);
  }

  const next = {
    ...project,
    settings: { ...(project.settings || {}) },
    characters: [...(project.characters || [])],
    actors: [...(project.actors || [])],
    cues: [...(project.cues || [])],
  };
  if (sourceRate && !targetRate) {
    next.settings.frameRate = String(cueMap.project?.frameRate || sourceRate);
    next.settings.startTimecode = cueMap.project?.startTimecode || next.settings.startTimecode || '00:00:00:00';
    next.settings.startFrameOffset = Math.max(0, Math.round(Number(cueMap.project?.startFrameOffset) || 0));
  }
  const characterIdMap = new Map();
  const actorIdMap = new Map();
  let charactersCreated = 0;
  let actorsCreated = 0;

  for (const source of cueMap.characters || []) {
    const name = String(source.name || '').trim();
    if (!name) continue;
    let character = next.characters.find(item => item.characterId === source.characterId)
      || next.characters.find(item => String(item.name || '').toLowerCase() === name.toLowerCase());
    if (!character) {
      character = createCharacter({ name, description: source.description || '' });
      next.characters.push(character);
      charactersCreated += 1;
    }
    characterIdMap.set(source.characterId, character.characterId);
  }

  for (const source of cueMap.actors || []) {
    const emailCheck = validateEmail(source.email || '');
    if (!emailCheck.valid) continue;
    let actor = next.actors.find(item => item.actorId === source.actorId)
      || next.actors.find(item => String(item.email || '').toLowerCase() === emailCheck.normalised);
    if (!actor) {
      actor = createActor({ name: source.name || emailCheck.normalised, email: emailCheck.normalised });
      next.actors.push(actor);
      actorsCreated += 1;
    }
    actorIdMap.set(source.actorId, actor.actorId);
  }

  const sourceProjectId = cueMap.project?.projectId || '';
  const existingImports = new Set(next.cues.map(cue => {
    const imported = cue.importedFrom || {};
    return imported.projectId && imported.cueId ? `${imported.projectId}:${imported.cueId}` : null;
  }).filter(Boolean));
  const usedCueNumbers = new Set(next.cues.map(cue => String(cue.cueNumber || '').toLowerCase()));
  let importedCount = 0;
  let skippedCount = 0;

  for (const source of cueMap.cues) {
    const importKey = sourceProjectId && source.cueId ? `${sourceProjectId}:${source.cueId}` : null;
    if (importKey && existingImports.has(importKey)) {
      skippedCount += 1;
      continue;
    }
    let characterId = characterIdMap.get(source.characterId);
    if (!characterId) {
      const fallbackName = String(source.characterName || 'UNASSIGNED').trim() || 'UNASSIGNED';
      let character = next.characters.find(item => String(item.name || '').toLowerCase() === fallbackName.toLowerCase());
      if (!character) {
        character = createCharacter({ name: fallbackName });
        next.characters.push(character);
        charactersCreated += 1;
      }
      characterId = character.characterId;
    }

    const requestedNumber = String(source.cueNumber || '').trim();
    const cueNumber = requestedNumber && !usedCueNumbers.has(requestedNumber.toLowerCase())
      ? requestedNumber
      : nextCueNumber(next.cues);
    usedCueNumbers.add(cueNumber.toLowerCase());
    const cue = createCue({
      projectId: next.projectId,
      characterId,
      cueNumber,
      scene: source.scene || '',
      dialogue: source.dialogue || '',
      notes: source.notes || '',
      inFrames: Math.max(0, Math.round(source.inFrames)),
      outFrames: Math.max(0, Math.round(source.outFrames)),
      streamerTargetFrames: Array.isArray(source.streamerTargetFrames) ? source.streamerTargetFrames : [],
      actorId: actorIdMap.get(source.actorId) || null,
    });
    cue.status = CUE_STATUSES.includes(source.status) ? source.status : 'open';
    cue.importedFrom = { projectId: sourceProjectId, cueId: source.cueId || null };
    next.cues.push(cue);
    if (importKey) existingImports.add(importKey);
    importedCount += 1;
  }

  return {
    project: touchProject(next),
    summary: { importedCount, skippedCount, charactersCreated, actorsCreated },
  };
}

module.exports = {
  CUE_MAP_SCHEMA,
  buildCueMap,
  importCueMap,
  validateCueMap,
};
