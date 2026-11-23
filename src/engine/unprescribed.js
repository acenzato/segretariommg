// Analisi per inserimento senza prescrizioni ed elenco prescrizioni.
"use strict";

const {
  getAvailableExams,
  recordDiagnosticEvent,
} = require("./host");
const {
  PREFERRED_UNITS,
  getExamConcept,
  getLongReportKind,
  normalizeDateValue,
  normalizeExamName,
  parseItalianNumber,
  sameNumericValue,
} = require("./core");
const {
  catalogScore,
  detectSpecimen,
  ensureLabCatalog,
  labCatalog,
  resolveExamName,
  significantTokens,
  stripSpecimenPrefix,
} = require("./catalog");
const {
  convertMeasurement,
  convertRange,
  normalizeLongReportText,
  normalizeUnit,
  prepareRangeInput,
  splitReportText,
  unitsCompatible,
} = require("./long-report");
const {
  aiLineHasMeasurement,
  buildPsaReflexLongReport,
  buildPsaReflexLongReportFromRawResults,
  buildReferenceIntervalPrompt,
  cleanModelLabLabel,
  cleanReportLines,
  detectKnownLabLayout,
  extractAcrResult,
  extractAouPadovaResults,
  extractHbA1cFallback,
  extractJSONObject,
  extractKnownLongReportText,
  extractPaddleTabularResults,
  extractSpecimenAnchoredResults,
  extractUlss6DirectResults,
  genericLongReportSlice,
  getKnownLayoutDisplayName,
  isHbA1cAuxiliaryLine,
  isHbA1cLabel,
  isLongReportComponent,
  knownLongReportKinds,
  ollamaChat,
  parseAnchoredMeasurementLine,
  parseExplicitReportDateText,
  parseInlineKnownMeasurement,
  parseInlineSpecimenMeasurement,
  removeConsumedAiLines,
  removeUnsupportedDuplicateAssignments,
  reportContainsLongReportCluster,
  reportReallyContainsLongReportKind,
  sourceSupportScoreForResult,
  stripKnownPageChrome,
  unitCompatibleWithConcept,
  validateAiMeasurementEvidence,
  validatedAiReportDate,
  valuesClinicallyEquivalent,
} = require("./extraction");

// Voci principali della branca 11 Laboratorio ricontrollate nel catalogo
// locale CVP 2026-10-30. Per i referti composti si crea UNA sola riga Eumed
// e il dettaglio viene scritto nel campo Referto.
const UNPRESCRIBED_FIXED_COMPLEX_CODES = {
  EMOCROMO: "90.62.2_2",
  PROTIDOGRAMMA: "90.38.4_0",
  URINE: "90.44.3_0",
  PSA_REFLEX: "90.56.9_0",
  BILIRUBINA: "90.10.5_3",
  TIPIZZAZIONE_LINFOCITARIA: "91.47.C_2",
  TIPIZZAZIONE_MONOCLONALE: "90.69.2_2",
  BENCE_JONES: "90.69.2_3"
};

function findCatalogEntryByCode(code) {
  const wanted = String(code || "").trim();
  if (!wanted) return null;
  return labCatalog.find(entry => String(entry?.code || "") === wanted) || null;
}

function catalogEntrySpecimen(entry) {
  const raw = String(entry?.name || "").toUpperCase();
  const n = normalizeExamName(raw);

  const serumSpecific =
    raw.includes("[S]") ||
    raw.includes("[P]") ||
    n.includes("SIERO") ||
    n.includes("PLASMA");

  const urineSpecific =
    raw.includes("[U]") ||
    raw.includes("[DU]") ||
    n.includes("URINE") ||
    n.includes("URINARIO") ||
    n.includes("URINARIA");

  if (serumSpecific && !urineSpecific) return "SERUM";
  if (urineSpecific && !serumSpecific) return "URINE";
  if (serumSpecific && urineSpecific) return "MULTI";
  return "";
}

