'use strict';

const fs = require('fs');
const path = require('path');

const { buildAdrSessionRows } = require('./adrSessionReport');
const { framesToSeconds, framesToTimecode, secondsToFrames } = require('../../core/timecode');

const DEFAULT_SAMPLE_RATE = 48000;
const OUTPUT_BIT_DEPTH = 24;
const OUTPUT_CHANNELS = 1;
const OUTPUT_BYTES_PER_SAMPLE = OUTPUT_BIT_DEPTH / 8;
const SILENCE_CHUNK_BYTES = 1024 * 1024;

function safeName(value, fallback = 'Untitled') {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || fallback;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

function formatSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds.toFixed(3) : '';
}

function ensureUniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let index = 2;
  let candidate = path.join(dir, `${base}_${index}${ext}`);
  while (fs.existsSync(candidate)) {
    index += 1;
    candidate = path.join(dir, `${base}_${index}${ext}`);
  }
  return candidate;
}

function getTakeTracks(take) {
  return Array.isArray(take.tracks) && take.tracks.length
    ? take.tracks
    : [{ laneId: 'mic1', label: 'Mic 1', trackName: 'Mic 1', filePath: take.filePath, durationSecs: take.durationSecs }];
}

function getTrackLaneIdentity(track) {
  const laneId = String(track?.laneId || '').trim();
  if (laneId) return laneId;
  const trackName = String(track?.trackName || track?.label || '').trim();
  if (trackName) return `named:${trackName}`;
  const filePath = String(track?.filePath || '').trim();
  if (filePath) return `file:${filePath}`;
  return 'lane:unknown';
}

function buildLookup(project) {
  const cues = new Map((project.cues || []).map(cue => [cue.cueId, cue]));
  const characters = new Map((project.characters || []).map(character => [character.characterId, character]));
  const actors = new Map((project.actors || []).map(actor => [actor.actorId, actor]));
  return { cues, characters, actors };
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

    if (!fmt) throw new Error('WAV fmt chunk missing.');
    if (!data) throw new Error('WAV data chunk missing.');
    if (fmt.audioFormat !== 1) throw new Error(`Unsupported WAV format ${fmt.audioFormat}; PCM required.`);
    if (![16, 24, 32].includes(fmt.bitsPerSample)) throw new Error(`Unsupported bit depth ${fmt.bitsPerSample}.`);
    if (fmt.channels < 1) throw new Error('WAV has no channels.');

    return { ...fmt, dataOffset: data.offset, dataSize: data.size };
  } finally {
    fs.closeSync(fd);
  }
}

function buildWavHeader(dataByteCount, sampleRate = DEFAULT_SAMPLE_RATE) {
  const byteRate = sampleRate * OUTPUT_CHANNELS * OUTPUT_BYTES_PER_SAMPLE;
  const blockAlign = OUTPUT_CHANNELS * OUTPUT_BYTES_PER_SAMPLE;
  const buffer = Buffer.alloc(44);
  let offset = 0;
  buffer.write('RIFF', offset); offset += 4;
  buffer.writeUInt32LE(36 + dataByteCount, offset); offset += 4;
  buffer.write('WAVE', offset); offset += 4;
  buffer.write('fmt ', offset); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4;
  buffer.writeUInt16LE(1, offset); offset += 2;
  buffer.writeUInt16LE(OUTPUT_CHANNELS, offset); offset += 2;
  buffer.writeUInt32LE(sampleRate, offset); offset += 4;
  buffer.writeUInt32LE(byteRate, offset); offset += 4;
  buffer.writeUInt16LE(blockAlign, offset); offset += 2;
  buffer.writeUInt16LE(OUTPUT_BIT_DEPTH, offset); offset += 2;
  buffer.write('data', offset); offset += 4;
  buffer.writeUInt32LE(dataByteCount, offset);
  return buffer;
}

