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
const HEADER_BODY_START_Y = 100;

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
 * Draws the letterhead: logo top-left (if present), org name beside/at the
 * logo position, the report title centered below, and a horizontal rule
 * separating header from body. Leaves doc.y at a fixed value so body
 * content starts at the same position whether or not a logo was drawn.
 */
export function addLetterhead(
  doc: PDFKit.PDFDocument,
  opts: { orgName: string; logoPath: string | null; reportTitle: string },
): void {
  const { orgName, logoPath, reportTitle } = opts;
  const pageWidth = doc.page.width;
  const marginLeft = doc.page.margins.left;
  const marginRight = doc.page.margins.right;

  let textStartX = marginLeft;

  if (logoPath) {
    try {
      doc.image(logoPath, marginLeft, 30, { width: 50, height: 50, fit: [50, 50] });
      textStartX = marginLeft + 62;
    } catch {
      // Corrupt/unreadable image file — fall back to no-logo layout silently.
      textStartX = marginLeft;
    }
  }

  if (orgName) {
    doc
      .fontSize(14)
      .font('Helvetica-Bold')
      .text(orgName, textStartX, 40, { width: pageWidth - textStartX - marginRight });
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .text(reportTitle, marginLeft, 88, {
      width: pageWidth - marginLeft - marginRight,
      align: 'center',
    });

  doc.font('Helvetica');

  doc
    .moveTo(marginLeft, HEADER_BODY_START_Y - 8)
    .lineTo(pageWidth - marginRight, HEADER_BODY_START_Y - 8)
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
  const generatedOn = new Date().toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

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

    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#555555')
      .text(`Generated on ${generatedOn}`, marginLeft, footerY, {
        width: (pageWidth - marginLeft - marginRight) / 2,
        align: 'left',
      });

    doc.text(`Page ${i - range.start + 1} of ${range.count}`, marginLeft, footerY, {
      width: pageWidth - marginLeft - marginRight,
      align: 'right',
    });

    doc.fillColor('#000000');
  }
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
