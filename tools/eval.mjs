#!/usr/bin/env node
// Valutazione standalone del workflow prescritto su un dataset
// (dataset_format.md): genera prediction.json e score.json per ogni caso
// e stampa le metriche aggregate. Non usa Chrome, browser o Eumed.
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const { listCases, predictCase, predictPdf, scoreRun, writeJson } = require("../src/standalone/run-case.js");
const { aggregateScores } = require("../src/standalone/score.js");

const USAGE = `Uso: node tools/eval.mjs <dataset_root> --run-id <id> [opzioni]
     node tools/eval.mjs --pdf <referto.pdf> --targets "ESAME 1,ESAME 2" [opzioni]

Dataset (con ground truth):
  --case <id>             solo questo caso (ripetibile)
  --score-only            ricalcola score.json da prediction.json esistenti
  --validate-only         valida soltanto i casi
  --raw                   salva anche runs/<id>/raw/ (contiene dati del referto)
  --json                  stampa le metriche aggregate in JSON

Singolo PDF (senza ground truth; stampa prediction.json):
  --pdf <file>            PDF testuale da analizzare
  --targets <a,b,...>     esami prescritti, separati da virgola
  --target <nome>         esame prescritto (ripetibile, per nomi con virgole)
  --out <file>            scrive il risultato su file invece che su stdout
  --raw                   con --out, salva anche raw/ accanto al file

Comuni:
  --deterministic-only    solo parser deterministico, senza Ollama
  --model <nome>          modello Ollama (predefinito: quello dell'estensione)
  --ollama-url <url>      Ollama locale (predefinito: http://127.0.0.1:11434)`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      "run-id": { type: "string" },
      case: { type: "string", multiple: true },
      "deterministic-only": { type: "boolean", default: false },
      model: { type: "string" },
      "ollama-url": { type: "string" },
      "score-only": { type: "boolean", default: false },
      "validate-only": { type: "boolean", default: false },
      raw: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      pdf: { type: "string" },
      targets: { type: "string" },
      target: { type: "string", multiple: true },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (error) {
  fail(`${error.message}\n\n${USAGE}`);
}

const { values: opts, positionals } = parsed;
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const ollama = {};
if (opts.model) ollama.model = opts.model;
if (opts["ollama-url"]) ollama.url = opts["ollama-url"];

if (opts.pdf) {
  if (positionals.length) fail(USAGE);
  const targets = [...(opts.targets || "").split(","), ...(opts.target || [])];
  if (opts.raw && !opts.out) fail("--raw richiede --out.");
  let prediction;
  try {
    prediction = await predictPdf(opts.pdf, targets, {
      runId: opts["run-id"] || "pdf",
      deterministicOnly: opts["deterministic-only"],
      ollama,
      rawDir: opts.raw ? path.join(path.dirname(path.resolve(opts.out)), "raw") : "",
    });
  } catch (error) {
    fail(error.message);
  }
  if (opts.out) writeJson(path.resolve(opts.out), prediction);
  else console.log(JSON.stringify(prediction, null, 2));
  if (prediction.run.error) console.error(`errore: ${prediction.run.error}`);
  else if (prediction.run.ai_failures) {
    console.error(`${prediction.run.ai_failures}/${prediction.run.ai_calls} chiamate IA fallite`);
  }
  process.exit(prediction.run.error ? 1 : 0);
}

if (positionals.length !== 1) fail(USAGE);

let cases;
try {
  cases = listCases(positionals[0], { caseIds: opts.case || null });
} catch (error) {
  fail(error.message);
}
if (!cases.length) fail("Nessun caso trovato.");

if (opts["validate-only"]) {
  console.log(`${cases.length} casi validi.`);
  process.exit(0);
}

const runId = opts["run-id"];
if (!runId || !/^[\w.:-]+$/.test(runId)) fail("--run-id obbligatorio (lettere, cifre, . _ - :).");

const entries = [];
for (const caseInfo of cases) {
  if (!opts["score-only"]) {
    const prediction = await predictCase(caseInfo, {
      runId,
      deterministicOnly: opts["deterministic-only"],
      ollama,
      raw: opts.raw,
    });
    if (prediction.run.error) console.error(`${caseInfo.caseId}: errore: ${prediction.run.error}`);
    else if (prediction.run.ai_failures) {
      console.error(`${caseInfo.caseId}: ${prediction.run.ai_failures}/${prediction.run.ai_calls} chiamate IA fallite`);
    }
  }
  const score = scoreRun(caseInfo, runId);
  entries.push({ gt: caseInfo.gt, score });
  const c = score.counts;
  // Solo conteggi: niente testo o valori del referto nell'output.
  console.error(
    `${caseInfo.caseId}: correct=${c.correct} wrong_value=${c.wrong_value} false_fill=${c.false_fill} ` +
    `missed=${c.missed} correct_abstention=${c.correct_abstention} date_ok=${score.report_date_ok}`
  );
}

const summary = aggregateScores(entries);
if (opts.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const pct = (x) => (x === null ? "n/d" : `${(x * 100).toFixed(1)}%`);
  console.log(`Casi: ${summary.cases} · target: ${summary.targets} · errori di esecuzione: ${summary.error_cases}`);
  for (const key of [
    "critical_error_rate",
    "fill_precision",
    "fill_recall",
    "abstention_accuracy",
    "unit_accuracy",
    "range_accuracy",
    "report_date_accuracy",
    "not_in_eumed_recall",
  ]) {
    console.log(`  ${key.padEnd(22)} ${pct(summary[key])}`);
  }
}
process.exitCode = summary.error_cases ? 1 : 0;
