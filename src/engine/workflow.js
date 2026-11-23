// Flusso esiti prescritti: piano parser, residui IA, merge e audit.
"use strict";

const {
  getExamConcept,
  getLongReportKind,
  normalizeExamName,
} = require("./core");
const {
  detectSpecimen,
} = require("./catalog");
const {
  convertMeasurement,
} = require("./long-report");
const {
  buildResidualAiText,
  cleanReportLines,
  collectStrongResolvedTargets,
  dedupeRecognizedNotInGrid,
  detectKnownLabLayout,
  extractAouPadovaResults,
  extractFromReport,
  extractSpecimenAnchoredResults,
  extractUlss6DirectResults,
  isLongReportComponent,
  targetConceptTerms,
  valuesClinicallyEquivalent,
} = require("./extraction");
const {
  buildPrescribedTransferText,
  getUnclaimedAiEvidence,
} = require("./unprescribed");

function cloneResultWithSource(item, source) {
  return {
    ...item,
    workflowSource: source
  };
}

function enrichEquivalentResult(primary, secondary) {
  const out = { ...primary };

  if (
    !out.rangeAvailable &&
    secondary?.rangeAvailable
  ) {
    out.refMin = secondary.refMin;
    out.refMax = secondary.refMax;
    out.refUnit = secondary.refUnit;
    out.originalRefMin = secondary.originalRefMin;
    out.originalRefMax = secondary.originalRefMax;
    out.originalRefUnit = secondary.originalRefUnit;
    out.rangeConverted = secondary.rangeConverted;
    out.rangeAvailable = true;
    out.rangeReason = secondary.rangeReason || "";
  }

  if (
    !out.comparatorOriginal &&
    secondary?.comparatorOriginal
  ) {
    out.comparatorOriginal =
      secondary.comparatorOriginal;
    out.comparatorOperator =
      secondary.comparatorOperator;
    out.comparatorOriginalWithUnit =
      secondary.comparatorOriginalWithUnit;
  }

  return out;
}

function extractionHasAmbiguityForExam(extraction, exam) {
  const n = normalizeExamName(exam);

  return [
    ...(extraction?.uncertain || []),
    ...(extraction?.rejected || [])
  ].some(item => {
    const text = normalizeExamName(
      `${item?.exam || ""} ${item?.text || ""} ${item?.raw_label || ""} ${item?.reason || ""}`
    );

    return n && text.includes(n);
  });
}