function sanitizeCreationCatalogAlias(alias) {
  let s = String(alias || "").trim();
  if (!s) return "";

  // Molte aliases CVP contengono istruzioni amministrative che citano ALTRI
  // esami ("Non associabile a...", "Incluso: ..."). Quelle parole non sono
  // sinonimi e non devono influenzare il resolver che CREA una nuova riga.
  s = s.split(/(?:[.;]\s*|\s+-\s+|\s+)(?:Non associabile|Inclus[oa]|Erogabile|Salvo range|Se TSH|Per la valutazione|Nell'ambito)\b/i)[0];
  return s.trim();
}

function buildUnprescribedDecisionContext(reportText, rawResults = []) {
  const rawLabels = (rawResults || [])
    .map(item => `${item?.raw_label || ""} ${item?.exam || ""}`.trim())
    .filter(Boolean)
    .join("\n");
  const source = `${String(reportText || "")}\n${rawLabels}`;
  const n = normalizeExamName(source);

  const thyroidHasFreeHormones =
    /(?:^|\s)FT4(?:\s|$)/.test(n) ||
    /(?:^|\s)FT3(?:\s|$)/.test(n) ||
    n.includes("TIROXINA LIBERA") ||
    n.includes("TRIIODOTIRONINA LIBERA");

  const lines = String(source || "").replace(/\r/g, "").split("\n");
  const serology = {
    ROSOLIA: { igg: false, igm: false },
    VARICELLA: { igg: false, igm: false },
    HAV: { igg: false, igm: false }
  };

  for (const rawLine of lines) {
    const line = normalizeExamName(rawLine || "");
    if (!line) continue;

    let family = "";
    if (line.includes("ROSOLIA") || line.includes("RUBELL")) family = "ROSOLIA";
    else if (line.includes("VARICELL") || /(?:^|\s)VZV(?:\s|$)/.test(line)) family = "VARICELLA";
    else if (/(?:^|\s)HAV(?:\s|$)/.test(line) || line.includes("EPATITE A")) family = "HAV";
    if (!family) continue;

    if (/(?:^|\s)IGG(?:\s|$)/.test(line)) serology[family].igg = true;
    if (/(?:^|\s)IGM(?:\s|$)/.test(line)) serology[family].igm = true;
  }

  // Metodo LDL: nei referti AOU la dicitura "(metodo diretto)" può stare
  // sulla riga immediatamente successiva a P-LDL COLESTEROLO. Conserviamo
  // questa informazione nel contesto così il resolver può scegliere la voce
  // prescrivibile corretta invece di dichiarare ambiguità diretto/indiretto.
  let ldlMethod = "";
  for (let i = 0; i < lines.length; i++) {
    const line = normalizeExamName(lines[i] || "");
    if (!/\bLDL\b/.test(line)) continue;
    const window = normalizeExamName(lines.slice(i, i + 3).join(" "));
    if (/METODO DIRETT|DETERMINAZIONE DIRETT/.test(window) && !/INDIRETT/.test(window)) {
      ldlMethod = "direct";
      break;
    }
    if (/INDIRETT|CALCOLAT|FRIEDEWALD/.test(window)) {
      ldlMethod = "indirect";
      break;
    }
  }

  const urineCreatinineForAcr = lines.some((line, index) => {
    if (!/^U\s+CREATININA\b/.test(normalizeExamName(line))) return false;
    const nearby = normalizeExamName(lines.slice(Math.max(0, index - 3), index + 5).join("\n"));
    return /RAPP(?:ORTO)?\s+(?:U\s+)?ALBUMINA\s+(?:U\s+)?CREATININA/.test(nearby);
  });
  return { thyroidHasFreeHormones, serology, ldlMethod, urineCreatinineForAcr };
}

function serologyFamilyState(context, family) {
  return context?.serology?.[family] || { igg: false, igm: false };
}

function preferredCreationCatalogDecision(query, context = {}) {
  const n = normalizeExamName(query || "");
  if (!n) return null;
  const concept = getExamConcept(query || "");

  const exact = code => {
    const entry = findCatalogEntryByCode(code);
    return entry ? { entry, score: 3000, preferred: true } : null;
  };

  if (/COLESTEROLO NON HDL/.test(n)) return { blocked: true, reason: "Colesterolo non-HDL: dato derivato senza prestazione autonoma univoca nel catalogo. Consulta il valore nel referto originale." };
  if (detectSpecimen(query) !== "URINE" && /^COLESTEROLO(?: TOTALE)?(?: S)?$/.test(stripSpecimenPrefix(query))) return exact("90.14.3_0");

  // Il rapporto albumina/creatinina non e' il dosaggio della creatinina
  // urinaria per ACR. Questa guardia deve precedere i mapping creatinina.
  if (/RAPP(?:ORTO)?\s+(?:U\s+)?ALBUMINA\s+(?:U\s+)?CREATININA|RAPPORTO\s+ALB\s+CRE|^(?:ACR|RAC)(?:\s|$)/.test(n)) {
    return { blocked: true, reason: "Rapporto albumina/creatinina urinario (ACR), non creatinina sierica: nessuna voce catalogo univoca per il rapporto" };
  }
  if (concept === "FT3") return exact("90.43.3_0");

  // Sierologie con voce diversa per stato immune vs ricerca di infezione.
  // Regola operativa: solo IgG nel referto => stato immune; IgG + IgM =>
  // ricerca di infezione attiva. Non dipendiamo da un quesito clinico che
  // normalmente non compare nel referto ematochimico.
  if (n.includes("ROSOLIA") || n.includes("RUBELL")) {
    const state = serologyFamilyState(context, "ROSOLIA");
    const hasIgM = /\bIGM\b/.test(n) || state.igm;
    const hasIgG = /\bIGG\b/.test(n) || state.igg;
    if (hasIgM) return exact("91.26.D_0");
    if (hasIgG) return exact("91.26.E_0");
  }

  if (n.includes("VARICELL") || /\bVZV\b/.test(n)) {
    const state = serologyFamilyState(context, "VARICELLA");
    const lineIgM = /\bIGM\b/.test(n);
    const lineIgG = /\bIGG\b/.test(n);
    if (lineIgM) return exact("91.26.C_4");
    if (lineIgG) return exact(state.igm ? "91.26.C_3" : "91.26.C_2");
  }

  if (/\bHAV\b/.test(n) || n.includes("EPATITE A")) {
    const state = serologyFamilyState(context, "HAV");
    const lineIgM = /\bIGM\b/.test(n);
    const lineIgG = /\bIGG\b/.test(n);
    if (lineIgM) return exact("91.17.6_3");
    if (lineIgG) return exact(state.igm ? "91.17.6_2" : "91.17.8_0");
  }

  if (/ANTI ?HBC|\bHBCAB\b/.test(n)) {
    return { blocked: true, reason: "Anti-HBc isolato: nessuna voce prescrivibile individuale univoca nel catalogo locale" };
  }

  // Voci routine che nel CVP hanno aliases/varianti abbastanza vicine da
  // rendere il fuzzy matching pericoloso in creazione riga.
  if (/\bHBA1C\b/.test(n) || n.includes("EMOGLOBINA GLICATA")) return exact("90.28.1_0");

  // Marcatori tumorali: nel catalogo CEA ha più aliases/varianti quasi
  // equivalenti (e persino aliases amministrativi su altre voci). Per la
  // routine sierica scegliamo esplicitamente la prestazione corretta.
  if (/\bCEA\b/.test(n) || n.includes("CARCINO EMBRION") || n.includes("CARCINOEMBRION")) {
    return exact("90.56.3_2");
  }
  if (/\bCA 15 3\b/.test(n) || n.includes("ANTIGENE CARBOIDRATICO 15 3")) {
    return exact("90.55.2_0");
  }

  // 1,25-diidrossivitamina D è una prestazione diversa dalla 25-OH vitamina D.
  if ((/\b1 25\b/.test(n) || n.includes("1 25 VITAMINA D")) && n.includes("VITAMINA D")) {
    return exact("90.44.5_2");
  }

  // Vitamina D di routine / 25-OH: va distinta dalla 1,25-OH.
  // Nei referti AOU/Synlab la riga può essere semplicemente "S-VITAMINA D"
  // e la specifica "25 idrossicalciferolo" può comparire sulla riga seguente:
  // il concetto VITAMIN_D identifica quindi la prestazione 25-OH.
  if (concept === "VITAMIN_D" || n.includes("25 IDROSSICALCIFEROLO") || /\b25 OH\b/.test(n)) {
    return exact("90.44.6_2");
  }

  // Analiti che nel catalogo hanno voce padre + variante specifica per siero/plasma.
  // In creazione riga scegliamo direttamente il codice figlio mostrato da Eumed,
  // evitando ambiguità con la voce padre o con varianti non pertinenti.
  if (concept === "B12" || n.includes("COBALAMINA") || /\bB ?12\b/.test(n)) {
    return exact("90.13.5_2");
  }

  if (concept === "LDH" || /\bLDH\b/.test(n) || /\bLAD\b/.test(n) || n.includes("LATTATO DEIDROGENASI") || n.includes("LATTATODEIDROGENASI")) {
    return exact("90.29.2_2");
  }

  if (concept === "VES" || /\bV E S\b/.test(n)) return exact("90.82.5_0");

  if ((/\bCK\b/.test(n) || n.includes("CREATINFOSFOCHINASI") || n.includes("CREATINCHINASI")) &&
      !/CK.?MB|ISOENZ|DOPO SFORZO/.test(n)) return exact("90.15.4_2");

  if (concept === "TSH" || /\bTSH\b/.test(n) || n.includes("TIREOTROPINA")) {
    if (n.includes("REFLEX") || n.includes("RIFLESS")) return exact("90.41.8_0");
    // Preferenza operativa: TSH isolato => TSH Reflex; se nello stesso
    // referto compaiono FT4 e/o FT3 => TSH standard non-reflex.
    return context?.thyroidHasFreeHormones
      ? exact("90.42.1_0")
      : exact("90.41.8_0");
  }

  if ((concept === "CRP" || n.includes("PROTEINA C REATTIVA")) &&
      /ALTA SENS|ULTRA SENS|ULTRASENS|HS.?CRP|HS PCR/.test(n)) return exact("90.72.3_3");

  if (n.includes("PROCALCITONINA")) return exact("90.38.Z_2");

  if ((concept === "APTT" || /\bAPTT\b/.test(n) || n.includes("TROMBOPLASTINA PARZIALE")) &&
      !/LAC|LUPUS|ANTICOAGULANT/.test(n)) return exact("90.76.1_0");

  if ((concept === "PT" || /\bTEMPO DI PROTROMBINA\b/.test(n) || /(?:^| )PT(?: |$)/.test(n)) &&
      !/PROTEINA C|PROTEINA S/.test(n)) return exact("90.75.4_0");

  if (n.includes("SATURAZIONE TRANSFERRINA") || /\bTIBC\b/.test(n)) return exact("SATTRANSF");

  // Creatinina urinaria: il catalogo distingue 24h e voce per calcolo ACR.
  // Se il referto dice solo "U-creatinina" non inventiamo quale delle due.
  if (n.includes("CREATININA") && /ACR|ALBUMIN.?CREAT/.test(n)) return exact("90.16.3_7");
  if (concept === "CREATININE_URINE" || (concept === "CREATININE" && detectSpecimen(query) === "URINE")) {
    if (/24 ?H|24 ORE|GIORNALIER/.test(n)) return exact("90.16.3_3");
    if (/ACR|ALBUMIN.?CREAT|RAPPORTO/.test(n)) return exact("90.16.3_7");
    if (context?.urineCreatinineForAcr && !/MINZ|DROGHE|PERITONE|DIALISI/.test(n)) return exact("90.16.3_7");
    return { blocked: true, reason: "Creatinina urinaria senza tipologia prescrivibile univoca" };
  }

  // Il rapporto ACR non ha nel catalogo locale una voce unica inequivoca.
  if (/RAPPORTO.*ALBUMIN.*CREAT|ALBUMIN.*CREAT.*RAPPORTO|\bACR\b/.test(n)) {
    return { blocked: true, reason: "Rapporto albumina/creatinina senza voce catalogo univoca" };
  }

  // LDL: se il referto specifica diretto/indiretto possiamo decidere; altrimenti
  // lasciamo l'ambiguità esplicita anziché scegliere arbitrariamente.
  if (concept === "LDL") {
    if ((/DIRETT/.test(n) && !/INDIRETT/.test(n)) || context?.ldlMethod === "direct") {
      return exact("90.13.C_0");
    }
    if (/INDIRETT|CALCOLAT|FRIEDEWALD/.test(n) || context?.ldlMethod === "indirect") {
      return exact("90.13.B_0");
    }
  }

  return null;
}

function creationCatalogScore(query, entry) {
  const aliases = [
    entry?.name,
    ...(Array.isArray(entry?.aliases) ? entry.aliases : [])
  ]
    .map(sanitizeCreationCatalogAlias)
    .filter(Boolean);

  let base = 0;
  for (const alias of aliases) {
    // Non accettare "glicemia" dentro "ipoglicemia": in creazione di
    // prestazioni valgono parole intere, non sottostringhe di altre parole.
    base = Math.max(base, catalogScore(query, alias, { wholeWords: true }));
  }
  if (!base) return 0;

  const qSpecimen = detectSpecimen(query);
  const eSpecimen = catalogEntrySpecimen(entry);
  let bonus = 0;

  // In creazione riga la matrice specifica è importante: se il referto
  // è P-/S- preferisci la prestazione [S], se è U- preferisci [U].
  if (qSpecimen === "SERUM") {
    if (eSpecimen === "SERUM") bonus += 170;
    else if (eSpecimen === "MULTI") bonus += 45;
    else if (eSpecimen === "URINE") return 0;
  } else if (qSpecimen === "URINE") {
    if (eSpecimen === "URINE") bonus += 170;
    else if (eSpecimen === "MULTI") bonus += 45;
    else if (eSpecimen === "SERUM") return 0;
  }

  const queryConcept = getExamConcept(query);
  const entryConcept = getExamConcept(entry?.name || "");
  if (queryConcept && entryConcept && queryConcept === entryConcept) {
    bonus += 80;
  }

  // Penalizza qualificatori clinicamente diversi che possono condividere
  // lo stesso alias amministrativo del catalogo. Esempio reale: "VITAMINA B12"
  // non deve diventare "COBALAMINA (VIT. B12) ATTIVA [S]" solo perché [S]
  // riceve un bonus di matrice.
  const qn = normalizeExamName(query);
  const en = normalizeExamName(entry?.name || "");
  const qualifiers = [
    ["ATTIVA", 320],
    ["REFLEX", 180],
    ["24H", 220],
    ["POST PRANDIALE", 220],
    ["POCT", 220],
    ["LIQUOR", 260],
    ["LIQ AMNIOTICO", 260],
    ["PERITONEALE", 260],
    ["ERITROCITARIO", 260],
    ["INTRAERITROCITARIO", 260]
  ];

  for (const [qualifier, penalty] of qualifiers) {
    if (en.includes(qualifier) && !qn.includes(qualifier)) bonus -= penalty;
  }

  // Le voci figlie/specifiche del CVP sono in genere quelle mostrate
  // nell'autocomplete Eumed quando esiste una variante di matrice.
  if (String(entry?.code || "").includes("_")) bonus += 8;

  return base + bonus;
}

function matchCatalogForCreation(query, context = {}) {
  if (!labCatalog.length) return null;

  const preferred = preferredCreationCatalogDecision(query, context);
  if (preferred?.blocked) {
    return { blocked: true, reason: preferred.reason || "Voce catalogo non univoca" };
  }
  if (preferred?.entry) {
    return {
      entry: preferred.entry,
      score: preferred.score || 3000,
      candidates: [{ entry: preferred.entry, score: preferred.score || 3000 }],
      preferred: true
    };
  }

  const ranked = labCatalog
    .map(entry => ({ entry, score: creationCatalogScore(query, entry) }))
    .filter(x => x.score >= 650)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return null;

  const best = ranked[0];
  const second = ranked[1];

  // Se due voci hanno lo stesso parent_code, scegli la più specifica per
  // matrice anziché dichiarare ambiguità (es. POTASSIO [S] vs S/U/dU).
  if (second && best.score - second.score < 55) {
    const sameParent =
      String(best.entry?.parent_code || "") &&
      String(best.entry?.parent_code || "") ===
        String(second.entry?.parent_code || "");

    const qSpec = detectSpecimen(query);
    const bestSpec = catalogEntrySpecimen(best.entry);
    const secondSpec = catalogEntrySpecimen(second.entry);

    const bestClearlySpecific =
      (qSpec === "SERUM" && bestSpec === "SERUM" && secondSpec !== "SERUM") ||
      (qSpec === "URINE" && bestSpec === "URINE" && secondSpec !== "URINE");

    if (!sameParent && !bestClearlySpecific && best.score < 980) {
      return {
        ambiguous: true,
        candidates: ranked.slice(0, 5)
      };
    }
  }

  return {
    entry: best.entry,
    score: best.score,
    candidates: ranked.slice(0, 5)
  };
}

function isMolecularMicrobiologyText(text) {
  const n = normalizeExamName(text || "");
  return /(?:^| )(DNA|RNA)(?: |$)|\bPCR\b|ACIDI NUCLEICI|ANALISI QUALITATIVA.*DNA|ANALISI QUANTITATIVA.*DNA|ANALISI QUALITATIVA.*RNA|ANALISI QUANTITATIVA.*RNA|AMPLIFICAZ|GENOM/.test(n);
}

function looksLikeSerologyText(text) {
  const n = normalizeExamName(text);
  if (!n) return false;
  if (isMolecularMicrobiologyText(text)) return false;

  if (
    n.includes("ANTICORP") ||
    n.includes("IMMUNOBLOT") ||
    n.includes("WESTERN BLOT") ||
    n.includes("SIEROLOG") ||
    n.includes("VDRL") ||
    n.includes("TPHA") ||
    n.includes("TPPA") ||
    /\bRPR\b/.test(n) ||
    /\bANA\b/.test(n) ||
    /\bENA\b/.test(n) ||
    /\bANCA\b/.test(n) ||
    /\bASLO\b/.test(n) ||
    n.includes("ANTINUCLE") ||
    n.includes("ANTI NUCLE") ||
    n.includes("TRANSGLUTAMIN") ||
    n.includes("ENDOMIS") ||
    n.includes("GLIADIN") ||
    n.includes("STREPTOLIS") ||
    n.includes("COOMBS INDIRETTO")
  ) {
    return true;
  }

  if (
    /\b(HBSAG|HBEAG)\b/.test(n) ||
    /ANTI ?HB[SEC]/.test(n) || /\bHB[SEC]AB\b/.test(n) ||
    (n.includes("HIV") && (n.includes("P24") || n.includes("ANTIGEN"))) ||
    (n.includes("HCV") && n.includes("ANTIGEN"))
  ) {
    return true;
  }

  const infectious =
    /(CITOMEGAL|\bCMV\b|TOXOPLAS|ROSOL|RUBELL|EPSTEIN|\bEBV\b|HERPES|\bHSV\b|VARICELL|PARVOVIR|BORREL|TREPON|SIFIL|CHLAMYD|MYCOPLAS|HELICOBACT|EPATITE|\bHAV\b|\bHBV\b|\bHCV\b|\bHIV\b|SARS COV)/.test(n);

  return infectious && /(IGG|IGM|IGA|ANTIC|ANTIGEN|REATTIV|POSITIV|NEGATIV)/.test(n);
}

function isSerologyCatalogEntry(entry) {
  const n = normalizeExamName(entry?.name || "");
  if (!n) return false;

  if (n.includes("ANTICORP") || n.includes("IMMUNOBLOT")) return true;

  return (
    /(VIRUS|TOXOPLAS|TREPON|BORREL|CHLAMYD|MYCOPLAS|HELICOBACT|SIFIL)/.test(n) &&
    /(ANTIGEN|IGG|IGM|P24|VDRL|RPR|TPHA|TPPA)/.test(n)
  );
}

function cleanupSerologyQuery(text) {
  let s = String(text || "")
    .replace(/\t+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Togli la parte chiaramente risultativa lasciando il nome dell'esame.
  s = s.replace(
    /\s+(?:POSITIV[OA]?|NEGATIV[OA]?|REATTIV[OA]?|NON\s+REATTIV[OA]?|DUBBI[OA]?|ASSENT[EI]|PRESENT[EI])\b.*$/i,
    ""
  );

  s = s.replace(
    /\s+[<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?\s*(?:AU\/ML|IU\/ML|UI\/ML|U\/ML|INDEX|COI|S\/CO|RATIO|TITOLO|UA\/ML|U\/L|KU\/L)?\b.*$/i,
    ""
  );

  s = s
    .replace(/\bCMV\b/gi, "CITOMEGALOVIRUS")
    .replace(/\bEBV\b/gi, "VIRUS EPSTEIN BARR")
    .replace(/^ANA$/i, "ANTICORPI ANTI ANTIGENI INTRACELLULARI ANA")
    .replace(/^ENA$/i, "ANTICORPI ANTI ANTIGENI INTRACELLULARI SPECIFICI ENA")
    .replace(/^ANCA$/i, "ANTICORPI ANTI CITOPLASMA DEI NEUTROFILI ANCA")
    .replace(/^ASLO$/i, "ANTISTREPTOLISINA O ASLO")
    .trim();

  return s;
}

function preferredSerologyCatalogEntry(text, context = {}) {
  const n = normalizeExamName(text || "");
  if (!n || isMolecularMicrobiologyText(text)) return null;

  // Per Rosolia, Varicella e HAV scegliamo la variante catalogo in base
  // alla combinazione effettivamente presente nel referto: solo IgG = stato
  // immune; presenza di IgM (tipicamente insieme alle IgG) = infezione attiva.
  if (n.includes("ROSOLIA") || n.includes("RUBELL")) {
    const state = serologyFamilyState(context, "ROSOLIA");
    if (/\bIGM\b/.test(n) || state.igm) return findCatalogEntryByCode("91.26.D_0");
    if (/\bIGG\b/.test(n) || state.igg) return findCatalogEntryByCode("91.26.E_0");
  }
  if (n.includes("VARICELL") || /\bVZV\b/.test(n)) {
    if (/\bIGM\b/.test(n)) return findCatalogEntryByCode("91.26.C_4");
    if (/\bIGG\b/.test(n)) {
      const state = serologyFamilyState(context, "VARICELLA");
      return findCatalogEntryByCode(state.igm ? "91.26.C_3" : "91.26.C_2");
    }
  }
  if (/\bHAV\b/.test(n) || n.includes("EPATITE A")) {
    if (/\bIGM\b/.test(n)) return findCatalogEntryByCode("91.17.6_3");
    if (/\bIGG\b/.test(n)) {
      const state = serologyFamilyState(context, "HAV");
      return findCatalogEntryByCode(state.igm ? "91.17.6_2" : "91.17.8_0");
    }
  }

  // Profili/virus più comuni. Una PCR/DNA/RNA non è sierologia e viene
  // esclusa sopra: non deve mai diventare automaticamente "anticorpi".
  if ((/\bHIV\b/.test(n) || n.includes("IMMUNODEFIC")) && (n.includes("P24") || n.includes("ANTICORP") || n.includes("ANTIGEN"))) {
    return findCatalogEntryByCode("91.23.F_0");
  }
  if ((/\bHCV\b/.test(n) || n.includes("EPATITE C")) && n.includes("ANTIGEN")) {
    return findCatalogEntryByCode("91.19.6_0");
  }
  if ((/\bHCV\b/.test(n) || n.includes("EPATITE C")) && (n.includes("ANTICORP") || /ANTI ?HCV/.test(n) || /\bIG[GM]\b/.test(n))) {
    return findCatalogEntryByCode("91.19.5_0");
  }
  if ((/\bCMV\b/.test(n) || n.includes("CITOMEGALOVIRUS")) && (n.includes("ANTICORP") || /\bIG[GM]\b/.test(n) || n.includes("SIEROLOG"))) {
    return findCatalogEntryByCode("91.15.F_0");
  }
  if (n.includes("TOXOPLAS") && (n.includes("ANTICORP") || /\bIG[GM]\b/.test(n) || n.includes("SIEROLOG"))) {
    return findCatalogEntryByCode("91.09.D_0");
  }
  if ((/\bEBV\b/.test(n) || n.includes("EPSTEIN BARR")) && (n.includes("ANTICORP") || /\bIG[GM]\b/.test(n) || /VCA|EBNA/.test(n))) {
    return findCatalogEntryByCode("91.21.6_0");
  }

  // Marcatori HBV singoli: distinguere antigeni e anticorpi.
  if (/ANTI ?HBS|\bHBSAB\b/.test(n) || (n.includes("ANTICORP") && n.includes("HBS"))) return findCatalogEntryByCode("91.18.3_0");
  if (/\bHBSAG\b/.test(n) && !/ANTI ?HBS|\bHBSAB\b/.test(n)) return findCatalogEntryByCode("91.18.5_0");
  if (/ANTI ?HBE|\bHBEAB\b/.test(n) || (n.includes("ANTICORP") && n.includes("HBE"))) return findCatalogEntryByCode("91.18.2_0");
  if (/\bHBEAG\b/.test(n) && !/ANTI ?HBE|\bHBEAB\b/.test(n)) return findCatalogEntryByCode("91.18.4_0");

  if ((n.includes("SARS COV") || n.includes("COVID")) && (n.includes("ANTICORP") || /\bIGG\b/.test(n))) {
    return findCatalogEntryByCode("91.13.1_48");
  }
  if (n.includes("HELICOBACTER") && (n.includes("ANTICORP") || /\bIG[GM]\b/.test(n))) {
    return findCatalogEntryByCode("90.84.8_4");
  }

  if (n.includes("TREPONEMA") || n.includes("SIFIL") || n.includes("TPHA") || n.includes("TPPA")) {
    return findCatalogEntryByCode("91.10.B_2");
  }

  // Autoimmunità / sierologia classica.
  if (/\bANA\b/.test(n) || n.includes("ANTI NUCLE") || n.includes("ANTINUCLE")) {
    if (n.includes("REFLEX") || n.includes("RIFLESS")) {
      return findCatalogEntryByCode("90.524_0") || findCatalogEntryByCode("90.52.4_0");
    }
    return findCatalogEntryByCode("90.52.4_0");
  }
  if (/\bENA\b/.test(n) || n.includes("ANTIGENI INTRACELLULARI SPECIFICI") || n.includes("CTD SCREEN")) {
    return findCatalogEntryByCode("90.47.3_0");
  }
  if (/\bP[ -]?ANCA\b/.test(n)) return findCatalogEntryByCode("90.48.2_2");
  if (/\bC[ -]?ANCA\b/.test(n)) return findCatalogEntryByCode("90.48.2_3");
  if (/\bANCA\b/.test(n)) return findCatalogEntryByCode("ANCA") || findCatalogEntryByCode("90.48.2");

  if (n.includes("TRANSGLUTAMIN")) {
    if (/\bIGG\b/.test(n)) return findCatalogEntryByCode("90.53.D_3");
    if (/\bIGA\b/.test(n)) return findCatalogEntryByCode("90.53.D_2");
  }

  if (/\bASLO\b/.test(n) || n.includes("ANTISTREPTOLIS")) {
    return findCatalogEntryByCode("91.08.5_0");
  }

  return null;
}

function buildSerologyExcerpt(lines, index) {
  const out = [];
  const current = String(lines[index] || "").trim();
  if (current) out.push(current);

  // Aggiungi solo eventuali righe di continuazione del RISULTATO corrente.
  // Non includere la sierologia precedente/successiva: ogni prestazione deve
  // avere il proprio referto, senza contaminazioni da test vicini.
  for (let i = index + 1; i < Math.min(lines.length, index + 3); i++) {
    const line = String(lines[i] || "").trim();
    if (!line) continue;
    if (/^(?:Pag(?:ina)?\.?\s+\d+|Validat|Firmat|Rappresentazione)/i.test(line)) break;
    if (looksLikeSerologyText(line)) break;
    if (/^[BPSU]-\S+/i.test(line) || /^PROFILO\s+/i.test(line)) break;

    // Righe tipiche di prosecuzione: esito qualitativo, titolo, indice o valore.
    if (
      /^(?:POSITIV|NEGATIV|REATTIV|NON\s+REATTIV|DUBBI|ASSENT|PRESENT)/i.test(line) ||
      /^(?:TITOLO|INDEX|COI|S\/CO|RATIO)\b/i.test(line) ||
      /^[<>≤≥]?[+-]?\d+(?:[.,]\d+)?\b/.test(line)
    ) {
      out.push(line);
      continue;
    }

    break;
  }

  return [...new Set(out)].join("\n").trim();
}

function mergeUniqueLongReportText(...parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    for (const line of String(part || "").replace(/\r/g, "").split("\n")) {
      const clean = line.replace(/\s+/g, " ").trim();
      if (!clean) continue;
      const key = normalizeExamName(clean);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
  }
  return normalizeLongReportText(out.join("\n"));
}

function detectSerologyComplexItems(reportText, reportDate, context = {}) {
  const lines = cleanReportLines(reportText);
  const groups = new Map();
  const unmatched = [];

  // Profilo HBV completo: se sono presenti più componenti tipiche, usa la
  // prestazione Reflex unica del catalogo anziché creare tre righe.
  const nReport = normalizeExamName(reportText);
  const hbvMarkers = [
    /\bHBSAG\b/.test(nReport),
    /ANTI\s*HBS|ANTICORPI\s*HBS/.test(nReport),
    /ANTI\s*HBC|ANTICORPI\s*HBC/.test(nReport)
  ].filter(Boolean).length;

  if (hbvMarkers >= 2) {
    const hbvEntry = findCatalogEntryByCode("91.18.6_0");
    if (hbvEntry) {
      const hbvLines = lines.filter(line =>
        /HBV|EPATITE B|HBSAG|HBEAG|ANTI.?HBS|ANTI.?HBC|ANTI.?HBE/i.test(line)
      );
      if (hbvLines.length) {
        groups.set(`CAT:${hbvEntry.code}`, {
          exam: hbvEntry.name,
          catalogCode: hbvEntry.code,
          catalogEntry: hbvEntry,
          complexKind: "SIEROLOGIA",
          reportDate,
          text: hbvLines.join("\n").trim(),
          source: "serology-local"
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!looksLikeSerologyText(line)) continue;

    // Le righe HBV già incluse nel profilo reflex non vanno duplicate.
    if (hbvMarkers >= 2 && /HBV|EPATITE B|HBSAG|HBEAG|ANTI.?HBS|ANTI.?HBC|ANTI.?HBE/i.test(line)) {
      continue;
    }

    const query = cleanupSerologyQuery(line);
    const preferredEntry = preferredSerologyCatalogEntry(line, context) || preferredSerologyCatalogEntry(query, context);
    let match = preferredEntry
      ? { entry: preferredEntry, score: 2000, candidates: [{ entry: preferredEntry, score: 2000 }] }
      : matchCatalogForCreation(query, context);

    // Se la riga è molto corta, riprova con la forma originale.
    if (!match?.entry && !match?.ambiguous) {
      match = matchCatalogForCreation(line, context);
    }

    if (!match?.entry || !isSerologyCatalogEntry(match.entry)) {
      unmatched.push({ line, query, reason: match?.ambiguous ? "catalogo ambiguo" : "nessuna voce sierologica certa" });
      continue;
    }

    const key = `CAT:${match.entry.code}`;
    const excerpt = buildSerologyExcerpt(lines, i);
    const existing = groups.get(key);

    if (existing) {
      existing.text = mergeUniqueLongReportText(existing.text, excerpt);
    } else {
      groups.set(key, {
        exam: match.entry.name,
        catalogCode: match.entry.code,
        catalogEntry: match.entry,
        complexKind: "SIEROLOGIA",
        reportDate,
        text: excerpt || line,
        source: "serology-local"
      });
    }
  }

  return {
    items: [...groups.values()],
    unmatched
  };
}

function getFixedComplexCatalogEntry(kind) {
  const code = UNPRESCRIBED_FIXED_COMPLEX_CODES[kind];
  return code ? findCatalogEntryByCode(code) : null;
}

function buildRawSerologyComplexItems(rawResults, reportText, reportDate, context = {}) {
  const groups = new Map();
  const lines = cleanReportLines(reportText);

  for (const raw of rawResults || []) {
    const label = cleanModelLabLabel(raw?.raw_label || raw?.exam || "");
    if (!label) continue;

    const preferredEntry = preferredSerologyCatalogEntry(label, context);
    const match = preferredEntry
      ? { entry: preferredEntry, score: 2000 }
      : matchCatalogForCreation(cleanupSerologyQuery(label), context);
    if (!match?.entry || !isSerologyCatalogEntry(match.entry)) continue;

    const key = String(match.entry.code || normalizeExamName(match.entry.name));
    const rawLine = lines.find(line => {
      const nLine = normalizeExamName(line);
      const tokens = significantTokens(normalizeExamName(label));
      return tokens.length >= 1 && tokens.slice(0, 4).every(token => nLine.includes(token));
    });

    const text = normalizeLongReportText(
      rawLine || formatRawComplexResult(raw)
    );
    if (!text) continue;

    const existing = groups.get(key);
    if (existing) {
      existing.text = mergeUniqueLongReportText(existing.text, text);
    } else {
      groups.set(key, {
        exam: match.entry.name,
        catalogCode: match.entry.code,
        catalogEntry: match.entry,
        complexKind: "SIEROLOGIA",
        reportDate,
        text,
        source: "serology-parser"
      });
    }
  }

  return [...groups.values()];
}

function formatRawComplexResult(item) {
  const label = String(item?.raw_label || item?.exam || "").trim();
  const value = String(item?.value || "").trim();
  const unit = String(item?.unit || "").trim();
  const min = String(item?.ref_min || "").trim();
  const max = String(item?.ref_max || "").trim();

  let line = `${label}: ${value}${unit ? ` ${unit}` : ""}`.trim();
  if (min && max) line += ` (rif. ${min} - ${max}${unit ? ` ${unit}` : ""})`;
  return line;
}

function buildBilirubinComplexText(rawResults, reportText) {
  const rows = (rawResults || []).filter(item =>
    ["BILIRUBIN_TOTAL", "BILIRUBIN_DIRECT", "BILIRUBIN_INDIRECT"].includes(
      getExamConcept(`${item?.raw_label || ""} ${item?.exam || ""}`)
    )
  );

  if (rows.length) {
    return [...new Set(rows.map(formatRawComplexResult))].join("\n").trim();
  }

  return cleanReportLines(reportText)
    .filter(line => /BILIRUBINA/i.test(line))
    .join("\n")
    .trim();
}

function buildUnprescribedFixedComplexItems(reportText, layout, rawResults, reportDate) {
  const items = [];
  const presentKinds = new Set();

  for (const kind of knownLongReportKinds(layout, reportText)) {
    if (["EMOCROMO", "URINE", "PROTIDOGRAMMA", "TIPIZZAZIONE_LINFOCITARIA", "TIPIZZAZIONE_MONOCLONALE", "BENCE_JONES"].includes(kind)) {
      presentKinds.add(kind);
    }
  }

  const nReport = normalizeExamName(reportText);

  if (
    (rawResults || []).some(item =>
      ["PSA_TOTAL", "PSA_FREE"].includes(
        getExamConcept(`${item?.raw_label || ""} ${item?.exam || ""}`)
      )
    ) ||
    /\bPSA\b/.test(nReport) ||
    nReport.includes("ANTIGENE PROSTATICO SPECIFICO")
  ) {
    presentKinds.add("PSA_REFLEX");
  }

  if (
    (rawResults || []).some(item =>
      ["BILIRUBIN_TOTAL", "BILIRUBIN_DIRECT", "BILIRUBIN_INDIRECT"].includes(
        getExamConcept(`${item?.raw_label || ""} ${item?.exam || ""}`)
      )
    ) ||
    nReport.includes("BILIRUBINA")
  ) {
    presentKinds.add("BILIRUBINA");
  }

  // Nei layout non ancora noti usa anche i cluster generici già presenti.
  if (reportContainsLongReportCluster(reportText, "EMOCROMO")) presentKinds.add("EMOCROMO");
  if (reportContainsLongReportCluster(reportText, "URINE")) presentKinds.add("URINE");
  if (nReport.includes("PROTIDOGRAM") || (nReport.includes("ELETTROFORESI") && nReport.includes("PROTEIN"))) presentKinds.add("PROTIDOGRAMMA");
  if (
    nReport.includes("IMMUNOFENOTIP") ||
    nReport.includes("FENOTIPIZZAZIONE LINFOCIT") ||
    nReport.includes("TBNK") ||
    nReport.includes("TIPIZZAZIONE LINFOCIT")
  ) presentKinds.add("TIPIZZAZIONE_LINFOCITARIA");
  if (
    nReport.includes("TIPIZZAZIONE COMPONENTI MONOCLONALI") ||
    nReport.includes("TEST DI IMMUNOSOTTRAZIONE")
  ) presentKinds.add("TIPIZZAZIONE_MONOCLONALE");
  if (nReport.includes("BENCE JONES")) presentKinds.add("BENCE_JONES");

  for (const kind of presentKinds) {
    const entry = getFixedComplexCatalogEntry(kind);
    if (!entry) continue;

    let text = "";

    if (["EMOCROMO", "URINE", "PROTIDOGRAMMA", "TIPIZZAZIONE_LINFOCITARIA", "TIPIZZAZIONE_MONOCLONALE", "BENCE_JONES"].includes(kind)) {
      text =
        extractKnownLongReportText(layout, kind, reportText) ||
        genericLongReportSlice(reportText, kind);
    } else if (kind === "PSA_REFLEX") {
      text =
        buildPsaReflexLongReportFromRawResults(rawResults || [], reportText).text ||
        buildPsaReflexLongReport(reportText);
    } else if (kind === "BILIRUBINA") {
      text = buildBilirubinComplexText(rawResults, reportText);
    }

    if (!text) continue;

    items.push({
      exam: entry.name,
      catalogCode: entry.code,
      catalogEntry: entry,
      complexKind: kind,
      reportDate,
      text: normalizeLongReportText(text),
      source: "parser-complex"
    });
  }

  return items;
}

function rawResultCoveredByUnprescribedComplex(item, complexItems) {
  const label = `${item?.raw_label || ""} ${item?.exam || ""}`;
  const concept = getExamConcept(label);
  const kinds = new Set((complexItems || []).map(x => x.complexKind));

  if (kinds.has("BILIRUBINA") && ["BILIRUBIN_TOTAL", "BILIRUBIN_DIRECT", "BILIRUBIN_INDIRECT"].includes(concept)) return true;
  if (kinds.has("PSA_REFLEX") && ["PSA_TOTAL", "PSA_FREE"].includes(concept)) return true;

  if (kinds.has("EMOCROMO") && isLongReportComponent(label, new Set(["EMOCROMO"]))) return true;
  if (kinds.has("URINE") && isLongReportComponent(label, new Set(["URINE"]))) return true;
  if (kinds.has("PROTIDOGRAMMA") && isLongReportComponent(label, new Set(["PROTIDOGRAMMA"]))) return true;
  if (kinds.has("TIPIZZAZIONE_LINFOCITARIA") && isLongReportComponent(label, new Set(["TIPIZZAZIONE_LINFOCITARIA"]))) return true;
  if (kinds.has("TIPIZZAZIONE_MONOCLONALE") && isLongReportComponent(label, new Set(["TIPIZZAZIONE_MONOCLONALE"]))) return true;
  if (kinds.has("BENCE_JONES") && isLongReportComponent(label, new Set(["BENCE_JONES"]))) return true;

  const creation = matchCatalogForCreation(item?.raw_label || item?.exam || "");
  if (creation?.entry && isSerologyCatalogEntry(creation.entry)) return true;
  if (looksLikeSerologyText(label)) return true;

  return false;
}

const UNPRESCRIBED_SCHEMA = {
  "type": "object",
  "properties": {
    "d": {
      "type": "string"
    },
    "de": {
      "type": "string"
    },
    "r": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "exam": {
            "type": "string"
          },
          "value": {
            "type": "string"
          },
          "unit": {
            "type": "string"
          },
          "ref_min": {
            "type": "string"
          },
          "ref_max": {
            "type": "string"
          },
          "ref_unit": {
            "type": "string"
          },
          "line_start": {"type":"integer","minimum":1},
          "line_end": {"type":"integer","minimum":1},
          "raw_label": {
            "type": "string"
          }
        },
        "required": [
          "exam",
          "value",
          "unit",
          "ref_min",
          "ref_max",
          "ref_unit",
          "raw_label", "line_start", "line_end"
        ],
        "additionalProperties": false
      }
    },
    "c": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "EMOCROMO",
              "URINE",
              "PROTIDOGRAMMA",
              "TIPIZZAZIONE_LINFOCITARIA",
              "TIPIZZAZIONE_MONOCLONALE",
              "BENCE_JONES",
              "PSA_REFLEX",
              "BILIRUBINA",
              "SIEROLOGIA"
            ]
          },
          "label": {
            "type": "string"
          },
          "line_start": {
            "type": "integer",
            "minimum": 1
          },
          "line_end": {
            "type": "integer",
            "minimum": 1
          }
        },
        "required": [
          "kind",
          "label",
          "line_start",
          "line_end"
        ],
        "additionalProperties": false
      }
    },
    "u": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string"
          },
          "reason": {
            "type": "string"
          }
        },
        "required": [
          "text",
          "reason"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "d",
    "de",
    "r",
    "c",
    "u"
  ],
  "additionalProperties": false
};

