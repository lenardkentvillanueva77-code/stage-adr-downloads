'use strict';

/**
 * core/schemaVersion.js
 *
 * Schema migration dispatch. When a project file is opened, its
 * schemaVersion is compared to CURRENT_SCHEMA_VERSION. If older,
 * migration functions are applied in sequence before the project
 * is parsed into typed models.
 *
 * Rules:
 * - Migration functions must be pure transforms on raw JSON objects
 * - Fields are never deleted without a major version bump
 * - The cloud backend will run the same migrations when ingesting
 *   locally-created projects in Phase 3
 */

const CURRENT_SCHEMA_VERSION = '1.1.0';

/**
 * Ordered list of migrations.
 */
const MIGRATIONS = [
  {
    from: '1.0.0',
    to:   '1.1.0',
    migrate(raw) {
      // Actor assignment foundation (schema 1.1.0):
      //   - Add top-level actors array (empty by default)
      //   - Add actorId: null to every cue
      //   - Resolve any orphaned cue.actorId references
      const actors = Array.isArray(raw.actors) ? raw.actors : [];
      const actorIds = new Set(actors.map(a => a.actorId));

      const cues = Array.isArray(raw.cues)
        ? raw.cues.map(cue => ({
            ...cue,
            // Ensure actorId field exists; normalise orphans to null
            actorId: (cue.actorId && actorIds.has(cue.actorId))
              ? cue.actorId
              : null,
          }))
        : [];

      return {
        ...raw,
        schemaVersion: '1.1.0',
        actors,
        cues,
      };
    },
  },
];

/**
 * Apply all necessary migrations to a raw project object.
 *
 * @param {object} rawProject — parsed JSON, not yet validated
 * @returns {{ project: object, migrationsApplied: string[] }}
 */
function migrateProject(rawProject) {
  let current = { ...rawProject };
  const migrationsApplied = [];

  for (const migration of MIGRATIONS) {
    if (current.schemaVersion === migration.from) {
      current = migration.migrate(current);
      migrationsApplied.push(`${migration.from} → ${migration.to}`);
    }
  }

  return { project: current, migrationsApplied };
}

/**
 * Check if a project needs migration.
 * @param {object} rawProject
 * @returns {boolean}
 */
function needsMigration(rawProject) {
  return rawProject.schemaVersion !== CURRENT_SCHEMA_VERSION;
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  migrateProject,
  needsMigration,
};