function mergeIndependentReadings(
  parserExtraction,
  hybridExtraction,
  targetExams
) {
  const parserMap =
    new Map(
      (parserExtraction?.results || [])
        .map(item => [item.exam, item])
    );

  const hybridMap =
    new Map(
      (hybridExtraction?.results || [])
        .map(item => [item.exam, item])
    );

  const aiResolved =
    new Set(
      hybridExtraction?.targetedAiResolvedTargets || []
    );

  const aiLongResolved =
    new Set(
      hybridExtraction?.targetedAiLongResolvedTargets || []
    );

  const targetSet =
    new Set(targetExams || []);

  const results = [];
  const mergeUncertain = [];
  const stats = {
    parserOnly: 0,
    aiOnly: 0,
    concordant: 0,
    conflicts: 0,
    qwenNoiseIgnored: 0
  };

  // Un parser strutturato produce un dato solo dopo:
  // matrice biologica -> mapping Eumed -> unità -> conversione -> controllo
  // delle rappresentazioni equivalenti. Per questo un risultato presente
  // in parserExtraction è considerato fonte deterministica forte.
  for (const exam of targetSet) {
    if (getLongReportKind(exam)) continue;

    const parserItem = parserMap.get(exam);
    const hybridItem = hybridMap.get(exam);
    const aiFound = aiResolved.has(exam);

    if (parserItem) {
      if (hybridItem) {
        const concept =
          parserItem.concept ||
          hybridItem.concept ||
          getExamConcept(exam);

        const agree =
          valuesClinicallyEquivalent(
            parserItem.value,
            hybridItem.value,
            concept
          );

        if (agree && aiFound) {
          const merged =
            enrichEquivalentResult(
              parserItem,
              hybridItem
            );

          stats.concordant += 1;

          results.push(
            cloneResultWithSource(
              merged,
              "parser+qwen"
            )
          );

          continue;
        }

        if (!agree) {
          // IA può leggere un numero vicino appartenente ad altra riga
          // (es. PLT 299 come AST). Non deve avere potere di veto su un
          // risultato deterministico strutturato.
          stats.qwenNoiseIgnored += 1;
        }
      } else if (
        aiFound ||
        extractionHasAmbiguityForExam(
          hybridExtraction,
          exam
        )
      ) {
        stats.qwenNoiseIgnored += 1;
      }

      stats.parserOnly += 1;

      results.push(
        cloneResultWithSource(
          parserItem,
          "parser"
        )
      );

      continue;
    }

    // Solo se il parser non ha trovato nulla, IA può essere fonte unica.
    if (hybridItem && aiFound) {
      stats.aiOnly += 1;

      results.push(
        cloneResultWithSource(
          hybridItem,
          "qwen"
        )
      );
    }
  }

  const parserLongMap =
    new Map(
      (parserExtraction?.longReports || [])
        .map(item => [item.exam, item])
    );

  const hybridLongMap =
    new Map(
      (hybridExtraction?.longReports || [])
        .map(item => [item.exam, item])
    );

  const longReports = [];

  for (const exam of targetSet) {
    if (!getLongReportKind(exam)) continue;

    const parserItem = parserLongMap.get(exam);
    const hybridItem = hybridLongMap.get(exam);
    const aiFound = aiLongResolved.has(exam);

    if (parserItem?.text) {
      longReports.push({
        ...parserItem,
        workflowSource:
          aiFound ? "parser+qwen" : "parser"
      });
      continue;
    }

    if (hybridItem?.text) {
      longReports.push({
        ...hybridItem,
        workflowSource:
          aiFound ? "qwen" : "parser"
      });
    }
  }

  function itemCoveredByAcceptedResult(item) {
    const itemText =
      `${item?.exam || ""} ${item?.text || ""} ` +
      `${item?.raw_label || ""} ${item?.catalogName || ""}`;

    const itemName =
      normalizeExamName(
        item?.exam ||
        item?.text ||
        item?.catalogName ||
        ""
      );

    const itemConcept =
      getExamConcept(itemText);

    const itemSpecimen =
      detectSpecimen(
        item?.raw_label ||
        item?.exam ||
        item?.text ||
        ""
      );

    return results.some(result => {
      const resultName =
        normalizeExamName(result?.exam || "");

      if (
        itemName &&
        resultName &&
        (
          itemName === resultName ||
          itemName.includes(resultName) ||
          resultName.includes(itemName)
        )
      ) {
        return true;
      }

      const resultConcept =
        getExamConcept(
          `${result?.exam || ""} ${result?.raw_label || ""}`
        );

      if (
        !itemConcept ||
        !resultConcept ||
        itemConcept !== resultConcept
      ) {
        return false;
      }

      const resultSpecimen =
        detectSpecimen(
          result?.raw_label ||
          result?.exam ||
          ""
        );

      if (
        itemSpecimen &&
        resultSpecimen &&
        itemSpecimen !== resultSpecimen
      ) {
        return false;
      }

      return true;
    });
  }

  const recognizedNotInGrid =
    dedupeRecognizedNotInGrid([
      ...(parserExtraction?.recognizedNotInGrid || []),
      ...(hybridExtraction?.recognizedNotInGrid || [])
    ]).filter(
      item => !itemCoveredByAcceptedResult(item)
    );

  const seenAmbiguous = new Set();
  const uncertain = [];

  for (const item of [
    ...mergeUncertain,
    ...(hybridExtraction?.uncertain || [])
  ]) {
    // Se il parser deterministico ha già fornito il risultato accettato,
    // non mostrare come ambiguità il rumore generato dal secondo lettore.
    if (itemCoveredByAcceptedResult(item)) continue;

    const key = normalizeExamName(
      `${item?.text || item?.exam || ""} ${item?.reason || ""}`
    );

    if (key && seenAmbiguous.has(key)) continue;
    if (key) seenAmbiguous.add(key);
    uncertain.push(item);
  }

  const hasAcceptedBilirubinReflex = results.some(result =>
    getExamConcept(`${result?.exam || ""} ${result?.raw_label || ""}`) === "BILIRUBIN_TOTAL" &&
    normalizeExamName(result?.exam || "").includes("BILIRUBINA REFLEX")
  );

  function isBilirubinNoise(item) {
    if (!hasAcceptedBilirubinReflex) return false;

    const concept = getExamConcept(
      `${item?.exam || ""} ${item?.text || ""} ${item?.raw_label || ""} ${item?.catalogName || ""}`
    );

    return [
      "BILIRUBIN_TOTAL",
      "BILIRUBIN_DIRECT",
      "BILIRUBIN_INDIRECT"
    ].includes(concept);
  }

  const filteredUncertain = uncertain.filter(
    item => !isBilirubinNoise(item)
  );

  const rejected =
    (hybridExtraction?.rejected || [])
      .filter(
        item =>
          !itemCoveredByAcceptedResult(item) &&
          !isBilirubinNoise(item)
      );

  const filteredRecognizedNotInGrid =
    recognizedNotInGrid.filter(
      item => !isBilirubinNoise(item)
    );

  return {
    results,
    longReports,
    recognizedNotInGrid: filteredRecognizedNotInGrid,
    rejected,
    uncertain: filteredUncertain,
    targetedAiTargets: [...targetSet],
    targetedAiBatches:
      hybridExtraction?.targetedAiBatches || 0,
    targetedAiResolvedTargets:
      hybridExtraction?.targetedAiResolvedTargets || [],
    targetedAiLongResolvedTargets:
      hybridExtraction?.targetedAiLongResolvedTargets || [],
    longReportAiFallbacks:
      hybridExtraction?.longReportAiFallbacks || 0,
    labLayout:
      parserExtraction?.labLayout ||
      hybridExtraction?.labLayout ||
      "",
    labLayoutName:
      parserExtraction?.labLayoutName ||
      hybridExtraction?.labLayoutName ||
      "",
    reportDate:
      parserExtraction?.reportDate ||
      hybridExtraction?.reportDate ||
      "",
    reportDateEvidence:
      parserExtraction?.reportDateEvidence ||
      hybridExtraction?.reportDateEvidence ||
      "",
    workflowStats: stats
  };
}

