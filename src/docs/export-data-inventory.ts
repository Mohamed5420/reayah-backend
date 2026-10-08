/**
 * Builds docs/DATA_INVENTORY.docx (for counsel) from docs/DATA_INVENTORY.md, the source of truth.
 * Run after every change to the inventory: `npm run docs:inventory`. Dev-only (uses the `docx` dev
 * dependency); understands the subset of Markdown the inventory uses: `#` / `##` headings, paragraphs,
 * `-` bullets, `1.` lists, pipe tables, **bold** and `code`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

const DOCS = path.resolve(__dirname, '../../docs');
const SOURCE = path.join(DOCS, 'DATA_INVENTORY.md');
const TARGET = path.join(DOCS, 'DATA_INVENTORY.docx');

const FONT = 'Calibri';
const BODY_SIZE = 21; // half-points: 10.5 pt
const TABLE_SIZE = 18; // 9 pt

/** **bold** and `code` runs. */
const runs = (text: string, size = BODY_SIZE, bold = false): TextRun[] =>
  text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('**'))
        return new TextRun({ text: part.slice(2, -2), bold: true, size, font: FONT });
      if (part.startsWith('`')) return new TextRun({ text: part.slice(1, -1), size, font: 'Consolas' });
      return new TextRun({ text: part, bold, size, font: FONT });
    });

const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const border = { style: BorderStyle.SINGLE, size: 4, color: 'B7C3D0' };

const table = (rows: string[][]) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows: rows.map(
      (cells, i) =>
        new TableRow({
          tableHeader: i === 0,
          children: cells.map(
            (cell) =>
              new TableCell({
                shading: i === 0 ? { type: ShadingType.CLEAR, fill: 'E7EEF7', color: 'auto' } : undefined,
                margins: { top: 60, bottom: 60, left: 80, right: 80 },
                children: [new Paragraph({ children: runs(cell, TABLE_SIZE, i === 0) })],
              }),
          ),
        }),
    ),
  });

const build = (markdown: string) => {
  const children: Array<Paragraph | Table> = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.startsWith('# ')) {
      children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: runs(line.slice(2), 40, true) }));
    } else if (line.startsWith('## ')) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 280, after: 120 },
          children: runs(line.slice(3), 28, true),
        }),
      );
    } else if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        if (!/^\|\s*-/.test(lines[i])) rows.push(cellsOf(lines[i]));
        i++;
      }
      i--;
      children.push(table(rows), new Paragraph({ children: [] }));
    } else if (line.startsWith('- ')) {
      children.push(
        new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: runs(line.slice(2)) }),
      );
    } else if (/^\d+\. /.test(line)) {
      children.push(
        new Paragraph({
          numbering: { reference: 'numbers', level: 0 },
          spacing: { after: 80 },
          children: runs(line.replace(/^\d+\. /, '')),
        }),
      );
    } else {
      children.push(new Paragraph({ spacing: { after: 120 }, children: runs(line) }));
    }
  }
  return new Document({
    creator: 'Reaya+',
    title: 'Reaya+ Personal Data Inventory',
    styles: { default: { document: { run: { font: FONT, size: BODY_SIZE } } } },
    numbering: {
      config: [
        {
          reference: 'numbers',
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: { top: 850, bottom: 850, left: 850, right: 850 },
          },
        },
        children,
      },
    ],
  });
};

const main = async () => {
  const buffer = await Packer.toBuffer(build(fs.readFileSync(SOURCE, 'utf8')));
  fs.writeFileSync(TARGET, buffer);
  console.log(`Written ${path.relative(process.cwd(), TARGET)} (${buffer.length} bytes)`);
};

void main();