function expandUnprescribedPayload(parsed, sourceLines) {
  const original = parsed && typeof parsed === "object" ? parsed : {};
  const p = { ...original,
    r: (Array.isArray(original.r) ? original.r : []).map(row => Array.isArray(row) ? row : [row?.exam, row?.value, row?.unit, row?.ref_min, row?.ref_max, row?.ref_unit, row?.raw_label, row?.line_start, row?.line_end]),
    c: (Array.isArray(original.c) ? original.c : []).map(row => Array.isArray(row) ? row : [row?.kind, row?.label, row?.line_start, row?.line_end]),
    u: (Array.isArray(original.u) ? original.u : []).map(row => Array.isArray(row) ? row : [row?.text, row?.reason])
  };
  const lines = Array.isArray(sourceLines) ? sourceLines : [];

  const complex = Array.isArray(p.c)
    ? p.c.map(row => {
        const start = Number(row?.[2]);
        const end = Number(row?.[3]);
        const valid = Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= lines.length;
        return {
          kind: String(row?.[0] || ""),
          label: String(row?.[1] || ""),
          line_start: start,
          line_end: end,
          text: valid ? lines.slice(start - 1, end).join("\n").trim() : ""
        };
      })
    : [];

  return {
    report_date: String(p.d || ""),
    report_date_evidence: String(p.de || ""),
    results: Array.isArray(p.r)
      ? p.r.map(row => ({
          exam: String(row?.[0] || ""),
          value: String(row?.[1] || ""),
          unit: String(row?.[2] || ""),
          ref_min: String(row?.[3] || ""),
          ref_max: String(row?.[4] || ""),
          ref_unit: String(row?.[5] || ""),
          raw_label: String(row?.[6] || ""),
          line_start: row?.[7], line_end: row?.[8],
          _qwenUnprescribed: true
        }))
      : [],
    complex,
    uncertain: Array.isArray(p.u)
      ? p.u.map(row => ({ text: String(row?.[0] || ""), reason: String(row?.[1] || "") }))
      : []
  };
}