function emptyHybridExtraction(parserExtraction = null) {
  return {
    results: [],
    longReports: [],
    recognizedNotInGrid: [],
    rejected: [],
    uncertain: [],
    targetedAiBatches: 0,
    targetedAiTargets: [],
    targetedAiResolvedTargets: [],
    targetedAiLongResolvedTargets: [],
    longReportAiFallbacks: 0,
    labLayout: parserExtraction?.labLayout || "",
    labLayoutName: parserExtraction?.labLayoutName || "",
    reportDate: parserExtraction?.reportDate || "",
    reportDateEvidence:
      parserExtraction?.reportDateEvidence || ""
  };
}

function residualTargetHasTextAnchor(reportText, exam) {
  const normalizedReport = normalizeExamName(reportText);
  if (!normalizedReport) return false;

  const wordSet = new Set(
    normalizedReport
      .split(/\s+/)
      .filter(Boolean)
  );

  const terms = targetConceptTerms(exam)
    .map(normalizeExamName)
    .filter(Boolean);

  // Se il resolver non conosce ancora sinonimi affidabili per questo esame,
  // non usiamo il gate: IA resta disponibile come rete di sicurezza.
  if (!terms.length) return null;

  for (const term of terms) {
    // Sigle brevi (TSH, AST, ALT, WBC, RBC...) devono comparire come token
    // autonomi: evita falsi match dentro parole più lunghe.
    if (!term.includes(" ") && term.length <= 4) {
      if (wordSet.has(term)) return true;
      continue;
    }

    if (normalizedReport.includes(term)) return true;
  }

  return false;
}

function shouldSendResidualTargetToQwen(reportText, exam, knownLayout) {
  // Su layout ignoti IA deve continuare a vedere tutti i target irrisolti.
  if (!knownLayout) {
    return { send: true, reason: "unknown_layout" };
  }

  const hasAnchor = residualTargetHasTextAnchor(reportText, exam);

  if (hasAnchor === null) {
    return { send: true, reason: "no_known_aliases" };
  }

  if (hasAnchor) {
    return { send: true, reason: "text_anchor" };
  }

  return { send: false, reason: "no_text_anchor" };
}

