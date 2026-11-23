// Estrazione del testo da PDF testuali in Node, con la stessa ricostruzione
// delle righe dell'estensione. Le pagine scansionate non sono supportate.
"use strict";

const fs = require("node:fs");
const { CONFIG } = require("../engine/core");
const { textContentToLines } = require("../engine/pdf-text");

let pdfJsPromise = null;

function loadPdfJs() {
  if (!pdfJsPromise) pdfJsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfJsPromise;
}

async function extractTextFromPdfBytes(bytes) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;

  try {
    const pageTexts = [];
    const scannedPages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const pageText = textContentToLines(await page.getTextContent()).trim();
      if (pageText.replace(/\s/g, "").length < CONFIG.pdfTextPageMinChars) {
        scannedPages.push(pageNumber);
        continue;
      }
      pageTexts.push(`=== PAGINA ${pageNumber} - TESTO PDF ===\n${pageText}`);
    }
    if (scannedPages.length) {
      throw new Error(
        `Pagine senza testo PDF (OCR non supportato in modalità standalone): ${scannedPages.join(", ")}.`
      );
    }
    return pageTexts.join("\n\n").trim();
  } finally {
    await loadingTask.destroy();
  }
}

async function extractTextFromPdfFile(path) {
  return extractTextFromPdfBytes(await fs.promises.readFile(path));
}

module.exports = {
  extractTextFromPdfBytes,
  extractTextFromPdfFile,
};
