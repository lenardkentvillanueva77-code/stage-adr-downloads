'use strict';

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 48000;
const OUTPUT_BIT_DEPTH = 24;
const OUTPUT_BYTES_PER_SAMPLE = OUTPUT_BIT_DEPTH / 8;
const CHUNK_SAMPLES = 32768;

function readFourCC(buffer, offset) {
  return buffer.toString('ascii', offset, offset + 4);
}

function parseWavFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    if (fs.readSync(fd, header, 0, 12, 0) !== 12
        || readFourCC(header, 0) !== 'RIFF'
        || readFourCC(header, 8) !== 'WAVE') {
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

    if (!fmt || !data) throw new Error('WAV format or data chunk is missing.');
    if (fmt.audioFormat !== 1) throw new Error('Only PCM WAV sources can be comped.');
    if (![16, 24, 32].includes(fmt.bitsPerSample)) {
      throw new Error(`Unsupported WAV bit depth: ${fmt.bitsPerSample}.`);
    }
    if (fmt.sampleRate !== SAMPLE_RATE) {
      throw new Error(`Comp sources must be ${SAMPLE_RATE} Hz; found ${fmt.sampleRate} Hz.`);
    }
    if (fmt.channels < 1) throw new Error('WAV source has no channels.');
    return { ...fmt, dataOffset: data.offset, dataSize: data.size };
  } finally {
    fs.closeSync(fd);
  }
}

function buildWavHeader(dataByteCount) {
  const buffer = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * OUTPUT_BYTES_PER_SAMPLE;
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataByteCount, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(OUTPUT_BYTES_PER_SAMPLE, 32);
  buffer.writeUInt16LE(OUTPUT_BIT_DEPTH, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataByteCount, 40);
  return buffer;
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

function takeTracks(take) {
  return Array.isArray(take?.tracks) && take.tracks.length
    ? take.tracks
    : [{ laneId: 'mic1', label: 'Mic 1', trackName: 'Mic 1', filePath: take?.filePath, durationSecs: take?.durationSecs }];
}

function laneIdentity(track) {
  return String(track?.laneId || track?.trackName || track?.label || 'mic1');
}

function safePart(value, fallback) {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 64) || fallback;
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const extension = path.extname(filePath);
  const base = filePath.slice(0, -extension.length);
  let index = 2;
  while (fs.existsSync(`${base}_${index}${extension}`)) index += 1;
  return `${base}_${index}${extension}`;
}