function validateUnprescribedAiSource(payload, sourceText) {
  const normalized = normalizeExamName(sourceText);
  const sourceLines = String(sourceText || "").split(/\r?\n/);
  let rejectedNumeric = 0, rejectedComplex = 0, rejectedUncertain = 0;
  const sourceWarnings = [];
  const results = (payload.results || []).filter(item => {
    const label = normalizeExamName(item.raw_label || item.exam || "");
    const value = String(item.value || "").trim();
    const verified = validateAiMeasurementEvidence(item, sourceText);
    const present = !!verified;
    if (verified) {
      Object.assign(item, verified);
      if (verified._rangeRejected) sourceWarnings.push({text:item.raw_label,reason:"Intervallo normale IA non confermato sulla riga sorgente: limiti lasciati vuoti."});
    }
    if (!present) {
      rejectedNumeric++;
      if (label.length >= 3 && normalized.includes(label)) sourceWarnings.push({
        text: String(item.raw_label || item.exam),
        reason: "Risultato o unita proposti dall'IA non confermati nel testo: verifica il referto originale."
      });
    }
    return Boolean(present);
  });
  const kinds = ["EMOCROMO", "URINE", "PROTIDOGRAMMA", "TIPIZZAZIONE_LINFOCITARIA", "TIPIZZAZIONE_MONOCLONALE", "BENCE_JONES", "PSA_REFLEX", "BILIRUBINA", "SIEROLOGIA"];
  const supportsKind = (text, kind) => {
    const n = normalizeExamName(text);
    if (kind === "BILIRUBINA") return n.includes("BILIRUBINA");
    if (kind === "PSA_REFLEX") return /\bPSA\b|ANTIGENE PROSTATICO SPECIFICO/.test(n);
    return reportReallyContainsLongReportKind(text, kind);
  };
  const complex = (payload.complex || []).filter(item => {
    const present = kinds.includes(item.kind) && item.text && (item.kind === "SIEROLOGIA"
      ? normalized.includes(normalizeExamName(item.label)) && looksLikeSerologyText(item.label)
      : supportsKind(sourceText, item.kind) && supportsKind(item.text, item.kind));
    if (!present) rejectedComplex++;
    return Boolean(present);
  });
  const uncertain = (payload.uncertain || []).filter(item => {
    const label = normalizeExamName(item.text || "");
    const reason = normalizeExamName(item.reason || "");
    const note = /\bEGFR\b|CKD EPI/.test(label) || /UNITA.*(?:AMBIG|MAIUSC|MINUSC)/.test(label) ||
      (/FORMATO STANDARD|MAIUSC|MINUSC/.test(reason) && /MG DL/.test(reason));
    const present = !note && label.length >= 3 && normalized.includes(label) && !isKnownResidualNonExamLabel(item.text, item.reason);
    if (!present) rejectedUncertain++;
    return present;
  });
  if (typeof recordDiagnosticEvent === "function") recordDiagnosticEvent("ia_validazione", {
    acceptedNumeric: results.length, acceptedComplex: complex.length,
    rejectedNumeric, rejectedComplex, rejectedUncertain
  });
  return { ...payload, report_date: validatedAiReportDate(payload.report_date, payload.report_date_evidence, sourceText), results, complex, uncertain: [...uncertain, ...sourceWarnings] };
}

