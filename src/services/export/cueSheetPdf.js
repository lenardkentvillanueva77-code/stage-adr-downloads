'use strict';

/**
 * src/services/export/cueSheetPdf.js
 *
 * ADR cue sheet PDF export service.
 * Uses PDFKit to generate a clean, professional A4 document.
 *
 * Architecture:
 *   - Pure service module. No Electron deps. No IPC.
 *   - Called from ipc/exportHandlers.js which handles file dialogs and paths.
 *   - Uses core/timecode.js for authoritative frame→timecode conversion.
 *   - Returns a Buffer; caller writes it to disk.
 *
 * Layout:
 *   ┌──────────────────────────────────┐
 *   │         [Stage Post Logo]        │
 *   │             ADR List             │
 *   │     Project Title / Film Name    │
 *   │   Based on file: video.fileName  │
 *   ├──────────────────────────────────┤
 *   │ Character │ Time Code │ Line │ Notes │
 *   │ ...rows...                        │
 *   ├──────────────────────────────────┤
 *   │  Prepared by: [name]             │
 *   └──────────────────────────────────┘
 *
 * If the logo file is missing, the logo area is replaced with the text
 * "STAGE POST" — the PDF still exports without crashing.
 */

const PDFDocument = require('pdfkit');
const path        = require('path');
const fs          = require('fs');

const { framesToTimecode } = require('../../core/timecode');

// ── Layout constants ──────────────────────────────────────────────────────────

const PAGE_MARGIN   = 50;
const PAGE_SIZE     = 'A4';   // 595.28 × 841.89 pt
const PAGE_W        = 595.28;
const CONTENT_W     = PAGE_W - PAGE_MARGIN * 2;

// Column widths (must sum to ≤ CONTENT_W = 495.28)
const COL_CHAR     = 90;
const COL_TC       = 145;   // "HH:MM:SS:FF - HH:MM:SS:FF" = up to 29 chars
const COL_LINE     = 180;
const COL_NOTES    = 80;
// total = 495

const COLS = [
  { label: 'Character', width: COL_CHAR  },
  { label: 'Time Code', width: COL_TC    },
  { label: 'Line',      width: COL_LINE  },
  { label: 'Notes',     width: COL_NOTES },
];

const ROW_FONT_SIZE   = 8;
const ROW_LINE_H      = 12;    // minimum row height
const ROW_PADDING     = 4;     // vertical padding inside cell
const HEADER_H        = 18;
const HEADER_FONT_SIZE = 8;
const FOOTER_H        = 30;    // reserved at page bottom for Prepared by line

const LOGO_PATH = path.join(__dirname, '..', '..', '..', 'renderer', 'assets', 'stagepost-logo.png');
const LOGO_FIT  = [180, 45];   // max width × height for the logo image

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate an ADR cue sheet PDF as a Buffer.
 *
 * @param {object} opts
 * @param {object}   opts.project     — full project object from .stageadr
 * @param {string}   opts.preparedBy  — "Prepared by" credit line
 * @returns {Promise<Buffer>}
 */
function generateCueSheetPdf({ project, preparedBy }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin:      PAGE_MARGIN,
        size:        PAGE_SIZE,
        autoFirstPage: true,
        info: {
          Title:    'ADR List',
          Author:   preparedBy || 'Stage Post',
          Creator:  'Stage Post ADR Cue Recorder',
          Subject:  project.filmTitle || project.projectName || 'ADR List',
        },
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      _renderDocument(doc, project, preparedBy || '');
      doc.end();

    } catch (err) {
      reject(err);
    }
  });
}

// ── Document rendering ────────────────────────────────────────────────────────

function _renderDocument(doc, project, preparedBy) {
  const frameRate = project.settings?.frameRate || '25';

  // Build sorted cue rows with resolved character names
  const charMap = Object.fromEntries(
    (project.characters || []).map(c => [c.characterId, c.name])
  );

  const cues = [...(project.cues || [])]
    .sort((a, b) => a.inFrames - b.inFrames);

  const rows = cues.map(cue => ({
    character: charMap[cue.characterId] || '—',
    timecode:  _formatTimecode(cue.inFrames, cue.outFrames, frameRate),
    line:      (cue.dialogue || '').trim() || '—',
    notes:     (cue.notes    || '').trim(),
  }));

  // ── Page 1 header block ───────────────────────────────────────────────────
  _drawPageHeader(doc, project);
  const tableTopY = doc.y + 10;

  // ── Table ─────────────────────────────────────────────────────────────────
  _drawTable(doc, rows, tableTopY, preparedBy, project);
}

function _drawPageHeader(doc, project) {
  const centerX  = PAGE_MARGIN + CONTENT_W / 2;

  // Logo (or fallback text)
  const logoExists = fs.existsSync(LOGO_PATH);
  if (logoExists) {
    // Center the logo image
    const logoW = LOGO_FIT[0];
    doc.image(LOGO_PATH, centerX - logoW / 2, doc.y, {
      fit:   LOGO_FIT,
      align: 'center',
    });
    doc.moveDown(0.3);
  } else {
    // Fallback: bold text in brand colours (dark bg not possible in PDF default)
    doc.fontSize(22)
       .font('Helvetica-Bold')
       .fillColor('#333333')
       .text('STAGE POST', { align: 'center' });
    doc.moveDown(0.2);
  }

  // "ADR List" title
  doc.fontSize(16)
     .font('Helvetica-Bold')
     .fillColor('#000000')
     .text('ADR List', { align: 'center' });

  doc.moveDown(0.25);

  // Film title / project name
  const title = project.filmTitle
    ? `${project.filmTitle}  —  ${project.projectName}`
    : (project.projectName || '(untitled)');
  doc.fontSize(10)
     .font('Helvetica')
     .fillColor('#222222')
     .text(title, { align: 'center' });

  // Source file
  const fileName = project.video?.fileName || '(no video loaded)';
  doc.fontSize(8)
     .fillColor('#555555')
     .text(`Based on file: ${fileName}`, { align: 'center' });

  doc.fillColor('#000000');
  doc.moveDown(0.5);

  // Horizontal rule
  doc.moveTo(PAGE_MARGIN, doc.y)
     .lineTo(PAGE_MARGIN + CONTENT_W, doc.y)
     .lineWidth(0.5)
     .strokeColor('#999999')
     .stroke();
}

