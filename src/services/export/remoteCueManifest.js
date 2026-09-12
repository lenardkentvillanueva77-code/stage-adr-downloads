'use strict';

const { framesToProjectTimecode, getProjectStartFrameOffset } = require('../../core/timecode');

const MANIFEST_SCHEMA = 'post-adr-remote-cue-manifest-v1';
const REMOTE_MEDIA_MODE = 'cue-proxy';

function safe(value) {
  return value == null ? '' : String(value);
}

function csvCell(value) {
  const text = safe(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

function buildLookup(items, key) {
  return new Map((items || []).map(item => [item[key], item]));
}

function getFrameRate(project) {
  return project.settings?.frameRate || project.video?.frameRate || '25';
}

function cueDurationFrames(cue) {
  return Math.max(0, Number(cue.outFrames || 0) - Number(cue.inFrames || 0));
}

function buildRemoteCueRows(project) {
  const frameRate = getFrameRate(project);
  const startFrameOffset = getProjectStartFrameOffset(project, frameRate);
  const characters = buildLookup(project.characters, 'characterId');
  const actors = buildLookup(project.actors, 'actorId');

  return [...(project.cues || [])]
    .sort((a, b) => Number(a.inFrames || 0) - Number(b.inFrames || 0))
    .map((cue) => {
      const character = characters.get(cue.characterId) || {};
      const actor = cue.actorId ? actors.get(cue.actorId) : null;
      const actorEmail = actor?.email || '';
      const remoteEligible = !!actorEmail;

      return {
        cueId: cue.cueId,
        cueNumber: cue.cueNumber || '',
        characterId: cue.characterId || '',
        characterName: character.name || '',
        actorId: actor?.actorId || null,
        actorName: actor?.name || '',
        actorEmail,
        dialogue: cue.dialogue || '',
        notes: cue.notes || '',
        status: cue.status || 'open',
        sourceTimeline: {
          frameRate,
          inFrames: Number(cue.inFrames || 0),
          outFrames: Number(cue.outFrames || 0),
          durationFrames: cueDurationFrames(cue),
          startFrameOffset,
          startTimecode: project.settings?.startTimecode || framesToProjectTimecode(0, frameRate, startFrameOffset),
          inTimecode: framesToProjectTimecode(Number(cue.inFrames || 0), frameRate, startFrameOffset),
          outTimecode: framesToProjectTimecode(Number(cue.outFrames || 0), frameRate, startFrameOffset),
        },
        remote: {
          eligible: remoteEligible,
          assignmentSource: cue.actorId ? 'cue.actorId' : 'unassigned',
          cloudProjectId: null,
          cloudCueId: null,
          accessEmail: actorEmail || null,
          mediaMode: REMOTE_MEDIA_MODE,
          proxyFile: null,
          proxyHash: null,
          proxyCueInFrames: null,
          proxyCueOutFrames: null,
          proxyPreRollFrames: null,
          proxyPostRollFrames: null,
        },
        warnings: remoteEligible ? [] : ['Cue has no assigned actor email.'],
      };
    });
}

function buildRemoteCueManifest(project) {
  const frameRate = getFrameRate(project);
  const cues = buildRemoteCueRows(project);
  const remoteCueCount = cues.filter(cue => cue.remote.eligible).length;
  const unassignedCueCount = cues.length - remoteCueCount;

  return {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    purpose: 'remote-actor-cue-assignment',
    project: {
      projectId: project.projectId || '',
      projectName: project.projectName || '',
      filmTitle: project.filmTitle || '',
      schemaVersion: project.schemaVersion || '',
      appVersion: project.appVersion || '',
      frameRate,
      startTimecode: project.settings?.startTimecode || framesToProjectTimecode(0, frameRate, getProjectStartFrameOffset(project, frameRate)),
      startFrameOffset: getProjectStartFrameOffset(project, frameRate),
      sampleRate: project.settings?.sampleRate || '',
      bitDepth: project.settings?.bitDepth || '',
      video: project.video ? {
        fileName: project.video.fileName || '',
        durationSeconds: project.video.durationSeconds || null,
        frameRate: project.video.frameRate || '',
        width: project.video.width || null,
        height: project.video.height || null,
      } : null,
    },
    remoteMediaPlan: {
      mode: REMOTE_MEDIA_MODE,
      proxyGenerated: false,
      proxyRule: 'Future cue proxies should map proxy cue-in/out frames back to sourceTimeline in/out frames.',
    },
    summary: {
      actors: (project.actors || []).length,
      cues: cues.length,
      remoteEligibleCues: remoteCueCount,
      unassignedCues: unassignedCueCount,
    },
    actors: (project.actors || []).map(actor => ({
      actorId: actor.actorId,
      name: actor.name || '',
      email: actor.email || '',
      remoteEnabled: !!actor.remoteEnabled,
    })),
    cues,
  };
}

function generateRemoteCueManifestJson({ project }) {
  return Buffer.from(JSON.stringify(buildRemoteCueManifest(project), null, 2), 'utf8');
}

function generateRemoteCueManifestCsv({ project }) {
  const rows = buildRemoteCueRows(project);
  const headers = [
    'Remote Eligible',
    'Actor Email',
    'Actor',
    'Character',
    'Cue',
    'In TC',
    'Out TC',
    'In Frames',
    'Out Frames',
    'Duration Frames',
    'Status',
    'Dialogue',
    'Notes',
    'Cue ID',
    'Actor ID',
    'Character ID',
    'Media Mode',
    'Proxy File',
    'Cloud Cue ID',
    'Warnings',
  ];

  const lines = [csvRow(headers)];
  for (const item of rows) {
    lines.push(csvRow([
      item.remote.eligible ? 'YES' : 'NO',
      item.actorEmail,
      item.actorName,
      item.characterName,
      item.cueNumber,
      item.sourceTimeline.inTimecode,
      item.sourceTimeline.outTimecode,
      item.sourceTimeline.inFrames,
      item.sourceTimeline.outFrames,
      item.sourceTimeline.durationFrames,
      item.status,
      item.dialogue,
      item.notes,
      item.cueId,
      item.actorId || '',
      item.characterId,
      item.remote.mediaMode,
      item.remote.proxyFile || '',
      item.remote.cloudCueId || '',
      item.warnings.join('; '),
    ]));
  }

  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  return Buffer.concat([bom, Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

module.exports = {
  buildRemoteCueManifest,
  buildRemoteCueRows,
  generateRemoteCueManifestCsv,
  generateRemoteCueManifestJson,
};
