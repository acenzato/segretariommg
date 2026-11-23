#!/usr/bin/env node
// Genera segretario.js (content script unico caricato da Chrome) a partire
// dai moduli in src/. I moduli sono CommonJS per poter essere eseguiti anche
// in Node; qui vengono rimossi require/module.exports e i corpi vengono
// concatenati, nell'ordine indicato, dentro un'unica IIFE.
// segretario.js non è versionato: test, CI e installer lo rigenerano.
//
//   node tools/build_extension.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "segretario.js");

// Ordine di concatenazione: ogni modulo può dipendere solo dai precedenti.
// src/engine/host.js non è incluso: nell'estensione i suoi hook sono le
// funzioni omonime definite in src/extension/content.js.
export const MODULES = [
  "src/engine/core.js",
  "src/engine/catalog.js",
  "src/engine/long-report.js",
  "src/engine/extraction.js",
  "src/engine/pdf-text.js",
  "src/engine/unprescribed.js",
  "src/engine/workflow.js",
  "src/extension/content.js",
];

const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "script",
  allowReturnOutsideFunction: true,
  locations: true,
};

function isRequireDeclaration(node) {
  return node.type === "VariableDeclaration" &&
    node.declarations.every(d =>
      d.init?.type === "CallExpression" &&
      d.init.callee.type === "Identifier" &&
      d.init.callee.name === "require"
    );
}

function isModuleExports(node) {
  const e = node.type === "ExpressionStatement" ? node.expression : null;
  return e?.type === "AssignmentExpression" &&
    e.left.type === "MemberExpression" &&
    e.left.object.name === "module" &&
    e.left.property.name === "exports";
}

function isUseStrict(node) {
  return node.type === "ExpressionStatement" && node.directive === "use strict";
}

// Righe che iniziano dentro un template literal o una stringa multilinea:
// la loro indentazione fa parte del valore e non va toccata.
function protectedLines(source) {
  const starts = [];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  const result = new Set();
  for (const token of acorn.tokenizer(source, PARSE_OPTIONS)) {
    const isTemplate = token.type === acorn.tokTypes.template ||
      token.type === acorn.tokTypes.invalidTemplate;
    if (!isTemplate && token.type !== acorn.tokTypes.string) continue;
    if (!source.slice(token.start, token.end + 1).includes("\n")) continue;
    starts.forEach((p, index) => {
      const inside = isTemplate
        ? p > token.start && p <= token.end
        : p > token.start && p < token.end;
      if (inside) result.add(index + 2); // starts[0] è l'inizio della riga 2
    });
  }
  return result;
}

export function moduleBody(file, source) {
  source = source.replace(/\r\n/g, "\n");
  const ast = acorn.parse(source, PARSE_OPTIONS);
  const lines = source.split("\n");
  const drop = new Set();
  for (const node of ast.body) {
    if (!(isUseStrict(node) || isRequireDeclaration(node) || isModuleExports(node))) continue;
    for (let l = node.loc.start.line; l <= node.loc.end.line; l++) drop.add(l - 1);
  }
  const kept = lines.filter((_, i) => !drop.has(i)).join("\n").replace(/^\n+|\n+$/g, "");
  // Nel bundle require/module non esistono: ammessi solo nell'intestazione.
  if (/\brequire\s*\(|\bmodule\.exports\b/.test(kept)) {
    throw new Error(`${file}: require/module.exports fuori dall'intestazione del modulo.`);
  }
  const keep = protectedLines(kept);
  return kept.split("\n")
    .map((line, i) => (line && !keep.has(i + 1) ? `  ${line}` : line))
    .join("\n");
}

export function buildExtension() {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const prologue = `(() => {
  "use strict";

  // ============================================================
  // SEGRETARIO MMG
  // Versione ${version}
  //
  // FILE GENERATO da tools/build_extension.mjs: non modificarlo a mano.
  // Sorgenti: src/engine (algoritmi, eseguibili anche in Node) e
  // src/extension (interfaccia Eumed, Vaadin, Chrome, Ollama).
  //
  // - Estrazione con Qwen 3.5 4B locale
  // - Comunicazione diretta Ollama via service worker Chrome
  // - Streaming + keep_alive + referti a blocchi
  // - Structured JSON
  // - Resolver semantico esami
  // - Conversione deterministica unità
  // - Valore + Min + Max + Data referto
  // - Referti lunghi: Emocromo / Urine / Protidogramma / Tipizzazione
  // - Catalogo laboratorio CVP locale per sinonimi e classificazione
  // - PDF/JPEG/PNG locali; PaddleOCR locale per OCR dei file scannerizzati
  // - Verifica numerica/data dopo ogni scrittura Vaadin
  // - Salvataggio finale SEMPRE manuale
  // ============================================================
`;
  const bodies = MODULES.map(file =>
    moduleBody(file, fs.readFileSync(path.join(root, file), "utf8"))
  );
  return `${prologue}\n${bodies.join("\n\n")}\n})();\n`;
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const generated = buildExtension();
  fs.writeFileSync(output, generated);
  console.log(`Generato ${path.relative(root, output)} (${generated.split("\n").length} righe).`);
}
