// Configurazione, normalizzazione nomi esame, concetti clinici e utilità comuni.
"use strict";

// Esami più prescritti nello studio: usati come candidati forti
// nel fallback Qwen. La lista viene comunque intersecata con la Grid
// realmente visibile, quindi non crea esami che non siano prescritti.
const FREQUENT_EXAM_HINT_RULES = [
  { key: "ALT", all: ["ALANINA", "AMINOTRANSFERASI"] },
  { key: "PSA_REFLEX", all: ["ANTIGENE", "PROSTATICO", "PSA", "REFLEX"] },
  { key: "AST", all: ["ASPARTATO", "AMINOTRANSFERASI"] },
  { key: "BILIRUBINA_REFLEX", all: ["BILIRUBINA", "REFLEX"] },
  { key: "CALCIO", all: ["CALCIO", "TOTALE", "S"] },
  { key: "CLORO", all: ["CLORURO", "CLORO", "S"] },
  { key: "B12", all: ["COBALAMINA", "VIT", "B12"] },
  { key: "HDL", all: ["COLESTEROLO", "HDL"] },
  { key: "LDL_DIRETTO", all: ["COLESTEROLO", "LDL", "DIRETTA"] },
  { key: "LDL_INDIRETTO", all: ["COLESTEROLO", "LDL", "INDIRETTA"] },
  { key: "COLESTEROLO_TOTALE", all: ["COLESTEROLO", "TOTALE"] },
  { key: "CK", all: ["CREATINCHINASI"] },
  { key: "CREATININA_S", all: ["CREATININA", "S"], any: ["EGFR", "EVENTUALE"] },
  { key: "CREATININA_U_ACR", all: ["CREATININA", "U", "ACR"] },
  { key: "PROTIDOGRAMMA", all: ["ELETTROFORESI", "PROTEINE", "SIERICHE"] },
  { key: "EMOCROMO", all: ["EMOCROMO", "COMPLETO", "FORMULA"] },
  { key: "URINOCOLTURA", all: ["ESAME", "COLTURALE", "URINA"], any: ["URINOCOLTURA", "MITTO"] },
  { key: "FERRITINA", all: ["FERRITINA"] },
  { key: "FERRO", all: ["FERRO", "S"] },
  { key: "FOLATO", all: ["FOLATO"] },
  { key: "ALP", all: ["FOSFATASI", "ALCALINA"] },
  { key: "FOSFATO", all: ["FOSFATO", "INORGANICO", "S"] },
  { key: "GGT", all: ["GAMMA", "GLUTAMIL"], any: ["GGT", "TRANSPEPTIDASI"] },
  { key: "GLUCOSIO", all: ["GLUCOSIO", "S"] },
  { key: "HBA1C", all: ["EMOGLOBINA", "GLICATA"] },
  { key: "IGA", all: ["IMMUNOGLOBULINE", "IGA", "S"] },
  { key: "INSULINA", all: ["INSULINA", "S"] },
  { key: "IGE_SPECIFICHE", all: ["IGE", "SPECIFICHE", "ALLERGOLOGICHE"] },
  { key: "LDH", all: ["LATTATO", "DEIDROGENASI", "LDH", "S"] },
  { key: "MAGNESIO", all: ["MAGNESIO", "TOTALE", "S"] },
  { key: "MICROALBUMINURIA_ACR", all: ["MICROALBUMINURIA", "ACR"] },
  { key: "PTH", all: ["PARATORMONE", "PTH"], any: ["MOLECOLA", "INTATTA"] },
  { key: "BNP", all: ["PEPTIDE", "NATRIURETICO"], any: ["BNP", "NTPROBNP"] },
  { key: "POTASSIO", all: ["POTASSIO", "S"] },
  { key: "PCR", all: ["PROTEINA", "C", "REATTIVA", "PCR"] },
  { key: "SODIO", all: ["SODIO", "S"] },
  { key: "PT", all: ["TEMPO", "PROTROMBINA", "PT"] },
  { key: "APTT", all: ["TEMPO", "TROMBOPLASTINA", "APTT"] },
  { key: "TSH_STANDARD", all: ["TIREOTROPINA", "TSH"], none: ["REFLEX"] },
  { key: "TSH_REFLEX", all: ["TIREOTROPINA", "TSH", "REFLEX"] },
  { key: "FT4", all: ["TIROXINA", "LIBERA", "FT4"] },
  { key: "TOXO", all: ["TOXOPLASMA", "ANTICORPI", "IGG", "IGM"] },
  { key: "TRIGLICERIDI", all: ["TRIGLICERIDI"] },
  { key: "FT3", all: ["TRIODOTIRONINA", "LIBERA", "FT3"] },
  { key: "URATO", all: ["URATO", "ACIDO", "URICO", "S"] },
  { key: "UREA", all: ["UREA", "S"], any: ["AZOTEMIA", "UREA"] },
  { key: "URINE_COMPLETO", all: ["URINE", "ESAME", "COMPLETO"] },
  { key: "VES", all: ["VELOCITA", "SEDIMENTAZIONE", "EMAZIE", "VES"] },
  { key: "CMV", all: ["CITOMEGALOVIRUS", "ANTICORPI", "IGG", "IGM"] },
  { key: "VITAMINA_D", all: ["VITAMINA", "D", "25", "OH"] },

  // Aggiunti perché emersi nei test reali più recenti.
  { key: "FSH", all: ["FOLLITROPINA", "FSH"] },
  { key: "ESTRADIOLO", all: ["ESTRADIOLO", "E2"] },
  { key: "TESTOSTERONE_LIBERO", all: ["TESTOSTERONE", "LIBERO"] }
];