async function extractUnprescribedWithQwen(reportText, progressCallback = null, options = {}) {
  const chunks = splitReportText(reportText, 6000);
  const merged = { report_date: "", report_date_evidence: "", results: [], complex: [], uncertain: [] };
  const dates = [];

  for (let index = 0; index < chunks.length; index++) {
    const sourceLines = String(chunks[index] || "").replace(/\r/g, "").split("\n");
    const numbered = sourceLines.map((line, i) => `[L${i + 1}] ${line}`).join("\n");

    const system = `
Sei un estrattore locale di referti di laboratorio per un medico.
NON fare diagnosi, NON dare consigli, NON inventare dati e NON convertire unità.
${options?.residualOnly
? `Il testo contiene SOLO la parte residua che il parser deterministico non ha spiegato. Estrai soltanto gli esami realmente presenti in questo residuo; non ricostruire o ripetere esami che non compaiono nel testo fornito.${options?.layoutName ? ` Layout di origine: ${options.layoutName}.` : ""}`
: `Devi estrarre TUTTI gli esami presenti nel testo, perché non esiste una lista di esami già prescritti.`}

Formato structured output:
- d = data di refertazione/validazione/firma/emissione YYYY-MM-DD o ""
- de = citazione testuale INTERA della riga originale contenente sia la dicitura referto/firma sia la data, senza prefisso [Lx]. Non usare la sola dicitura.
- r = oggetti risultati numerici con exam, value, unit, ref_min, ref_max, ref_unit, raw_label (tutte stringhe), line_start e line_end interi del solo blocco sorgente (massimo 4 righe, estremi INCLUSIVI). Se il risultato e sulla sola riga L2, usa line_start=2 e line_end=2, NON 3. raw_label contiene solo il nome originale, senza valore, unita o range.
- c = oggetti referti complessi con kind, label, line_start, line_end. kind deve essere uno dei valori ammessi; righe intere numeriche.
- u = oggetti elementi realmente incerti con text, reason. Non interpretare note generali del laboratorio come condizioni del paziente.
mg/dl, mg/dL e MG/DL indicano la stessa unita: le maiuscole non sono ambiguita.
CHIMICA CLINICA e COLESTEROLO FRAZIONATO sono intestazioni, non referti complessi. Glucosio, creatinina, lipidi sono risultati numerici.
Un elenco di risultati numerici non costituisce EMOCROMO o un altro referto complesso: se nessun complesso e presente, c=[]. Non inventare URINE o altre sezioni assenti. Non calcolare valori mancanti. Copia raw_label dal testo originale. Le note generali sui limiti eGFR non sono esami incerti.

TRATTA SEMPRE COME COMPLESSI, MAI COME RISULTATI NUMERICI SINGOLI:
- EMOCROMO e formula;
- URINE esame completo e sedimento (ma non ACR/microalbuminuria autonoma);
- PROTIDOGRAMMA/elettroforesi proteica;
- TIPIZZAZIONE/FENOTIPIZZAZIONE LINFOCITARIA;
- TIPIZZAZIONE DELLE COMPONENTI MONOCLONALI / immunosottrazione / immunofissazione;
- PROTEINURIA DI BENCE-JONES e relativo commento qualitativo;
- PSA: totale/libero/rapporto in un unico PSA_REFLEX;
- BILIRUBINA: totale + diretta/coniugata + indiretta/non coniugata in un unico BILIRUBINA;
- TUTTI GLI ESAMI SIEROLOGICI: anticorpi, IgG/IgM specifiche, sierodiagnosi, immunoblot, test infettivologici anticorpali/antigenici. Ogni prestazione sierologica distinta usa kind SIEROLOGIA.

Per c usa le righe numerate del blocco; includi tutte le righe che servono a capire il risultato.
Per r usa solo il risultato corrente numerico. Non scambiare range, date o valori storici per risultati.
${buildReferenceIntervalPrompt()}
`;

    const user = `BLOCCO ${index + 1}/${chunks.length}\n\n${numbered}`;

    progressCallback?.({
      phase: "unprescribed_qwen_start",
      current: index + 1,
      total: chunks.length,
      mode: options?.residualOnly ? "residual" : "full"
    });

    const content = await ollamaChat(
      [{ role: "system", content: system }, { role: "user", content: user }],
      info => progressCallback?.({
        phase: "unprescribed_qwen_stream",
        current: index + 1,
        total: chunks.length,
        chars: info?.chars || 0,
        mode: options?.residualOnly ? "residual" : "full"
      }),
      6000,
      UNPRESCRIBED_SCHEMA
    );

    const payload = validateUnprescribedAiSource(expandUnprescribedPayload(extractJSONObject(content), sourceLines), sourceLines.join("\n"));
    merged.results.push(...payload.results);
    merged.complex.push(...payload.complex);
    merged.uncertain.push(...payload.uncertain);
    if (payload.report_date) dates.push({ date: payload.report_date, evidence: payload.report_date_evidence });
  }

  const uniqueDates = [...new Set(dates.map(x => x.date).filter(Boolean))];
  if (uniqueDates.length === 1) {
    merged.report_date = uniqueDates[0];
    merged.report_date_evidence = dates.find(x => x.date === uniqueDates[0])?.evidence || "";
  }

  return merged;
}

function buildKnownUnprescribedResidualEvidence(reportText, layout, rawResults, fixedComplex) {
  const parserLike = {
    labLayout: layout,
    results: rawResults || [],
    recognizedNotInGrid: [],
    longReports: (fixedComplex || []).map(item => ({
      exam: item?.exam || "",
      kind: item?.complexKind || getLongReportKind(item?.exam || ""),
      text: item?.text || ""
    }))
  };

  return getUnclaimedAiEvidence(reportText, parserLike);
}

