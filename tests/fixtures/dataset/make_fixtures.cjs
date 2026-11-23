// Genera i PDF testuali dei casi sintetici in tests/fixtures/dataset.
// Uso: node tests/fixtures/dataset/make_fixtures.cjs
// I referti qui sotto sono inventati: nessun dato reale di pazienti.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPORTS = {
  "synth-inline-0001": [
    "LABORATORIO SINTETICO DI PROVA - REFERTO FITTIZIO",
    "Paziente: CASO SINTETICO",
    "Data referto: 03/11/2026",
    "EMATOLOGIA",
    "ES. EMOCROMOCITOMETRICO",
    "Leucociti 6,10 x10^3/mmc [4,50 - 11,00]",
    "Eritrociti 4,90 x10^6/mmc [4,50 - 6,10]",
    "Emoglobina 14,8 g/dL [14,0 - 18,0]",
    "Ematocrito 44,2 % [40,0 - 50,0]",
    "Volume cellulare medio 90,2 fL [80,0 - 99,0]",
    "Piastrine 241 x10^3/mmc [130 - 400]",
    "CHIMICA CLINICA",
    "P-GLUCOSIO 94 mg/dL [74 - 106]",
    "P-CREATININA * 1,22 mg/dL [0,72 - 1,18]",
    "P-TRIGLICERIDI 52 mg/dL [30,0 - 150,0]",
    "P-COLESTEROLO 172 mg/dL [80 - 200]",
    "P-HDL-COLESTEROLO 62 mg/dL [45 - 130]",
    "Validazione assistita da sistema esperto",
  ],
};

const escapePdfText = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);

// PDF 1.4 minimale, una pagina A4, Helvetica, una riga di testo per riga.
function buildTextPdf(lines) {
  const content = [
    "BT",
    "/F1 10 Tf",
    "14 TL",
    "50 800 Td",
    ...lines.map((line, i) => `${i ? "T* " : ""}(${escapePdfText(line)}) Tj`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

if (require.main === module) {
  for (const [caseId, lines] of Object.entries(REPORTS)) {
    const file = path.join(__dirname, "cases", caseId, "source.pdf");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buildTextPdf(lines));
    console.log(`scritto ${path.relative(process.cwd(), file)}`);
  }
}

module.exports = { REPORTS, buildTextPdf };