function frequentRuleMatchesExam(rule, exam) {
  const n = normalizeExamName(exam);

  const hasAll = (rule.all || []).every(token =>
    n.includes(normalizeExamName(token))
  );

  if (!hasAll) return false;

  if (
    (rule.none || []).some(token =>
      n.includes(normalizeExamName(token))
    )
  ) {
    return false;
  }

  if (rule.any?.length) {
    return rule.any.some(token =>
      n.includes(normalizeExamName(token))
    );
  }

  return true;
}

const CONFIG = {
  aiModel: "qwen3.5:4b",

  examNameColumn: 2,
  prescriptionDateColumn: 1,
  resultDateColumn: 3,
  valueColumn: 4,
  resultColumn: 5,
  minColumn: 6,
  maxColumn: 7,
  longReportButtonColumn: 11,

  editorWaitMs: 3000,
  commitWaitMs: 550,

  reportChunkChars: 4800,

  // Con Min/Max + unità + metadati il JSON può essere abbastanza lungo.
  // Streaming evita il vecchio problema di timeout; quindi diamo più
  // spazio all'output per non troncare array JSON a metà.
  aiMaxTokens: 2800,
  aiRetryMaxTokens: 4200,

  // Lettura rapida integrato nell'estensione: PaddleOCR.js + ONNX Runtime Web.
  paddleModulePath: "vendor/paddleocr/paddleocr.bundle.js",
  paddleSandboxPath: "paddle_sandbox.html",
  paddleDetModelPath: "vendor/paddleocr/models/PP-OCRv6_tiny_det_onnx_infer.tar",
  paddleRecModelPath: "vendor/paddleocr/models/PP-OCRv6_tiny_rec_onnx_infer.tar",
  paddleWasmPath: "vendor/paddleocr/wasm/",
  paddleOcrMinScore: 0.20,
  imageMaxDimension: 2400,
  pdfTextPageMinChars: 80,
  pdfVisionMaxPages: 20,

  debug: false
};

const PREFERRED_UNITS = {
  CREATININE: "mg/dL",
  FT3: "pmol/L",
  FT4: "pmol/L",
  HBA1C: "mmol/mol",
  CALCIUM_TOTAL: "mg/dL",
  CHOLESTEROL_TOTAL: "mg/dL",
  HDL: "mg/dL",
  LDL: "mg/dL",
  TRIGLYCERIDES: "mg/dL",
  GLUCOSE: "mg/dL",
  VITAMIN_D: "nmol/L",
  IRON: "ug/dL",
  URIC_ACID: "mg/dL",
  UREA: "mg/dL",
  PHOSPHATE: "mg/dL",
  BILIRUBIN_TOTAL: "mg/dL",
  BILIRUBIN_DIRECT: "mg/dL",
  BILIRUBIN_INDIRECT: "mg/dL",
  PCR: "mg/dL"
};

const log = (...args) => {
  if (CONFIG.debug) console.log("[Segretario MMG]", ...args);
};