function dedupeUnprescribedWarnings(items) {
  const seen=new Set();
  return (items || []).filter(item => {
    if (isKnownResidualNonExamLabel(item?.text,item?.reason)) return false;
    const concept=getExamConcept(item?.text || '');
    const key=concept==='ACR' ? 'ACR' : normalizeExamName(item?.text || '')+'|'+normalizeExamName(item?.reason || '');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function isKnownResidualNonExamLabel(text, reason = "") {
  const n = normalizeExamName(text || "");
  const r = normalizeExamName(reason || "");
  if (!n) return true;
  if (/^(?:RACCOMANDATO|VALORI? DI RIFERIMENTO|FISIOLOGICO|MODERATAMENTE AUMENTATO|SEVERAMENTE AUMENTATO)(?:\b|:)/.test(n)) return true;
  // Frammenti senza etichetta: i risultati ancorati alla loro intestazione
  // vengono estratti separatamente, non trattati come nuovi esami.
  if (/^(?:[<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?\s*\*?\s*)?(?:mg\s*\/\s*d[lL]|mmol\s*\/\s*[lL]|umol\s*\/\s*[lL]|mg\s*\/\s*g(?:\s+Creat\.?)?)(?:\s|$)/i.test(String(text || "").trim())) return true;

  // Intestazioni/sezioni dei referti: descrivono il blocco sottostante ma
  // non sono prestazioni autonome da creare in Eumed.
  const sectionHeadings = new Set([
    "MARCATORI CARDIACI",
    "INDICI DI FLOGOSI",
    "BIOCHIMICA CLINICA",
    "CHIMICA CLINICA",
    "EMATOLOGIA",
    "METABOLISMO PROTEICO",
    "PROTEINE URINARIE",
    "PROFILO EMATOLOGICO",
    "PROFILO PROTEICO",
    "PROFILO URINARIO",
    "ESAME CHIMICO FISICO",
    "ESAME CITOFLUORIMETRICO AUTOMATIZZATO DEL SEDIMENTO"
  ]);
  if (sectionHeadings.has(n)) return true;

  // Firme e validazioni sono metadati amministrativi, non esami mancanti.
  if (/^DOTT(?: SSA)?\b/.test(n) || /^DR(?: SSA)?\b/.test(n)) {
    if (!r || /FIRMA|REFERTANTE|VALIDAZ|MEDICO|DIRETTORE/.test(r)) return true;
  }
  if (/FIRMA DEL REFERTANTE|VALIDAZIONE CLINICA|FIRMATARIO/.test(r)) return true;

  return false;
}

function validateKnownLayoutQwenResidualResults(payload, residualText, uncertain) {
  if (!payload) return payload;

  const accepted = [];
  const acceptedComplex = [];
  let suppressedNoise = 0;
  const sourceLines = String(residualText || "")
    .replace(/\r/g, "")
    .split("\n");
  const normalizedResidual = normalizeExamName(residualText || "");

  const lineWindowSupports = item => {
    const rawLabel = normalizeExamName(cleanModelLabLabel(item?.raw_label || ""));
    const value = String(item?.value || "")
      .trim()
      .replace(/^[<≤>≥]\s*/, "")
      .replace(/\s+/g, "")
      .replace(/\./g, ",");
    if (!rawLabel || !value) return false;

    for (let i = 0; i < sourceLines.length; i++) {
      const line = normalizeExamName(sourceLines[i]);
      if (!line.includes(rawLabel)) continue;

      // Nei PDF tabellari AOU/Schiavonia nome, valore, unità e range possono
      // essere spezzati su righe successive. Richiediamo comunque che il
      // valore dichiarato da Qwen compaia vicino all'etichetta sorgente.
      const window = sourceLines
        .slice(i, Math.min(sourceLines.length, i + 5))
        .join(" ")
        .replace(/\s+/g, "")
        .replace(/\./g, ",");
      if (window.includes(value)) return true;
    }

    return false;
  };

  for (const item of payload.results || []) {
    // Nei layout noti Qwen è solo un recupero semantico del residuo: sia la
    // raw_label sia il valore devono essere realmente supportati dal testo
    // che gli è stato fornito. Il catalogo Eumed viene validato dopo.
    const score = sourceSupportScoreForResult(item, residualText);
    const rawLabel = cleanModelLabLabel(item?.raw_label || "");

    if (isKnownResidualNonExamLabel(rawLabel, "")) {
      suppressedNoise += 1;
      continue;
    }

    if (!rawLabel || score < 8 || !lineWindowSupports(item)) {
      // Il semantic rescue è una rete di sicurezza, non una fonte di nuovi
      // warning clinici. Se Qwen propone un esame non dimostrabile nel testo
      // residuo (es. "Troponina I" inventata), lo scartiamo silenziosamente
      // e lo contiamo solo come rumore soppresso.
      suppressedNoise += 1;
      continue;
    }

    accepted.push(item);
  }

  // Anche i referti complessi prodotti durante il rescue devono avere
  // un'etichetta realmente presente nel residuo. In precedenza il filtro
  // rigoroso valeva solo per i numerici e una "Troponina I" allucinata poteva
  // riapparire come complesso non associato al catalogo.
  for (const item of payload.complex || []) {
    const rawLabel = cleanModelLabLabel(item?.label || "");
    const label = normalizeExamName(rawLabel);
    if (isKnownResidualNonExamLabel(rawLabel, "")) {
      suppressedNoise += 1;
      continue;
    }
    if (label && label.length >= 4 && normalizedResidual.includes(label)) {
      acceptedComplex.push(item);
    } else {
      suppressedNoise += 1;
    }
  }

  const acceptedUncertain = [];
  for (const item of payload.uncertain || []) {
    const text = String(item?.text || item?.label || item?.exam || "");
    const reason = String(item?.reason || "");
    if (isKnownResidualNonExamLabel(text, reason)) {
      suppressedNoise += 1;
      continue;
    }
    acceptedUncertain.push(item);
  }

  return {
    ...payload,
    results: accepted,
    complex: acceptedComplex,
    uncertain: acceptedUncertain,
    _suppressedResidualNoise: suppressedNoise
  };
}

function extractSimpleNumericReport(reportText) {
  const lines = String(reportText || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const units = {
    AST: ["u/l", "ui/l"], ALT: ["u/l", "ui/l"], GGT: ["u/l", "ui/l"],
    ALP: ["u/l", "ui/l"], LDH: ["u/l", "ui/l"], CK: ["u/l", "ui/l"],
    GLUCOSE: ["mg/dl", "mmol/l"], CREATININE: ["mg/dl", "mg/l", "umol/l"],
    UREA: ["mg/dl", "mmol/l"], URIC_ACID: ["mg/dl", "umol/l"],
    CHOLESTEROL_TOTAL: ["mg/dl", "mmol/l"], HDL: ["mg/dl", "mmol/l"],
    LDL: ["mg/dl", "mmol/l"], TRIGLYCERIDES: ["mg/dl", "mmol/l"],
    SODIUM: ["mmol/l", "meq/l"], POTASSIUM: ["mmol/l", "meq/l"],
    CHLORIDE: ["mmol/l", "meq/l"], CALCIUM_TOTAL: ["mg/dl", "mmol/l"],
    MAGNESIUM: ["mg/dl", "mmol/l"], PHOSPHATE: ["mg/dl", "mmol/l"],
    IRON: ["ug/dl", "umol/l"], PCR: ["mg/l", "mg/dl"],
    TSH: ["mui/l", "uiu/ml", "mu/l"], FT3: ["pmol/l", "pg/ml"],
    FT4: ["pmol/l", "ng/dl"], PTH: ["pg/ml", "ng/l", "pmol/l"],
    VITAMIN_D: ["ng/ml", "ug/l", "nmol/l"], B12: ["pg/ml", "ng/l", "pmol/l"],
    FOLATE: ["ng/ml", "ug/l", "nmol/l"], FERRITIN: ["ng/ml", "ug/l"],
  };
  const shortNames = /^(?:AST|ALT|GOT|GPT|GGT|GAMMA GT|ALP|LDH|CK|CPK|GLICEMIA|GLUCOSIO|CREATININA(?: SIERICA)?|UREA|AZOTEMIA|URICEMIA|ACIDO URICO|COLESTEROLO(?: TOTALE| HDL| LDL)?|HDL|LDL|TRIGLICERIDI|SODIO|SODIEMIA|POTASSIO|POTASSIEMIA|KALIEMIA|CLORO|CLORUREMIA|CALCIO(?: TOTALE)?|CALCEMIA|MAGNESIO|MAGNESEMIA|FOSFORO|FOSFOREMIA|SIDEREMIA|FERRO|PCR|TSH(?: REFLEX)?|FT3|FT4|PTH|VITAMINA D|VITAMINA B12|B12|FOLATI|FOLATO|ACIDO FOLICO)$/;
  const results = [];
  const context = buildUnprescribedDecisionContext(reportText);
  for (const line of lines) {
    const match = line.match(/^(.+?)\s+([+]?\d+(?:[.,]\d+)?)\s+([^\s]+\s*\/\s*[^\s]+)\s*$/);
    if (!match) return null;
    const label = match[1].trim();
    const n = normalizeExamName(label);
    // Urine, timed collections and complex panels keep their dedicated parsers.
    if (detectSpecimen(label) === "URINE" || /URIA|\b24\s*H\b|\b24H\b/.test(n)) return null;
    const preferred = shortNames.test(n) ? preferredPrescriptionCatalogEntry(label) : null;
    const catalogLabel = preferred?.name || label;
    const resolved = matchCatalogForCreation(catalogLabel, context);
    if (!resolved?.entry || resolved.ambiguous || resolved.blocked) return null;
    const exactName = [resolved.entry.name, ...(resolved.entry.aliases || [])]
      .some(alias => normalizeExamName(sanitizeCreationCatalogAlias(alias)) === n);
    if (!shortNames.test(n) && !exactName) return null;
    const raw = { exam: catalogLabel, raw_label: catalogLabel, evidence: line, value: match[2], unit: match[3].replace(/\s/g, ""),
      ref_min: "", ref_max: "", ref_unit: "" };
    const candidate = prepareUnprescribedNumericCandidate(raw, "", context);
    if (!candidate.success || !units[candidate.item.concept]?.includes(normalizeUnit(raw.unit))) return null;
    results.push(raw);
  }
  return results;
}

function extractUnprescribedDeterministicRaw(reportText, layout) {
  const simple = extractSimpleNumericReport(reportText);
  if (simple) return simple;
  let raw = [];

  if (layout === "SYNLAB_DATA_MEDICA") {
    raw.push(...extractSpecimenAnchoredResults(reportText));
    const acr = extractAcrResult(reportText, layout);
    if (acr) raw.push(acr);
  } else if (layout === "AOU_PADOVA") {
    raw.push(...extractAouPadovaResults(reportText));
    const acr = extractAcrResult(reportText, "AOU_PADOVA");
    if (acr) raw.push(acr);
  } else if (layout === "ULSS6_SCHIAVONIA") {
    raw.push(...extractSpecimenAnchoredResults(reportText));
    raw.push(...extractUlss6DirectResults(reportText));
    const acr = extractAcrResult(reportText, "ULSS6_SCHIAVONIA");
    if (acr) raw.push(acr);
  } else {
    raw.push(...extractSpecimenAnchoredResults(reportText));
    const acr = extractAcrResult(reportText, layout || "GENERIC");
    if (acr) raw.push(acr);
  }

  raw.push(...extractPaddleTabularResults(reportText));
  raw = removeUnsupportedDuplicateAssignments(raw, reportText);

  if (isHbA1cLabel(reportText)) {
    for (let i = raw.length - 1; i >= 0; i--) {
      const t = `${raw[i]?.exam || ""} ${raw[i]?.raw_label || ""}`;
      if (isHbA1cLabel(t) || isHbA1cAuxiliaryLine(t)) raw.splice(i, 1);
    }
    const hba1c = extractHbA1cFallback(reportText);
    if (hba1c) raw.push(hba1c);
  }

  return raw;
}

function sanitizeUnprescribedRange(concept, value, unit, range) {
  if (!range?.available) return range;

  const u = normalizeUnit(unit || "");
  const v = parseItalianNumber(value);
  const min = parseItalianNumber(range.min);
  const max = parseItalianNumber(range.max);

  if (!Number.isFinite(v)) return range;

  // Nei referti lipidici AOU le fasce descrittive (es. "borderline 5,18-6,19")
  // possono finire vicino al valore espresso in mg/dL. Non sono un intervallo
  // di riferimento del risultato e soprattutto non vanno salvate come 5-6 mg/dL.
  const lipidConcept = [
    "CHOLESTEROL_TOTAL",
    "CHOLESTEROL_HDL",
    "CHOLESTEROL_LDL",
    "TRIGLYCERIDES"
  ].includes(concept);

  if (lipidConcept && u === "mg/dl") {
    const finiteBounds = [min, max].filter(Number.isFinite);
    if (finiteBounds.length && Math.max(...finiteBounds) < 25) {
      return {
        available: false,
        min: "",
        max: "",
        unit: "",
        reason: "Fascia decisionale lipidica non usata come Min/Max"
      };
    }
  }

  return range;
}

function prepareUnprescribedNumericCandidate(item, reportDate, context = {}) {
  const query = cleanModelLabLabel(item?.raw_label || item?.exam || "");
  if (isKnownResidualNonExamLabel(query)) return { success: false, ignoredNonExam: true };
  if (/\bEGFR\b|FILTRAZIONE GLOMERULARE/.test(normalizeExamName(query)) &&
      !/CREATININA/.test(normalizeExamName(query))) {
    return { success: false, uncertain: {
      text: query,
      reason: "eGFR: dato accessorio della creatinina, non inserito come prestazione autonoma. Il valore resta da consultare nel referto originale."
    } };
  }
  const match = matchCatalogForCreation(query, context);

  if (!match?.entry) {
    return {
      success: false,
      uncertain: {
        text: query || item?.exam || "Esame",
        reason: match?.blocked
          ? (match.reason || "Voce catalogo non univoca")
          : match?.ambiguous
            ? "Più voci del catalogo prescrivibile risultano equivalenti"
            : "Nessuna voce certa nel catalogo prescrivibile"
      }
    };
  }

  if (isSerologyCatalogEntry(match.entry) || looksLikeSerologyText(query)) {
    return { success: false, complex: true };
  }

  let rawValue = String(item?.value || "").trim();
  let comparatorOriginal = "";
  let comparatorOperator = "";
  const comparatorMatch = rawValue.match(/^([<≤>≥])\s*([+-]?\d+(?:[.,]\d+)?)$/);
  if (comparatorMatch) {
    comparatorOperator = comparatorMatch[1];
    comparatorOriginal = rawValue;

    // Preferenza operativa: per risultati espressi come <x / ≤x valorizza
    // comunque il campo numerico Eumed con x. L'anteprima conserva la forma
    // originale per rendere evidente che si tratta di un limite analitico.
    if (comparatorOperator === "<" || comparatorOperator === "≤") {
      rawValue = comparatorMatch[2];
    } else {
      return {
        success: false,
        uncertain: {
          text: query || match.entry.name,
          reason: `Valore con comparatore (${rawValue}${item?.unit ? ` ${item.unit}` : ""}) da controllare: per > / ≥ non viene rimosso automaticamente il simbolo.`
        }
      };
    }
  }

  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(rawValue)) {
    return {
      success: false,
      uncertain: {
        text: query || match.entry.name,
        reason: `Risultato non numerico (${String(item?.value || "").trim() || "vuoto"})`
      }
    };
  }

  const conceptText = normalizeExamName(`${match.entry.name} ${query}`);
  // 1,25-diidrossivitamina D non va convertita con le regole della 25-OH:
  // pmol/L e' un'unita' fisiologica valida per questa prestazione e viene
  // mantenuta tale e quale. La 25-OH continua invece a usare VITAMIN_D.
  const concept = (
    conceptText.includes("VITAMINA D") &&
    (/\b1 25\b/.test(conceptText) || conceptText.includes("1 25 OH"))
  ) ? "VITAMIN_D_1_25" : getExamConcept(`${match.entry.name} ${query}`);
  const conversion = convertMeasurement(concept, rawValue, item?.unit || "");

  if (!conversion.ok) {
    return {
      success: false,
      uncertain: {
        text: match.entry.name,
        reason: conversion.reason || "Conversione/unità non validabile"
      }
    };
  }

  const rangeInput = prepareRangeInput(item, item?.unit || "");
  let range = convertRange(
    concept,
    rangeInput.min,
    rangeInput.max,
    rangeInput.unit,
    conversion.unit
  );

  if (range.available && !unitsCompatible(range.unit, conversion.unit)) {
    range = { available: false, min: "", max: "", unit: "", reason: "Unità range non compatibile con il valore finale" };
  }

  range = sanitizeUnprescribedRange(
    concept,
    conversion.value,
    conversion.unit,
    range
  );

  return {
    success: true,
    item: {
      exam: match.entry.name,
      catalogCode: match.entry.code,
      catalogEntry: match.entry,
      value: conversion.value,
      unit: conversion.unit,
      originalValue: conversion.originalValue,
      originalUnit: conversion.originalUnit,
      converted: conversion.converted,
      refMin: range.available ? range.min : "",
      refMax: range.available ? range.max : "",
      refUnit: range.available ? range.unit : "",
      rangeAvailable: !!range.available,
      reportDate,
      concept,
      raw_label: query,
      evidence: String(item?.evidence || ""),
      source: item?._qwenUnprescribed ? "qwen" : "parser",
      comparatorOriginal,
      comparatorOperator,
      comparatorOriginalWithUnit: comparatorOriginal
        ? `${comparatorOriginal}${item?.unit ? ` ${item.unit}` : ""}`
        : ""
    }
  };
}

function dedupeUnprescribedNumeric(items, uncertain) {
  const groups = new Map();

  for (const item of items || []) {
    const key = String(item.catalogCode || normalizeExamName(item.exam));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const out = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }

    const first = group[0];
    const concept = first.concept || getExamConcept(first.exam);
    const allEquivalent = group.every(item =>
      valuesClinicallyEquivalent(item.value, first.value, concept)
    );

    if (!allEquivalent) {
      uncertain.push({
        text: first.exam,
        reason: "Più risultati differenti associati alla stessa voce del catalogo: " +
          group.map(x => `${x.value}${x.unit ? ` ${x.unit}` : ""}`).join(" | ")
      });
      continue;
    }

    const preferred = normalizeUnit(PREFERRED_UNITS[concept] || "");
    const best =
      group.find(x => preferred && normalizeUnit(x.unit) === preferred && !x.converted) ||
      group.find(x => x.rangeAvailable) ||
      group[0];

    if (!best.rangeAvailable) {
      const withRange = group.find(x => x.rangeAvailable && unitsCompatible(x.refUnit, best.unit));
      if (withRange) {
        best.refMin = withRange.refMin;
        best.refMax = withRange.refMax;
        best.refUnit = withRange.refUnit;
        best.rangeAvailable = true;
      }
    }

    out.push(best);
  }

  return out;
}

function catalogEntryForQwenComplex(item, context = {}) {
  const kind = String(item?.kind || "");
  if (UNPRESCRIBED_FIXED_COMPLEX_CODES[kind]) {
    return getFixedComplexCatalogEntry(kind);
  }

  if (kind === "BILIRUBINA") return getFixedComplexCatalogEntry("BILIRUBINA");
  if (kind === "PSA_REFLEX") return getFixedComplexCatalogEntry("PSA_REFLEX");

  if (kind === "SIEROLOGIA") {
    const source = item?.label || item?.text || "";
    const preferredEntry = preferredSerologyCatalogEntry(source, context);
    if (preferredEntry && isSerologyCatalogEntry(preferredEntry)) return preferredEntry;
    const match = matchCatalogForCreation(cleanupSerologyQuery(source), context);
    if (match?.entry && isSerologyCatalogEntry(match.entry)) return match.entry;
  }

  return null;
}

function transferNumericSourceSupported(item, reportText) {
  const label = normalizeExamName(item.raw_label || item.exam || "");
  const value = String(item.value || "").replace(/^[<>\u2264\u2265]\s*/, "").replace(",", ".");
  if (!label || !/^[+-]?\d+(?:\.\d+)?$/.test(value) || !item.unit) return false;
  const lines = cleanReportLines(reportText);
  return lines.some((line, index) => {
    if (!normalizeExamName(line).includes(label)) return false;
    const measurements = [];
    const direct = parseInlineSpecimenMeasurement(line) || parseInlineKnownMeasurement(line);
    if (direct) measurements.push(direct);
    for (let i = index + 1; i < Math.min(lines.length, index + 6); i++) {
      if (/^(?:SI|S|P|U|B)\s*-\s*/i.test(lines[i])) break;
      const next = parseAnchoredMeasurementLine(lines[i]);
      if (next) measurements.push(next);
    }
    return measurements.some(measurement => Number(String(measurement.value).replace(",", ".")) === Number(value) &&
      normalizeUnit(measurement.unit) === normalizeUnit(item.unit));
  });
}

function transferComplexSourceSupported(kind, text) {
  if (kind === "BILIRUBINA") return /BILIRUBINA/.test(normalizeExamName(text));
  if (kind === "PSA_REFLEX") return /\bPSA\b|ANTIGENE PROSTATICO SPECIFICO/.test(normalizeExamName(text));
  return reportReallyContainsLongReportKind(text, kind);
}

function buildPrescribedTransferText(extraction, reportText) {
  if (!String(reportText || "").trim()) return "";
  const layout = detectKnownLabLayout(reportText);
  const raw = extractUnprescribedDeterministicRaw(reportText, layout);
  const context = buildUnprescribedDecisionContext(reportText, raw);
  const date = normalizeDateValue(extraction.reportDate || parseExplicitReportDateText(reportText)?.date || "");
  const absent = entry => {
    const resolution = resolveExamName(entry.name);
    return !resolution.success && resolution.reason !== "ambiguous";
  };
  const fixed = buildUnprescribedFixedComplexItems(reportText, layout, raw, date)
    .filter(item => absent(item.catalogEntry) && transferComplexSourceSupported(item.complexKind, item.text));
  // A PSA total alone is still a complete reported result. Do not invent a
  // free PSA or a ratio just because the catalog groups them in one entry.
  if (!fixed.some(item=>item.complexKind === "PSA_REFLEX")) {
    const psa=raw.filter(item=>getExamConcept(`${item.raw_label || ""} ${item.exam || ""}`)==="PSA_TOTAL" &&
      transferNumericSourceSupported(item,reportText) && unitCompatibleWithConcept("PSA_TOTAL",item.unit));
    const entry=getFixedComplexCatalogEntry("PSA_REFLEX");
    if (psa.length && psa.every(item=>normalizeUnit(item.unit)===normalizeUnit(psa[0].unit) && sameNumericValue(item.value,psa[0].value)) && entry && absent(entry)) {
      const item=psa[0];
      fixed.push({exam:entry.name,catalogCode:entry.code,catalogEntry:entry,complexKind:"PSA_REFLEX",reportDate:date,
        text:`PSA totale: ${item.value} ${item.unit}${item.reference_text ? "\nRiferimento: "+item.reference_text : ""}`});
    }
  }
  const complexCodes = new Set(fixed.map(item => item.catalogCode));
  const groups = new Map();
  for (const item of [...raw, ...(extraction.recognizedNotInGrid || [])]) {
    if (!transferNumericSourceSupported(item, reportText)) continue;
    const prepared = prepareUnprescribedNumericCandidate(item, date, context);
    if (!prepared.success || complexCodes.has(prepared.item.catalogCode) ||
        getLongReportKind(prepared.item.exam) || !absent(prepared.item.catalogEntry)) continue;
    if (item.catalogCode && item.catalogCode !== prepared.item.catalogCode) continue;
    const rows = groups.get(prepared.item.catalogCode) || [];
    rows.push({raw:item,prepared:prepared.item});groups.set(prepared.item.catalogCode,rows);
  }
  const numeric = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    if (!rows.every(row => valuesClinicallyEquivalent(row.prepared.value, first.prepared.value, first.prepared.concept))) continue;
    numeric.push({ esame:first.prepared.exam, codice:first.prepared.catalogCode,
      valore:String(first.raw.value), unita:String(first.raw.unit),
      min:String(first.raw.ref_min || ""), max:String(first.raw.ref_max || ""),
      unita_intervallo:String(first.raw.ref_unit || first.raw.unit || "") });
  }
  if (!numeric.length && !fixed.length) return "";
  return JSON.stringify({formato:"SEGRETARIO_MMG_REFERTO_V1",data_referto:date,numerici:numeric,
    complessi:fixed.map(item=>({esame:item.exam,codice:item.catalogCode,tipo:item.complexKind,testo:item.text}))},null,2);
}

function parsePrescribedTransferText(text) {
  const source = String(text || "").trim();
  if (!source.startsWith("{") || !source.includes('"SEGRETARIO_MMG_REFERTO_V1"')) return null;
  let payload;
  try { payload=JSON.parse(source); } catch {throw new Error("Blocco di trasferimento incompleto: copialo nuovamente per intero.");}
  if (payload.formato !== "SEGRETARIO_MMG_REFERTO_V1") return null;
  if (!Array.isArray(payload.numerici) || !Array.isArray(payload.complessi) || payload.numerici.length+payload.complessi.length>500) throw new Error("Blocco di trasferimento non valido.");
  const reportDate=normalizeDateValue(payload.data_referto || "");
  if(payload.data_referto && !reportDate) throw new Error("Data del blocco di trasferimento non valida.");
  const context=buildUnprescribedDecisionContext(payload.numerici.map(row=>row.esame).join("\n"));
  const uncertain=[],numeric=[],complex=[];
  for (const row of payload.numerici) {
    const entry=findCatalogEntryByCode(row.codice);
    if (!entry || entry.name !== row.esame || typeof row.valore!=="string" || typeof row.unita!=="string") throw new Error("Associazione esame/codice del blocco non valida. Ricopia il blocco originale.");
    const raw={exam:row.esame,raw_label:row.esame,value:row.valore,unit:row.unita,
      ref_min:row.min,ref_max:row.max,ref_unit:row.unita_intervallo};
    const prepared=prepareUnprescribedNumericCandidate(raw,reportDate,context);
    if (!prepared.success || prepared.item.catalogCode!==row.codice) throw new Error("Valore, unita o associazione del blocco non validabili: verifica il referto originale.");
    numeric.push(prepared.item);
  }
  for (const row of payload.complessi) {
    const entry=getFixedComplexCatalogEntry(row.tipo);
    if (!entry || entry.code!==row.codice || entry.name!==row.esame || typeof row.testo!=="string" || !transferComplexSourceSupported(row.tipo,row.testo)) throw new Error("Referto complesso del blocco non validabile.");
    if (!complex.some(item=>item.catalogCode===entry.code)) complex.push({exam:entry.name,catalogCode:entry.code,catalogEntry:entry,
      complexKind:row.tipo,reportDate,text:row.testo,source:"trasferimento-locale"});
  }
  if (!reportDate) uncertain.push({text:"Data del referto",reason:"Data non presente nel blocco: controlla prima di inserire."});
  const deduped=dedupeUnprescribedNumeric(numeric,uncertain);
  return {layout:"TRASFERIMENTO_LOCALE",reportDate,numeric:deduped,complex,uncertain,
    stats:{rawResults:payload.numerici.length,numeric:deduped.length,complex:complex.length,qwenUsed:false,qwenResidualUsed:false,qwenResidualEvidence:0,qwenResidualChars:0}};
}

async function extractUnprescribedFromReport(reportText, progressCallback = null) {
  await ensureLabCatalog();
  if (!labCatalog.length) throw new Error("Catalogo laboratorio locale non disponibile.");
  const transferred=parsePrescribedTransferText(reportText);
  if (transferred) return transferred;

  const layout = detectKnownLabLayout(reportText);
  const explicitDate = parseExplicitReportDateText(reportText);
  let reportDate = explicitDate?.date || "";
  const uncertain = [];

  progressCallback?.({ phase: "unprescribed_parser", layout });

  const simpleNumericReport = extractSimpleNumericReport(reportText);
  let rawResults = simpleNumericReport || extractUnprescribedDeterministicRaw(reportText, layout);

  // Qwen ha due ruoli distinti:
  // - layout ignoto: estrae l'intero referto;
  // - AOU / SYNLAB / Schiavonia: riceve SOLO il testo residuo non spiegato
  //   dal parser e recupera eventuali analiti dimenticati.
  let qwenPayload = null;
  let qwenResidualEvidenceCount = 0;
  let qwenResidualChars = 0;

  if (!layout && !simpleNumericReport) {
    qwenPayload = await extractUnprescribedWithQwen(reportText, progressCallback);
    rawResults.push(...(qwenPayload.results || []));
    uncertain.push(...(qwenPayload.uncertain || []));
    if (!reportDate && qwenPayload.report_date) reportDate = qwenPayload.report_date;
  } else if (layout) {
    // Prima del rescue costruiamo i complessi già certi così le loro righe
    // non vengono scambiate per nuovi esami mancanti.
    const parserComplexForResidual = buildUnprescribedFixedComplexItems(
      reportText,
      layout,
      rawResults,
      reportDate
    );

    const residual = buildKnownUnprescribedResidualEvidence(
      reportText,
      layout,
      rawResults,
      parserComplexForResidual
    );

    qwenResidualEvidenceCount = residual?.count || 0;
    qwenResidualChars = String(residual?.text || "").length;

    if (qwenResidualEvidenceCount > 0 && qwenResidualChars > 0) {
      progressCallback?.({
        phase: "unprescribed_qwen_residual",
        layout,
        evidence: qwenResidualEvidenceCount,
        chars: qwenResidualChars
      });

      qwenPayload = await extractUnprescribedWithQwen(
        residual.text,
        progressCallback,
        {
          residualOnly: true,
          layoutName: getKnownLayoutDisplayName(layout)
        }
      );

      qwenPayload = validateKnownLayoutQwenResidualResults(
        qwenPayload,
        residual.text,
        uncertain
      );

      rawResults.push(...(qwenPayload.results || []));
      uncertain.push(...(qwenPayload.uncertain || []));
    }
  }

  const decisionContext = buildUnprescribedDecisionContext(reportText, rawResults);

  // Ricostruisci i complessi dopo il rescue: Qwen potrebbe aver recuperato
  // componenti utili a PSA reflex/bilirubina o altri cluster.
  const fixedComplex = buildUnprescribedFixedComplexItems(
    reportText,
    layout,
    rawResults,
    reportDate
  );

  const rawSerology = buildRawSerologyComplexItems(rawResults, reportText, reportDate, decisionContext);
  const serology = detectSerologyComplexItems(reportText, reportDate, decisionContext);
  uncertain.push(...serology.unmatched.map(x => ({
    text: x.line,
    reason: `Possibile sierologia non associata automaticamente: ${x.reason}`
  })));

  const complexMap = new Map();
  for (const item of [...fixedComplex, ...rawSerology, ...serology.items]) {
    const key = String(item.catalogCode || normalizeExamName(item.exam));
    if (!complexMap.has(key)) complexMap.set(key, item);
    else {
      const existing = complexMap.get(key);
      existing.text = mergeUniqueLongReportText(existing.text, item.text);
    }
  }

  if (qwenPayload) {
    for (const item of qwenPayload.complex || []) {
      const entry = catalogEntryForQwenComplex(item, decisionContext);
      if (!entry || !item.text) {
        if (item.label) uncertain.push({
          text: item.label,
          reason: "Referto complesso IA non associato con certezza al catalogo prescrivibile"
        });
        continue;
      }

      const key = String(entry.code);
      if (!complexMap.has(key)) {
        complexMap.set(key, {
          exam: entry.name,
          catalogCode: entry.code,
          catalogEntry: entry,
          complexKind: item.kind,
          reportDate,
          text: normalizeLongReportText(item.text),
          source: "qwen-complex"
        });
      }
    }
  }

  const complex = [...complexMap.values()];
  const numericCandidates = [];

  for (const raw of rawResults) {
    if (rawResultCoveredByUnprescribedComplex(raw, complex)) continue;

    const prepared = prepareUnprescribedNumericCandidate(raw, reportDate, decisionContext);
    if (prepared.success) numericCandidates.push(prepared.item);
    else if (prepared.uncertain) uncertain.push(prepared.uncertain);
  }

  const numeric = dedupeUnprescribedNumeric(numericCandidates, uncertain)
    .sort((a, b) => String(a.exam).localeCompare(String(b.exam), "it"));

  complex.sort((a, b) => String(a.exam).localeCompare(String(b.exam), "it"));

  if (!reportDate) {
    uncertain.unshift({
      text: "Data del referto",
      reason: "Data di refertazione/validazione/firma non rilevata con certezza"
    });
  }

  if (typeof recordDiagnosticEvent === "function") recordDiagnosticEvent("parser_referto", {
    knownLayout: !!layout, rawResults: rawResults.length, numeric: numeric.length,
    complex: complex.length, uncertain: uncertain.length, qwenUsed: !!qwenPayload,
    qwenResidualEvidence: qwenResidualEvidenceCount
  });

  return {
    layout,
    reportDate,
    numeric,
    complex,
    uncertain: dedupeUnprescribedWarnings(uncertain),
    stats: {
      rawResults: rawResults.length,
      numeric: numeric.length,
      complex: complex.length,
      qwenUsed: !!qwenPayload,
      qwenResidualUsed: !!layout && !!qwenPayload,
      qwenResidualEvidence: qwenResidualEvidenceCount,
      qwenResidualChars,
      qwenResidualNoiseSuppressed: Number(qwenPayload?._suppressedResidualNoise || 0)
    }
  };
}

function directCatalogCodeFromPrescriptionLabel(label) {
  const raw = String(label || "").toUpperCase();
  if (!raw) return null;

  // Se l'utente incolla direttamente un codice del catalogo, usalo.
  const candidates = labCatalog
    .filter(entry => {
      const code = String(entry?.code || "").toUpperCase().trim();
      if (!code || code.length < 4) return false;
      const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^A-Z0-9_.-])${escaped}([^A-Z0-9_.-]|$)`, "i").test(raw);
    });

  return candidates.length === 1 ? candidates[0] : null;
}

function preferredPrescriptionCatalogEntry(label, context = {}) {
  const raw = sanitizeCreationCatalogAlias(label);
  const n = normalizeExamName(raw);
  if (!n) return null;

  const direct = directCatalogCodeFromPrescriptionLabel(raw);
  if (direct) return direct;
  const reviewedAliases = {
"Colesterolo LDL": "90.13.C_0",
"PSA totale": "90.56.9_0",
"PSA libero": "90.56.9_0",
"Bilirubina totale": "90.10.5_3",
"Bilirubina reflex": "90.10.5_3",
"Elettroforesi dell'emoglobina": "90.66.7_2",
"Emoglobina A2 (HbA2)": "90.66.7_2",
"Emoglobina fetale (HbF)": "90.66.7_2",
"HbA2": "90.66.7_2",
"HbF": "90.66.7_2",
"Folati (acido folico)": "90.23.2_2",
"Folati": "90.23.2_2",
"Anticorpi anti-tireoperossidasi (anti-TPO)": "90.51.4_0",
"Anti-TPO": "90.51.4_0",
"Troponina cardiaca": "90.82.3_0",
"Immunoglobuline IgA totali": "90.69.4_7",
"Anticorpi antinucleo (ANA)": "90.52.4_0",
"Anticorpi anti-EBV VCA IgM": "91.21.6_0",
"Anticorpi anti-EBV VCA IgG": "91.21.6_0",
"Anticorpi anti-EBNA IgG": "91.21.6_0",
"Pepsinogeno I": "90.38.M_0",
"Pepsinogeno II": "90.38.N_0",
"Vitamina E (alfa-tocoferolo)": "90.45.2_3",
"Osmolalità sierica": "90.34.7_2",
"Bicarbonati sierici": "90.10.2_2",
"IgG4 sieriche": "90.68.4_5",
"G6PD": "90.27.2_0",
"G6PD (glucosio-6-fosfato deidrogenasi)": "90.27.2_0",
"Anticorpi anticardiolipina IgG": "90.47.5_2",
"Anticorpi anticardiolipina IgM": "90.47.5_3",
"Anticorpi anti-mitocondrio (AMA)": "90.52.1_0",
"Anticorpi anti-LKM1": "90.51.5_0",
"Anticorpi anti-SLA/LP": "90.52.5_13",
"Anticorpi anti-GBM": "90.48.9_0",
"Anticorpi anticentromero": "90.47.F_0",
"Anticorpi anti-Jo-1": "90.47.7_0",
"Anticorpi anti-Mi-2": "90.52.5_40",
"DHEA-S": "90.17.2_0",
"Androstenedione": "90.17.3_0",
"17-OH progesterone": "90.01.2_0",
"Tireoglobulina": "90.41.5_0",
"Anticorpi anti-recettore dell'acetilcolina": "90.53.9_0",
"Anticorpi anti-GAD65": "90.49.7_0",
"Anticorpi anti-IA2": "90.52.5_12",
"NSE (enolasi neurone-specifica)": "90.18.4_0",
"HBV-DNA quantitativo": "91.16.B_0",
"HCV-RNA quantitativo": "91.19.4_0"
};
  const reviewed=Object.entries(reviewedAliases).find(([alias])=>normalizeExamName(alias)===n);
  if(reviewed) return findCatalogEntryByCode(reviewed[1]);
  if (["EMOGRUPPO", "GRUPPO SANGUIGNO", "GRUPPO ABO", "GRUPPO AB0", "GRUPPO ABO E RH", "GRUPPO AB0 E RH", "EMOGRUPPO E RH"].includes(n)) return findCatalogEntryByCode("90.65.3_2");

  // Sinonimi operativi della sola lista di prescrizione: non reinterpretare
  // "albumina glicata" come HbA1c e non alterare i parser dei referti.
  if (/^(?:GLICEMIA|GLUCOSIO)(?: BASALE| A DIGIUNO)?$/.test(n)) {
    return findCatalogEntryByCode("90.27.1_2");
  }
  if (n === "GLICATA") return findCatalogEntryByCode("90.28.1_0");
  const routineSynonyms = {
    "CALCEMIA": "90.11.4_2",
    "FOSFOREMIA": "90.24.3_2",
    "FOSFATEMIA": "90.24.3_2",
    "MAGNESEMIA": "90.32.5_2",
    "KALIEMIA": "90.37.4_2",
    "KALEMIA": "90.37.4_2",
    "POTASSIEMIA": "90.37.4_2",
    "SODIEMIA": "90.40.4_2",
    "NATREMIA": "90.40.4_2",
    "NATRIEMIA": "90.40.4_2",
    "CLOREMIA": "90.13.3_2",
    "AZOTEMIA": "90.44.1_6",
    "URICEMIA": "90.43.5_2",
    "SIDEREMIA": "90.22.5_2",
    "ALP": "90.23.5_0",
    "ALP TOTALE": "90.23.5_0",
    "ALP OSSEA": "90.24.1_0",
    "FOSFATASI ALCALINA OSSEA": "90.24.1_0",
    "FOSFATASI ALCALINA TOTALE": "90.23.5_0"
  };
  if (routineSynonyms[n]) return findCatalogEntryByCode(routineSynonyms[n]);
  // La raccolta temporizzata deve essere esplicita. Non confondere urine
  // estemporanee, rapporti con creatinina e campioni delle 24 ore.
  const urinarySynonyms = {
    SODIURIA: ["90.40.4_3", "90.40.4_4"],
    NATRIURIA: ["90.40.4_3", "90.40.4_4"],
    KALIURIA: ["90.37.4_4", "90.37.4_3"],
    POTASSIURIA: ["90.37.4_4", "90.37.4_3"],
    FOSFATURIA: ["90.24.3_3", "90.24.3_4"],
    MAGNESIURIA: ["90.32.5_4", "90.32.5_5"],
    CLORURIA: ["90.13.3_3", "90.13.3_4"],
    URICOSURIA: ["90.43.5_3", "90.43.5_4"],
    CALCIURIA: [null, "90.11.4_3"]
  };
  const urinary = n.match(/^(\w+)(?: (24 ?H|24 ORE|DELLE 24 ?H|DELLE 24 ORE|SPOT|ESTEMPORANEA|SEMPLICE|NORMALE))?$/);
  if (urinary && urinarySynonyms[urinary[1]]) {
    const timed = /24/.test(urinary[2] || "");
    const code = urinarySynonyms[urinary[1]][timed ? 1 : 0];
    if (code) return findCatalogEntryByCode(code);
  }
  if (/^(?:ALANINA|ALANINO) AMINO\s*TRANSFERASI$/.test(n)) {
    return findCatalogEntryByCode("90.04.5_0");
  }
  if (/^(?:ASPARTATO|ASPARTICO) AMINO\s*TRANSFERASI$/.test(n)) {
    return findCatalogEntryByCode("90.09.2_0");
  }

  const molecular = isMolecularMicrobiologyText(raw) || /CARICA VIRALE|VIREMIA/.test(n);

  // Accorpamenti usati nella prescrizione: diversi dalle singole righe che
  // possono comparire nei referti di laboratorio.
  if (!molecular && (/\bCMV\b/.test(n) || n.includes("CITOMEGALOVIRUS"))) {
    return findCatalogEntryByCode("CMVAB");
  }
  if (!molecular && n.includes("TOXOPLAS")) {
    return findCatalogEntryByCode("TOXOPAB");
  }
  if (!molecular && (n.includes("PARVOVIRUS") || /\bB19\b/.test(n))) {
    return findCatalogEntryByCode("PARVOINF");
  }
  if (!molecular && (n.includes("TREPONEMA") || n.includes("SIFIL") || /\bTPHA\b|\bTPPA\b|\bVDRL\b|\bRPR\b/.test(n))) {
    return findCatalogEntryByCode(n.includes("LIQUOR") ? "91.10.B_3" : "91.10.B_2");
  }
  if (!molecular && (/\bHIV\b/.test(n) || n.includes("IMMUNODEFIC"))) {
    return findCatalogEntryByCode("91.23.F_0");
  }
  if (!molecular && (/\bHCV\b/.test(n) || n.includes("EPATITE C")) && !n.includes("ANTIGENE")) {
    return findCatalogEntryByCode("91.19.5_0");
  }

  // HBV: se la lista contiene un profilo/multipli marcatori usa il reflex
  // unico. HBs/HBsAg isolato usa invece HBsAg, come da uso operativo.
  const isHbv = /\bHBV\b|EPAT(?:ITE)? B/.test(n) || /HBS|HBC|HBE/.test(n);
  if (!molecular && isHbv) {
    if (context?.hbvProfile) return findCatalogEntryByCode("91.18.6_0");
    if (/ANTI\s*HBS|HBSAB|ANTICORPI\s+HBS/.test(n)) return findCatalogEntryByCode("91.18.3_0");
    if (/ANTI\s*HBE|HBEAB|ANTICORPI\s+HBE/.test(n)) return findCatalogEntryByCode("91.18.2_0");
    if (/\bHBEAG\b|ANTIGENE\s+HBE/.test(n)) return findCatalogEntryByCode("91.18.4_0");
    if (/\bHBSAG\b|ANTIGENE\s+HBS|(?:^|\s)HBS(?:\s|$)/.test(n)) return findCatalogEntryByCode("91.18.5_0");
  }

  return null;
}


function getUnclaimedAiEvidence(reportText, parserExtraction) {
  const layout =
    parserExtraction?.labLayout ||
    detectKnownLabLayout(reportText);

  const stripped = stripKnownPageChrome(reportText, layout);
  const unclaimed = removeConsumedAiLines(stripped, parserExtraction);

  const parsedConcepts = new Set(
    (parserExtraction?.results || [])
      .map(item => getExamConcept(`${item?.exam || ""} ${item?.raw_label || ""}`))
      .filter(Boolean)
  );

  const longKinds = new Set(
    (parserExtraction?.longReports || [])
      .map(item => item?.kind || getLongReportKind(item?.exam || ""))
      .filter(Boolean)
  );

  const hasExplicitTargetConcept = concept =>
    getAvailableExams().some(exam => getExamConcept(exam) === concept);

  const isKnownAuxiliaryLine = line => {
    const n = normalizeExamName(line);
    const concept = getExamConcept(line);
    if (isKnownResidualNonExamLabel(line)) return true;
    if (parsedConcepts.has("HBA1C") && isHbA1cLabel(line)) return true;

    // Rapporto FLC: dato accessorio delle due catene quando Eumed non ha
    // una riga dedicata. Non deve far partire un recupero semantico per un
    // target del tutto assente (es. IgE allergeniche).
    if (concept === "FLC_RATIO" && !hasExplicitTargetConcept("FLC_RATIO")) {
      return true;
    }

    // eGFR è accessorio della creatinina sierica quando questa è già stata
    // risolta deterministicamente.
    if (
      parsedConcepts.has("CREATININE") &&
      (/\bEGFR\b/.test(n) || n.includes("FILTRAZIONE GLOMERULARE"))
    ) {
      return true;
    }

    // Diuresi/volume delle 24h è contesto del referto Bence-Jones/urinario,
    // non una nuova prestazione da spiegare semanticamente.
    if (
      /\bDIURESI\b/.test(n) &&
      (longKinds.has("BENCE_JONES") || longKinds.has("URINE"))
    ) {
      return true;
    }

    // Componenti già inglobate in referti complessi non devono riattivare
    // IA come se fossero un analita sconosciuto autonomo.
    if (
      n.includes("COMPONENTE MONOCLONALE") &&
      (longKinds.has("PROTIDOGRAMMA") || longKinds.has("TIPIZZAZIONE_MONOCLONALE"))
    ) {
      return true;
    }

    return false;
  };

  const hasPlausibleAnalyteLabel = line => {
    const raw = String(line || "").trim();
    // Le righe di continuazione che iniziano direttamente con il valore
    // (es. "52,0 %" o una seconda unità equivalente) non rappresentano
    // un nuovo esame e non devono alimentare il semantic rescue.
    const beforeNumber = raw.split(/[<>≤≥]?\s*[+-]?\d/)[0] || "";
    return /[A-Za-zÀ-ÿ]{2,}/.test(beforeNumber);
  };

  const evidenceLines = String(unclaimed || "")
    .split(/\r?\n/)
    .map(line => String(line || "").trim())
    .filter(Boolean)
    .filter(line => {
      if (isKnownAuxiliaryLine(line)) return false;

      if (aiLineHasMeasurement(line)) {
        return hasPlausibleAnalyteLabel(line);
      }

      const n = normalizeExamName(line);
      return (
        /(?:POSITIV\w*|NEGATIV\w*|REATTIV\w*|NON\s+REATTIV\w*|PRESENT\w*|ASSENT\w*|RILEVAT\w*|NON\s+RILEVAT\w*)/.test(n) &&
        /[A-Z]{2,}/.test(n)
      );
    });

  return {
    text: unclaimed,
    evidenceLines,
    count: evidenceLines.length
  };
}

module.exports = {
  buildPrescribedTransferText,
  buildUnprescribedDecisionContext,
  extractUnprescribedFromReport,
  getUnclaimedAiEvidence,
  matchCatalogForCreation,
  preferredPrescriptionCatalogEntry,
  preferredSerologyCatalogEntry,
  prepareUnprescribedNumericCandidate,
  sanitizeCreationCatalogAlias,
};
