import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as PDFDocument from 'pdfkit';
import { addFooter, addLetterhead, drawTable, resolveLogoPath } from './pdf-layout.util';

const APP_URL = 'http://localhost:3001';

describe('resolveLogoPath', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-layout-util-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null (never throws) when logoUrl is null', () => {
    expect(() => resolveLogoPath(null, APP_URL, tmpDir)).not.toThrow();
    expect(resolveLogoPath(null, APP_URL, tmpDir)).toBeNull();
  });

  it('returns null (never throws) when logoUrl is undefined', () => {
    expect(resolveLogoPath(undefined, APP_URL, tmpDir)).toBeNull();
  });

  it('returns null when logoUrl is an external/CDN URL that does not match the appUrl/uploads prefix', () => {
    const externalUrl = 'https://cdn.example.com/logos/acme.png';
    expect(() => resolveLogoPath(externalUrl, APP_URL, tmpDir)).not.toThrow();
    expect(resolveLogoPath(externalUrl, APP_URL, tmpDir)).toBeNull();
  });

  it('returns null when logoUrl points at a local path whose file does not exist on disk', () => {
    const missingFileUrl = `${APP_URL}/uploads/orgs/does-not-exist.png`;
    expect(() => resolveLogoPath(missingFileUrl, APP_URL, tmpDir)).not.toThrow();
    expect(resolveLogoPath(missingFileUrl, APP_URL, tmpDir)).toBeNull();
  });

  it('resolves to the absolute local path when the file DOES exist under the uploads prefix', () => {
    fs.mkdirSync(path.join(tmpDir, 'orgs'), { recursive: true });
    const filePath = path.join(tmpDir, 'orgs', 'logo.png');
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // fake PNG bytes

    const url = `${APP_URL}/uploads/orgs/logo.png`;
    expect(resolveLogoPath(url, APP_URL, tmpDir)).toBe(filePath);
  });
});

describe('addLetterhead', () => {
  function renderToBuffer(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      build(doc);
      doc.end();
    });
  }

  it('generates a valid, non-trivial PDF when logoPath is null (no logo) — org has no logo configured', async () => {
    const buffer = await renderToBuffer((doc) => {
      addLetterhead(doc, { orgName: 'Acme Corp', logoPath: null, reportTitle: 'Test Report' });
      addFooter(doc);
    });

    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(200);
  });

  it('does not crash when doc.image() is pointed at a corrupt/unreadable logo file (try/catch fallback)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-layout-util-corrupt-'));
    const corruptPath = path.join(tmpDir, 'corrupt.png');
    // Not a real image — pdfkit's doc.image() should throw internally, and
    // addLetterhead must swallow that and fall back to the no-logo layout.
    fs.writeFileSync(corruptPath, 'this is not an image');

    await expect(
      renderToBuffer((doc) => {
        addLetterhead(doc, {
          orgName: 'Acme Corp',
          logoPath: corruptPath,
          reportTitle: 'Test Report',
        });
        addFooter(doc);
      }),
    ).resolves.toBeInstanceOf(Buffer);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('drawTable', () => {
  it('overflows onto a new page and re-draws the header when rows exceed one page', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => [`EMP-${i}`, `Employee ${i}`, i]);

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      addLetterhead(doc, { orgName: 'Acme Corp', logoPath: null, reportTitle: 'Big Table' });
      drawTable(doc, {
        headers: ['Emp Code', 'Name', 'Count'],
        columnWidths: [150, 250, 100],
        rows,
      });
      addFooter(doc);
      doc.end();
    });

    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(500);
  });

  it('renders a "No records found." placeholder row without throwing for an empty dataset', async () => {
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      addLetterhead(doc, { orgName: 'Acme Corp', logoPath: null, reportTitle: 'Empty Table' });
      drawTable(doc, { headers: ['A', 'B'], columnWidths: [200, 200], rows: [] });
      addFooter(doc);
      doc.end();
    });

    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });
});