function _drawTable(doc, rows, startY, preparedBy, project) {
  let y = startY;
  let firstPage = true;

  const drawColumnHeaders = (atY) => {
    // Header background
    doc.rect(PAGE_MARGIN, atY, CONTENT_W, HEADER_H)
       .fill('#222222');

    doc.font('Helvetica-Bold')
       .fontSize(HEADER_FONT_SIZE)
       .fillColor('#ffffff');

    let x = PAGE_MARGIN;
    COLS.forEach(col => {
      doc.text(col.label, x + 3, atY + 5, { width: col.width - 6, lineBreak: false });
      x += col.width;
    });

    doc.fillColor('#000000');
    return atY + HEADER_H;
  };

  // Draw initial headers
  y = drawColumnHeaders(y);

  rows.forEach((row, rowIdx) => {
    const vals = [row.character, row.timecode, row.line, row.notes];

    // Calculate the height needed for this row (tallest cell wins)
    const cellHeights = vals.map((val, i) => {
      const h = doc.heightOfString(val || ' ', {
        width:    COLS[i].width - 6,
        fontSize: ROW_FONT_SIZE,
      });
      return Math.max(ROW_LINE_H, h) + ROW_PADDING * 2;
    });
    const rowH = Math.max(...cellHeights);

    // Page break check — leave space for footer
    const pageBottom = doc.page.height - PAGE_MARGIN - FOOTER_H;
    if (y + rowH > pageBottom) {
      // Draw footer on current page before breaking
      _drawFooter(doc, preparedBy);

      doc.addPage();
      y = PAGE_MARGIN;

      // Repeat column headers on new page
      _drawPageContinuationHeader(doc, project);
      y = doc.y + 4;
      y = drawColumnHeaders(y);
    }

    // Alternating row shading
    if (rowIdx % 2 === 0) {
      doc.rect(PAGE_MARGIN, y, CONTENT_W, rowH).fill('#f7f7f7');
    }

    // Row text
    doc.fillColor('#000000')
       .font('Helvetica')
       .fontSize(ROW_FONT_SIZE);

    let x = PAGE_MARGIN;
    vals.forEach((val, i) => {
      doc.text(val || '—', x + 3, y + ROW_PADDING, {
        width:    COLS[i].width - 6,
        lineBreak: true,
        height:   rowH - ROW_PADDING,
      });
      x += COLS[i].width;
    });

    // Thin bottom border for each row
    doc.moveTo(PAGE_MARGIN, y + rowH)
       .lineTo(PAGE_MARGIN + CONTENT_W, y + rowH)
       .lineWidth(0.25)
       .strokeColor('#dddddd')
       .stroke();

    y += rowH;
  });

  // Empty state
  if (rows.length === 0) {
    doc.font('Helvetica')
       .fontSize(9)
       .fillColor('#888888')
       .text('No cues in this project.', PAGE_MARGIN, y + 10, { align: 'center' });
    y += 30;
  }

  // Final footer
  _drawFooter(doc, preparedBy);
}

function _drawPageContinuationHeader(doc, project) {
  const title = project.filmTitle
    ? `${project.filmTitle} — ${project.projectName}`
    : (project.projectName || 'ADR List');
  doc.fontSize(8)
     .font('Helvetica-Oblique')
     .fillColor('#666666')
     .text(`ADR List (continued) — ${title}`, PAGE_MARGIN, PAGE_MARGIN, {
       align: 'left',
     });
  doc.moveDown(0.2);
  doc.moveTo(PAGE_MARGIN, doc.y)
     .lineTo(PAGE_MARGIN + CONTENT_W, doc.y)
     .lineWidth(0.5)
     .strokeColor('#cccccc')
     .stroke();
  doc.moveDown(0.3);
}

function _drawFooter(doc, preparedBy) {
  const footerY = doc.page.height - PAGE_MARGIN - 16;
  // Thin rule
  doc.moveTo(PAGE_MARGIN, footerY - 6)
     .lineTo(PAGE_MARGIN + CONTENT_W, footerY - 6)
     .lineWidth(0.5)
     .strokeColor('#aaaaaa')
     .stroke();

  doc.fontSize(8)
     .font('Helvetica')
     .fillColor('#444444');

  const byLine = preparedBy ? `Prepared by: ${preparedBy}` : '';
  doc.text(byLine, PAGE_MARGIN, footerY, {
    width:  CONTENT_W / 2,
    lineBreak: false,
  });

  // Page number right-aligned
  const pageNum = `Page ${doc.bufferedPageRange().count}`;
  doc.text(pageNum, PAGE_MARGIN + CONTENT_W / 2, footerY, {
    width:  CONTENT_W / 2,
    align: 'right',
    lineBreak: false,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format In and Out frames as "HH:MM:SS:FF - HH:MM:SS:FF".
 * Uses authoritative framesToTimecode from core/timecode.js.
 */
function _formatTimecode(inFrames, outFrames, frameRate) {
  const tcIn  = framesToTimecode(inFrames,  frameRate);
  const tcOut = framesToTimecode(outFrames, frameRate);
  return `${tcIn} - ${tcOut}`;
}

module.exports = { generateCueSheetPdf };