function createSilentWav(filePath, totalSamples, sampleRate) {
  const dataByteCount = totalSamples * OUTPUT_BYTES_PER_SAMPLE;
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, buildWavHeader(dataByteCount, sampleRate));
    const silence = Buffer.alloc(SILENCE_CHUNK_BYTES);
    let remaining = dataByteCount;
    while (remaining > 0) {
      const bytes = Math.min(remaining, silence.length);
      fs.writeSync(fd, silence, 0, bytes);
      remaining -= bytes;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readSourceSample(buffer, offset, bitsPerSample) {
  if (bitsPerSample === 16) return buffer.readInt16LE(offset) << 8;
  if (bitsPerSample === 24) return buffer.readIntLE(offset, 3);
  return buffer.readInt32LE(offset) >> 8;
}

function writeOutputSample(buffer, offset, value) {
  const clipped = Math.max(-8388608, Math.min(8388607, Math.round(value)));
  buffer.writeIntLE(clipped, offset, 3);
}

function mixPcmIntoStem({ stemPath, sourcePath, sourceInfo, startSample, totalSamples }) {
  if (sourceInfo.sampleRate !== DEFAULT_SAMPLE_RATE) {
    throw new Error(`Source sample rate ${sourceInfo.sampleRate} does not match export sample rate ${DEFAULT_SAMPLE_RATE}.`);
  }

  const sourceBytesPerSample = sourceInfo.bitsPerSample / 8;
  const sourceFrameBytes = sourceBytesPerSample * sourceInfo.channels;
  const sourceSamples = Math.floor(sourceInfo.dataSize / sourceFrameBytes);
  const writableSamples = Math.max(0, Math.min(sourceSamples, totalSamples - startSample));
  if (writableSamples <= 0) return 0;

  const sourceFd = fs.openSync(sourcePath, 'r');
  const destFd = fs.openSync(stemPath, 'r+');
  try {
    const chunkSamples = Math.min(32768, writableSamples);
    const sourceBuffer = Buffer.alloc(chunkSamples * sourceFrameBytes);
    const destBuffer = Buffer.alloc(chunkSamples * OUTPUT_BYTES_PER_SAMPLE);
    let samplesWritten = 0;

    while (samplesWritten < writableSamples) {
      const samplesThisChunk = Math.min(chunkSamples, writableSamples - samplesWritten);
      const sourceBytes = samplesThisChunk * sourceFrameBytes;
      const destBytes = samplesThisChunk * OUTPUT_BYTES_PER_SAMPLE;
      const sourcePosition = sourceInfo.dataOffset + samplesWritten * sourceFrameBytes;
      const destPosition = 44 + (startSample + samplesWritten) * OUTPUT_BYTES_PER_SAMPLE;

      fs.readSync(sourceFd, sourceBuffer, 0, sourceBytes, sourcePosition);
      fs.readSync(destFd, destBuffer, 0, destBytes, destPosition);

      for (let i = 0; i < samplesThisChunk; i += 1) {
        const sourceOffset = i * sourceFrameBytes;
        const destOffset = i * OUTPUT_BYTES_PER_SAMPLE;
        const sourceSample = readSourceSample(sourceBuffer, sourceOffset, sourceInfo.bitsPerSample);
        const existingSample = destBuffer.readIntLE(destOffset, 3);
        writeOutputSample(destBuffer, destOffset, existingSample + sourceSample);
      }

      fs.writeSync(destFd, destBuffer, 0, destBytes, destPosition);
      samplesWritten += samplesThisChunk;
    }

    return samplesWritten;
  } finally {
    fs.closeSync(sourceFd);
    fs.closeSync(destFd);
  }
}

function getTakeStartOffsetSecs(take, track, project) {
  const projectOffset = Number(project.settings?.workspace?.recordingOffsetMs);
  if (Number.isFinite(projectOffset)) return projectOffset / 1000;

  const trackOffset = Number(track.recordingOffsetMs);
  if (Number.isFinite(trackOffset)) return trackOffset / 1000;

  const takeOffset = Number(take.recordingOffsetMs);
  if (Number.isFinite(takeOffset)) return takeOffset / 1000;

  if (typeof take.startOffsetSecs === 'number' && Number.isFinite(take.startOffsetSecs)) return take.startOffsetSecs;
  return 0;
}

function getFilmDurationSeconds(project, placements, frameRate) {
  const videoDuration = Number(project.video?.durationSeconds);
  if (Number.isFinite(videoDuration) && videoDuration > 0) return videoDuration;

  let maxSeconds = 0;
  for (const cue of project.cues || []) {
    if (typeof cue.outFrames === 'number') {
      maxSeconds = Math.max(maxSeconds, framesToSeconds(cue.outFrames, frameRate));
    }
  }
  for (const placement of placements) {
    maxSeconds = Math.max(maxSeconds, placement.timelineStartSeconds + (placement.durationSecs || 0));
  }
  return Math.max(1, maxSeconds);
}

function buildPlacements(project, options = {}) {
  const frameRate = project.settings?.frameRate || project.video?.frameRate || '25';
  const { cues, characters, actors } = buildLookup(project);
  const placements = [];
  const missingFiles = [];
  const unsupportedFiles = [];
  const characterIdFilter = options.characterId || null;
  const selectedOnly = options.selectedOnly !== false;

  for (const take of (project.takes || []).filter(item => !selectedOnly || item.isSelected)) {
    const cue = cues.get(take.cueId);
    if (!cue) continue;
    if (characterIdFilter && cue.characterId !== characterIdFilter) continue;
    const character = characters.get(cue.characterId) || {};
    const actor = actors.get(take.actorId || cue.actorId) || {};
    const characterName = safeName(character.name || 'Unassigned Character');
    const cueInSeconds = framesToSeconds(cue.inFrames || 0, frameRate);

    for (const track of getTakeTracks(take)) {
      const sourcePath = track.filePath || take.filePath || '';
      const laneId = String(track.laneId || '').trim();
      const laneKey = getTrackLaneIdentity(track);
      const laneName = safeName(track.trackName || track.label || track.laneId || 'Mic');
      const timelineStartSeconds = Math.max(0, cueInSeconds + getTakeStartOffsetSecs(take, track, project));
      const timelineStartFrames = secondsToFrames(timelineStartSeconds, frameRate);
      const base = {
        take,
        cue,
        actor,
        track,
        sourcePath,
        characterName,
        laneId,
        laneKey,
        laneName,
        timelineStartSeconds,
        timelineStartFrames,
        timelineStartTimecode: framesToTimecode(timelineStartFrames, frameRate),
        cueInTimecode: framesToTimecode(cue.inFrames || 0, frameRate),
        cueOutTimecode: framesToTimecode(cue.outFrames || 0, frameRate),
      };

      if (!sourcePath || !fs.existsSync(sourcePath)) {
        missingFiles.push({
          takeId: take.takeId,
          cueId: take.cueId,
          characterName,
          laneName,
          sourcePath,
        });
        continue;
      }

      try {
        const sourceInfo = parseWavFile(sourcePath);
        if (sourceInfo.sampleRate !== DEFAULT_SAMPLE_RATE) {
          unsupportedFiles.push({ ...base, reason: `Sample rate ${sourceInfo.sampleRate} is not ${DEFAULT_SAMPLE_RATE}.` });
          continue;
        }
        const sourceFrameBytes = (sourceInfo.bitsPerSample / 8) * sourceInfo.channels;
        placements.push({
          ...base,
          sourceInfo,
          durationSecs: Math.floor(sourceInfo.dataSize / sourceFrameBytes) / sourceInfo.sampleRate,
          timelineEndSeconds: timelineStartSeconds + (Math.floor(sourceInfo.dataSize / sourceFrameBytes) / sourceInfo.sampleRate),
        });
      } catch (err) {
        unsupportedFiles.push({ ...base, reason: err.message });
      }
    }
  }

  return { placements, missingFiles, unsupportedFiles, frameRate };
}

function buildPackageRows({ project, renderedFiles, missingFiles, unsupportedFiles, placements, characterId = null }) {
  const renderedBySource = new Map();
  for (const file of renderedFiles) {
    for (const sourcePath of file.sourcePaths) renderedBySource.set(sourcePath, file);
  }
  const missingBySource = new Map(missingFiles.map(item => [item.sourcePath, item]));
  const unsupportedBySource = new Map(unsupportedFiles.map(item => [item.sourcePath, item]));
  const placementBySource = new Map(placements.map(item => [item.sourcePath, item]));

  return buildAdrSessionRows(project)
    .filter(row => !characterId || row.characterId === characterId)
    .map(row => {
    const rendered = renderedBySource.get(row.filePath);
    const missing = missingBySource.get(row.filePath);
    const unsupported = unsupportedBySource.get(row.filePath);
    const placement = placementBySource.get(row.filePath);
    return {
      ...row,
      exportStatus: rendered ? 'PLACED_IN_FULL_LENGTH_STEM' : unsupported ? 'UNSUPPORTED_SOURCE' : missing ? 'MISSING_SOURCE' : row.goodTake === 'YES' ? 'SKIPPED' : 'ALTERNATE',
      exportedPath: rendered?.destPath || '',
      exportCharacterFolder: rendered?.characterFolder || '',
      timelineStartSeconds: placement?.timelineStartSeconds ?? '',
      timelineStartFrames: placement?.timelineStartFrames ?? '',
      timelineStartTimecode: placement?.timelineStartTimecode ?? '',
      cueInTimecode: placement?.cueInTimecode ?? row.cueInTimecode ?? '',
      cueOutTimecode: placement?.cueOutTimecode ?? row.cueOutTimecode ?? '',
      sourceExists: missing ? 'NO' : rendered ? 'YES' : '',
      exportNote: unsupported?.reason || '',
      };
    });
}

function writePackageCsv(csvPath, rows) {
  const headers = [
    'Project',
    'Film',
    'Character',
    'Actor',
    'Cue',
    'Cue In TC',
    'Cue Out TC',
    'In Frames',
    'Out Frames',
    'Take',
    'Take Name',
    'Good',
    'Lane',
    'Track Name',
    'Physical Input',
    'Source File',
    'Full-Length Stem',
    'Export Status',
    'Timeline Start TC',
    'Timeline Start Secs',
    'Duration Secs',
    'Start Offset Secs',
    'Recording Offset Ms',
    'Sample Rate',
    'Bit Depth',
    'Recorded At',
    'Notes',
    'Dialogue',
    'Export Note',
  ];

  const lines = [csvRow(headers)];
  for (const row of rows) {
    lines.push(csvRow([
      row.projectName,
      row.filmTitle,
      row.character,
      row.actor,
      row.cueNumber,
      row.cueInTimecode,
      row.cueOutTimecode,
      row.cueInFrames,
      row.cueOutFrames,
      row.takeNumber,
      row.takeName,
      row.goodTake,
      row.laneId,
      row.trackName,
      row.physicalInput,
      row.filePath,
      row.exportedPath,
      row.exportStatus,
      row.timelineStartTimecode,
      row.timelineStartSeconds,
      row.durationSecs,
      row.startOffsetSecs,
      row.recordingOffsetMs,
      row.sampleRate,
      row.bitDepth,
      row.recordedAt,
      row.notes,
      row.dialogue,
      row.exportNote,
    ]));
  }
  fs.writeFileSync(csvPath, Buffer.from(lines.join('\n'), 'utf8'));
}

function writeSummary(summaryPath, manifest) {
  const skippedSelectedRows = Array.isArray(manifest.skippedSelectedRows) ? manifest.skippedSelectedRows : [];
  const isTimelineTakesExport = manifest.reportType === 'adr-timeline-takes-export';
  const alternateRows = manifest.rows
    .filter(row => row.goodTake !== 'YES')
    .sort((a, b) => String(a.cueNumber).localeCompare(String(b.cueNumber)) || Number(a.takeNumber || 0) - Number(b.takeNumber || 0));

  const lines = [
    `POST ADR PRO - ADR DELIVERY REPORT`,
    ``,
    `DELIVERY OVERVIEW`,
    `Project:              ${manifest.project.projectName || ''}`,
    `Film:                 ${manifest.project.filmTitle || ''}`,
    `Generated:            ${manifest.generatedAt}`,
    `Package folder:       ${manifest.packageRoot}`,
    ``,
    `SYNC AND FORMAT`,
    `Stem start:           00:00:00:00 / film zero`,
    `Placement rule:       Cue In TC + recording offset`,
    `Recording offset:     ${manifest.recordingOffsetMs} ms`,
    `Film duration:        ${formatSeconds(manifest.filmDurationSeconds)} seconds`,
    `Export format:        ${manifest.sampleRate} Hz / ${manifest.bitDepth}-bit / mono WAV`,
    `Frame rate:           ${manifest.frameRate}`,
    ``,
    `DELIVERY COUNTS`,
    `Full-length stems:    ${manifest.renderedFiles.length}`,
    `${isTimelineTakesExport ? 'Placed takes' : 'Placed good takes'}:    ${manifest.placements.length}`,
    `Skipped selected:     ${skippedSelectedRows.length}`,
    `${isTimelineTakesExport ? 'Non-good take rows' : 'Alternate take rows'}:  ${alternateRows.length}`,
    `Missing sources:      ${manifest.missingFiles.length}`,
    `Unsupported sources:  ${manifest.unsupportedFiles.length}`,
    ``,
    isTimelineTakesExport ? `STEMS AND PLACED TAKES` : `STEMS AND PLACED GOOD TAKES`,
  ];

  if (manifest.renderedFiles.length) {
    for (const file of manifest.renderedFiles.slice().sort((a, b) =>
      a.characterName.localeCompare(b.characterName) || a.laneName.localeCompare(b.laneName))) {
      lines.push(
        ``,
        `${file.characterName} - ${file.laneName}`,
        `Stem: ${file.destPath}`,
        `Placed takes: ${file.placedTakeCount}`
      );

      for (const source of file.placedSources) {
        lines.push(
          `  - ${source.cueNumber} / T${source.takeNumber} / ${source.actorName || 'No actor'}`,
          `    Timeline: ${source.timelineStartTimecode} (${formatSeconds(source.timelineStartSeconds)}s), sample ${source.startSample}`,
          `    Cue: ${source.cueInTimecode} -> ${source.cueOutTimecode}`,
          `    Source: ${source.sourcePath}`
        );
      }
    }
  } else {
    lines.push(`- None`);
  }

  lines.push(``, isTimelineTakesExport ? `NON-GOOD TAKE ROWS` : `ALTERNATE TAKES`);
  if (alternateRows.length) {
    for (const row of alternateRows) {
      lines.push(
        `- ${row.cueNumber || 'Cue'} / ${row.character || 'No character'} / T${row.takeNumber || ''} / ${row.trackName || row.laneId || 'Mic'}`,
        `  Cue: ${row.cueInTimecode || ''} -> ${row.cueOutTimecode || ''}`,
        `  Source: ${row.filePath || '(no source file)'}`
      );
    }
  } else {
    lines.push(`- None`);
  }

  if (manifest.missingFiles.length) {
    lines.push(``, `MISSING SOURCES`);
    for (const file of manifest.missingFiles) {
      lines.push(`- ${file.characterName} / ${file.laneName}: ${file.sourcePath || '(blank source path)'}`);
    }
  }

  if (manifest.unsupportedFiles.length) {
    lines.push(``, `UNSUPPORTED SOURCES`);
    for (const file of manifest.unsupportedFiles) {
      lines.push(`- ${file.characterName} / ${file.laneName}: ${file.sourcePath || '(blank source path)'} (${file.reason})`);
    }
  }

  if (skippedSelectedRows.length) {
    lines.push(``, `SELECTED ROWS NOT PLACED`);
    for (const row of skippedSelectedRows) {
      lines.push(
        `- ${row.cueNumber || 'Cue'} / ${row.character || 'No character'} / T${row.takeNumber || ''} / ${row.trackName || row.laneId || 'Mic'}`,
        `  Status: ${row.exportStatus || 'SKIPPED'}`,
        `  Source: ${row.filePath || '(no source file)'}`
      );
    }
  }

  lines.push(
    ``,
    `TECHNICAL REPORT FILES`,
    `CSV:  ${manifest.csvPath || ''}`,
    `JSON: ${manifest.jsonPath || ''}`,
    ``,
    `NOTES`,
    `- Import each full-length WAV at film/session zero in the DAW.`,
    isTimelineTakesExport
      ? `- All usable takes are rendered into take-number stems; overlap stems prevent clips from colliding on the same track.`
      : `- Good takes are rendered into stems; alternates remain available via the source paths above and the CSV/JSON report.`,
    `- Talkback is never included in exported stems.`
  );

  fs.writeFileSync(summaryPath, Buffer.from(lines.join('\n'), 'utf8'));
}

function exportGoodTakesPackage({ project, destinationRoot, characterId = null }) {
  if (!project) throw new Error('No project is open.');
  if (!destinationRoot) throw new Error('No export destination was provided.');

  const cueById = new Map((project.cues || []).map(cue => [cue.cueId, cue]));
  const selectedTakes = (project.takes || []).filter(take => {
    if (!take.isSelected) return false;
    if (!characterId) return true;
    return cueById.get(take.cueId)?.characterId === characterId;
  });
  if (!selectedTakes.length) throw new Error('No good takes are selected.');

  const projectName = safeName(project.projectName || project.filmTitle, 'ADR_Project');
  const character = characterId
    ? (project.characters || []).find(item => item.characterId === characterId)
    : null;
  const exportLabel = character
    ? `${projectName}_${safeName(character.name, 'Character')}_Full_Length_Good_Takes_${timestampForPath()}`
    : `${projectName}_Full_Length_Good_Takes_${timestampForPath()}`;
  const packageRoot = ensureUniquePath(path.join(destinationRoot, exportLabel));
  fs.mkdirSync(packageRoot, { recursive: true });

  const { placements, missingFiles, unsupportedFiles, frameRate } = buildPlacements(project, { characterId });
  if (!placements.length) {
    throw new Error('No selected good take WAV files were usable for full-length export.');
  }

  const filmDurationSeconds = getFilmDurationSeconds(project, placements, frameRate);
  const totalSamples = Math.ceil(filmDurationSeconds * DEFAULT_SAMPLE_RATE);
  const groups = new Map();

  for (const placement of placements) {
    const key = `${placement.characterName}\n${placement.laneKey}`;
    if (!groups.has(key)) {
      groups.set(key, {
        characterName: placement.characterName,
        laneId: placement.laneId,
        laneKey: placement.laneKey,
        laneName: placement.laneName,
        placements: [],
      });
    }
    groups.get(key).placements.push(placement);
  }

  const renderedFiles = [];
  for (const group of groups.values()) {
    const characterFolder = path.join(packageRoot, group.characterName);
    fs.mkdirSync(characterFolder, { recursive: true });
    const fileName = `${safeName(group.characterName)}_${safeName(group.laneName)}_FULL_LENGTH.wav`;
    const destPath = ensureUniquePath(path.join(characterFolder, fileName));
    createSilentWav(destPath, totalSamples, DEFAULT_SAMPLE_RATE);

    const placedSources = [];
    for (const placement of group.placements.sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds)) {
      const startSample = Math.round(placement.timelineStartSeconds * DEFAULT_SAMPLE_RATE);
      const writtenSamples = mixPcmIntoStem({
        stemPath: destPath,
        sourcePath: placement.sourcePath,
        sourceInfo: placement.sourceInfo,
        startSample,
        totalSamples,
      });
      placedSources.push({
        takeId: placement.take.takeId,
        cueId: placement.take.cueId,
        cueNumber: placement.cue.cueNumber || placement.take.cueNumber || '',
        takeNumber: placement.take.takeNumber,
        actorName: placement.actor.name || '',
        sourcePath: placement.sourcePath,
        timelineStartSeconds: placement.timelineStartSeconds,
        timelineStartTimecode: placement.timelineStartTimecode,
        cueInTimecode: placement.cueInTimecode,
        cueOutTimecode: placement.cueOutTimecode,
        startSample,
        writtenSamples,
      });
    }

    renderedFiles.push({
      characterName: group.characterName,
      laneId: group.laneId,
      laneKey: group.laneKey,
      laneName: group.laneName,
      destPath,
      fileName,
      characterFolder,
      placedTakeCount: placedSources.length,
      sourcePaths: placedSources.map(source => source.sourcePath),
      placedSources,
    });
  }

  const reportRows = buildPackageRows({ project, renderedFiles, missingFiles, unsupportedFiles, placements, characterId });
  const skippedSelectedRows = reportRows.filter(row => row.goodTake === 'YES' && row.exportStatus !== 'PLACED_IN_FULL_LENGTH_STEM');
  const manifest = {
    reportType: 'adr-full-length-good-takes-export',
    generatedAt: new Date().toISOString(),
    recordingOffsetMs: Number(project.settings?.workspace?.recordingOffsetMs) || 0,
    sampleRate: DEFAULT_SAMPLE_RATE,
    bitDepth: OUTPUT_BIT_DEPTH,
    channels: OUTPUT_CHANNELS,
    frameRate,
    filmDurationSeconds,
    project: {
      projectId: project.projectId,
      projectName: project.projectName,
      filmTitle: project.filmTitle,
    },
    exportScope: character
      ? { type: 'character', characterId, characterName: character.name || '' }
      : { type: 'project' },
    packageRoot,
    renderedFiles,
    placements: placements.map(placement => ({
      takeId: placement.take.takeId,
      cueId: placement.take.cueId,
      cueNumber: placement.cue.cueNumber || placement.take.cueNumber || '',
      takeNumber: placement.take.takeNumber,
      characterName: placement.characterName,
      actorName: placement.actor.name || '',
      laneId: placement.laneId,
      laneKey: placement.laneKey,
      laneName: placement.laneName,
      sourcePath: placement.sourcePath,
      timelineStartSeconds: placement.timelineStartSeconds,
      timelineStartFrames: placement.timelineStartFrames,
      timelineStartTimecode: placement.timelineStartTimecode,
      cueInTimecode: placement.cueInTimecode,
      cueOutTimecode: placement.cueOutTimecode,
      durationSecs: placement.durationSecs,
    })),
    missingFiles,
    unsupportedFiles: unsupportedFiles.map(item => ({
      takeId: item.take.takeId,
      cueId: item.take.cueId,
      characterName: item.characterName,
      laneId: item.laneId,
      laneName: item.laneName,
      sourcePath: item.sourcePath,
      reason: item.reason,
    })),
    rows: reportRows,
    skippedSelectedRows,
  };

  const reportBase = character
    ? `${projectName}_${safeName(character.name, 'Character')}_ADR_Full_Length_Good_Takes_Report`
    : `${projectName}_ADR_Full_Length_Good_Takes_Report`;
  const jsonPath = path.join(packageRoot, `${reportBase}.json`);
  const csvPath = path.join(packageRoot, `${reportBase}.csv`);
  const summaryPath = path.join(packageRoot, `${reportBase}.txt`);
  manifest.csvPath = csvPath;
  manifest.jsonPath = jsonPath;
  manifest.summaryPath = summaryPath;

  fs.writeFileSync(jsonPath, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  writePackageCsv(csvPath, reportRows);
  writeSummary(summaryPath, manifest);

  return {
    packageRoot,
    csvPath,
    jsonPath,
    summaryPath,
    renderedFiles,
    copiedFiles: renderedFiles,
    missingFiles,
    unsupportedFiles: manifest.unsupportedFiles,
    skippedSelectedRows,
  };
}

function padTakeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? String(number).padStart(2, '0') : 'Unknown';
}

