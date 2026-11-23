"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { validateGt, loadCase } = require("../src/standalone/gt");
const { scoreTarget, scoreCase, aggregateScores } = require("../src/standalone/score");
const { createOllamaChat } = require("../src/standalone/ollama");
const { listCases, predictCase, scoreRun } = require("../src/standalone/run-case");
const { extractTextFromPdfFile } = require("../src/standalone/pdf-text");
const { buildTextPdf, REPORTS } = require("./fixtures/dataset/make_fixtures.cjs");

const DATASET = path.join(__dirname, "fixtures", "dataset");
const CASE_ID = "synth-inline-0001";
const fixtureGt = () =>
  JSON.parse(fs.readFileSync(path.join(DATASET, "cases", CASE_ID, "gt.eumed.json"), "utf8"));

const tempRoots = [];
test.after(() => tempRoots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function tempDataset() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "segretario-dataset-"));
  tempRoots.push(root);
  fs.cpSync(path.join(DATASET, "cases"), path.join(root, "cases"), { recursive: true });
  return root;
}

function ndjsonResponse(events) {
  const lines = events.map((e) => JSON.stringify(e) + "\n");
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      for (const line of lines) yield new TextEncoder().encode(line);
    })(),
  };
}

test("committed synthetic case is valid and the PDF matches its generator", () => {
  const [caseInfo] = listCases(DATASET);
  assert.equal(caseInfo.caseId, CASE_ID);
  assert.equal(caseInfo.source.kind, "pdf");
  const committed = fs.readFileSync(caseInfo.source.files[0]);
  assert.ok(committed.equals(buildTextPdf(REPORTS[CASE_ID])), "rigenerare con make_fixtures.cjs");
});