async function prepareResidualQwenPlan(
  reportText,
  targetExams,
  progressCallback = null
) {
  const startedAt = Date.now();

  const targets =
    (targetExams || []).filter(Boolean);

  const parserExtraction =
    await extractFromReport(
      reportText,
      info =>
        progressCallback?.({
          ...info,
          analysisStage: "parser"
        }),
      {
        deterministicOnly: true
      }
    );

  const strongResolved =
    collectStrongResolvedTargets(
      parserExtraction,
      targets
    );

  const unresolvedTargets =
    targets.filter(
      exam => !strongResolved.has(exam)
    );

  // v0.14.2: sui layout di laboratorio noti il parser deterministico ha
  // già letto l'intero referto strutturato. IA viene quindi chiamato
  // soltanto per un target residuo se nel testo esiste almeno un'ancora
  // lessicale plausibile (nome, sinonimo o componente del referto lungo).
  // Se non esiste alcun indizio, inviare comunque il nome dell'esame a
  // IA tende a produrre associazioni spurie e spreca decine di secondi.
  // Per layout sconosciuti manteniamo invece il comportamento prudente
  // precedente e lasciamo tutti i residui a IA.
  const knownLayout =
    parserExtraction?.labLayout ||
    detectKnownLabLayout(reportText);

  const skippedNoEvidenceTargets = [];
  const residualTargets = [];
  const semanticRescueTargets = [];
  const unclaimedEvidence = getUnclaimedAiEvidence(
    reportText,
    parserExtraction
  );

  for (const exam of unresolvedTargets) {
    const gate = shouldSendResidualTargetToQwen(
      reportText,
      exam,
      knownLayout
    );

    if (gate.send) {
      residualTargets.push(exam);
    } else if (
      gate.reason === "no_text_anchor" &&
      unclaimedEvidence.count > 0
    ) {
      // v0.15.15: se il parser ha lasciato righe di laboratorio reali non
      // consumate, IA può tentare un'associazione SEMANTICA anche se il
      // target non condivide parole note con la riga. Il resolver è
      // target-bound, quindi non può inventare una prestazione diversa.
      residualTargets.push(exam);
      semanticRescueTargets.push(exam);
    } else {
      skippedNoEvidenceTargets.push(exam);
    }
  }

  const residualText =
    residualTargets.length
      ? buildResidualAiText(
          reportText,
          parserExtraction,
          residualTargets
        )
      : "";

  const strongLongKinds = [
    ...new Set(
      (parserExtraction?.longReports || [])
        .filter(item =>
          strongResolved.has(item?.exam)
        )
        .map(item => item?.kind)
        .filter(Boolean)
    )
  ];

  const plan = {
    reportText,
    targets,
    parserExtraction,
    strongResolved,
    unresolvedTargets,
    residualTargets,
    skippedNoEvidenceTargets,
    semanticRescueTargets,
    unclaimedEvidenceCount: unclaimedEvidence.count,
    residualText,
    strongLongKinds,
    parserMs: Date.now() - startedAt
  };

  progressCallback?.({
    phase: "residual_plan",
    analysisStage: "planner",
    totalTargets: targets.length,
    strongResolved:
      strongResolved.size,
    unresolvedTargets,
    unresolvedCount:
      unresolvedTargets.length,
    residualTargets,
    residualCount:
      residualTargets.length,
    skippedNoEvidenceTargets,
    skippedNoEvidenceCount:
      skippedNoEvidenceTargets.length,
    semanticRescueTargets,
    semanticRescueCount:
      semanticRescueTargets.length,
    unclaimedEvidenceCount:
      unclaimedEvidence.count,
    originalChars:
      String(reportText || "").length,
    aiChars:
      residualText.length,
    parserMs: plan.parserMs
  });

  return plan;
}

