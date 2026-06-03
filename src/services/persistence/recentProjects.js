'use strict';

const fs = require('fs');
const path = require('path');

const MAX_RECENT_PROJECTS = 10;
let storePath = null;

function init(userDataPath) {
  storePath = path.join(userDataPath, 'recent-projects.json');
}

function readRecentProjects() {
  if (!storePath || !fs.existsSync(storePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(entry => entry && path.isAbsolute(entry.filePath || '')) : [];
  } catch {
    return [];
  }
}

function writeRecentProjects(entries) {
  if (!storePath) return;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(entries.slice(0, MAX_RECENT_PROJECTS), null, 2), 'utf8');
}

function addRecentProject(filePath, project = {}) {
  if (!filePath || !path.isAbsolute(filePath)) return readRecentProjects();

  const normalized = path.normalize(filePath);
  const now = new Date().toISOString();
  const next = [
    {
      filePath: normalized,
      filmTitle: project.filmTitle || '',
      projectName: project.projectName || path.basename(normalized, path.extname(normalized)),
      lastOpenedAt: now,
    },
    ...readRecentProjects().filter(entry => path.normalize(entry.filePath) !== normalized),
  ].slice(0, MAX_RECENT_PROJECTS);

  writeRecentProjects(next);
  return next;
}

function removeRecentProject(filePath) {
  if (!filePath) return readRecentProjects();
  const normalized = path.normalize(filePath);
  const next = readRecentProjects().filter(entry => path.normalize(entry.filePath) !== normalized);
  writeRecentProjects(next);
  return next;
}

function clearRecentProjects() {
  writeRecentProjects([]);
  return [];
}

module.exports = {
  init,
  readRecentProjects,
  addRecentProject,
  removeRecentProject,
  clearRecentProjects,
};
