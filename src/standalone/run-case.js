// Esecuzione del workflow prescritto (runAutoWorkflow) fuori dal browser:
// testo del referto + righe Eumed vuote -> prediction.json.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { configureHost } = require("../engine/host");
const { CONFIG, normalizeDateValue, normalizeExamName } = require("../engine/core");
const { ensureLabCatalog } = require("../engine/catalog");
const {
  buildEumedAudit,
  buildStrongParserWriteSet,
  filterPostQwenWriteSet,
  prepareResidualQwenPlan,
  runResidualQwenFromPlan,
} = require("../engine/workflow");
const { createOllamaChat } = require("./ollama");
const { extractTextFromPdfFile } = require("./pdf-text");
const { loadCase } = require("./gt");
const { scoreCase } = require("./score");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function pipelineVersion() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "manifest.json"), "utf8")).version;
}

function loadRepoCatalog() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "lab_catalog.json"), "utf8"));
}

// Configura il motore per Node. Con deterministicOnly l'IA non viene chiamata.
// Il motore tollera gli errori dell'IA (come nell'estensione): aiStats li
// conta, così un Ollama non raggiungibile non passa inosservato.
function configureStandaloneHost({ targets, deterministicOnly = false, ollama = {}, aiStats = null } = {}) {
  const chat = deterministicOnly
    ? async () => {
        throw new Error("IA disabilitata (deterministicOnly).");
      }
    : createOllamaChat({ model: CONFIG.aiModel, ...ollama });
  configureHost({
    getAvailableExams: () => [...(targets || [])],
    loadLabCatalogData: loadRepoCatalog,
    recordDiagnosticEvent: () => {},
    ollamaChatOnce: async (...args) => {
      if (aiStats) aiStats.calls += 1;
      try {
        return await chat(...args);
      } catch (error) {
        if (aiStats) {
          aiStats.failures += 1;
          aiStats.lastError = error?.message || String(error);
        }
        throw error;
      }
    },
  });
}

// Stesse fasi di runAutoWorkflow; restituisce ciò che verrebbe scritto in Eumed.
async function runPrescribedWorkflow(reportText, targetExams, { deterministicOnly = false, onProgress = null } = {}) {
  await ensureLabCatalog();

  const plan = await prepareResidualQwenPlan(reportText, targetExams, onProgress);
  const strongWriteSet = buildStrongParserWriteSet(plan);
  const analysis = await runResidualQwenFromPlan(
    deterministicOnly ? { ...plan, residualTargets: [], residualText: "" } : plan,
    onProgress
  );
  const merged = analysis.merged;
  const postQwen = filterPostQwenWriteSet(merged, plan.strongResolved, strongWriteSet.compositeDetails);
  const audit = buildEumedAudit(merged, reportText);

  return {
    written: {
      results: [...strongWriteSet.results, ...postQwen.results],
      longReports: [...strongWriteSet.longReports, ...postQwen.longReports],
    },
    merged,
    audit,
    stats: {
      strongResolved: plan.strongResolved.size,
      residualTargets: plan.residualTargets.length,
      skippedNoEvidence: plan.skippedNoEvidenceTargets.length,
      parserMs: analysis.parserMs,
      qwenMs: analysis.qwenMs,
    },
  };
}

const str = (value) => String(value ?? "");

function buildPredictionTargets(targets, workflow) {
  const byExam = (items) => new Map(items.map((item) => [item.exam, item]));
  const numeric = byExam(workflow.written.results);
  const longReports = byExam(workflow.written.longReports);
  const uncertain = workflow.merged.uncertain || [];

  const output = {};
  for (const target of targets) {
    const key = normalizeExamName(target);
    const filled = numeric.get(target);
    const long = longReports.get(target);
    const flagged = uncertain.find(
      (item) => normalizeExamName(item?.exam) === key || normalizeExamName(item?.text) === key
    );
    if (filled) {
      output[target] = {
        status: "filled",
        value: str(filled.value),
        unit: str(filled.unit),
        min: str(filled.refMin),
        max: str(filled.refMax),
      };
    } else if (long) {
      output[target] = { status: "long_report", text: str(long.text) };
    } else if (flagged) {
      output[target] = { status: "uncertain", reason: str(flagged.reason) };
    } else {
      output[target] = { status: "empty" };
    }
  }
  return output;
}