async function runResidualQwenFromPlan(
  plan,
  progressCallback = null
) {
  const qwenStartedAt = Date.now();

  let hybridExtraction =
    emptyHybridExtraction(
      plan.parserExtraction
    );

  if (plan.residualTargets.length) {
    hybridExtraction =
      await extractFromReport(
        plan.reportText,
        info =>
          progressCallback?.({
            ...info,
            analysisStage: "qwen"
          }),
        {
          deterministicOnly: false,
          aiTargetsOverride:
            plan.residualTargets,
          aiReportTextOverride:
            plan.residualText,
          skipLongReportAiKinds:
            plan.strongLongKinds
        }
      );
  }

  const merged =
    mergeIndependentReadings(
      plan.parserExtraction,
      hybridExtraction,
      plan.targets
    );

  merged.strongParserResolvedCount =
    plan.strongResolved.size;
  merged.residualAiTargetCount =
    plan.residualTargets.length;
  merged.residualAiTargets =
    plan.residualTargets;
  merged.unresolvedAfterParserCount =
    (plan.unresolvedTargets || plan.residualTargets || []).length;
  merged.aiSkippedNoEvidenceCount =
    (plan.skippedNoEvidenceTargets || []).length;
  merged.aiSkippedNoEvidenceTargets =
    plan.skippedNoEvidenceTargets || [];
  merged.aiSemanticRescueCount =
    (plan.semanticRescueTargets || []).length;
  merged.aiSemanticRescueTargets =
    plan.semanticRescueTargets || [];
  merged.aiUnclaimedEvidenceCount =
    plan.unclaimedEvidenceCount || 0;
  merged.aiInputChars =
    plan.residualText.length;
  merged.originalInputChars =
    String(plan.reportText || "").length;
  merged.aiInputReductionPercent =
    String(plan.reportText || "").length
      ? Math.max(
          0,
          Math.round(
            100 -
            (
              plan.residualText.length /
              String(plan.reportText || "").length
            ) * 100
          )
        )
      : 0;

  const qwenMs =
    plan.residualTargets.length
      ? Date.now() - qwenStartedAt
      : 0;

  merged.parserMs = plan.parserMs || 0;
  merged.qwenMs = qwenMs;

  return {
    parserExtraction:
      plan.parserExtraction,
    hybridExtraction,
    merged,
    strongResolved:
      plan.strongResolved,
    unresolvedTargets:
      plan.unresolvedTargets || plan.residualTargets,
    residualTargets:
      plan.residualTargets,
    skippedNoEvidenceTargets:
      plan.skippedNoEvidenceTargets || [],
    residualText:
      plan.residualText,
    parserMs:
      plan.parserMs || 0,
    qwenMs
  };
}

async function runResidualQwenAnalysis(
  reportText,
  targetExams,
  progressCallback = null
) {
  const plan =
    await prepareResidualQwenPlan(
      reportText,
      targetExams,
      progressCallback
    );

  return await runResidualQwenFromPlan(
    plan,
    progressCallback
  );
}

function collectRawBilirubinMeasurements(reportText) {
  const layout = detectKnownLabLayout(reportText);
  let raw = [];

  if (layout === "AOU_PADOVA") {
    raw = extractAouPadovaResults(reportText);
  } else if (layout === "ULSS6_SCHIAVONIA") {
    raw = [
      ...extractSpecimenAnchoredResults(reportText),
      ...extractUlss6DirectResults(reportText)
    ];
  } else {
    raw = extractSpecimenAnchoredResults(reportText);
  }

  // Integra eventuali frazioni bilirubiniche senza prefisso s-/p-
  // (frequente in alcuni referti SYNLAB).
  for (const line of cleanReportLines(reportText)) {
    const m = line.match(
      /^(Bilirubina\s+(?:Totale|Diretta|Indiretta|Coniugata|Non\s+Coniugata))\s+([<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?)\s+(mg\/dL|u?mol\/L|µmol\/L|μmol\/L)/i
    );

    if (!m) continue;

    raw.push({
      exam: m[1],
      raw_label: m[1],
      value: m[2].replace(/\s+/g, ""),
      unit: m[3],
      evidence: line
    });
  }

  const groups = new Map();

  for (const item of raw) {
    const specimen =
      detectSpecimen(item?.raw_label || item?.exam || "");

    if (specimen === "URINE") continue;

    const concept =
      getExamConcept(
        `${item?.exam || ""} ${item?.raw_label || ""}`
      );

    if (
      ![
        "BILIRUBIN_TOTAL",
        "BILIRUBIN_DIRECT",
        "BILIRUBIN_INDIRECT"
      ].includes(concept)
    ) {
      continue;
    }

    const rawValue =
      String(item?.value || "")
        .replace(/^[<>≤≥]\s*/, "")
        .trim();

    if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(rawValue)) {
      continue;
    }

    const converted =
      convertMeasurement(
        concept,
        rawValue,
        String(item?.unit || "")
      );

    if (!converted.ok) continue;

    if (!groups.has(concept)) {
      groups.set(concept, []);
    }

    groups.get(concept).push({
      value: converted.value,
      unit: converted.unit
    });
  }

  const output = {};

  for (const [concept, items] of groups.entries()) {
    if (!items.length) continue;

    const first = items[0];

    const agree =
      items.every(item =>
        valuesClinicallyEquivalent(
          item.value,
          first.value,
          concept
        )
      );

    if (agree) {
      output[concept] = first;
    }
  }

  return output;
}

