'use strict';

const fs = require('fs');
const path = require('path');
const { deepClone } = require('../../core/utils');
const { touchProject } = require('../../core/models/Project');

const DEFAULT_SCAN_LIMIT = 50_000;
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'release',
  'dist',
  'out',
  'build',
]);
const MEDIA_EXTENSIONS = new Set([
  '.aif',
  '.aiff',
  '.avi',
  '.caf',
  '.flac',
  '.m4a',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.mxf',
  '.ogg',
  '.wav',
  '.wave',
  '.wma',
]);

function pathKey(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase();
}

function samePath(left, right) {
  return pathKey(path.normalize(left || '')) === pathKey(path.normalize(right || ''));
}

function isFile(filePath) {
  try {
    return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
  } catch (_) {
    return false;
  }
}

function basenameKey(value) {
  const base = path.basename(String(value || '').trim());
  return base ? base.toLowerCase() : '';
}

function parentKey(value) {
  if (!value) return '';
  return path.basename(path.dirname(String(value))).toLowerCase();
}

function shouldIndexFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MEDIA_EXTENSIONS.has(ext);
}

function createFileIndex(rootFolder, { scanLimit = DEFAULT_SCAN_LIMIT } = {}) {
  const index = new Map();
  const warnings = [];
  let scannedFiles = 0;
  let limited = false;
  const stack = [rootFolder];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      warnings.push(`Skipped ${current}: ${err.message}`);
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !shouldIndexFile(fullPath)) continue;
      scannedFiles += 1;
      if (scannedFiles > scanLimit) {
        limited = true;
        warnings.push(`Stopped scanning after ${scanLimit} media files.`);
        stack.length = 0;
        break;
      }
      const key = basenameKey(entry.name);
      if (!key) continue;
      const matches = index.get(key) || [];
      matches.push(fullPath);
      index.set(key, matches);
    }
  }

  return { index, scannedFiles: Math.min(scannedFiles, scanLimit), warnings, limited };
}

function chooseCandidate(candidates, oldPath) {
  if (candidates.length === 1) return { status: 'found', filePath: candidates[0] };

  const oldParent = parentKey(oldPath);
  if (oldParent) {
    const parentMatches = candidates.filter(candidate => parentKey(candidate) === oldParent);
    if (parentMatches.length === 1) {
      return { status: 'found', filePath: parentMatches[0] };
    }
  }

  return { status: 'conflict', candidates };
}

function resolveReference(index, oldPath, fallbackName) {
  const currentPath = String(oldPath || '').trim();
  if (isFile(currentPath)) {
    return { status: 'unchanged', filePath: currentPath };
  }

  const key = basenameKey(currentPath || fallbackName);
  if (!key) return { status: 'missing', fileName: '' };

  const candidates = index.get(key) || [];
  if (!candidates.length) return { status: 'missing', fileName: key };

  const choice = chooseCandidate(candidates, currentPath);
  if (choice.status === 'conflict') {
    return { status: 'conflict', fileName: key, candidates };
  }
  if (samePath(currentPath, choice.filePath)) {
    return { status: 'unchanged', filePath: choice.filePath };
  }
  return { status: 'relinked', filePath: choice.filePath };
}

function addSummaryItem(summary, status, item) {
  summary.items.push({ status, ...item });
  if (status === 'relinked') summary.relinked += 1;
  else if (status === 'missing') summary.missing += 1;
  else if (status === 'conflict') summary.conflicts += 1;
  else if (status === 'unchanged') summary.unchanged += 1;
}

function relinkProjectFiles(project, rootFolder, opts = {}) {
  if (!project || typeof project !== 'object') {
    return { project, summary: null, error: 'No project is open.' };
  }
  if (!isDirectory(rootFolder)) {
    return { project, summary: null, error: 'Relink folder is invalid.' };
  }

  const scan = createFileIndex(rootFolder, opts);
  const summary = {
    folderPath: rootFolder,
    scannedFiles: scan.scannedFiles,
    relinked: 0,
    missing: 0,
    conflicts: 0,
    unchanged: 0,
    warnings: scan.warnings,
    items: [],
  };
  const next = deepClone(project);
  let changed = false;

  if (next.video) {
    const result = resolveReference(scan.index, next.video.localPath, next.video.fileName);
    addSummaryItem(summary, result.status, {
      kind: 'video',
      label: next.video.fileName || path.basename(next.video.localPath || '') || 'Video',
      oldPath: next.video.localPath || '',
      newPath: result.filePath || '',
      candidates: result.candidates || [],
    });
    if (result.status === 'relinked') {
      next.video = {
        ...next.video,
        fileName: next.video.fileName || path.basename(result.filePath),
        localPath: result.filePath,
      };
      changed = true;
    }
  }

  next.takes = (next.takes || []).map((take) => {
    let nextTake = { ...take };
    let takeChanged = false;
    let archiveDirectory = null;

    const primaryResult = resolveReference(scan.index, take.filePath, path.basename(take.filePath || ''));
    addSummaryItem(summary, primaryResult.status, {
      kind: 'take',
      takeId: take.takeId,
      label: `T${take.takeNumber || '?'} primary`,
      oldPath: take.filePath || '',
      newPath: primaryResult.filePath || '',
      candidates: primaryResult.candidates || [],
    });
    if (primaryResult.status === 'relinked') {
      nextTake.filePath = primaryResult.filePath;
      archiveDirectory = path.dirname(primaryResult.filePath);
      takeChanged = true;
    }

    if (Array.isArray(take.tracks)) {
      nextTake.tracks = take.tracks.map((track, index) => {
        const label = track.trackName || track.label || track.laneId || `Mic ${index + 1}`;
        const result = resolveReference(scan.index, track.filePath, path.basename(track.filePath || ''));
        addSummaryItem(summary, result.status, {
          kind: 'track',
          takeId: take.takeId,
          laneId: track.laneId || '',
          label: `T${take.takeNumber || '?'} ${label}`,
          oldPath: track.filePath || '',
          newPath: result.filePath || '',
          candidates: result.candidates || [],
        });
        if (result.status !== 'relinked') return track;
        if (!archiveDirectory) archiveDirectory = path.dirname(result.filePath);
        takeChanged = true;
        return { ...track, filePath: result.filePath };
      });
    }

    const firstTrackPath = nextTake.tracks?.find(track => isFile(track.filePath))?.filePath || '';
    if (!isFile(nextTake.filePath) && firstTrackPath) {
      nextTake.filePath = firstTrackPath;
      takeChanged = true;
    }

    if (archiveDirectory && !isDirectory(nextTake.archiveDirectory)) {
      nextTake.archiveDirectory = archiveDirectory;
      takeChanged = true;
    }

    if (takeChanged) changed = true;
    return nextTake;
  });

  return {
    project: changed ? touchProject(next) : project,
    summary,
    changed,
  };
}

module.exports = {
  createFileIndex,
  relinkProjectFiles,
};
