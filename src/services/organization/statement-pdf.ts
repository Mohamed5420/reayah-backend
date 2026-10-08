import path from 'node:path';
import PDFDocument from 'pdfkit';
import { t } from '../../utils/i18n';
import type { IOrgStatement } from '../../interfaces/IOrganization';

/** Noto Naskh Arabic (SIL Open Font License), shipped with the @expo-google-fonts package. */
const fontDir = path.dirname(require.resolve('@expo-google-fonts/noto-naskh-arabic/package.json'));
const REGULAR = path.join(fontDir, '400Regular/NotoNaskhArabic_400Regular.ttf');
const BOLD = path.join(fontDir, '700Bold/NotoNaskhArabic_700Bold.ttf');

/** Latin letters, digits and their punctuation: kept left-to-right inside an Arabic line. */
const LTR_RUN = /[0-9A-Za-z][0-9A-Za-z.,\-/#]*[0-9A-Za-z]|[0-9A-Za-z]/g;

/**
 * pdfkit lays an Arabic line out right-to-left (the font's `rtla` feature) by reversing the whole line,
 * which would also reverse numbers and Latin text ("2026" → "6202") and mirror brackets. Pre-reversing
 * those runs and swapping brackets makes the final line read correctly.
 */
export const rtlLine = (text: string) =>
  text
    .replace(LTR_RUN, (run) => [...run].reverse().join(''))
    .replace(/[()]/g, (c) => (c === '(' ? ')' : '('));

const egp = (piastres: number) =>
  (piastres / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The monthly statement as an Arabic A4 PDF (decision M3.4: a statement, clearly not a tax invoice). */
export const renderStatementPdf = (
  statement: IOrgStatement,
  org: { name: string; commercialRegisterNo: string },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: statement.number } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('regular', REGULAR);
    doc.registerFont('bold', BOLD);
    const line = (text: string, options: { font?: 'regular' | 'bold'; size?: number; gap?: number } = {}) => {
      doc
        .font(options.font ?? 'regular')
        .fontSize(options.size ?? 12)
        .text(rtlLine(text), { align: 'right', features: ['rtla'] });
      doc.moveDown(options.gap ?? 0.3);
    };

    line(t('statement.title'), { font: 'bold', size: 20, gap: 0.2 });
    line(t('statement.not_tax_invoice'), { size: 10, gap: 1 });
    line(t('statement.organization', { name: org.name }));
    line(t('statement.commercial_register', { number: org.commercialRegisterNo }));
    line(t('statement.period', { period: statement.period }));
    line(t('statement.number', { number: statement.number }), { gap: 1 });
    line(t('statement.commission', { visits: statement.visits, amount: egp(statement.commission) }));
    if (statement.subscriptionFees)
      line(t('statement.subscription', { amount: egp(statement.subscriptionFees) }));
    if (statement.subscriptionCredits) {
      line(t('statement.subscription_credit', { amount: egp(statement.subscriptionCredits) }));
    }
    doc.moveDown(0.5);
    line(t('statement.total', { amount: egp(statement.total) }), { font: 'bold', size: 14, gap: 1 });
    line(t('statement.settlement'), { size: 10 });
    doc.end();
  });
