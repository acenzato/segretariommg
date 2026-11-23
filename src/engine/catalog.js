// Catalogo laboratorio locale, specimen, unità di misura e conversioni.
"use strict";

const {
  getAvailableExams,
  loadLabCatalogData,
} = require("./host");
const {
  EXAM_ALIASES,
  FREQUENT_EXAM_HINT_RULES,
  frequentRuleMatchesExam,
  getExamConcept,
  normalizeExamName,
} = require("./core");

function getFrequentExamPriorityHints(availableExams) {
  const result = [];
  const seen = new Set();

  for (const rule of FREQUENT_EXAM_HINT_RULES) {
    const matches = availableExams.filter(exam =>
      frequentRuleMatchesExam(rule, exam)
    );

    for (const exam of matches) {
      const key = normalizeExamName(exam);
      if (seen.has(key)) continue;
      seen.add(key);

      const catalogMatch = matchCatalog(exam);
      const code = catalogMatch?.entry?.code || "";

      result.push({
        exam,
        code,
        key: rule.key
      });
    }
  }

  return result;
}


// ============================================================
// CATALOGO LABORATORIO LOCALE + SPECIMEN
// ============================================================

const labCatalog = [];
let labCatalogPromise = null;

async function ensureLabCatalog() {
  if (labCatalog.length) return labCatalog;

  if (!labCatalogPromise) {
    labCatalogPromise = Promise.resolve()
      .then(() => loadLabCatalogData())
      .then(data => {
        const entries = Array.isArray(data?.entries) ? data.entries : [];
        labCatalog.length = 0;
        for (const entry of entries) labCatalog.push(entry);
        return labCatalog;
      })
      .catch(error => {
        labCatalogPromise = null;
        console.warn("Segretario MMG: catalogo laboratorio non disponibile.", error);
        return [];
      });
  }

  return labCatalogPromise;
}

function detectSpecimen(text) {
  const n = normalizeExamName(text);
  if (/\[\s*U\s*\]/i.test(String(text))) return "URINE";
  if (/\[\s*(?:S|P)\s*\]/i.test(String(text))) return "SERUM";

  if (
    /^U\b/.test(n) ||
    /MICROALBUMIN|ALBUMINUR/.test(n) ||
    /\bURIN/.test(n) ||
    /\bU 24H\b/.test(n) ||
    /\bURINE\b/.test(n)
  ) {
    return "URINE";
  }

  if (
    /\[\s*(?:S|P)\s*\]/i.test(String(text)) ||
    /^S\b/.test(n) ||
    /^SI\b/.test(n) ||
    /^P\b/.test(n) ||
    /\bSIERO\b/.test(n) ||
    /\bPLASMA\b/.test(n) ||
    /\bSANGUE\b/.test(n) ||
    /\bS$/.test(n)
  ) {
    return "SERUM";
  }

  return "";
}

function specimenCompatible(query, candidate) {
  const q = detectSpecimen(query);
  const c = detectSpecimen(candidate);

  if (q === "URINE") {
    return c === "URINE";
  }

  if (c === "URINE" && q !== "URINE") {
    return false;
  }

  return true;
}

const CATALOG_QUERY_ALIASES = {
  "SIDEREMIA": "FERRO",
  "VITAMINA B12": "COBALAMINA VIT B12",
  "B12": "COBALAMINA VIT B12",
  "NT PROBNP": "PEPTIDE NATRIURETICO TIPO B BNP O NT PROBNP",
  "NTPROBNP": "PEPTIDE NATRIURETICO TIPO B BNP O NT PROBNP",
  "LAD": "LATTATO DEIDROGENASI LDH",
  "P LAD": "LATTATO DEIDROGENASI LDH",
  "FLC KAPPA": "CATENE LEGGERE LIBERE KAPPA",
  "FLC LAMBDA": "CATENE LEGGERE LIBERE LAMBA",
  "FLC LAMBA": "CATENE LEGGERE LIBERE LAMBA",
  "MICROALBUMINURIA": "ALBUMINURIA MICROALBUMINURIA",
  "ALBUMINA URINARIA MICROALBUMINURIA": "ALBUMINURIA MICROALBUMINURIA",
  "CEA": "ANTIGENE CARCINO EMBRIONARIO CEA",
  "ANTIGENE CARCINOEMBRIONALE CEA": "ANTIGENE CARCINO EMBRIONARIO CEA",
  "CA 15 3": "ANTIGENE CARBOIDRATICO 15 3 CA 15 3",
  "PSA REFLEX": "ANTIGENE PROSTATICO SPECIFICO PSA REFLEX",
  "PSA": "ANTIGENE PROSTATICO SPECIFICO PSA REFLEX",
  "VELOCITA DI FILTRAZIONE GLOMERULARE": "CREATININA S CON EVENTUALE EGFR",
  "FILTRAZIONE GLOMERULARE": "CREATININA S CON EVENTUALE EGFR",
  "EGFR": "CREATININA S CON EVENTUALE EGFR"
};