test("gt validator rejects the section 3.7 violations", () => {
  const errorsFor = (mutate, opts) => {
    const gt = fixtureGt();
    mutate(gt);
    return validateGt(gt, opts).join("\n");
  };
  assert.equal(errorsFor(() => {}), "");
  assert.match(errorsFor((g) => { g.format_version = 2; }), /format_version/);
  assert.match(errorsFor((g) => { g.extra = 1; }), /gt\.extra: campo non ammesso/);
  assert.match(errorsFor((g) => { g.input.workflow = "unprescribed"; }), /prescribed/);
  assert.match(errorsFor((g) => { g.input.eumed_targets.push("TSH"); }), /duplicati/);
  assert.match(errorsFor((g) => { delete g.expected.targets.TSH; }), /mancano \["TSH"\]/);
  assert.match(errorsFor((g) => { g.expected.targets.TSH.value = "1"; }), /TSH"\]\.value: campo non ammesso/);
  assert.match(errorsFor((g) => { g.expected.targets.GLUCOSIO.value = "<5"; }), /deve essere numerico/);
  assert.match(errorsFor((g) => { g.expected.targets.GLUCOSIO.min = "x"; }), /min: deve essere "" o numerico/);
  assert.match(errorsFor((g) => { g.expected.report_date = "2026-02-30"; }), /report_date/);
  assert.match(errorsFor((g) => { g.meta.synthetic = false; }, { requireSynthetic: true }), /synthetic/);
});

test("case loader enforces case_id and a single source form", () => {
  const root = tempDataset();
  const caseDir = path.join(root, "cases", CASE_ID);
  fs.writeFileSync(path.join(caseDir, "page-01.jpg"), "");
  assert.throws(() => loadCase(caseDir), /sia source\.pdf sia immagini/);
  fs.rmSync(path.join(caseDir, "source.pdf"));
  fs.writeFileSync(path.join(caseDir, "page-03.jpg"), "");
  assert.throws(() => loadCase(caseDir), /non consecutive/);
  const badDir = path.join(root, "cases", "Bad Name");
  fs.cpSync(path.join(DATASET, "cases", CASE_ID), badDir, { recursive: true });
  assert.throws(() => loadCase(badDir), /case_id non valido/);
});

test("scorer follows the outcome table and number tolerance", () => {
  const filled = { status: "filled", value: "166", unit: "mg/dL", min: "", max: "200", source: "" };
  const fill = (value, extra = {}) => ({ status: "filled", value, unit: "mg/dL", min: "", max: "200", ...extra });
  assert.deepEqual(scoreTarget(filled, fill("166,4")), { outcome: "correct", unit_ok: true, min_ok: true, max_ok: true });
  assert.equal(scoreTarget(filled, fill("168")).outcome, "wrong_value");
  assert.equal(scoreTarget(filled, { status: "long_report", text: "x" }).outcome, "wrong_value");
  assert.equal(scoreTarget(filled, { status: "uncertain" }).outcome, "missed");
  assert.equal(scoreTarget(filled, undefined).outcome, "missed");
  assert.deepEqual(scoreTarget(filled, fill("166", { unit: "MG/DL", min: "0", max: "200,0" })),
    { outcome: "correct", unit_ok: true, min_ok: false, max_ok: true });
  assert.equal(scoreTarget({ ...filled, unit: "µg/L" }, fill("166", { unit: " ug/l" })).unit_ok, true);
  assert.equal(scoreTarget({ status: "absent" }, fill("1")).outcome, "false_fill");
  assert.equal(scoreTarget({ status: "uncertain", reason: "" }, { status: "empty" }).outcome, "correct_abstention");
  const long = { status: "long_report", must_contain: ["WBC", "Hb  totale"] };
  assert.deepEqual(scoreTarget(long, { status: "long_report", text: "wbc 6\nHB\ttotale 14" }),
    { outcome: "correct", missing_terms: [] });
  assert.deepEqual(scoreTarget(long, { status: "long_report", text: "WBC 6" }),
    { outcome: "wrong_value", missing_terms: ["Hb  totale"] });
});

test("aggregate metrics count critical errors and group by meta", () => {
  const gt = fixtureGt();
  const prediction = {
    run: { run_id: "r", error: "" },
    report_date: "2026-11-03",
    targets: { GLUCOSIO: { status: "filled", value: "95", unit: "mg/dL", min: "74", max: "106" },
      FERRITINA: { status: "filled", value: "1", unit: "", min: "", max: "" } },
    not_in_eumed: ["hdl-colesterolo"],
  };
  const score = scoreCase({ caseId: CASE_ID, gt, prediction });
  assert.deepEqual(score.counts, { correct: 0, wrong_value: 1, missed: 4, false_fill: 1, correct_abstention: 1 });
  const summary = aggregateScores([{ gt, score }]);
  assert.equal(summary.critical_error_rate, 2 / 7);
  assert.equal(summary.fill_precision, 0);
  assert.equal(summary.abstention_accuracy, 0.5);
  assert.equal(summary.unit_accuracy, null);
  assert.equal(summary.not_in_eumed_recall, 1);
  assert.equal(summary.by_lab_layout.INLINE_CBC_CHEMISTRY.targets, 7);
});

test("Ollama client is local-only, keeps think:false and rejects thinking output", async () => {
  assert.throws(() => createOllamaChat({ url: "http://example.com:11434" }), /locale/);

  let request = null;
  const chat = createOllamaChat({
    model: "m",
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return ndjsonResponse([{ message: { content: "{\"a\"" } }, { message: { content: ":1}" } }, { done: true }]);
    },
  });
  assert.equal(await chat([{ role: "user", content: "x" }], null, 123, { type: "object" }), "{\"a\":1}");
  assert.equal(request.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(request.body.think, false);
  assert.equal(request.body.stream, true);
  assert.deepEqual(request.body.options, { temperature: 0, num_predict: 123 });
  assert.deepEqual(request.body.format, { type: "object" });

  const thinking = createOllamaChat({
    fetchImpl: async () => ndjsonResponse([{ message: { thinking: "hmm", content: "" } }]),
  });
  await assert.rejects(thinking([]), /ragionamento/);
});

test("PDF loader frames pages like the extension", async () => {
  const text = await extractTextFromPdfFile(path.join(DATASET, "cases", CASE_ID, "source.pdf"));
  assert.match(text, /^=== PAGINA 1 - TESTO PDF ===\nLABORATORIO SINTETICO/);
  assert.match(text, /\nP-GLUCOSIO 94 mg\/dL \[74 - 106\]\n/);
});

test("deterministic run on the synthetic case scores every target correctly", async () => {
  const root = tempDataset();
  const [caseInfo] = listCases(root);
  const prediction = await predictCase(caseInfo, { runId: "test", deterministicOnly: true });
  assert.equal(prediction.run.error, "");
  assert.equal(prediction.run.ai_calls, 0);
  assert.equal(prediction.report_date, "2026-11-03");
  assert.deepEqual(prediction.targets.TRIGLICERIDI,
    { status: "filled", value: "52", unit: "mg/dL", min: "30,0", max: "150,0" });
  assert.deepEqual(prediction.targets.FERRITINA, { status: "empty" });
  const score = scoreRun(caseInfo, "test");
  assert.deepEqual(score.counts, { correct: 5, wrong_value: 0, missed: 0, false_fill: 0, correct_abstention: 2 });
  assert.equal(score.report_date_ok, true);
  assert.ok(fs.existsSync(path.join(caseInfo.caseDir, "runs", "test", "score.json")));
  assert.ok(!fs.existsSync(path.join(caseInfo.caseDir, "runs", "test", "raw")));
});

test("CLI --pdf runs a single PDF without ground truth", () => {
  const { execFileSync } = require("node:child_process");
  const pdf = path.join(DATASET, "cases", CASE_ID, "source.pdf");
  const stdout = execFileSync(process.execPath, [
    path.join(__dirname, "..", "tools", "eval.mjs"),
    "--pdf", pdf, "--targets", "GLUCOSIO, TRIGLICERIDI", "--target", "FERRITINA", "--deterministic-only",
  ], { encoding: "utf8" });
  const prediction = JSON.parse(stdout);
  assert.deepEqual(Object.keys(prediction.targets), ["GLUCOSIO", "TRIGLICERIDI", "FERRITINA"]);
  assert.equal(prediction.targets.GLUCOSIO.status, "filled");
  assert.deepEqual(prediction.targets.FERRITINA, { status: "empty" });
  assert.equal(prediction.run.error, "");
});

test("residual targets go through the Ollama hook and AI flags become uncertain", async () => {
  const root = tempDataset();
  const caseDir = path.join(root, "cases", CASE_ID);
  fs.writeFileSync(path.join(caseDir, "source.pdf"),
    buildTextPdf([...REPORTS[CASE_ID], "Ferritina: in corso di dosaggio, vedi referto successivo"]));
  const [caseInfo] = listCases(root);
  const reply = { d: "", de: "", r: [], l: [], u: [{ id: "T1", reason: "in corso di dosaggio" }] };
  const prediction = await predictCase(caseInfo, {
    runId: "mock-ai",
    ollama: { fetchImpl: async () => ndjsonResponse([{ message: { content: JSON.stringify(reply) } }]) },
  });
  assert.equal(prediction.run.error, "");
  assert.ok(prediction.run.ai_calls >= 1);
  assert.equal(prediction.targets.FERRITINA.status, "uncertain");
  assert.equal(prediction.targets.GLUCOSIO.status, "filled");

  const down = await predictCase(caseInfo, {
    runId: "ai-down",
    ollama: { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } },
  });
  assert.match(down.run.error, /Ollama non risponde/);
  assert.ok(Object.values(down.targets).every((t) => t.status === "empty"));
});