function isExtensionContextInvalidatedError(error) {
  const message =
    String(error?.message || error || "");

  return (
    error?.code === "EXTENSION_CONTEXT_INVALIDATED" ||
    /extension context invalidated/i.test(message) ||
    /context.*invalid/i.test(message)
  );
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeExamName(text) {
  return String(text ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[()[\].,:;\/\\_\-\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeValueString(value) {
  return String(value ?? "")
    .trim()
    .replace(".", ",");
}

function parseItalianNumber(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/\s/g, "")
    .replace(",", ".");

  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function sameNumericValue(a, b) {
  const x = parseItalianNumber(a);
  const y = parseItalianNumber(b);

  if (x === null || y === null) return false;

  const tolerance = Math.max(
    1e-12,
    Math.abs(x) * 1e-12,
    Math.abs(y) * 1e-12
  );

  return Math.abs(x - y) <= tolerance;
}

function isValidCalendarDateParts(y, mo, d) {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return false;
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d
  );
}

function normalizeDateValue(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (isValidCalendarDateParts(y, mo, d)) {
      return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (isValidCalendarDateParts(y, mo, d)) {
      return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  return "";
}

function formatDateForGrid(value) {
  const iso = normalizeDateValue(value);
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatNumber(number, decimals, trimZeros = false) {
  let result = Number(number)
    .toFixed(decimals)
    .replace(".", ",");

  if (trimZeros) {
    result = result.replace(/,?0+$/, "");
  }

  return result;
}

function getExamConcept(text) {
  const n = normalizeExamName(text);

  if (/FOSFATASI ALCALINA|\bALP\b/.test(n) && /OSSE|OSSO/.test(n)) return "ALP_BONE";
  if (/^U\b|\bURIN|\bU 24H/.test(n)) {
    if (/CALCIO|CALCIUR/.test(n)) return "CALCIUM_URINE";
    if (/FOSFAT[OI]|FOSFORO|FOSFATUR/.test(n)) return "PHOSPHATE_URINE";
  }

  // Creatinine used to calculate ACR is a separate concentration result.
  if (/\bCREATININA\b/.test(n) && !/ALBUMIN|RAPPORTO|CLEARANCE/.test(n) &&
      (/\[\s*U\s*\]/i.test(String(text)) || /^U\b|URIN|\bU 24H\b/.test(n))) return "CREATININE_URINE";

  // Rapporto albumina/creatinina deve essere riconosciuto prima della
  // creatinina urinaria generica.
  if (
    n.includes("MICROALBUMINURIA") ||
    n.includes("RAPPORTO ALB CRE") ||
    /^ALBUMINA[ /]+CREATININA$/.test(n) ||
    n.includes("RAPPORTO ALBUMINA CREATININA") ||
    n.includes("RAPP ALBUMINA CREATININA") ||
    /RAPP(?:ORTO)?\s+U\s+ALBUMINA\s+U\s+CREATININA/.test(n) ||
    /\bRAC\b/.test(n) ||
    /\bACR\b/.test(n)
  ) return "ACR";

  if (n.includes("PEPTIDE NATRIURETICO") || n.includes("NT PROBNP") || n.includes("NTPROBNP") || /\bBNP\b/.test(n)) return "BNP";
  if (/\bUREA\b/.test(n) || n.includes("AZOTEMIA")) return "UREA";
  if (n.includes("ACIDO URICO") || /\bURATO\b/.test(n)) return "URIC_ACID";
  if (/\bSODIO\b/.test(n)) return "SODIUM";
  if (/\bPOTASSIO\b/.test(n)) return "POTASSIUM";
  if (/\bCLORO\b/.test(n) || n.includes("CLORURO")) return "CHLORIDE";
  if (/\bMAGNESIO\b/.test(n)) return "MAGNESIUM";
  if (n.includes("COBALAMINA") || /\bB12\b/.test(n)) return "B12";
  if (n.includes("ACIDO FOLICO") || /\bFOLATO\b/.test(n)) return "FOLATE";
  if (
    n.includes("FOSFATASI ALCALINA") ||
    /\bALP\b/.test(n)
  ) return "ALP";
  if (/\bLDH\b/.test(n) || /\bLAD\b/.test(n) || n.includes("LATTATO DEIDROGENASI")) return "LDH";

  // Catene leggere libere (FLC). Il catalogo CVP/Eumed contiene la grafia
  // storica "LAMBA" per LAMBDA: entrambe devono identificare lo stesso
  // concetto. Il rapporto kappa/lambda va riconosciuto PRIMA delle singole
  // catene, altrimenti verrebbe classificato come kappa.
  if (
    (n.includes("FLC") || n.includes("CATENE LEGGERE LIBERE")) &&
    (
      n.includes("KAPPA LAMBDA") ||
      n.includes("KAPPA LAMBA") ||
      /KAPPA\s*[/:-]\s*LAMB?DA/.test(n)
    )
  ) return "FLC_RATIO";

  if (
    (n.includes("FLC") || n.includes("CATENE LEGGERE LIBERE")) &&
    n.includes("KAPPA")
  ) return "FLC_KAPPA";

  if (
    (n.includes("FLC") || n.includes("CATENE LEGGERE LIBERE")) &&
    (n.includes("LAMBDA") || n.includes("LAMBA"))
  ) return "FLC_LAMBDA";

  if (/\bVES\b/.test(n) || /\bV E S\b/.test(n) || n.includes("VELOCITA DI SEDIMENTAZIONE")) return "VES";
  if (/\bAPTT\b/.test(n) || n.includes("TROMBOPLASTINA PARZIALE")) return "APTT";
  if (/\bPT\b/.test(n) || n.includes("TEMPO DI PROTROMBINA")) return "PT";
  if (/\bINSULINA\b/.test(n)) return "INSULIN";
  if (/\bIGA\b/.test(n) || n.includes("IMMUNOGLOBULINE IGA")) return "IGA";

  if (/\bTSH\b/.test(n) || n.includes("TIREOTROPINA")) {
    return "TSH";
  }

  if (
    /\bFT4\b/.test(n) ||
    (n.includes("TIROXINA") && n.includes("LIBERA")) ||
    (/\bT4\b/.test(n) && n.includes("LIBER"))
  ) {
    return "FT4";
  }

  if (
    /\bFT3\b/.test(n) ||
    (n.includes("TRIIODOTIRONINA") && n.includes("LIBERA")) ||
    (/\bT3\b/.test(n) && n.includes("LIBER"))
  ) {
    return "FT3";
  }

  if (n.includes("CREATININA") && !n.includes("CLEARANCE")) {
    if (
      /\[\s*U\s*\]/i.test(String(text)) ||
    /^U\b/.test(n) ||
      n.includes("URIN") ||
      /\bU 24H\b/.test(n)
    ) {
      return "CREATININE_URINE";
    }

    return "CREATININE";
  }

  if (
    n.includes("HBA1C") ||
    (n.includes("EMOGLOBINA") && n.includes("GLICATA")) ||
    (n.includes("EMOGLOBINA") && n.includes("GLICOSILATA"))
  ) {
    return "HBA1C";
  }

  if (/\bCALCIO\b/.test(n) && !n.includes("IONIZZ")) {
    return "CALCIUM_TOTAL";
  }

  if (n.includes("COLESTEROLO") && n.includes("HDL")) {
    return "HDL";
  }

  if (n.includes("COLESTEROLO") && n.includes("LDL")) {
    return "LDL";
  }

  if (
    n.includes("COLESTEROLO") &&
    (n.includes("TOTALE") || n === "COLESTEROLO")
  ) {
    return "CHOLESTEROL_TOTAL";
  }

  if (n.includes("TRIGLICERID")) {
    return "TRIGLYCERIDES";
  }

  if (
    n.includes("GLUCOSIO") ||
    n.includes("GLICEMIA")
  ) {
    return "GLUCOSE";
  }

  if (
    n.includes("TESTOSTERONE") &&
    n.includes("LIBER")
  ) {
    return "TESTOSTERONE_FREE";
  }

  if (n.includes("TESTOSTERONE")) {
    return "TESTOSTERONE_TOTAL";
  }

  if (
    /\bFSH\b/.test(n) ||
    n.includes("FOLLITROPINA")
  ) {
    return "FSH";
  }

  if (n.includes("FERRITINA")) {
    return "FERRITIN";
  }

  if (
    /\bFERRO\b/.test(n) ||
    n.includes("SIDEREMIA")
  ) {
    return "IRON";
  }

  if (
    n.includes("VITAMINA D") ||
    n.includes("25 OH") ||
    n.includes("25OH")
  ) {
    return "VITAMIN_D";
  }

  if (
    /\bFOSFAT[OI]\b/.test(n) ||
    n.includes("FOSFORO") ||
    n.includes("PHOSPHATE")
  ) {
    return "PHOSPHATE";
  }

  if (
    /\bPTH\b/.test(n) ||
    n.includes("PARATORMONE")
  ) {
    return "PTH";
  }

  if (n.includes("BILIRUBINA")) {
    // Le prestazioni Eumed composte/REFLEX possono contenere nel NOME
    // anche le parole "Diretta ed Indiretta". In quel caso il concetto
    // principale resta la bilirubina TOTALE e va riconosciuto prima
    // delle singole frazioni.
    if (
      n.includes("TOTALE") ||
      n.includes("REFLEX") ||
      n === "BILIRUBINA"
    ) {
      return "BILIRUBIN_TOTAL";
    }

    // "Non coniugata" va controllata prima di "coniugata".
    if (
      n.includes("NON CONIUGATA") ||
      n.includes("INDIRETTA")
    ) {
      return "BILIRUBIN_INDIRECT";
    }

    if (
      n.includes("CONIUGATA") ||
      n.includes("DIRETTA")
    ) {
      return "BILIRUBIN_DIRECT";
    }
  }

  if (
    /\bE2\b/.test(n) ||
    n.includes("ESTRADIOLO") ||
    n.includes("17 BETA ESTRADIOLO")
  ) {
    return "ESTRADIOL";
  }

  if (/\bPCR\b/.test(n) || n.includes("PROTEINA C REATTIVA")) {
    return "PCR";
  }

  if (
    /\bALT\b/.test(n) ||
    /\bGPT\b/.test(n) ||
    n.includes("ALANINA AMINOTRANSFERASI")
  ) {
    return "ALT";
  }

  if (
    /\bAST\b/.test(n) ||
    /\bGOT\b/.test(n) ||
    n.includes("ASPARTATO AMINOTRANSFERASI")
  ) {
    return "AST";
  }

  if (/\bGGT\b/.test(n) || n.includes("GAMMA GLUTAMIL")) {
    return "GGT";
  }

  if (
    /\bCK\b/.test(n) ||
    /\bCPK\b/.test(n) ||
    n.includes("CREATINCHINASI") ||
    n.includes("CREATINA CHINASI")
  ) {
    return "CK";
  }

  if (
    /\bPSA\b/.test(n) ||
    n.includes("ANTIGENE PROSTATICO SPECIFICO")
  ) {
    if (
      n.includes("LIBERO") ||
      n.includes("FREE") ||
      /\bFPSA\b/.test(n) ||
      /\bF PSA\b/.test(n)
    ) {
      return "PSA_FREE";
    }

    return "PSA_TOTAL";
  }

  return null;
}


function getLongReportKind(text) {
  const n = normalizeExamName(text);

  if (
    (
      /\bPSA\b/.test(n) ||
      n.includes("ANTIGENE PROSTATICO SPECIFICO")
    ) &&
    (
      n.includes("REFLEX") ||
      n.includes("RIFLESS")
    )
  ) {
    return "PSA_REFLEX";
  }

  if (
    n.includes("EMOCROMO") ||
    n.includes("EMOCROMOCITOMETRICO")
  ) {
    return "EMOCROMO";
  }

  if (
    (n.includes("URINE") && n.includes("ESAME")) ||
    n.includes("ESAME URINE COMPLETO")
  ) {
    return "URINE";
  }

  // Queste due prestazioni contengono spesso nella descrizione Eumed anche
  // la parola "elettroforesi". Devono essere classificate PRIMA del
  // protidogramma, altrimenti creano un falso secondo candidato.
  if (
    n.includes("TIPIZZAZIONE") &&
    n.includes("COMPONENT") &&
    n.includes("MONOCLONAL")
  ) {
    return "TIPIZZAZIONE_MONOCLONALE";
  }

  if (n.includes("BENCE") && n.includes("JONES")) {
    return "BENCE_JONES";
  }

  if (
    n.includes("PROTIDOGRAM") ||
    (
      n.includes("ELETTROFORESI") &&
      n.includes("PROTEIN") &&
      n.includes("SIERIC")
    )
  ) {
    return "PROTIDOGRAMMA";
  }

  if (
    n.includes("IMMUNOFENOTIPIZZAZIONE LEUCO") ||
    n.includes("IMMUNOFENOTIPIZZAZIONE LINFO") ||
    n.includes("TBNK") ||
    n.includes("TIPIZZAZIONE LINFOCIT")
  ) {
    return "TIPIZZAZIONE_LINFOCITARIA";
  }

  if (
    (
      n.includes("ANTICORPI ANTI ANTIGENI INTRACELLULARI") ||
      n.includes("ANTICORPI ANTI NUCLEO") ||
      /\bANA\b/.test(n)
    ) &&
    !n.includes("SPECIFICI") &&
    !/\bENA\b/.test(n)
  ) {
    return "ANA";
  }

  if (
    n.includes("ANTICORPI ANTI ANTIGENI INTRACELLULARI SPECIFICI") ||
    n.includes("ANTICORPI ANTI ENA") ||
    /\bENA\b/.test(n) ||
    n.includes("CTD SCREENING")
  ) {
    return "ENA";
  }

  return "";
}

function longReportKindLabel(kind) {
  return {
    EMOCROMO: "Emocromo",
    URINE: "Esame urine",
    PROTIDOGRAMMA: "Protidogramma",
    TIPIZZAZIONE_LINFOCITARIA: "Tipizzazione linfocitaria",
    TIPIZZAZIONE_MONOCLONALE: "Tipizzazione componenti monoclonali",
    BENCE_JONES: "Proteinuria di Bence-Jones",
    ANA: "ANA",
    ENA: "ENA",
    PSA_REFLEX: "PSA Reflex"
  }[kind] || kind;
}

const EXAM_ALIASES = {
  "PCR": "PROTEINA C REATTIVA",
  "GGT": "GAMMA GLUTAMIL",
  "GAMMA GT": "GAMMA GLUTAMIL",
  "GAMMAGT": "GAMMA GLUTAMIL",
  "ALT": "ALANINA AMINOTRANSFERASI",
  "GPT": "ALANINA AMINOTRANSFERASI",
  "AST": "ASPARTATO AMINOTRANSFERASI",
  "GOT": "ASPARTATO AMINOTRANSFERASI",
  "TSH": "TIREOTROPINA",
  "FT4": "TIROXINA LIBERA",
  "T4 LIBERO": "TIROXINA LIBERA",
  "T4 LIBERA": "TIROXINA LIBERA",
  "TIROXINA LIBERA FT4": "TIROXINA LIBERA",
  "FT3": "TRIIODOTIRONINA LIBERA",
  "T3 LIBERO": "TRIIODOTIRONINA LIBERA",
  "T3 LIBERA": "TRIIODOTIRONINA LIBERA",
  "CREAT": "CREATININA",
  "CREATININA": "CREATININA",
  "HBA1C": "EMOGLOBINA GLICATA",
  "GLICATA": "EMOGLOBINA GLICATA",
  "CALCIO": "CALCIO",
  "SIDEREMIA": "FERRO",
  "VITAMINA B12": "COBALAMINA",
  "B12": "COBALAMINA",
  "NT PROBNP": "PEPTIDE NATRIURETICO",
  "NTPROBNP": "PEPTIDE NATRIURETICO",
  "BNP": "PEPTIDE NATRIURETICO",
  "MICROALBUMINURIA": "ALBUMINURIA",
  "CEA": "ANTIGENE CARCINOEMBRIONARIO",
  "CA 15 3": "ANTIGENE CARBOIDRATICO 15.3",
  "PSA": "ANTIGENE PROSTATICO SPECIFICO"
};

module.exports = {
  CONFIG,
  EXAM_ALIASES,
  FREQUENT_EXAM_HINT_RULES,
  PREFERRED_UNITS,
  formatDateForGrid,
  formatNumber,
  frequentRuleMatchesExam,
  getExamConcept,
  getLongReportKind,
  isExtensionContextInvalidatedError,
  log,
  longReportKindLabel,
  normalizeDateValue,
  normalizeExamName,
  normalizeValueString,
  parseItalianNumber,
  sameNumericValue,
  sleep,
};
