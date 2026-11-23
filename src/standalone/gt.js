// Validazione di gt.eumed.json secondo dataset_format.md, sezione 3.7.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CASE_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SOURCE_TYPES = ["text_pdf", "scan_pdf", "mixed_pdf", "image"];
const LAB_LAYOUTS = [
  "SYNLAB_DATA_MEDICA",
  "AOU_PADOVA",
  "ULSS6_SCHIAVONIA",
  "INLINE_CBC_CHEMISTRY",
  "OTHER",
];
const TARGET_FIELDS = {
  filled: { required: ["value", "unit", "min", "max", "source"], optional: [] },
  absent: { required: [], optional: ["source"] },
  long_report: { required: ["must_contain"], optional: ["source"] },
  uncertain: { required: ["reason"], optional: ["source"] },
};

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNumericString = (s) => /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(String(s).trim().replace(",", "."));

function isIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

function checkFields(errors, where, obj, required, optional = []) {
  if (!isObject(obj)) {
    errors.push(`${where}: deve essere un oggetto`);
    return false;
  }
  for (const key of required) {
    if (!(key in obj)) errors.push(`${where}.${key}: campo obbligatorio mancante`);
  }
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) {
      errors.push(`${where}.${key}: campo non ammesso`);
    }
  }
  return true;
}

function checkType(errors, where, value, type) {
  const ok =
    type === "string[]"
      ? Array.isArray(value) && value.every((x) => typeof x === "string")
      : typeof value === type;
  if (!ok) errors.push(`${where}: tipo atteso ${type}`);
  return ok;
}

// Restituisce l'elenco degli errori (vuoto se il file è valido).
function validateGt(gt, { requireSynthetic = false } = {}) {
  const errors = [];
  if (!checkFields(errors, "gt", gt, ["format_version", "meta", "input", "expected"])) return errors;
  if (gt.format_version !== 1) errors.push("format_version: deve essere 1");

  const { meta, input, expected } = gt;
  if (checkFields(errors, "meta", meta, ["source_type", "lab_layout", "synthetic", "annotator"], ["notes"])) {
    if (checkType(errors, "meta.source_type", meta.source_type, "string") && !SOURCE_TYPES.includes(meta.source_type)) {
      errors.push(`meta.source_type: valore non ammesso "${meta.source_type}"`);
    }
    if (checkType(errors, "meta.lab_layout", meta.lab_layout, "string") && !LAB_LAYOUTS.includes(meta.lab_layout)) {
      errors.push(`meta.lab_layout: valore non ammesso "${meta.lab_layout}"`);
    }
    if (checkType(errors, "meta.synthetic", meta.synthetic, "boolean") && requireSynthetic && meta.synthetic !== true) {
      errors.push("meta.synthetic: nei dataset dentro il repository deve essere true");
    }
    checkType(errors, "meta.annotator", meta.annotator, "string");
    if ("notes" in meta) checkType(errors, "meta.notes", meta.notes, "string");
  }

  let targets = null;
  if (checkFields(errors, "input", input, ["workflow", "eumed_targets"])) {
    if (input.workflow !== "prescribed") errors.push("input.workflow: deve essere \"prescribed\"");
    if (checkType(errors, "input.eumed_targets", input.eumed_targets, "string[]")) {
      targets = input.eumed_targets;
      if (!targets.length) errors.push("input.eumed_targets: non può essere vuoto");
      if (new Set(targets).size !== targets.length) errors.push("input.eumed_targets: contiene duplicati");
    }
  }

  if (checkFields(errors, "expected", expected, ["report_date", "targets", "not_in_eumed"])) {
    if (checkType(errors, "expected.report_date", expected.report_date, "string") &&
        expected.report_date !== "" && !isIsoDate(expected.report_date)) {
      errors.push("expected.report_date: deve essere \"\" o una data YYYY-MM-DD valida");
    }
    checkType(errors, "expected.not_in_eumed", expected.not_in_eumed, "string[]");
    if (isObject(expected.targets)) {
      const keys = Object.keys(expected.targets);
      if (targets) {
        const missing = targets.filter((t) => !keys.includes(t));
        const extra = keys.filter((k) => !targets.includes(k));
        if (missing.length) errors.push(`expected.targets: mancano ${JSON.stringify(missing)}`);
        if (extra.length) errors.push(`expected.targets: chiavi non presenti in eumed_targets ${JSON.stringify(extra)}`);
      }
      for (const key of keys) validateTarget(errors, `expected.targets[${JSON.stringify(key)}]`, expected.targets[key]);
    } else {
      errors.push("expected.targets: deve essere un oggetto");
    }
  }
  return errors;
}