function buildPrediction({ targets, workflow, run }) {
  return {
    format_version: 1,
    run,
    report_date: workflow ? normalizeDateValue(workflow.merged.reportDate) : "",
    targets: workflow
      ? buildPredictionTargets(targets, workflow)
      : Object.fromEntries(targets.map((t) => [t, { status: "empty" }])),
    not_in_eumed: workflow
      ? [...new Set(workflow.audit.presentInReportAbsentEumed.map((item) => item.name))]
      : [],
  };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// Esegue il workflow prescritto su un singolo PDF testuale (o su immagini,
// che producono run.error). Non scrive file.
async function predictSource(source, targets, { runId = "", deterministicOnly = false, ollama = {} } = {}) {
  const startedAt = new Date();
  const run = {
    run_id: runId,
    pipeline_version: pipelineVersion(),
    model: deterministicOnly ? "" : ollama.model || CONFIG.aiModel,
    ocr_engine: "",
    started_at: startedAt.toISOString(),
    duration_ms: 0,
    error: "",
    ai_calls: 0,
    ai_failures: 0,
  };

  const aiStats = { calls: 0, failures: 0, lastError: "" };
  let workflow = null;
  let reportText = "";
  try {
    if (source.kind !== "pdf") {
      throw new Error("Le immagini richiedono OCR, non supportato in modalità standalone.");
    }
    reportText = await extractTextFromPdfFile(source.files[0]);
    configureStandaloneHost({ targets, deterministicOnly, ollama, aiStats });
    workflow = await runPrescribedWorkflow(reportText, targets, { deterministicOnly });
  } catch (error) {
    run.error = error?.message || String(error);
    workflow = null;
  }
  run.duration_ms = Date.now() - startedAt.getTime();
  run.ai_calls = aiStats.calls;
  run.ai_failures = aiStats.failures;

  return { prediction: buildPrediction({ targets, workflow, run }), reportText, workflow };
}

// raw/ contiene testo e valori del referto: solo su richiesta esplicita.
function writeRaw(rawDir, { reportText, workflow }) {
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, "report.txt"), reportText, "utf8");
  if (workflow) writeJson(path.join(rawDir, "workflow.json"), workflow);
}

async function predictCase(caseInfo, { runId, deterministicOnly = false, ollama = {}, raw = false } = {}) {
  const runDir = path.join(caseInfo.caseDir, "runs", runId);
  const result = await predictSource(caseInfo.source, caseInfo.gt.input.eumed_targets, {
    runId,
    deterministicOnly,
    ollama,
  });
  writeJson(path.join(runDir, "prediction.json"), result.prediction);
  if (raw) writeRaw(path.join(runDir, "raw"), result);
  return result.prediction;
}

async function predictPdf(pdfFile, targets, { runId = "pdf", deterministicOnly = false, ollama = {}, rawDir = "" } = {}) {
  const names = [...new Set((targets || []).map((t) => String(t).trim()).filter(Boolean))];
  if (!names.length) throw new Error("Indicare almeno un esame da cercare.");
  const result = await predictSource({ kind: "pdf", files: [path.resolve(pdfFile)] }, names, {
    runId,
    deterministicOnly,
    ollama,
  });
  if (rawDir) writeRaw(rawDir, result);
  return result.prediction;
}

function scoreRun(caseInfo, runId) {
  const runDir = path.join(caseInfo.caseDir, "runs", runId);
  const prediction = JSON.parse(fs.readFileSync(path.join(runDir, "prediction.json"), "utf8"));
  const score = scoreCase({ caseId: caseInfo.caseId, gt: caseInfo.gt, prediction });
  writeJson(path.join(runDir, "score.json"), score);
  return score;
}

function isInsideRepo(dir) {
  const relative = path.relative(REPO_ROOT, path.resolve(dir));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function listCases(datasetRoot, { caseIds = null } = {}) {
  const casesDir = path.join(datasetRoot, "cases");
  const requireSynthetic = isInsideRepo(datasetRoot);
  return fs
    .readdirSync(casesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !caseIds || caseIds.includes(name))
    .sort()
    .map((name) => loadCase(path.join(casesDir, name), { requireSynthetic }));
}

module.exports = {
  buildPrediction,
  configureStandaloneHost,
  listCases,
  predictCase,
  predictPdf,
  runPrescribedWorkflow,
  scoreRun,
  writeJson,
};
