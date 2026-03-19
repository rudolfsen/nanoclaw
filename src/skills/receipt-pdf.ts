import PDFDocument from 'pdfkit';
import fs from 'fs';

export interface ReceiptData {
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  reference?: string;
  description?: string;
}

export async function generateReceiptPdf(
  receipt: ReceiptData,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.fontSize(20).text('Kvittering', { align: 'center' });
    doc.moveDown();

    doc.fontSize(12);
    doc.text(`Leverandør: ${receipt.vendor}`);
    doc.text(`Dato: ${receipt.date}`);
    doc.text(`Beløp: ${receipt.amount.toFixed(2)} ${receipt.currency}`);
    if (receipt.reference) {
      doc.text(`Referanse: ${receipt.reference}`);
    }
    if (receipt.description) {
      doc.moveDown();
      doc.text(`Beskrivelse: ${receipt.description}`);
    }

    doc.moveDown(2);
    doc
      .fontSize(8)
      .fillColor('gray')
      .text('Generert automatisk av NanoClaw assistent', { align: 'center' });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}