function stripSpecimenPrefix(text) {
  return normalizeExamName(text)
    .replace(/^(S|SI|P|U)\s+/, "")
    .trim();
}

function catalogScore(query, alias, options = {}) {
  let q = stripSpecimenPrefix(query);
  const a = stripSpecimenPrefix(alias);

  if (!q || !a) return 0;

  const aliasTarget = CATALOG_QUERY_ALIASES[q];
  if (aliasTarget) q = normalizeExamName(aliasTarget);

  if (q === a) return 1000;
  const containsPhrase = (text, phrase) => (` ${text} `).includes(` ${phrase} `);
  const contained = options.wholeWords
    ? containsPhrase(a, q) || containsPhrase(q, a)
    : a.includes(q) || q.includes(a);
  if (contained) {
    const minLen = Math.min(a.length, q.length);
    return 800 + Math.min(150, minLen);
  }

  const qTokens = significantTokens(q);
  const aTokens = significantTokens(a);

  if (!qTokens.length || !aTokens.length) return 0;

  const aSet = new Set(aTokens);
  const matched = qTokens.filter(token => aSet.has(token)).length;
  const coverage = matched / qTokens.length;
  const reverse = matched / aTokens.length;

  if (coverage === 1) return 650 + Math.round(reverse * 100);
  if (coverage >= 0.75 && matched >= 2) return 500 + Math.round(coverage * 100);

  return 0;
}

