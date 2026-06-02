'use strict';

function safe(value) {
  return value == null ? '' : String(value);
}

function csvCell(value) {
  const text = safe(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function row(values) {
  return values.map(csvCell).join(',');
}

function buildRows(project) {
  const characters = project.characters || [];
  const actors = project.actors || [];
  const cues = project.cues || [];
  const takes = project.takes || [];
  const projectRecordingOffsetMs = project.settings?.workspace?.recordingOffsetMs;
  const projectStartOffsetSecs = typeof projectRecordingOffsetMs === 'number'
    ? projectRecordingOffsetMs / 1000
    : null;

  return takes.flatMap((take) => {
    const cue = cues.find(c => c.cueId === take.cueId) || {};
    const character = characters.find(c => c.characterId === cue.characterId) || {};
    const actor = actors.find(a => a.actorId === (take.actorId || cue.actorId)) || {};
    const tracks = Array.isArray(take.tracks) && take.tracks.length
      ? take.tracks
      : [{ laneId: 'mic1', label: 'Mic 1', filePath: take.filePath, durationSecs: take.durationSecs }];

    return tracks.map((track) => ({
      projectName: project.projectName || '',
      filmTitle: project.filmTitle || '',
      character: character.name || '',
      actor: actor.name || '',
      cueNumber: cue.cueNumber || take.cueNumber || '',
      cueInFrames: cue.inFrames ?? '',
      cueOutFrames: cue.outFrames ?? '',
      takeNumber: take.takeNumber,
      takeName: take.takeName || `T${String(take.takeNumber || '').padStart(2, '0')}`,
      goodTake: take.isSelected ? 'YES' : 'NO',
      laneId: track.laneId || '',
      trackName: track.trackName || track.label || '',
      physicalInput: track.physicalInput ?? '',
      filePath: track.filePath || '',
      archiveDirectory: take.archiveDirectory || '',
      durationSecs: track.durationSecs ?? take.durationSecs ?? '',
      startOffsetSecs: projectStartOffsetSecs ?? take.startOffsetSecs ?? '',
      recordingOffsetMs: projectRecordingOffsetMs ?? track.recordingOffsetMs ?? take.recordingOffsetMs ?? '',
      sampleRate: track.sampleRate ?? take.sampleRate ?? '',
      bitDepth: track.bitDepth ?? take.bitDepth ?? '',
      droppedBlocks: track.droppedBlocks ?? '',
      recordedAt: take.recordedAt || '',
      notes: take.notes || cue.notes || '',
      dialogue: cue.dialogue || '',
    }));
  });
}

function generateAdrSessionReportJson({ project }) {
  const payload = {
    reportType: 'adr-session-report',
    generatedAt: new Date().toISOString(),
    project: {
      projectId: project.projectId,
      projectName: project.projectName,
      filmTitle: project.filmTitle,
    },
    rows: buildRows(project),
  };

  return Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
}

function generateAdrSessionReportCsv({ project }) {
  const headers = [
    'Project',
    'Film',
    'Character',
    'Actor',
    'Cue',
    'In Frames',
    'Out Frames',
    'Take',
    'Take Name',
    'Good',
    'Lane',
    'Track Name',
    'Physical Input',
    'File Path',
    'Archive Directory',
    'Duration Secs',
    'Start Offset Secs',
    'Recording Offset Ms',
    'Sample Rate',
    'Bit Depth',
    'Dropped Blocks',
    'Recorded At',
    'Notes',
    'Dialogue',
  ];

  const lines = [row(headers)];
  for (const item of buildRows(project)) {
    lines.push(row([
      item.projectName,
      item.filmTitle,
      item.character,
      item.actor,
      item.cueNumber,
      item.cueInFrames,
      item.cueOutFrames,
      item.takeNumber,
      item.takeName,
      item.goodTake,
      item.laneId,
      item.trackName,
      item.physicalInput,
      item.filePath,
      item.archiveDirectory,
      item.durationSecs,
      item.startOffsetSecs,
      item.recordingOffsetMs,
      item.sampleRate,
      item.bitDepth,
      item.droppedBlocks,
      item.recordedAt,
      item.notes,
      item.dialogue,
    ]));
  }

  return Buffer.from(lines.join('\n'), 'utf8');
}

module.exports = {
  generateAdrSessionReportCsv,
  generateAdrSessionReportJson,
};