function makeTimelineTakeStemName(takeNumber, overlapIndex = 0) {
  const takeLabel = `Take ${padTakeNumber(takeNumber)}`;
  if (overlapIndex <= 0) return takeLabel;
  return `Overlap ${takeLabel} ${String(overlapIndex).padStart(2, '0')}`;
}

function assignPlacementsToNonOverlappingStems(placements) {
  const stems = [];
  const sorted = placements.slice().sort((a, b) =>
    a.timelineStartSeconds - b.timelineStartSeconds ||
    (a.timelineEndSeconds || 0) - (b.timelineEndSeconds || 0)
  );

  for (const placement of sorted) {
    let assigned = false;
    for (const stem of stems) {
      if (placement.timelineStartSeconds >= stem.lastEndSeconds) {
        stem.placements.push(placement);
        stem.lastEndSeconds = Math.max(stem.lastEndSeconds, placement.timelineEndSeconds || placement.timelineStartSeconds);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      stems.push({
        overlapIndex: stems.length,
        lastEndSeconds: placement.timelineEndSeconds || placement.timelineStartSeconds,
        placements: [placement],
      });
    }
  }

  return stems;
}

function exportTimelineTakesPackage({ project, destinationRoot, characterId = null }) {
  if (!project) throw new Error('No project is open.');
  if (!destinationRoot) throw new Error('No export destination was provided.');

  const cueById = new Map((project.cues || []).map(cue => [cue.cueId, cue]));
  const exportableTakes = (project.takes || []).filter(take => {
    if (!characterId) return true;
    return cueById.get(take.cueId)?.characterId === characterId;
  });
  if (!exportableTakes.length) throw new Error('No takes are available to export.');

  const projectName = safeName(project.projectName || project.filmTitle, 'ADR_Project');
  const character = characterId
    ? (project.characters || []).find(item => item.characterId === characterId)
    : null;
  const exportLabel = character
    ? `${projectName}_${safeName(character.name, 'Character')}_Timeline_Takes_${timestampForPath()}`
    : `${projectName}_Timeline_Takes_${timestampForPath()}`;
  const packageRoot = ensureUniquePath(path.join(destinationRoot, exportLabel));
  fs.mkdirSync(packageRoot, { recursive: true });

  const { placements, missingFiles, unsupportedFiles, frameRate } = buildPlacements(project, {
    characterId,
    selectedOnly: false,
  });
  if (!placements.length) {
    throw new Error('No take WAV files were usable for timeline export.');
  }

  const filmDurationSeconds = getFilmDurationSeconds(project, placements, frameRate);
  const totalSamples = Math.ceil(filmDurationSeconds * DEFAULT_SAMPLE_RATE);
  const groups = new Map();

  for (const placement of placements) {
    const takeNumber = Number(placement.take.takeNumber) || 0;
    const key = `${placement.characterName}\n${placement.laneKey}\n${takeNumber}`;
    if (!groups.has(key)) {
      groups.set(key, {
        characterName: placement.characterName,
        laneId: placement.laneId,
        laneKey: placement.laneKey,
        laneName: placement.laneName,
        takeNumber,
        placements: [],
      });
    }
    groups.get(key).placements.push(placement);
  }

  const renderedFiles = [];
  for (const group of Array.from(groups.values()).sort((a, b) =>
    a.characterName.localeCompare(b.characterName) ||
    a.takeNumber - b.takeNumber ||
    a.laneName.localeCompare(b.laneName)
  )) {
    const characterFolder = path.join(packageRoot, group.characterName);
    fs.mkdirSync(characterFolder, { recursive: true });
    const stems = assignPlacementsToNonOverlappingStems(group.placements);

    for (const stem of stems) {
      const stemName = makeTimelineTakeStemName(group.takeNumber, stem.overlapIndex);
      const needsLaneSuffix = group.laneKey !== 'lane:unknown' && groups.size > 1;
      const laneSuffix = needsLaneSuffix ? `_${safeName(group.laneName)}` : '';
      const fileName = `${safeName(group.characterName)}_${safeName(stemName)}${laneSuffix}_FULL_LENGTH.wav`;
      const destPath = ensureUniquePath(path.join(characterFolder, fileName));
      createSilentWav(destPath, totalSamples, DEFAULT_SAMPLE_RATE);

      const placedSources = [];
      for (const placement of stem.placements) {
        const startSample = Math.round(placement.timelineStartSeconds * DEFAULT_SAMPLE_RATE);
        const writtenSamples = mixPcmIntoStem({
          stemPath: destPath,
          sourcePath: placement.sourcePath,
          sourceInfo: placement.sourceInfo,
          startSample,
          totalSamples,
        });
        placedSources.push({
          takeId: placement.take.takeId,
          cueId: placement.take.cueId,
          cueNumber: placement.cue.cueNumber || placement.take.cueNumber || '',
          takeNumber: placement.take.takeNumber,
          actorName: placement.actor.name || '',
          sourcePath: placement.sourcePath,
          timelineStartSeconds: placement.timelineStartSeconds,
          timelineStartTimecode: placement.timelineStartTimecode,
          cueInTimecode: placement.cueInTimecode,
          cueOutTimecode: placement.cueOutTimecode,
          startSample,
          writtenSamples,
        });
      }

      renderedFiles.push({
        characterName: group.characterName,
        laneId: group.laneId,
        laneKey: group.laneKey,
        laneName: stemName,
        sourceLaneName: group.laneName,
        takeNumber: group.takeNumber,
        overlapIndex: stem.overlapIndex,
        destPath,
        fileName,
        characterFolder,
        placedTakeCount: placedSources.length,
        sourcePaths: placedSources.map(source => source.sourcePath),
        placedSources,
      });
    }
  }

  const manifest = {
    reportType: 'adr-timeline-takes-export',
    generatedAt: new Date().toISOString(),
    recordingOffsetMs: Number(project.settings?.workspace?.recordingOffsetMs) || 0,
    sampleRate: DEFAULT_SAMPLE_RATE,
    bitDepth: OUTPUT_BIT_DEPTH,
    channels: OUTPUT_CHANNELS,
    frameRate,
    filmDurationSeconds,
    project: {
      projectId: project.projectId,
      projectName: project.projectName,
      filmTitle: project.filmTitle,
    },
    exportScope: character
      ? { type: 'character', characterId, characterName: character.name || '' }
      : { type: 'project' },
    packageRoot,
    renderedFiles,
    placements: placements.map(placement => ({
      takeId: placement.take.takeId,
      cueId: placement.take.cueId,
      cueNumber: placement.cue.cueNumber || placement.take.cueNumber || '',
      takeNumber: placement.take.takeNumber,
      characterName: placement.characterName,
      actorName: placement.actor.name || '',
      laneId: placement.laneId,
      laneKey: placement.laneKey,
      laneName: placement.laneName,
      sourcePath: placement.sourcePath,
      timelineStartSeconds: placement.timelineStartSeconds,
      timelineStartFrames: placement.timelineStartFrames,
      timelineStartTimecode: placement.timelineStartTimecode,
      cueInTimecode: placement.cueInTimecode,
      cueOutTimecode: placement.cueOutTimecode,
      durationSecs: placement.durationSecs,
    })),
    missingFiles,
    unsupportedFiles: unsupportedFiles.map(item => ({
      takeId: item.take.takeId,
      cueId: item.take.cueId,
      characterName: item.characterName,
      laneId: item.laneId,
      laneName: item.laneName,
      sourcePath: item.sourcePath,
      reason: item.reason,
    })),
  };

  const reportBase = character
    ? `${projectName}_${safeName(character.name, 'Character')}_ADR_Timeline_Takes_Report`
    : `${projectName}_ADR_Timeline_Takes_Report`;
  const jsonPath = path.join(packageRoot, `${reportBase}.json`);
  const csvPath = path.join(packageRoot, `${reportBase}.csv`);
  const summaryPath = path.join(packageRoot, `${reportBase}.txt`);
  manifest.csvPath = csvPath;
  manifest.jsonPath = jsonPath;
  manifest.summaryPath = summaryPath;

  const reportRows = buildPackageRows({ project, renderedFiles, missingFiles, unsupportedFiles, placements, characterId });
  manifest.rows = reportRows;

  fs.writeFileSync(jsonPath, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  writePackageCsv(csvPath, reportRows);
  writeSummary(summaryPath, manifest);

  return {
    packageRoot,
    csvPath,
    jsonPath,
    summaryPath,
    renderedFiles,
    copiedFiles: renderedFiles,
    missingFiles,
    unsupportedFiles: manifest.unsupportedFiles,
    skippedSelectedRows: [],
  };
}

module.exports = {
  exportGoodTakesPackage,
  exportTimelineTakesPackage,
};
