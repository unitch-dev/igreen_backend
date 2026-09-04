import * as fs from 'fs';
import * as path from 'path';

/**
 * Shared pdfkit layout helpers used by every report PDF builder in
 * ReportsService — letterhead (logo + org name + title), a real bordered
 * table renderer with page-overflow handling, and a "Generated on ... /
 * Page X of Y" footer applied once per document via bufferedPageRange.
 */

const PAGE_BOTTOM_MARGIN = 40;
const FOOTER_RESERVED_HEIGHT = 70;
// Separator rule sits below the centered logo/org-name/title stack (logo
// bottom=95 when present, title bottom~123.4 otherwise), with body content
// starting a further 10pt below the rule. See addLetterhead().
const HEADER_SEPARATOR_Y = 133;
const HEADER_BODY_START_Y = 143;

/** Formats a Date as `YYYY-MM-DD HH:mm` in the server's local time (24-hour). */
function formatGeneratedOn(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Resolves an Organization.logoUrl (a full URL of shape
 * `${appUrl}/uploads/${key}`) to an absolute local file path suitable for
 * pdfkit's doc.image(). Returns null (never throws) when the logo is
 * missing, external/CDN-hosted (prefix mismatch), or the resolved file does
 * not exist on disk — callers must render the letterhead without a logo in
 * every one of those cases.
 */
export function resolveLogoPath(
  logoUrl: string | null | undefined,
  appUrl: string,
  localDir: string,
): string | null {
  if (!logoUrl) return null;

  const prefix = `${appUrl}/uploads/`;
  if (!logoUrl.startsWith(prefix)) return null;

  const relativeKey = logoUrl.slice(prefix.length);
  if (!relativeKey) return null;

  const absoluteDir = path.isAbsolute(localDir) ? localDir : path.join(process.cwd(), localDir);
  const resolved = path.join(absoluteDir, relativeKey);

  return fs.existsSync(resolved) ? resolved : null;
}

/**
 * Draws the letterhead centered as a single block on the page: logo (if
 * present) centered horizontally, the org name centered below it, the
 * report title centered below that, and a horizontal rule separating the
 * header from the body. Vertical positions are fixed regardless of whether
 * a logo is present, so the layout stays consistent across report types.
 */
export function addLetterhead(
  doc: PDFKit.PDFDocument,
  opts: { orgName: string; logoPath: string | null; reportTitle: string },
): void {
  const { orgName, logoPath, reportTitle } = opts;
  const pageWidth = doc.page.width;
  const marginLeft = doc.page.margins.left;
  const marginRight = doc.page.margins.right;
  const contentWidth = pageWidth - marginLeft - marginRight;

  if (logoPath) {
    try {
      const logoSize = 50;
      doc.image(logoPath, (pageWidth - logoSize) / 2, 25, {
        width: logoSize,
        height: logoSize,
        fit: [logoSize, logoSize],
      });
    } catch {
      // Corrupt/unreadable image file — fall back to no-logo layout silently.
    }
  }

  if (orgName) {
    doc
      .fontSize(14)
      .font('Helvetica-Bold')
      .text(orgName, marginLeft, 80, { width: contentWidth, align: 'center' });
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .text(reportTitle, marginLeft, 100, { width: contentWidth, align: 'center' });

  doc.font('Helvetica');

  doc
    .moveTo(marginLeft, HEADER_SEPARATOR_Y)
    .lineTo(pageWidth - marginRight, HEADER_SEPARATOR_Y)
    .lineWidth(1)
    .strokeColor('#999999')
    .stroke();

  doc.strokeColor('#000000');
  doc.y = HEADER_BODY_START_Y;
  doc.x = marginLeft;
}

/**
 * Draws "Generated on <date>" (left) and "Page X of Y" (right) on every
 * buffered page. Must be called ONCE, right before doc.end(), on a document
 * constructed with { bufferPages: true }.
 */
export function addFooter(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  const marginLeft = doc.page.margins.left;
  const marginRight = doc.page.margins.right;
  const generatedOn = formatGeneratedOn(new Date());

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const pageWidth = doc.page.width;
    const footerY = doc.page.height - PAGE_BOTTOM_MARGIN + 5;

    doc
      .moveTo(marginLeft, footerY - 8)
      .lineTo(pageWidth - marginRight, footerY - 8)
      .lineWidth(0.5)
      .strokeColor('#cccccc')
      .stroke();
    doc.strokeColor('#000000');

    // footerY (page.height - 35) sits BELOW the printable area's bottom
    // margin (page.height - margins.bottom, i.e. page.height - 40) by
    // design — footers live in the reserved margin strip. pdfkit's
    // auto-pagination triggers whenever a text write's y + height would
    // cross that margin boundary, so writing here with the real bottom
    // margin still in effect silently appends a fresh (blank) page on
    // every single footer line. Neutralize it for the duration of these
    // writes only, then restore, so nothing after this loop is affected.
    const realBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#555555')
      .text(`Generated on ${generatedOn}`, marginLeft, footerY, {
        width: (pageWidth - marginLeft - marginRight) / 2,
        align: 'left',
        lineBreak: false,
      });

    doc.text(`Page ${i - range.start + 1} of ${range.count}`, marginLeft, footerY, {
      width: pageWidth - marginLeft - marginRight,
      align: 'right',
      lineBreak: false,
    });

    doc.page.margins.bottom = realBottomMargin;
    doc.fillColor('#000000');
  }
}

const STAT_CARD_HEIGHT = 55;
const STAT_CARD_GAP = 10;

/**
 * Draws bordered "stat cards" side-by-side across the printable width,
 * mirroring the UI's KPI stat-card grid (muted label on top, bold value
 * below). Advances doc.y past the cards afterward.
 */
export function drawStatCards(
  doc: PDFKit.PDFDocument,
  cards: { label: string; value: string }[],
): void {
  if (cards.length === 0) return;

  const marginLeft = doc.page.margins.left;
  const marginRight = doc.page.margins.right;
  const totalWidth = doc.page.width - marginLeft - marginRight;
  const cardWidth = (totalWidth - STAT_CARD_GAP * (cards.length - 1)) / cards.length;
  const y = doc.y;

  let x = marginLeft;
  for (const card of cards) {
    doc.rect(x, y, cardWidth, STAT_CARD_HEIGHT).stroke('#cccccc');
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#666666')
      .text(card.label, x + 8, y + 10, { width: cardWidth - 16, ellipsis: true, lineBreak: false });
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#000000')
      .text(card.value, x + 8, y + 28, { width: cardWidth - 16, ellipsis: true, lineBreak: false });
    x += cardWidth + STAT_CARD_GAP;
  }

  doc.font('Helvetica').fontSize(11).fillColor('#000000');
  doc.y = y + STAT_CARD_HEIGHT + 15;
  doc.x = marginLeft;
}

const GRID_ROW_HEIGHT = 30;
const GRID_COLUMN_GAP = 10;

/**
 * Lays label:value pairs into N columns left-to-right, wrapping to as many
 * rows as needed, mirroring the UI's "Component Breakdown" grid. Each cell
 * shows a muted label above a bold-ish value. Adds a page (no header repeat
 * needed — this isn't a table) whenever a new row would overflow into the
 * footer's reserved space.
 */
export function drawLabelValueGrid(
  doc: PDFKit.PDFDocument,
  items: { label: string; value: string }[],
  columns: number,
): void {
  if (items.length === 0) return;

  const marginLeft = doc.page.margins.left;
  const marginRight = doc.page.margins.right;
  const totalWidth = doc.page.width - marginLeft - marginRight;
  const columnWidth = (totalWidth - GRID_COLUMN_GAP * (columns - 1)) / columns;

  const ensureSpace = (): void => {
    if (doc.y + GRID_ROW_HEIGHT > doc.page.height - FOOTER_RESERVED_HEIGHT) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
  };

  for (let i = 0; i < items.length; i += columns) {
    ensureSpace();
    const rowItems = items.slice(i, i + columns);
    const y = doc.y;
    let x = marginLeft;
    for (const item of rowItems) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#666666')
        .text(item.label, x, y, { width: columnWidth, ellipsis: true, lineBreak: false });
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#000000')
        .text(item.value, x, y + 13, { width: columnWidth, ellipsis: true, lineBreak: false });
      x += columnWidth + GRID_COLUMN_GAP;
    }
    doc.y = y + GRID_ROW_HEIGHT;
    doc.x = marginLeft;
  }

  doc.font('Helvetica').fontSize(11).fillColor('#000000');
}