function buildCompositeExamDetails(
  reportText,
  mergedExtraction
) {
  const output = [];

  const bilirubinResult =
    (mergedExtraction?.results || [])
      .find(item =>
        getExamConcept(
          `${item?.exam || ""} ${item?.raw_label || ""}`
        ) === "BILIRUBIN_TOTAL" &&
        normalizeExamName(item?.exam || "")
          .includes("BILIRUBINA REFLEX")
      );

  if (bilirubinResult) {
    const parts =
      collectRawBilirubinMeasurements(reportText);

    const total = parts.BILIRUBIN_TOTAL;
    const direct = parts.BILIRUBIN_DIRECT;
    const indirect = parts.BILIRUBIN_INDIRECT;

    if (direct || indirect) {
      const lines = [];

      if (total) {
        lines.push(
          `Bilirubina totale: ${total.value} ${total.unit}`
        );
      }

      if (direct) {
        lines.push(
          `Bilirubina diretta/coniugata: ${direct.value} ${direct.unit}`
        );
      }

      if (indirect) {
        lines.push(
          `Bilirubina indiretta/non coniugata: ${indirect.value} ${indirect.unit}`
        );
      }

      output.push({
        exam: bilirubinResult.exam,
        kind: "BILIRUBINA_COMPONENTI",
        text: lines.join("\n")
      });
    }
  }

  return output;
}

function buildStrongParserWriteSet(
  plan
) {
  const strong =
    plan?.strongResolved ||
    new Set();

  const results =
    (plan?.parserExtraction?.results || [])
      .filter(item =>
        strong.has(item?.exam) &&
        !getLongReportKind(item?.exam)
      )
      .map(item => ({
        ...item,
        workflowSource: "parser"
      }));

  const longReports =
    (plan?.parserExtraction?.longReports || [])
      .filter(item =>
        strong.has(item?.exam) &&
        !!String(item?.text || "").trim()
      )
      .map(item => ({
        ...item,
        workflowSource: "parser"
      }));

  const parserOnlyMerged =
    mergeIndependentReadings(
      plan.parserExtraction,
      emptyHybridExtraction(
        plan.parserExtraction
      ),
      plan.targets
    );

  const compositeDetails =
    buildCompositeExamDetails(
      plan.reportText,
      parserOnlyMerged
    );

  return {
    results,
    longReports,
    compositeDetails
  };
}

function filterPostQwenWriteSet(
  merged,
  strongResolved,
  alreadyCompletedComposite = []
) {
  const strong =
    strongResolved ||
    new Set();

  const results =
    (merged?.results || [])
      .filter(item =>
        !strong.has(item?.exam) &&
        item?.workflowSource === "qwen"
      );

  const longReports =
    (merged?.longReports || [])
      .filter(item =>
        !strong.has(item?.exam) &&
        item?.workflowSource === "qwen"
      );

  const completedCompositeKeys =
    new Set(
      (alreadyCompletedComposite || [])
        .map(item =>
          normalizeExamName(
            `${item?.exam || ""}|${item?.text || ""}`
          )
        )
    );

  return {
    results,
    longReports,
    completedCompositeKeys
  };
}

function auditItemName(item) {
  return String(
    item?.exam ||
    item?.raw_label ||
    item?.text ||
    item?.catalogName ||
    item?.name ||
    ""
  ).trim();
}