function copySegment({ output, sourcePath, sourceInfo, sourceStartSecs, timelineStartSecs, durationSecs, fadeInSecs, fadeOutSecs }) {
  const sourceBytesPerSample = sourceInfo.bitsPerSample / 8;
  const sourceFrameBytes = sourceBytesPerSample * sourceInfo.channels;
  const sourceTotalSamples = Math.floor(sourceInfo.dataSize / sourceFrameBytes);
  const outputTotalSamples = Math.floor(output.length / OUTPUT_BYTES_PER_SAMPLE);
  const sourceStartSample = Math.max(0, Math.round(sourceStartSecs * SAMPLE_RATE));
  const timelineStartSample = Math.max(0, Math.round(timelineStartSecs * SAMPLE_RATE));
  const requestedSamples = Math.max(0, Math.round(durationSecs * SAMPLE_RATE));
  const writableSamples = Math.min(
    requestedSamples,
    sourceTotalSamples - sourceStartSample,
    outputTotalSamples - timelineStartSample
  );
  if (writableSamples <= 0) return 0;

  const fadeInSamples = Math.min(writableSamples, Math.round(Math.max(0, fadeInSecs || 0) * SAMPLE_RATE));
  const fadeOutSamples = Math.min(writableSamples, Math.round(Math.max(0, fadeOutSecs || 0) * SAMPLE_RATE));
  const fd = fs.openSync(sourcePath, 'r');
  try {
    const sourceBuffer = Buffer.alloc(Math.min(CHUNK_SAMPLES, writableSamples) * sourceFrameBytes);
    let copied = 0;
    while (copied < writableSamples) {
      const count = Math.min(CHUNK_SAMPLES, writableSamples - copied);
      const bytes = count * sourceFrameBytes;
      const sourcePosition = sourceInfo.dataOffset + (sourceStartSample + copied) * sourceFrameBytes;
      fs.readSync(fd, sourceBuffer, 0, bytes, sourcePosition);

      for (let index = 0; index < count; index += 1) {
        const segmentIndex = copied + index;
        let gain = 1;
        if (fadeInSamples > 0 && segmentIndex < fadeInSamples) gain *= segmentIndex / fadeInSamples;
        const samplesFromEnd = writableSamples - segmentIndex - 1;
        if (fadeOutSamples > 0 && samplesFromEnd < fadeOutSamples) gain *= samplesFromEnd / fadeOutSamples;
        const sample = readSourceSample(sourceBuffer, index * sourceFrameBytes, sourceInfo.bitsPerSample);
        const outputOffset = (timelineStartSample + segmentIndex) * OUTPUT_BYTES_PER_SAMPLE;
        const existing = output.readIntLE(outputOffset, OUTPUT_BYTES_PER_SAMPLE);
        writeOutputSample(output, outputOffset, existing + sample * gain);
      }
      copied += count;
    }
    return writableSamples;
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments
    .map(segment => ({
      sourceTakeId: String(segment?.sourceTakeId || ''),
      sourceLaneId: String(segment?.sourceLaneId || 'mic1'),
      sourceStartSecs: Number(segment?.sourceStartSecs),
      timelineStartSecs: Number(segment?.timelineStartSecs),
      durationSecs: Number(segment?.durationSecs),
      fadeInSecs: Number(segment?.fadeInSecs) || 0,
      fadeOutSecs: Number(segment?.fadeOutSecs) || 0,
    }))
    .filter(segment => segment.sourceTakeId
      && Number.isFinite(segment.sourceStartSecs)
      && Number.isFinite(segment.timelineStartSecs)
      && Number.isFinite(segment.durationSecs)
      && segment.sourceStartSecs >= 0
      && segment.timelineStartSecs >= 0
      && segment.durationSecs > 0)
    .sort((left, right) => left.timelineStartSecs - right.timelineStartSecs);
}

function renderCompTake({ project, cue, segments, takeNumber, projectMediaPath }) {
  const normalizedSegments = normalizeSegments(segments);
  if (!normalizedSegments.length) throw new Error('The comp lane has no regions to save.');
  if (!projectMediaPath) throw new Error('Save the project before creating a comp take.');

  const takeById = new Map((project.takes || []).map(take => [take.takeId, take]));
  const sourceTakes = normalizedSegments.map(segment => takeById.get(segment.sourceTakeId));
  if (sourceTakes.some(take => !take || take.cueId !== cue.cueId)) {
    throw new Error('A comp region references a missing take or a take from another cue.');
  }

  const laneMap = new Map();
  for (const take of sourceTakes) {
    for (const track of takeTracks(take)) {
      const identity = laneIdentity(track);
      if (!laneMap.has(identity)) laneMap.set(identity, { laneId: identity, label: track.trackName || track.label || identity });
    }
  }

  const frameRate = Number(project.settings?.frameRate || project.video?.frameRate || 25) || 25;
  const cueDurationSecs = Math.max(0, ((cue.outFrames || 0) - (cue.inFrames || 0)) / frameRate);
  const compDurationSecs = Math.max(cueDurationSecs, ...normalizedSegments.map(segment => segment.timelineStartSecs + segment.durationSecs));
  const totalSamples = Math.max(1, Math.ceil(compDurationSecs * SAMPLE_RATE));
  const cueDir = path.join(projectMediaPath, 'takes', safePart(cue.cueNumber, 'cue'));
  fs.mkdirSync(cueDir, { recursive: true });

  const renderedTracks = [];
  const laneCount = laneMap.size;
  for (const lane of laneMap.values()) {
    const output = Buffer.alloc(totalSamples * OUTPUT_BYTES_PER_SAMPLE);
    let copiedSamples = 0;
    for (const segment of normalizedSegments) {
      const take = takeById.get(segment.sourceTakeId);
      const tracks = takeTracks(take);
      const track = tracks.find(candidate => laneIdentity(candidate) === lane.laneId);
      if (!track?.filePath || !fs.existsSync(track.filePath)) continue;
      const sourceInfo = parseWavFile(track.filePath);
      const sourceLaneOffset = Number(take.syncEdit?.laneOffsets?.[segment.sourceLaneId]) || 0;
      const targetLaneOffset = Number(take.syncEdit?.laneOffsets?.[lane.laneId]) || 0;
      copiedSamples += copySegment({
        output,
        sourcePath: track.filePath,
        sourceInfo,
        ...segment,
        timelineStartSecs: Math.max(0, segment.timelineStartSecs + targetLaneOffset - sourceLaneOffset),
      });
    }
    if (!copiedSamples) continue;

    const numberPart = String(takeNumber).padStart(3, '0');
    const lanePart = laneCount > 1 ? `_${safePart(lane.laneId, 'mic')}` : '';
    const filePath = uniquePath(path.join(cueDir, `take_${numberPart}_created${lanePart}.wav`));
    fs.writeFileSync(filePath, Buffer.concat([buildWavHeader(output.length), output]));
    renderedTracks.push({
      laneId: lane.laneId,
      label: lane.label,
      trackName: lane.label,
      filePath,
      durationSecs: totalSamples / SAMPLE_RATE,
      sampleRate: SAMPLE_RATE,
      bitDepth: OUTPUT_BIT_DEPTH,
    });
  }

  if (!renderedTracks.length) throw new Error('None of the selected comp sources contained usable audio.');
  return {
    filePath: renderedTracks[0].filePath,
    durationSecs: totalSamples / SAMPLE_RATE,
    tracks: renderedTracks,
    segments: normalizedSegments,
  };
}

module.exports = { renderCompTake, normalizeSegments, parseWavFile };