const LIST_ROW_HEIGHT = 16;

/**
 * Draws one line per row: left text left-aligned, right text right-aligned
 * on the same line, mirroring the UI's "Live Now" / "System Changes" lists.
 * Adds a page whenever the next row would overflow into the footer's
 * reserved space (no header to repeat).
 */
export function drawList(doc: PDFKit.PDFDocument, rows: { left: string; right: string }[]): void {
  const marginLeft = doc.page.margins.left;
  const marginRight = doc.page.margins.right;
  const totalWidth = doc.page.width - marginLeft - marginRight;

  if (rows.length === 0) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor('#666666')
      .text('No records found.', marginLeft, doc.y, { width: totalWidth });
    doc.font('Helvetica').fillColor('#000000');
    doc.x = marginLeft;
    return;
  }

  const halfWidth = (totalWidth - GRID_COLUMN_GAP) / 2;

  for (const row of rows) {
    if (doc.y + LIST_ROW_HEIGHT > doc.page.height - FOOTER_RESERVED_HEIGHT) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
    const y = doc.y;
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#000000')
      .text(row.left, marginLeft, y, { width: halfWidth, ellipsis: true, lineBreak: false });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#555555')
      .text(row.right, marginLeft + halfWidth + GRID_COLUMN_GAP, y, {
        width: halfWidth,
        align: 'right',
        ellipsis: true,
        lineBreak: false,
      });
    doc.y = y + LIST_ROW_HEIGHT;
    doc.x = marginLeft;
  }

  doc.fillColor('#000000');
}

