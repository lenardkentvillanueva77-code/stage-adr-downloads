'use strict';

/**
 * src/services/export/cueSheetCsv.js
 *
 * ADR cue sheet CSV export service.
 * Pure module — no Electron deps, fully testable in isolation.
 *
 * Columns (in order):
 *   Cue Number | Character | In Timecode | Out Timecode | Dialogue | Notes | Status
 *
 * Encoding rules:
 *   - RFC 4180-compliant CSV.
 *   - Every field is double-quoted to handle commas, quotes, and newlines safely.
 *   - Internal double-quotes are escaped by doubling ("").
 *   - Internal line breaks are preserved as \n within the quoted field.
 *   - Header row always present.
 *   - UTF-8 with BOM so Excel opens it correctly without import wizard.
 *
 * @param {{ project: object }} opts
 * @returns {Buffer}  UTF-8 with BOM
 */

const { framesToProjectTimecode, getProjectStartFrameOffset } = require('../../core/timecode');

const COLUMNS = [
  'Cue Number',
  'Character',
  'In Timecode',
  'Out Timecode',
  'Dialogue',
  'Notes',
  'Status',
];

/**
 * Escape a single CSV field value.
 * Always wraps in double-quotes. Doubles any internal double-quotes.
 * Preserves internal newlines (safe inside quoted field per RFC 4180).
 */
function csvField(value) {
  const s = (value == null ? '' : String(value)).replace(/"/g, '""');
  return `"${s}"`;
}

/**
 * Generate the CSV content as a UTF-8 Buffer (with BOM for Excel compatibility).
 *
 * @param {{ project: object }} opts
 * @returns {Buffer}
 */
function generateCueSheetCsv({ project }) {
  const frameRate = project.settings?.frameRate || '25';
  const startFrameOffset = getProjectStartFrameOffset(project, frameRate);

  // Build character lookup map
  const charMap = Object.fromEntries(
    (project.characters || []).map(c => [c.characterId, c.name])
  );

  // Sort cues by in-point
  const cues = [...(project.cues || [])].sort((a, b) => a.inFrames - b.inFrames);

  // Header row
  const rows = [COLUMNS.map(csvField).join(',')];

  // Data rows
  for (const cue of cues) {
    const charName = charMap[cue.characterId] || '';
    const inTc     = framesToProjectTimecode(cue.inFrames,  frameRate, startFrameOffset);
    const outTc    = framesToProjectTimecode(cue.outFrames, frameRate, startFrameOffset);

    rows.push([
      csvField(cue.cueNumber     || ''),
      csvField(charName),
      csvField(inTc),
      csvField(outTc),
      csvField(cue.dialogue      || ''),
      csvField(cue.notes         || ''),
      csvField(cue.status        || 'open'),
    ].join(','));
  }

  const content = rows.join('\r\n') + '\r\n';

  // UTF-8 BOM + content
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  return Buffer.concat([bom, Buffer.from(content, 'utf8')]);
}

module.exports = { generateCueSheetCsv };
