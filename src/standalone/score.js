// Punteggio di prediction.json rispetto a gt.eumed.json (dataset_format.md, sezione 6).
"use strict";

const OUTCOMES = ["correct", "wrong_value", "missed", "false_fill", "correct_abstention"];

function parseDecimal(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return null;
  return Number(text);
}

// Sezione 6.2: tolleranza relativa al valore atteso.
function valuesMatch(predicted, expected) {
  const a = parseDecimal(predicted);
  const b = parseDecimal(expected);
  if (a === null || b === null) {
    return String(predicted ?? "").trim().toLowerCase() === String(expected ?? "").trim().toLowerCase();
  }
  return Math.abs(a - b) <= Math.max(0.01, 0.005 * Math.abs(b));
}

function boundsMatch(predicted, expected) {
  const p = String(predicted ?? "").trim();
  const e = String(expected ?? "").trim();
  if (!p || !e) return !p && !e;
  return parseDecimal(p) !== null && parseDecimal(e) !== null && valuesMatch(p, e);
}

const normalizeUnit = (unit) => String(unit ?? "").trim().toLowerCase().replace(/[µμ]/g, "u");
const normalizeText = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const foldName = (name) =>
  String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

function scoreTarget(expected, predicted) {
  const predictedStatus = predicted?.status || "empty";
  const writes = predictedStatus === "filled" || predictedStatus === "long_report";

  if (expected.status === "absent" || expected.status === "uncertain") {
    return { outcome: writes ? "false_fill" : "correct_abstention" };
  }
  if (!writes) return { outcome: "missed" };

  if (expected.status === "filled") {
    if (predictedStatus !== "filled" || !valuesMatch(predicted.value, expected.value)) {
      return { outcome: "wrong_value" };
    }
    return {
      outcome: "correct",
      unit_ok: normalizeUnit(predicted.unit) === normalizeUnit(expected.unit),
      min_ok: boundsMatch(predicted.min, expected.min),
      max_ok: boundsMatch(predicted.max, expected.max),
    };
  }

  // expected long_report
  if (predictedStatus !== "long_report") return { outcome: "wrong_value" };
  const text = normalizeText(predicted.text);
  const missingTerms = expected.must_contain.filter((term) => !text.includes(normalizeText(term)));
  return { outcome: missingTerms.length ? "wrong_value" : "correct", missing_terms: missingTerms };
}

function emptyCounts() {
  return Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
}

function scoreCase({ caseId, gt, prediction }) {
  const targets = {};
  const counts = emptyCounts();
  for (const name of gt.input.eumed_targets) {
    const result = scoreTarget(gt.expected.targets[name], prediction?.targets?.[name]);
    targets[name] = result;
    counts[result.outcome] += 1;
  }

  const predictedNotInEumed = new Set((prediction?.not_in_eumed || []).map(foldName));
  const expectedNotInEumed = gt.expected.not_in_eumed || [];

  return {
    format_version: 1,
    case_id: caseId,
    run_id: prediction?.run?.run_id || "",
    report_date_ok: String(prediction?.report_date ?? "") === gt.expected.report_date,
    targets,
    counts,
    // Campi informativi oltre al formato minimo della sezione 6.5.
    not_in_eumed_found: expectedNotInEumed.filter((name) => predictedNotInEumed.has(foldName(name))).length,
    not_in_eumed_expected: expectedNotInEumed.length,
    error: prediction?.run?.error || "",
  };
}

const ratio = (num, den) => (den ? num / den : null);

function aggregateGroup(entries) {
  const counts = emptyCounts();
  let expectedWrites = 0;
  let expectedAbstentions = 0;
  let correctFilled = 0;
  let unitOk = 0;
  let rangeOk = 0;
  let dateOk = 0;
  let nieFound = 0;
  let nieExpected = 0;
  let errorCases = 0;

  for (const { gt, score } of entries) {
    if (score.report_date_ok) dateOk += 1;
    if (score.error) errorCases += 1;
    nieFound += score.not_in_eumed_found;
    nieExpected += score.not_in_eumed_expected;
    for (const [name, result] of Object.entries(score.targets)) {
      counts[result.outcome] += 1;
      const status = gt.expected.targets[name].status;
      if (status === "filled" || status === "long_report") expectedWrites += 1;
      else expectedAbstentions += 1;
      if (result.outcome === "correct" && status === "filled") {
        correctFilled += 1;
        if (result.unit_ok) unitOk += 1;
        if (result.min_ok && result.max_ok) rangeOk += 1;
      }
    }
  }

  const totalTargets = OUTCOMES.reduce((sum, o) => sum + counts[o], 0);
  return {
    cases: entries.length,
    targets: totalTargets,
    counts,
    critical_error_rate: ratio(counts.wrong_value + counts.false_fill, totalTargets),
    fill_precision: ratio(counts.correct, counts.correct + counts.wrong_value + counts.false_fill),
    fill_recall: ratio(counts.correct, expectedWrites),
    abstention_accuracy: ratio(counts.correct_abstention, expectedAbstentions),
    unit_accuracy: ratio(unitOk, correctFilled),
    range_accuracy: ratio(rangeOk, correctFilled),
    report_date_accuracy: ratio(dateOk, entries.length),
    not_in_eumed_recall: ratio(nieFound, nieExpected),
    error_cases: errorCases,
  };
}

function groupBy(entries, key) {
  const groups = {};
  for (const entry of entries) {
    const value = entry.gt.meta[key];
    (groups[value] ||= []).push(entry);
  }
  return Object.fromEntries(
    Object.keys(groups).sort().map((value) => [value, aggregateGroup(groups[value])])
  );
}

// entries: [{ gt, score }]
function aggregateScores(entries) {
  return {
    ...aggregateGroup(entries),
    by_source_type: groupBy(entries, "source_type"),
    by_lab_layout: groupBy(entries, "lab_layout"),
  };
}

module.exports = {
  OUTCOMES,
  aggregateScores,
  scoreCase,
  scoreTarget,
  valuesMatch,
};