function buildEumedAudit(extraction, reportText = "") {
  const targetExams = (extraction?.targetedAiTargets || []).filter(Boolean);
  const normalizedReport =
    normalizeExamName(reportText);

  function targetHasReportEvidence(exam) {
    if (!normalizedReport) return true;

    const terms =
      [...targetConceptTerms(exam)]
        .map(normalizeExamName)
        .filter(term => term && term.length >= 3);

    return terms.some(term =>
      normalizedReport.includes(term)
    );
  }

  const presentLongKinds = new Set(
    targetExams
      .map(getLongReportKind)
      .filter(Boolean)
  );

  const hasCreatinineTarget = targetExams.some(
    exam => getExamConcept(exam) === "CREATININE"
  );

  const shouldSuppressComponentWarning = item => {
    const text = `${auditItemName(item)} ${item?.reason || ""}`;
    const n = normalizeExamName(text);

    if (isLongReportComponent(text, presentLongKinds)) {
      return true;
    }

    // eGFR è informazione accessoria della creatinina sierica e non una
    // prestazione autonoma quando in Eumed esiste già CREATININA.
    if (
      hasCreatinineTarget &&
      (
        /\bEGFR\b/.test(n) ||
        n.includes("FILTRAZIONE GLOMERULARE")
      )
    ) {
      return true;
    }

    return false;
  };

  const presentInReportAbsentEumed =
    (extraction?.recognizedNotInGrid || [])
      .filter(item => !shouldSuppressComponentWarning(item))
      .map(item => ({
        name: auditItemName(item),
        detail:
          item?.value
            ? `${item.value}${item.unit ? " " + item.unit : ""}`
            : ""
      }))
      .filter(x => x.name);

  const rawAmbiguousItems = [
    ...(extraction?.uncertain || []).map(item => ({
      name: auditItemName(item) || "Dato non risolto",
      reason: String(item?.reason || "").trim()
    })),
    ...(extraction?.rejected || []).map(item => ({
      name: auditItemName(item) || "Dato rifiutato",
      reason: String(item?.reason || "").trim()
    }))
  ]
    .filter(item => !shouldSuppressComponentWarning(item))
    .filter(item => {
      // Se IA propone un target Eumed ma nel referto non compare
      // nemmeno una delle sue ancore lessicali, il risultato rifiutato
      // è rumore del modello: va classificato come "non trovato",
      // non come esame ambiguo/non validabile.
      const itemName =
        normalizeExamName(item.name);

      const matchingTarget =
        targetExams.find(exam => {
          const targetName =
            normalizeExamName(exam);

          if (
            itemName &&
            targetName &&
            (
              itemName === targetName ||
              itemName.includes(targetName) ||
              targetName.includes(itemName)
            )
          ) {
            return true;
          }

          const itemConcept =
            getExamConcept(item.name);
          const targetConcept =
            getExamConcept(exam);

          return (
            itemConcept &&
            targetConcept &&
            itemConcept === targetConcept
          );
        });

      if (
        matchingTarget &&
        !targetHasReportEvidence(
          matchingTarget
        )
      ) {
        return false;
      }

      return true;
    });

  const ambiguousItems = [];
  const seenAmbiguous = new Set();

  for (const item of rawAmbiguousItems) {
    const key = normalizeExamName(`${item.name}|${item.reason}`);
    if (seenAmbiguous.has(key)) continue;
    seenAmbiguous.add(key);
    ambiguousItems.push(item);
  }

  const resolvedNames = new Set(
    [
      ...(extraction?.results || []).map(x => x?.exam),
      ...(extraction?.longReports || []).map(x => x?.exam)
    ]
      .filter(Boolean)
      .map(normalizeExamName)
  );

  const ambiguousText = normalizeExamName(
    ambiguousItems
      .map(x => `${x.name} ${x.reason}`)
      .join(" ")
  );

  const eumedNotFound = targetExams
    .filter(exam => !resolvedNames.has(normalizeExamName(exam)))
    .filter(exam => {
      const n = normalizeExamName(exam);
      return !n || !ambiguousText.includes(n);
    });

  const dedupeNamed = list => {
    const seen = new Set();
    return list.filter(item => {
      const key = normalizeExamName(
        typeof item === "string"
          ? item
          : `${item?.name || ""}|${item?.detail || ""}`
      );
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  return {
    presentInReportAbsentEumed: dedupeNamed(presentInReportAbsentEumed),
    eumedNotFound: dedupeNamed(eumedNotFound),
    ambiguousItems,
    transferText: buildPrescribedTransferText(extraction,reportText)
  };
}

module.exports = {
  buildCompositeExamDetails,
  buildEumedAudit,
  buildStrongParserWriteSet,
  filterPostQwenWriteSet,
  prepareResidualQwenPlan,
  runResidualQwenAnalysis,
  runResidualQwenFromPlan,
};