interface DrawTableOptions {
  headers: string[];
  rows: (string | number)[][];
  columnWidths: number[];
  startX?: number;
  fontSize?: number;
}

const ROW_HEIGHT = 20;
const HEADER_FONT_SIZE = 9;

/**
 * Draws a real bordered table: shaded/bold header row, bordered data cells,
 * per-column text clipped to its column width. Handles page overflow by
 * starting a new page and re-drawing the header whenever the next row would
 * overflow into the footer's reserved space.
 */
export function drawTable(doc: PDFKit.PDFDocument, opts: DrawTableOptions): void {
  const { headers, rows, columnWidths, fontSize = 8 } = opts;
  const startX = opts.startX ?? doc.page.margins.left;
  const tableWidth = columnWidths.reduce((a, b) => a + b, 0);

  const drawHeaderRow = (): void => {
    const y = doc.y;
    doc.rect(startX, y, tableWidth, ROW_HEIGHT).fill('#e5e5e5');
    doc.fillColor('#000000');
    doc.rect(startX, y, tableWidth, ROW_HEIGHT).stroke();

    let x = startX;
    doc.font('Helvetica-Bold').fontSize(HEADER_FONT_SIZE);
    for (let i = 0; i < headers.length; i++) {
      doc.rect(x, y, columnWidths[i], ROW_HEIGHT).stroke();
      doc.text(headers[i], x + 3, y + 6, {
        width: columnWidths[i] - 6,
        height: ROW_HEIGHT - 6,
        ellipsis: true,
        lineBreak: false,
      });
      x += columnWidths[i];
    }
    doc.font('Helvetica').fontSize(fontSize);
    doc.y = y + ROW_HEIGHT;
    doc.x = startX;
  };

  const ensureSpace = (): void => {
    if (doc.y + ROW_HEIGHT > doc.page.height - FOOTER_RESERVED_HEIGHT) {
      doc.addPage();
      doc.y = doc.page.margins.top;
      drawHeaderRow();
    }
  };

  drawHeaderRow();

  if (rows.length === 0) {
    const y = doc.y;
    doc.rect(startX, y, tableWidth, ROW_HEIGHT).stroke();
    doc
      .font('Helvetica-Oblique')
      .fontSize(fontSize)
      .text('No records found.', startX + 3, y + 6, { width: tableWidth - 6, lineBreak: false });
    doc.font('Helvetica');
    doc.y = y + ROW_HEIGHT;
    doc.x = startX;
    return;
  }

  for (const row of rows) {
    ensureSpace();
    const y = doc.y;
    let x = startX;
    doc.fontSize(fontSize);
    for (let i = 0; i < row.length; i++) {
      doc.rect(x, y, columnWidths[i], ROW_HEIGHT).stroke();
      doc.text(String(row[i] ?? ''), x + 3, y + 6, {
        width: columnWidths[i] - 6,
        height: ROW_HEIGHT - 6,
        ellipsis: true,
        lineBreak: false,
      });
      x += columnWidths[i];
    }
    doc.y = y + ROW_HEIGHT;
    doc.x = startX;
  }
}