function validateTarget(errors, where, entry) {
  if (!isObject(entry)) {
    errors.push(`${where}: deve essere un oggetto`);
    return;
  }
  const spec = TARGET_FIELDS[entry.status];
  if (!spec) {
    errors.push(`${where}.status: valore non ammesso ${JSON.stringify(entry.status)}`);
    return;
  }
  checkFields(errors, where, entry, ["status", ...spec.required], spec.optional);
  for (const key of ["value", "unit", "min", "max", "source", "reason"]) {
    if (key in entry) checkType(errors, `${where}.${key}`, entry[key], "string");
  }
  if (entry.status === "filled") {
    if (typeof entry.value === "string" && !isNumericString(entry.value)) {
      errors.push(`${where}.value: deve essere numerico`);
    }
    for (const key of ["min", "max"]) {
      if (typeof entry[key] === "string" && entry[key] !== "" && !isNumericString(entry[key])) {
        errors.push(`${where}.${key}: deve essere "" o numerico`);
      }
    }
  }
  if (entry.status === "long_report" && checkType(errors, `${where}.must_contain`, entry.must_contain, "string[]")) {
    if (!entry.must_contain.length) errors.push(`${where}.must_contain: non può essere vuoto`);
  }
}

// Trova il sorgente del caso (regola 9): source.pdf oppure page-01.*, page-02.*, ...
function findCaseSource(caseDir) {
  const names = fs.readdirSync(caseDir);
  const hasPdf = names.includes("source.pdf");
  const pages = names
    .filter((n) => /^page-\d{2}\.(jpg|jpeg|png)$/i.test(n))
    .sort();
  if (hasPdf && pages.length) throw new Error("il caso contiene sia source.pdf sia immagini page-NN");
  if (hasPdf) return { kind: "pdf", files: [path.join(caseDir, "source.pdf")] };
  if (!pages.length) throw new Error("sorgente mancante (source.pdf o page-01.*)");
  pages.forEach((name, i) => {
    if (Number(name.slice(5, 7)) !== i + 1) throw new Error(`immagini non consecutive da page-01: ${name}`);
  });
  return { kind: "images", files: pages.map((n) => path.join(caseDir, n)) };
}

function readJsonFile(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${file}: BOM UTF-8 non ammesso`);
  return JSON.parse(text);
}

// Carica e valida un caso; lancia un errore con tutti i problemi trovati.
function loadCase(caseDir, { requireSynthetic = false } = {}) {
  const caseId = path.basename(caseDir);
  const problems = [];
  if (!CASE_ID_RE.test(caseId)) problems.push(`case_id non valido: ${caseId}`);
  let gt = null;
  try {
    gt = readJsonFile(path.join(caseDir, "gt.eumed.json"));
    problems.push(...validateGt(gt, { requireSynthetic }));
  } catch (error) {
    problems.push(`gt.eumed.json: ${error.message}`);
  }
  let source = null;
  try {
    source = findCaseSource(caseDir);
  } catch (error) {
    problems.push(error.message);
  }
  if (problems.length) {
    throw new Error(`Caso ${caseId} non valido:\n- ${problems.join("\n- ")}`);
  }
  return { caseId, caseDir, gt, source };
}

module.exports = {
  CASE_ID_RE,
  findCaseSource,
  loadCase,
  readJsonFile,
  validateGt,
};