function matchCatalog(query) {
  if (!labCatalog.length) return null;

  let best = null;
  let bestScore = 0;
  let secondScore = 0;

  for (const entry of labCatalog) {
    const aliases = [
      entry?.name,
      ...(Array.isArray(entry?.aliases) ? entry.aliases : [])
    ].filter(Boolean);

    let score = 0;

    for (const alias of aliases) {
      if (!specimenCompatible(query, alias)) continue;
      score = Math.max(score, catalogScore(query, alias));
    }

    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = entry;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  if (!best || bestScore < 650) return null;

  // Evita associazioni deboli/ambigue.
  if (bestScore < 900 && bestScore - secondScore < 80) {
    return null;
  }

  return {
    entry: best,
    score: bestScore
  };
}

function gridMatchesCatalogEntry(entry, query) {
  const exams = getAvailableExams();
  const aliases = [
    entry?.name,
    ...(Array.isArray(entry?.aliases) ? entry.aliases : [])
  ].filter(Boolean);

  const scored = exams
    .filter(exam => specimenCompatible(query, exam))
    .map(exam => {
      let score = 0;
      for (const alias of aliases) {
        score = Math.max(score, catalogScore(alias, exam));
      }
      return { exam, score };
    })
    .filter(x => x.score >= 650)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return [];

  const top = scored[0].score;
  return scored
    .filter(x => x.score === top)
    .map(x => x.exam);
}

function significantTokens(text) {
  const ignored = new Set([
    "P", "S", "U", "PLASMA", "SIERO", "SANGUE", "DOSAGGIO", "TEST"
  ]);

  return normalizeExamName(text)
    .split(" ")
    .filter(token => token.length >= 3 && !ignored.has(token));
}

function resolveExamName(query) {
  const exams = getAvailableExams();
  const q = normalizeExamName(query);

  if (!q) {
    return {
      success: false,
      reason: "not_found",
      query
    };
  }

  // Preferenze catalogo forti per denominazioni di laboratorio ricorrenti.
  // Servono soprattutto quando in Grid esistono prestazioni amministrative
  // più specifiche del nome usato dal laboratorio.
  const specialConcept = getExamConcept(query);

  // v0.10.2: concept-first. Se in Eumed esiste una sola prestazione
  // con lo stesso concetto clinico, usala come target naturale.
  if (specialConcept) {
    const conceptMatches = exams.filter(exam =>
      specimenCompatible(query, exam) &&
      getExamConcept(exam) === specialConcept
    );

    if (conceptMatches.length === 1) {
      return {
        success: true,
        exam: conceptMatches[0],
        method: "eumed-concept-first",
        concept: specialConcept
      };
    }
  }

  if (specialConcept === "ACR") {
    const acr = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return (n.includes("MICROALBUMINURIA") && n.includes("ACR")) ||
             (n.includes("ALBUMINA") && n.includes("CREATININA") && (n.includes("ACR") || n.includes("RAPPORTO")));
    });
    if (acr.length === 1) {
      return { success: true, exam: acr[0], method: "catalog-special-acr", concept: "ACR" };
    }
  }

  if (specialConcept === "VES") {
    const matches = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return (
        /\bVES\b/.test(n) ||
        (
          n.includes("VELOCITA") &&
          n.includes("SEDIMENTAZIONE")
        )
      );
    });

    if (matches.length === 1) {
      return {
        success: true,
        exam: matches[0],
        method: "eumed-special-ves",
        concept: "VES"
      };
    }
  }

  if (specialConcept === "IRON") {
    const matches = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return (
        /\bFERRO\b/.test(n) ||
        n.includes("SIDEREMIA")
      ) && !n.includes("FERRITINA");
    });

    if (matches.length === 1) {
      return {
        success: true,
        exam: matches[0],
        method: "eumed-special-iron",
        concept: "IRON"
      };
    }
  }

  if (specialConcept === "FT4") {
    const matches = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return (
        /\bFT4\b/.test(n) ||
        (
          n.includes("TIROXINA") &&
          n.includes("LIBERA")
        )
      );
    });

    if (matches.length === 1) {
      return {
        success: true,
        exam: matches[0],
        method: "eumed-special-ft4",
        concept: "FT4"
      };
    }
  }

  if (specialConcept === "FT3") {
    const matches = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return (
        /\bFT3\b/.test(n) ||
        (
          n.includes("TRIIODOTIRONINA") &&
          n.includes("LIBERA")
        )
      );
    });

    if (matches.length === 1) {
      return {
        success: true,
        exam: matches[0],
        method: "eumed-special-ft3",
        concept: "FT3"
      };
    }
  }

  if (specialConcept === "AST") {
    const matches = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return (
        /\bAST\b/.test(n) ||
        /\bGOT\b/.test(n) ||
        n.includes("ASPARTATO AMINOTRANSFERASI")
      );
    });

    if (matches.length === 1) {
      return {
        success: true,
        exam: matches[0],
        method: "eumed-special-ast",
        concept: "AST"
      };
    }
  }

  if (specialConcept === "GLUCOSE") {
    const matches = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return n.includes("GLUCOSIO") &&
             !n.includes("URIN") &&
             !n.includes("CURVA") &&
             !n.includes("CARICO");
    });
    if (matches.length === 1) {
      return { success: true, exam: matches[0], method: "eumed-special-glucose", concept: "GLUCOSE" };
    }
  }

  if (specialConcept === "GGT") {
    const preferred = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return (
        n.includes("GAMMA GLUTAMIL") ||
        /\bGGT\b/.test(n)
      ) && !n.includes("URIN");
    });

    if (preferred.length === 1) {
      return {
        success: true,
        exam: preferred[0],
        method: "eumed-special-ggt",
        concept: "GGT"
      };
    }
  }

  if (specialConcept === "VITAMIN_D") {
    const matches = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return n.includes("VITAMINA D") && (n.includes("25") || n.includes("OH"));
    });
    if (matches.length === 1) {
      return { success: true, exam: matches[0], method: "eumed-special-vitamin-d", concept: "VITAMIN_D" };
    }
  }

  if (specialConcept === "CREATININE") {
    const preferred = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return n.includes("CREATININA") &&
             !n.includes("URIN") &&
             !n.includes("ACR") &&
             (n.includes("EGFR") || n.includes("EVENTUALE"));
    });
    if (preferred.length === 1) {
      return { success: true, exam: preferred[0], method: "eumed-special-creatinine-egfr", concept: "CREATININE" };
    }
    const matches = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return n.includes("CREATININA") && !n.includes("URIN") && !n.includes("ACR");
    });
    if (matches.length === 1) {
      return { success: true, exam: matches[0], method: "eumed-special-creatinine", concept: "CREATININE" };
    }
  }

  if (specialConcept === "PHOSPHATE") {
    const phosphate = exams.filter(exam =>
      normalizeExamName(exam).includes("FOSFATO INORGANICO") && specimenCompatible(query,exam)
    );

    if (phosphate.length === 1) {
      return {
        success: true,
        exam: phosphate[0],
        method: "catalog-special-phosphate",
        concept: "PHOSPHATE"
      };
    }
  }

  if (
    specialConcept === "BILIRUBIN_TOTAL" &&
    (q.includes("BILIRUBINA TOTALE") || q.includes("BILIRUBINA REFLEX"))
  ) {
    const reflex = exams.filter(exam =>
      normalizeExamName(exam).includes("BILIRUBINA REFLEX")
    );

    if (reflex.length === 1) {
      return {
        success: true,
        exam: reflex[0],
        method: "catalog-special-bilirubin-reflex",
        concept: "BILIRUBIN_TOTAL"
      };
    }
  }

  if (
    specialConcept === "TSH" &&
    (q.includes("RIFLESS") || q.includes("REFLEX"))
  ) {
    const reflex = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return n.includes("TIREOTROPINA") && n.includes("REFLEX");
    });

    if (reflex.length === 1) {
      return {
        success: true,
        exam: reflex[0],
        method: "catalog-special-tsh-reflex",
        concept: "TSH"
      };
    }
  }

  if (
    specialConcept === "TSH" &&
    !q.includes("RIFLESS") &&
    !q.includes("REFLEX")
  ) {
    const standard = exams.filter(exam => {
      const n = normalizeExamName(exam);
      return (n.includes("TIREOTROPINA") || /\bTSH\b/.test(n)) &&
             !n.includes("REFLEX") && !n.includes("RIFLESS");
    });
    if (standard.length === 1) {
      return { success: true, exam: standard[0], method: "catalog-special-tsh-standard", concept: "TSH" };
    }
  }

  const compatibleExams = exams.filter(
    exam => specimenCompatible(query, exam)
  );

  const exact = compatibleExams.filter(
    exam => normalizeExamName(exam) === q
  );

  if (exact.length === 1) {
    return {
      success: true,
      exam: exact[0],
      method: "exact"
    };
  }

  const concept = getExamConcept(query);

  if (concept) {
    const conceptMatches = compatibleExams.filter(
      exam => getExamConcept(exam) === concept
    );

    if (conceptMatches.length === 1) {
      return {
        success: true,
        exam: conceptMatches[0],
        method: "concept",
        concept
      };
    }

    if (conceptMatches.length > 1) {
      return {
        success: false,
        reason: "ambiguous",
        query,
        concept,
        candidates: conceptMatches
      };
    }
  }

  let search = q;

  if (EXAM_ALIASES[q]) {
    search = normalizeExamName(EXAM_ALIASES[q]);
  }

  const contains = compatibleExams.filter(
    exam => normalizeExamName(exam).includes(search)
  );

  if (contains.length === 1) {
    return {
      success: true,
      exam: contains[0],
      method: search === q ? "contains" : "alias"
    };
  }

  if (contains.length > 1) {
    return {
      success: false,
      reason: "ambiguous",
      query,
      candidates: contains
    };
  }

  const tokens = significantTokens(query);

  if (tokens.length) {
    const tokenMatches = compatibleExams.filter(exam => {
      const en = normalizeExamName(exam);
      return tokens.every(token => en.includes(token));
    });

    if (tokenMatches.length === 1) {
      return {
        success: true,
        exam: tokenMatches[0],
        method: "tokens"
      };
    }

    if (tokenMatches.length > 1) {
      return {
        success: false,
        reason: "ambiguous",
        query,
        candidates: tokenMatches
      };
    }
  }

  // Ultimo livello: catalogo regionale di laboratorio locale.
  const catalogMatch = matchCatalog(query);

  if (catalogMatch?.entry) {
    const gridMatches = gridMatchesCatalogEntry(
      catalogMatch.entry,
      query
    );

    if (gridMatches.length === 1) {
      return {
        success: true,
        exam: gridMatches[0],
        method: "catalog",
        catalogEntry: catalogMatch.entry
      };
    }

    if (gridMatches.length > 1) {
      return {
        success: false,
        reason: "ambiguous",
        query,
        candidates: gridMatches,
        catalogEntry: catalogMatch.entry
      };
    }

    return {
      success: false,
      reason: "known_not_in_grid",
      query,
      catalogEntry: catalogMatch.entry
    };
  }

  return {
    success: false,
    reason: "not_found",
    query
  };
}

module.exports = {
  catalogScore,
  detectSpecimen,
  ensureLabCatalog,
  getFrequentExamPriorityHints,
  labCatalog,
  matchCatalog,
  resolveExamName,
  significantTokens,
  stripSpecimenPrefix,
};
