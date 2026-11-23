(() => {
  "use strict";

  // ============================================================
  // SEGRETARIO MMG
  // Versione 0.16.29
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

  // Configurazione, normalizzazione nomi esame, concetti clinici e utilità comuni.

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

  // Catalogo laboratorio locale, specimen, unità di misura e conversioni.


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

  // Referti lunghi (emocromo, urine, protidogramma, ...): riconoscimento e testo.


  function normalizeLongReportText(text) {
    return String(text ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function normalizeUnit(unit) {
    return String(unit ?? "")
      .toLowerCase()
      .replace(/µ/g, "u")
      .replace(/μ/g, "u")
      .replace(/\s+/g, "")
      // OCR frequente: la "l" finale viene letta come I, | o 1.
      .replace(/\/i$/i, "/l")
      .replace(/\/\|$/i, "/l")
      .replace(/\/1$/i, "/l")
      .replace(/^mmoul$/i, "mmol/l")
      .replace(/^mmol\/i$/i, "mmol/l")
      .replace(/^mmol\/\|$/i, "mmol/l")
      .replace(/^mmo1\/l$/i, "mmol/l")
      .replace(/^mg\/di$/i, "mg/dl")
      .replace(/^mg\/d1$/i, "mg/dl")
      .replace(/^ng\/mi$/i, "ng/ml")
      .replace(/^u\/i$/i, "u/l")
      .replace(/^ui\/i$/i, "ui/l")
      .replace("litre", "l")
      .replace("liter", "l")
      .replace(/\.$/, "")
      .replace(/^mg\/gcrea(?:t(?:inina)?)?$/, "mg/g");
  }

  function convertMeasurement(concept, value, unit) {
    const originalValue = normalizeValueString(value);
    const originalUnit = String(unit ?? "").trim();
    const n = parseItalianNumber(originalValue);

    if (n === null) {
      return {
        ok: false,
        reason: "Valore numerico non interpretabile"
      };
    }

    const u = normalizeUnit(originalUnit);

    // Nessuna unità preferenziale: nessuna conversione.
    if (!PREFERRED_UNITS[concept]) {
      return {
        ok: true,
        value: originalValue,
        unit: originalUnit,
        originalValue,
        originalUnit,
        converted: false,
        concept
      };
    }

    if (!u) {
      return {
        ok: false,
        reason: `Unità non rilevata per ${concept}`,
        concept
      };
    }

    if (concept === "CREATININE") {
      if (u === "mg/dl") {
        return {
          ok: true, value: originalValue, unit: "mg/dL",
          originalValue, originalUnit, converted: false, concept
        };
      }

      if (u === "umol/l") {
        return {
          ok: true, value: formatNumber(n / 88.4, 2), unit: "mg/dL",
          originalValue, originalUnit, converted: true, concept
        };
      }

      if (u === "mg/l") {
        return {
          ok: true, value: formatNumber(n / 10, 2), unit: "mg/dL",
          originalValue, originalUnit, converted: true, concept
        };
      }

      return {
        ok: false,
        reason: `Unità creatinina non gestita: ${originalUnit}`,
        concept
      };
    }

    if (concept === "FT4") {
      if (u === "pmol/l") {
        return {
          ok: true, value: originalValue, unit: "pmol/L",
          originalValue, originalUnit, converted: false, concept
        };
      }

      if (u === "ng/dl") {
        return {
          ok: true, value: formatNumber(n * 12.87, 2), unit: "pmol/L",
          originalValue, originalUnit, converted: true, concept
        };
      }

      if (u === "ng/l" || u === "pg/ml") {
        // 1 pg/mL = 1 ng/L.
        return {
          ok: true, value: formatNumber(n * 1.287, 2), unit: "pmol/L",
          originalValue, originalUnit, converted: true, concept
        };
      }

      return {
        ok: false,
        reason: `Unità FT4 non gestita: ${originalUnit}`,
        concept
      };
    }

    if (concept === "FT3") {
      if (u === "pmol/l") {
        return {
          ok: true, value: originalValue, unit: "pmol/L",
          originalValue, originalUnit, converted: false, concept
        };
      }

      if (u === "pg/ml" || u === "ng/l") {
        return {
          ok: true, value: formatNumber(n * 1.536, 2), unit: "pmol/L",
          originalValue, originalUnit, converted: true, concept
        };
      }

      return {
        ok: false,
        reason: `Unità FT3 non gestita: ${originalUnit}`,
        concept
      };
    }

    if (concept === "HBA1C") {
      if (u.includes("mmol/mol")) {
        return {
          ok: true, value: originalValue, unit: "mmol/mol",
          originalValue, originalUnit, converted: false, concept
        };
      }

      if (u === "%" || u.includes("percent")) {
        return {
          ok: true,
          value: formatNumber((n - 2.15) * 10.929, 0),
          unit: "mmol/mol",
          originalValue,
          originalUnit,
          converted: true,
          concept
        };
      }

      return {
        ok: false,
        reason: `Unità HbA1c non gestita: ${originalUnit}`,
        concept
      };
    }

    if (concept === "GLUCOSE") {
      if (u === "mg/dl") return {ok:true,value:originalValue,unit:"mg/dL",originalValue,originalUnit,converted:false,concept};
      if (u === "mmol/l") return {ok:true,value:formatNumber(n * 18.0182, 0),unit:"mg/dL",originalValue,originalUnit,converted:true,concept};
      return {ok:false,reason:`Unità glucosio non gestita: ${originalUnit}`,concept};
    }

    if (concept === "VITAMIN_D") {
      if (u === "nmol/l") {
        return {
          ok: true,
          value: originalValue,
          unit: "nmol/L",
          originalValue,
          originalUnit,
          converted: false,
          concept
        };
      }

      // 1 µg/L = 1 ng/mL.
      // Per 25-OH vitamina D: ng/mL × 2,5 = nmol/L.
      if (u === "ng/ml" || u === "ug/l") {
        return {
          ok: true,
          value: formatNumber(n * 2.5, 1),
          unit: "nmol/L",
          originalValue,
          originalUnit,
          converted: true,
          concept
        };
      }

      return {
        ok: false,
        reason: `Unità vitamina D non gestita: ${originalUnit}`,
        concept
      };
    }

    if (concept === "IRON") {
      if (u === "ug/dl") return {ok:true,value:originalValue,unit:"ug/dL",originalValue,originalUnit,converted:false,concept};
      if (u === "umol/l") return {ok:true,value:formatNumber(n * 5.5845, 0),unit:"ug/dL",originalValue,originalUnit,converted:true,concept};
      return {ok:false,reason:`Unità ferro non gestita: ${originalUnit}`,concept};
    }

    if (concept === "URIC_ACID") {
      if (u === "mg/dl") return {ok:true,value:originalValue,unit:"mg/dL",originalValue,originalUnit,converted:false,concept};
      if (u === "umol/l") return {ok:true,value:formatNumber(n / 59.48, 2),unit:"mg/dL",originalValue,originalUnit,converted:true,concept};
      if (u === "mmol/l") return {ok:true,value:formatNumber(n * 16.807, 2),unit:"mg/dL",originalValue,originalUnit,converted:true,concept};
      return {ok:false,reason:`Unità acido urico non gestita: ${originalUnit}`,concept};
    }

    if (concept === "UREA") {
      if (u === "mg/dl") return {ok:true,value:originalValue,unit:"mg/dL",originalValue,originalUnit,converted:false,concept};
      if (u === "mmol/l") return {ok:true,value:formatNumber(n * 6.006, 1),unit:"mg/dL",originalValue,originalUnit,converted:true,concept};
      return {ok:false,reason:`Unità urea non gestita: ${originalUnit}`,concept};
    }

    if (concept === "PHOSPHATE") {
      if (u === "mg/dl") return {ok:true,value:originalValue,unit:"mg/dL",originalValue,originalUnit,converted:false,concept};
      if (u === "mmol/l") return {ok:true,value:formatNumber(n * 3.095, 2),unit:"mg/dL",originalValue,originalUnit,converted:true,concept};
      return {ok:false,reason:`Unità fosfato non gestita: ${originalUnit}`,concept};
    }

    if (["BILIRUBIN_TOTAL", "BILIRUBIN_DIRECT", "BILIRUBIN_INDIRECT"].includes(concept)) {
      if (u === "mg/dl") return {ok:true,value:originalValue,unit:"mg/dL",originalValue,originalUnit,converted:false,concept};
      if (u === "umol/l") return {ok:true,value:formatNumber(n / 17.104, 2),unit:"mg/dL",originalValue,originalUnit,converted:true,concept};
      return {ok:false,reason:`Unità bilirubina non gestita: ${originalUnit}`,concept};
    }

    if (concept === "PCR") {
      if (u === "mg/dl") return {ok:true,value:originalValue,unit:"mg/dL",originalValue,originalUnit,converted:false,concept};
      if (u === "mg/l") return {ok:true,value:formatNumber(n / 10, 2, true),unit:"mg/dL",originalValue,originalUnit,converted:true,concept};
      return {ok:false,reason:`Unità PCR non gestita: ${originalUnit}`,concept};
    }

    if (concept === "CALCIUM_TOTAL") {
      if (u === "mg/dl") {
        return {
          ok: true, value: originalValue, unit: "mg/dL",
          originalValue, originalUnit, converted: false, concept
        };
      }

      if (u === "mmol/l") {
        return {
          ok: true, value: formatNumber(n * 4.008, 2), unit: "mg/dL",
          originalValue, originalUnit, converted: true, concept
        };
      }

      if (u === "mg/l") {
        return {
          ok: true, value: formatNumber(n / 10, 2), unit: "mg/dL",
          originalValue, originalUnit, converted: true, concept
        };
      }

      return {
        ok: false,
        reason: `Unità calcio non gestita: ${originalUnit}`,
        concept
      };
    }

    if (["CHOLESTEROL_TOTAL", "HDL", "LDL"].includes(concept)) {
      if (u === "mg/dl") {
        return {
          ok: true, value: originalValue, unit: "mg/dL",
          originalValue, originalUnit, converted: false, concept
        };
      }

      if (u === "mmol/l") {
        return {
          ok: true, value: formatNumber(n * 38.67, 0), unit: "mg/dL",
          originalValue, originalUnit, converted: true, concept
        };
      }

      return {
        ok: false,
        reason: `Unità lipidi non gestita: ${originalUnit}`,
        concept
      };
    }

    if (concept === "TRIGLYCERIDES") {
      if (u === "mg/dl") {
        return {
          ok: true, value: originalValue, unit: "mg/dL",
          originalValue, originalUnit, converted: false, concept
        };
      }

      if (u === "mmol/l") {
        return {
          ok: true, value: formatNumber(n * 88.57, 0), unit: "mg/dL",
          originalValue, originalUnit, converted: true, concept
        };
      }

      return {
        ok: false,
        reason: `Unità trigliceridi non gestita: ${originalUnit}`,
        concept
      };
    }

    return {
      ok: true,
      value: originalValue,
      unit: originalUnit,
      originalValue,
      originalUnit,
      converted: false,
      concept
    };
  }

  function unitsCompatible(a, b) {
    const ua = normalizeUnit(a);
    const ub = normalizeUnit(b);

    if (!ua || !ub) return true;
    return ua === ub;
  }

  function parseBilateralRangeText(text, fallbackUnit = "") {
    const source = String(text ?? "")
      .replace(/\u00a0/g, " ")
      .trim();

    if (!source) return null;

    // Accetta 3,0 - 5,2 / 3.0–5.2 e unità opzionale.
    const match = source.match(
      /([+-]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|a)\s*([+-]?\d+(?:[.,]\d+)?)\s*(mg\s*\/\s*dL|mmol\s*\/\s*L|umol\s*\/\s*L|µmol\s*\/\s*L|μmol\s*\/\s*L|pmol\s*\/\s*L|ng\s*\/\s*dL|ng\s*\/\s*L|pg\s*\/\s*mL|mmol\s*\/\s*mol|%)?/i
    );

    if (!match) return null;

    return {
      min: match[1],
      max: match[2],
      unit: String(match[3] || fallbackUnit || "").replace(/\s+/g, "")
    };
  }

  function prepareRangeInput(item, resultUnit) {
    if (item?._rangeRejected) return {min:"",max:"",unit:""};
    let min = String(item?.ref_min ?? "").trim();
    let max = String(item?.ref_max ?? "").trim();
    let unit = String(item?.ref_unit ?? "").trim();

    if (!min || !max) {
      const parsed =
        parseBilateralRangeText(item?.reference_text, resultUnit) ||
        parseBilateralRangeText(item?.evidence, resultUnit);

      if (parsed) {
        min = min || parsed.min;
        max = max || parsed.max;
        unit = unit || parsed.unit;
      }
    }

    // Molti referti riportano l'unità una sola volta accanto al risultato.
    // In quel caso Min/Max sono nella stessa unità del risultato.
    if ((min || max) && !unit) unit = resultUnit;

    return { min, max, unit };
  }

  function shouldSuppressAutomaticRange(concept) {
    return new Set([
      "ALP_BONE",
      "FERRITIN",
      "FSH",
      "ESTRADIOL",
      "TESTOSTERONE_FREE",
      "TESTOSTERONE_TOTAL",
      "VITAMIN_D",
      "HBA1C"
    ]).has(concept);
  }

  function convertRange(concept, refMin, refMax, refUnit, resultUnit) {
    if (shouldSuppressAutomaticRange(concept)) {
      return {
        ok: true,
        available: false,
        reason: "Intervallo contestuale/multiplo: Min/Max non compilati automaticamente"
      };
    }

    const minText = String(refMin ?? "").trim();
    const maxText = String(refMax ?? "").trim();

    // Compiliamo Min/Max solo se entrambi sono presenti.
    if (!minText && !maxText) {
      return {
        ok: true,
        available: false,
        reason: "Intervallo non bilaterale o non completo"
      };
    }

    if (
      (minText && !/^[+-]?\d+(?:[.,]\d+)?$/.test(minText)) ||
      (maxText && !/^[+-]?\d+(?:[.,]\d+)?$/.test(maxText))
    ) {
      return {
        ok: true,
        available: false,
        reason: "Intervallo non numerico semplice"
      };
    }

    const effectiveUnit = String(refUnit || resultUnit || "").trim();

    if (!unitsCompatible(effectiveUnit, resultUnit)) {
      // Se il concetto ha conversione nota, convertMeasurement gestirà
      // comunque l'unità del range. Per gli altri esami evitiamo di
      // inserire range con unità diversa dal risultato.
      if (!PREFERRED_UNITS[concept]) {
        return {
          ok: true,
          available: false,
          reason: `Unità intervallo (${effectiveUnit}) diversa dal risultato (${resultUnit})`
        };
      }
    }

    const minConverted = minText ? convertMeasurement(concept, minText, effectiveUnit) : {ok:true,value:"",unit:effectiveUnit,converted:false};
    const maxConverted = maxText ? convertMeasurement(concept, maxText, effectiveUnit) : {ok:true,value:"",unit:effectiveUnit,converted:false};

    if (!minConverted.ok || !maxConverted.ok) {
      return {
        ok: true,
        available: false,
        reason:
          minConverted.reason ||
          maxConverted.reason ||
          "Intervallo non convertibile"
      };
    }

    return {
      ok: true,
      available: true,
      min: minConverted.value,
      max: maxConverted.value,
      unit: minConverted.unit || effectiveUnit,
      originalMin: minText,
      originalMax: maxText,
      originalUnit: effectiveUnit,
      converted: minConverted.converted || maxConverted.converted
    };
  }

  // Split per righe con piccola sovrapposizione tra blocchi
  // per evitare di separare esame e intervallo di riferimento.
  function splitReportText(text, maxChars = CONFIG.reportChunkChars) {
    const lines = String(text)
      .replace(/\r/g, "")
      .split("\n");

    const chunks = [];
    let currentLines = [];

    function currentLength(linesToMeasure) {
      return linesToMeasure.join("\n").length;
    }

    function flush() {
      if (!currentLines.length) return;

      const clean = currentLines.join("\n").trim();
      if (clean) chunks.push(clean);

      // Mantiene le ultime 2 righe come contesto per il blocco successivo.
      currentLines = currentLines.slice(-2);
    }

    for (const line of lines) {
      const candidate = [...currentLines, line];

      if (currentLength(candidate) > maxChars && currentLines.length) {
        flush();
      }

      // Riga singola molto lunga: taglio controllato.
      if (line.length > maxChars) {
        if (currentLines.length > 2) flush();

        for (let i = 0; i < line.length; i += maxChars) {
          chunks.push(line.slice(i, i + maxChars));
        }

        currentLines = [];
        continue;
      }

      currentLines.push(line);
    }

    const tail = currentLines.join("\n").trim();
    if (tail) chunks.push(tail);

    return chunks.length ? chunks : [String(text)];
  }

  // Parser deterministici dei referti, prompt/schema IA e validazione dei risultati.


  // ============================================================
  // Structured output compatto + split adattivo (v0.8.5)
  // ============================================================

  const LAB_SCHEMA = {
    type: "object",
    properties: {
      d: { type: "string" },
      de: { type: "string" },
      r: {
        type: "array",
        items: {
          type: "array",
          prefixItems: [
            { type: "string" },
            { type: "string" },
            { type: "string" },
            { type: "string" },
            { type: "string" },
            { type: "string" },
            { type: "string" }
          ],
          minItems: 7,
          maxItems: 7
        }
      },
      l: {
        type: "array",
        items: {
          type: "array",
          prefixItems: [
            {
              type: "string",
              enum: [
                "EMOCROMO",
                "URINE",
                "PROTIDOGRAMMA",
                "TIPIZZAZIONE_LINFOCITARIA",
                "TIPIZZAZIONE_MONOCLONALE",
                "BENCE_JONES"
              ]
            },
            { type: "string" },
            { type: "integer", minimum: 1 },
            { type: "integer", minimum: 1 }
          ],
          minItems: 4,
          maxItems: 4
        }
      },
      u: {
        type: "array",
        items: {
          type: "array",
          prefixItems: [
            { type: "string" },
            { type: "string" }
          ],
          minItems: 2,
          maxItems: 2
        }
      }
    },
    required: ["d", "de", "r", "l", "u"]
  };

  function expandCompactLabPayload(parsed) {
    const p = parsed && typeof parsed === "object" ? parsed : {};

    return {
      report_date: String(p.d ?? ""),
      report_date_evidence: String(p.de ?? ""),

      results: Array.isArray(p.r)
        ? p.r.map(row => ({
            exam: String(row?.[0] ?? ""),
            value: String(row?.[1] ?? ""),
            unit: String(row?.[2] ?? ""),
            ref_min: String(row?.[3] ?? ""),
            ref_max: String(row?.[4] ?? ""),
            ref_unit: String(row?.[5] ?? ""),
            raw_label: String(row?.[6] ?? "")
          }))
        : [],

      long_reports: Array.isArray(p.l)
        ? p.l.map(row => ({
            kind: String(row?.[0] ?? ""),
            exam: String(row?.[1] ?? ""),
            line_start: Number(row?.[2]),
            line_end: Number(row?.[3])
          }))
        : [],

      uncertain: Array.isArray(p.u)
        ? p.u.map(row => ({
            text: String(row?.[0] ?? ""),
            reason: String(row?.[1] ?? "")
          }))
        : []
    };
  }

  function extractJSONObject(text) {
    const clean = String(text ?? "")
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("IA non ha restituito JSON completo.");
    }

    return JSON.parse(clean.slice(start, end + 1));
  }

  function attachOriginalLongReportText(parsed, sourceLines) {
    const safeLines = Array.isArray(sourceLines) ? sourceLines : [];

    parsed.long_reports = (parsed.long_reports || []).map(item => {
      const start = Number(item?.line_start);
      const end = Number(item?.line_end);

      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start ||
        end > safeLines.length
      ) {
        return {
          ...item,
          text: "",
          invalid_range: true
        };
      }

      return {
        ...item,
        text: safeLines.slice(start - 1, end).join("\n").trim(),
        invalid_range: false
      };
    });

    return parsed;
  }

  function mergeAdaptivePayloads(payloads) {
    const merged = {
      report_date: "",
      report_date_evidence: "",
      results: [],
      long_reports: [],
      uncertain: []
    };

    const dates = [];

    for (const payload of payloads) {
      if (!payload) continue;

      merged.results.push(...(payload.results || []));
      merged.long_reports.push(...(payload.long_reports || []));
      merged.uncertain.push(...(payload.uncertain || []));

      const date = String(payload.report_date || "").trim();
      if (date) {
        dates.push({
          date,
          evidence: String(payload.report_date_evidence || "").trim()
        });
      }
    }

    const uniqueDates = [...new Set(dates.map(x => x.date))];

    if (uniqueDates.length === 1) {
      merged.report_date = uniqueDates[0];
      merged.report_date_evidence =
        dates.find(x => x.date === uniqueDates[0])?.evidence || "";
    } else if (uniqueDates.length > 1) {
      const parsedDates = uniqueDates
        .map(value => ({
          value,
          time: Date.parse(`${value}T00:00:00`)
        }))
        .filter(x => Number.isFinite(x.time))
        .sort((a, b) => a.time - b.time);

      const first = parsedDates[0];
      const last = parsedDates[parsedDates.length - 1];
      const spreadDays =
        first && last
          ? Math.round((last.time - first.time) / 86400000)
          : 0;

      // Nei referti scannerizzati sono frequenti date storiche / risultati
      // precedenti. Se le date candidate sono molto lontane (> 90 giorni),
      // assumiamo come data del referto corrente la più recente.
      // Date ravvicinate restano invece ambigue.
      if (
        parsedDates.length === uniqueDates.length &&
        spreadDays > 90
      ) {
        merged.report_date = last.value;
        merged.report_date_evidence =
          dates.find(x => x.date === last.value)?.evidence || "";

        log(
          "Date OCR discordanti: scelta la più recente come data referto corrente.",
          uniqueDates,
          "->",
          last.value
        );
      } else {
        merged.uncertain.push({
          text: "Data del referto",
          reason:
            "Sottoblocchi con date di refertazione discordanti: " +
            uniqueDates.join(", ")
        });
      }
    }

    return merged;
  }

  function splitTextAdaptive(text) {
    const lines = String(text ?? "").replace(/\r/g, "").split("\n");

    if (lines.length <= 1) {
      const s = String(text ?? "");
      const mid = Math.max(1, Math.floor(s.length / 2));
      return [s.slice(0, mid), s.slice(mid)];
    }

    const mid = Math.max(1, Math.floor(lines.length / 2));

    // Una riga di sovrapposizione aiuta quando un'intestazione cade
    // esattamente sul confine. La deduplicazione successiva la assorbe.
    const left = lines.slice(0, Math.min(lines.length, mid + 1)).join("\n");
    const right = lines.slice(Math.max(0, mid - 1)).join("\n");

    return [left, right];
  }

  async function ollamaChat(
    messages,
    onProgress = null,
    numPredict = CONFIG.aiMaxTokens,
    formatSchema = null
  ) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await ollamaChatOnce(
          messages,
          onProgress,
          numPredict,
          formatSchema
        );
      } catch (error) {
        lastError = error;

        // Un contesto invalidato non può essere recuperato dal vecchio
        // content script: serve ricaricare Eumed. Non fare retry inutile.
        if (
          isExtensionContextInvalidatedError(error)
        ) {
          throw error;
        }

        const transient =
          /connessione interna all'estensione interrotta/i.test(
            String(error?.message || error)
          );

        if (!transient || attempt > 0) {
          throw error;
        }

        await sleep(450);
      }
    }

    throw lastError ||
      new Error("Errore IA/Ollama.");
  }

  function buildLabSystemPrompt() {
    return `
Sei un estrattore locale di dati di laboratorio per un medico.

NON fare diagnosi.
NON dare consigli clinici.
NON inventare dati.
NON convertire unità.

Restituisci ESCLUSIVAMENTE lo structured output richiesto.
Il formato è compatto:
- d = data di refertazione/validazione/firma/emissione in YYYY-MM-DD, oppure ""
- de = brevissima evidenza della data, oppure ""
- r = risultati singoli: [exam,value,unit,ref_min,ref_max,ref_unit,raw_label]
- l = referti lunghi: [kind,exam,line_start,line_end]
- u = dati incerti: [text,reason]

DATA DEL REFERTO:
Usa SOLO una data esplicitamente associata a referto, refertazione, validazione,
firma o emissione. Non usare prelievo, raccolta, accettazione, prescrizione o richiesta.

REFERTI LUNGHI:
I seguenti gruppi NON devono essere scomposti in risultati singoli:
- EMOCROMO: emocromo/formula, WBC, RBC, Hb/Hgb, Hct, PLT, MCV, MCH, MCHC,
  RDW, MPV, neutrofili, linfociti, monociti, eosinofili, basofili e assoluti.
- URINE: esame urine completo, pH, densità/peso specifico, glucosio urinario,
  proteine/albumina del test urine, emoglobina, chetoni, urobilinogeno,
  nitriti, esterasi leucocitaria, sedimento.
  NON inglobare microalbuminuria/ACR o creatinina urinaria autonome.
- PROTIDOGRAMMA: elettroforesi/protidogramma e frazioni albumina, alfa, beta,
  gamma, rapporto A/G.
- TIPIZZAZIONE_LINFOCITARIA: immunofenotipizzazione/tipizzazione T/B/NK,
  CD3, CD4, CD8, CD19, CD16/CD56 e rapporti correlati.
- TIPIZZAZIONE_MONOCLONALE: tipizzazione/immunosottrazione/immunofissazione
  delle componenti monoclonali, con eventuale commento qualitativo.
- BENCE_JONES: ricerca della proteinuria di Bence-Jones e relativo esito
  qualitativo/commento (incluse catene leggere monoclonali urinarie).

Per un referto lungo usa UNA sola voce l per gruppo presente nel blocco.
Il testo ricevuto è numerato [L1], [L2], ...; line_start/line_end devono indicare
la prima e ultima riga appartenenti al gruppo. NON trascrivere il testo del gruppo.
NON duplicare i suoi componenti in r.

RISULTATI SINGOLI:
- soltanto risultato corrente numerico semplice;
- non confondere risultato con range, data, età o valore storico;
- ref_min/ref_max per intervallo bilaterale chiaro; per un unico limite <x o >x compila solo max o min, lasciando vuoto l altro estremo;
- per fasce multiple o range condizionali lascia min/max vuoti;
- conserva fedelmente valore e unità originali;
- non inserire POSITIVO/NEGATIVO/ASSENTE/PRESENTE come risultato numerico;
- se incerto usa u invece di indovinare.

ARRAY u (INCERTI):
- usa u SOLO se nel BLOCCO è realmente presente un dato o una riga ambigua;
- NON elencare esami della Grid che non compaiono nel blocco;
- NON scrivere mai "Non presente nel testo fornito";
- NON inserire in u note generiche sui valori di riferimento;
- NON inserire in u componenti di EMOCROMO/URINE/PROTIDOGRAMMA/TIPIZZAZIONE
  LINFOCITARIA/TIPIZZAZIONE MONOCLONALE/BENCE-JONES se il gruppo è già stato
  classificato come referto lungo;
- NON interpretare clinicamente i reperti qualitativi dell'esame urine:
  fanno parte del referto lungo URINE.

MATRICE BIOLOGICA:
- il prefisso s-/si-/p- indica sangue/siero/plasma;
- il prefisso u- e le righe interne a ESAME URINE appartengono alle urine;
- NON usare mai Glucosio/Bilirubina/Albumina/Emoglobina dell'esame urine per
  compilare omonime prestazioni sieriche/plasmatiche.

ESAMI FREQUENTI:
- nella richiesta utente riceverai una lista "ESAMI FREQUENTI PRIORITARI";
- se il laboratorio usa un sinonimo/abbreviazione chiaramente equivalente,
  restituisci il nome canonico di quella lista;
- non inventare equivalenze e non scegliere un esame prioritario se matrice,
  metodo (es. diretto/indiretto) o REFLEX non sono compatibili.

REGOLE OCR / SCANSIONI:
- non riutilizzare mai il valore numerico di una riga per un esame diverso;
- ogni risultato deve essere associato all'etichetta presente nella stessa riga
  o nello stesso blocco visivo;
- se leggi FOSFATO/FOSFORO non trasformarlo in BILIRUBINA anche se il valore
  numerico potrebbe essere plausibile;
- date di risultati precedenti/storici NON sono date di refertazione;
- per la data referto usa solo data esplicitamente associata a referto,
  validazione, firma o emissione.

RICERCA EUMED-FIRST:
- la lista ricevuta contiene gli accertamenti vuoti di Eumed da cercare;
- considera OGNI target separatamente, anche se un altro lettore/parsing potrebbe averlo già trovato;
- se il target è presente, restituisci soltanto il risultato supportato dal testo del referto;
- se il target non è presente, non inventarlo e non aggiungere una voce "non trovato";
- il valore deve provenire dalla stessa riga/blocco dell'etichetta sorgente;
- per una prestazione composta come BILIRUBINA REFLEX, il risultato numerico principale è la bilirubina TOTALE; diretta/coniugata e indiretta/non coniugata sono componenti, non valori concorrenti della totale.

REGOLE CATALOGO / PRESTAZIONI:
- "BILIRUBINA TOTALE" può corrispondere alla prestazione "BILIRUBINA REFLEX";
  la bilirubina diretta/indiretta è inclusa nella prestazione reflex e NON va
  duplicata come secondo risultato se la Grid contiene la voce REFLEX.
- SIDEREMIA = FERRO [S].
- "TSH 3° Generazione Riflesso" = TIREOTROPINA [TSH] TEST REFLEX.
- "ORMONE FOLLICOLOSTIMOLANTE (FSH)" = FOLLITROPINA (FSH).
- "17 BETA ESTRADIOLO" = ESTRADIOLO (E2).
- Per ferritina, vitamina D, FSH, estradiolo e testosterone i range possono
  dipendere da categorie/fase/sesso/età: non inventare un unico ref_min/ref_max.
`;
  }

  async function extractReportChunkOnce(
    reportText,
    availableExams,
    chunkIndex,
    totalChunks,
    progressCallback = null,
    numPredict = CONFIG.aiMaxTokens
  ) {
    const priorityHints =
      getFrequentExamPriorityHints(availableExams);

    const priorityExamList = priorityHints.length
      ? priorityHints
          .map((x, i) =>
            `${i + 1}. ${x.exam}${x.code ? ` [catalogo ${x.code}]` : ""}`
          )
          .join("\n")
      : "(nessuno degli esami prioritari è presente in Eumed)";

    const examList = availableExams
      .map((x, i) => `${i + 1}. ${x}`)
      .join("\n");

    const sourceLines = String(reportText ?? "")
      .replace(/\r/g, "")
      .split("\n");

    const numberedReportText = sourceLines
      .map((line, i) => `[L${i + 1}] ${line}`)
      .join("\n");

    const userPrompt = `
ESAMI FREQUENTI PRIORITARI PRESENTI IN EUMED
(nomi canonici da preferire quando una dicitura del laboratorio è equivalente):

${priorityExamList}

REGOLE PER I CANDIDATI PRIORITARI:
- se una dicitura del laboratorio è chiaramente equivalente a uno di questi esami,
  usa ESATTAMENTE il nome canonico mostrato sopra;
- non forzare un candidato solo perché è frequente;
- rispetta sempre matrice biologica, REFLEX/non REFLEX, diretto/indiretto e unità;
- se nessun candidato prioritario è semanticamente corretto, usa l'elenco completo di Eumed
  o lascia il dato incerto.

ESAMI ATTUALMENTE PRESENTI IN EUMED:

${examList}

==============================
BLOCCO ${chunkIndex}/${totalChunks}
DEL REFERTO
==============================

${numberedReportText}
`;

    const content = await ollamaChat(
      [
        { role: "system", content: buildLabSystemPrompt() },
        { role: "user", content: userPrompt }
      ],
      progressCallback,
      numPredict,
      LAB_SCHEMA
    );

    const parsed = expandCompactLabPayload(extractJSONObject(content));

    return attachOriginalLongReportText(parsed, sourceLines);
  }

  async function extractReportChunkAdaptive(
    reportText,
    availableExams,
    chunkIndex,
    totalChunks,
    progressCallback = null,
    depth = 0
  ) {
    try {
      return await extractReportChunkOnce(
        reportText,
        availableExams,
        chunkIndex,
        totalChunks,
        progressCallback,
        depth === 0 ? CONFIG.aiMaxTokens : CONFIG.aiRetryMaxTokens
      );

    } catch (error) {
      const text = String(reportText ?? "").trim();

      log(
        `Blocco ${chunkIndex}/${totalChunks} non valido a profondità ${depth}; ` +
        "split adattivo.",
        error?.message || error
      );

      if (
        depth >= CONFIG.adaptiveMaxDepth ||
        text.length <= CONFIG.adaptiveMinChunkChars
      ) {
        throw new Error(
          `IA non ha prodotto structured output valido anche dopo split adattivo ` +
          `(profondità ${depth}). ${error?.message || error}`
        );
      }

      const [left, right] = splitTextAdaptive(text);

      if (!left.trim() || !right.trim() || left === text || right === text) {
        throw error;
      }

      progressCallback?.({
        phase: "adaptive_split",
        current: chunkIndex,
        total: totalChunks,
        depth: depth + 1
      });

      const leftParsed = await extractReportChunkAdaptive(
        left,
        availableExams,
        chunkIndex,
        totalChunks,
        progressCallback,
        depth + 1
      );

      const rightParsed = await extractReportChunkAdaptive(
        right,
        availableExams,
        chunkIndex,
        totalChunks,
        progressCallback,
        depth + 1
      );

      return mergeAdaptivePayloads([leftParsed, rightParsed]);
    }
  }

  async function extractReportChunk(
    reportText,
    availableExams,
    chunkIndex,
    totalChunks,
    progressCallback = null
  ) {
    return extractReportChunkAdaptive(
      reportText,
      availableExams,
      chunkIndex,
      totalChunks,
      progressCallback,
      0
    );
  }



  // v0.15.15 - Qwen come resolver semantico VINCOLATO ai target Eumed.
  // Nei residui Qwen non restituisce più un nome esame libero: sceglie un ID
  // T1..Tn che il codice riconverte nella voce Eumed esatta. Questo evita
  // falsi rifiuti per sinonimi/abbreviazioni (es. LAD -> LDH, LAMBDA -> LAMBA).
  function sourceLabelForAiRow(item, sourceText) {
    // The source row owns its label. A model may propose a target, never rename this evidence.
    const line = String(sourceText || '').replace(/\r/g, '').split('\n')[Number(item.line_start) - 1];
    if (!line || !Number.isInteger(Number(item.line_start))) return String(item.raw_label || '');
    const escapedUnit = String(item.unit || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escapedUnit) return String(item.raw_label || '');
    const match = line.match(new RegExp('^(.+?)\\s+([<>≤≥]?\\s*[+-]?\\d+(?:[.,]\\d+)?)\\s*\\*?\\s*' + escapedUnit + '(?:\\s|$)', 'i'));
    const canonical = value => String(value || '').replace(/\s/g,'').replace(',','.');
    return match && canonical(match[2]) === canonical(item.value) ? match[1].trim() : String(item.raw_label || '');
  }

  function validateAiMeasurementEvidence(item, sourceText) {
    // Stage 1: reconstruct immutable evidence independently of the proposed target.
    const lines = String(sourceText || '').replace(/\r/g, '').split('\n');
    const label = sourceLabelForAiRow(item, sourceText).trim();
    const key = normalizeExamName(label);
    if (!key) return null;
    const starts = lines.map((line, index) => normalizeExamName(line).includes(key) ? index : -1).filter(i => i >= 0);
    const candidates = [];
    for (const start of starts) {
      if (item.line_start != null && Number(item.line_start) !== start + 1) continue;
      let end = start;
      // Continuations may contain units/numbers, never another named examination.
      while (end + 1 < lines.length && end < start + 3 && /^\s*(?:[<>≤≥+\-\d.,*\s]+|(?:mg|g|ng|pg|ug|µg|μg|mmol|umol|µmol|pmol|nmol|U|UI|mUI|mIU)\s*\/\s*(?:L|dL|mL)(?:\s+[\d.,<>≤≥*\s-]+)?)\s*$/i.test(lines[end + 1])) end++;
      if (item.line_end != null && (Number(item.line_end) < start + 1 || Number(item.line_end) > end + 1)) continue;
      if (item.line_end != null) end = Number(item.line_end) - 1;
      const quote = lines.slice(start, end + 1).join('\n');
      if (item.quote != null && String(item.quote).trim() !== quote.trim()) continue;
      const position = lines[start].toLocaleLowerCase().indexOf(label.toLocaleLowerCase());
      if (position < 0) continue;
      const tail = quote.slice(position + label.length).replace(/^\s*[:=]?\s*/, '');
      const measurement = tail.match(/^\s*([<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?)\s*\*?\s*([^\s\d]+(?:\s*\/\s*[^\s\d]+)?)\s*([\s\S]*)$/);
      if (!measurement) continue;
      const canonical = value => String(value || '').replace(/\s/g, '').replace(',', '.').replace('≤','<=').replace('≥','>=');
      if (canonical(measurement[1]) !== canonical(item.value) || normalizeUnit(measurement[2]) !== normalizeUnit(item.unit)) continue;
      const rangeText = measurement[3].trim().replace(/^[\[(]\s*([\s\S]*?)\s*[\])]$/, '$1');
      const plainRange = /^(?:[+-]?\d+(?:[.,]\d+)?\s*[-–]\s*[+-]?\d+(?:[.,]\d+)?|(?:<=|>=|[<>≤≥])\s*[+-]?\d+(?:[.,]\d+)?)$/.test(rangeText);
      const range = plainRange ? parseBilateralRangeFromTail(rangeText) : null;
      const min = String(item.ref_min || ''), max = String(item.ref_max || '');
      const single = measurement[3].trim().match(/^([<>≤≥])\s*(\d+(?:[.,]\d+)?)\s*$/);
      const expectedMin = range?.min || (single && /[>≥]/.test(single[1]) ? single[2] : '');
      const expectedMax = range?.max || (single && /[<≤]/.test(single[1]) ? single[2] : '');
      const rangeSupported = (!min || canonical(min) === canonical(expectedMin)) && (!max || canonical(max) === canonical(expectedMax)) &&
        (!item.ref_unit || normalizeUnit(item.ref_unit) === normalizeUnit(item.unit));
      candidates.push({...item, raw_label:label, ref_min: rangeSupported ? min : '', ref_max: rangeSupported ? max : '', ref_unit: rangeSupported ? item.ref_unit : '',
        evidence: quote, _sourceEvidence: Object.freeze({line_start:start + 1,line_end:end + 1,quote}), _rangeRejected: !rangeSupported});
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  function validatedAiReportDate(date, evidence, sourceText) {
    const iso = normalizeDateValue(date);
    let quote = String(evidence || '').trim();
    const citation = quote.match(/^\[L(\d+)\]\s*/);
    if (citation) {
      quote = quote.slice(citation[0].length);
      const originalLine = String(sourceText || '').replace(/\r/g,'').split('\n')[Number(citation[1]) - 1];
      if (originalLine?.trim() !== quote) return '';
    }
    if (!iso || !quote || !String(sourceText || '').includes(quote)) return '';
    const explicit = parseExplicitReportDateText(quote);
    return explicit?.date === iso ? iso : '';
  }

  function buildResidualResolverSchema(targetIds) {
    const str={type:'string'}, id={type:'string',enum:targetIds.length?targetIds:['T1']};
    const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
    return object({d:str,de:str,r:{type:'array',items:object({id,raw_label:str,value:str,unit:str,ref_min:str,ref_max:str,ref_unit:str,line_start:{type:"integer",minimum:1},line_end:{type:"integer",minimum:1}})},l:{type:'array',items:object({id,line_start:{type:'integer',minimum:1},line_end:{type:'integer',minimum:1}})},u:{type:'array',items:object({id,reason:str})}});
  }

  function residualResolverTargetRows(targetExams) {
    return (targetExams || []).map((exam, index) => {
      const id = `T${index + 1}`;
      const kind = getLongReportKind(exam);
      const concept = getExamConcept(exam);
      const aliases = targetConceptTerms(exam)
        .map(x => String(x || "").trim())
        .filter(Boolean)
        .slice(0, 10);
      const cat = matchCatalog(exam)?.entry || null;

      return {
        id,
        exam,
        kind: kind || "",
        concept: concept || "",
        code: String(cat?.code || "").trim(),
        aliases
      };
    });
  }

  function buildReferenceIntervalPrompt() {
    return `INTERVALLI DI RIFERIMENTO (ref_min, ref_max, ref_unit):
- ref_min e ref_max sono stringhe con SOLO numeri, senza <, >, <=, >=, unita o testo.
- "0,67 - 1,17" -> ref_min="0,67", ref_max="1,17".
- "<200", "<=200" o "≤200" -> ref_min="", ref_max="200".
- ">40", ">=40" o "≥40" -> ref_min="40", ref_max="".
- NON inventare zero come minimo per <200. NON scambiare una soglia del range con il risultato value.
- ref_unit e l'unita del range; se identica al risultato copia unit. Se entrambi i limiti mancano usa ref_unit="".
- Copia solo il range della stessa misurazione. Se assente, ambiguo o con piu fasce per eta/sesso, entrambi i limiti vuoti. Non interpretare note cliniche.`;
  }

  function buildResidualResolverSystemPrompt() {
    return `Associa i risultati del referto ai target Eumed usando esclusivamente gli ID forniti. Rispondi in JSON conforme allo schema.
Leggi tutto il documento, incluse urine e firma finale. Ometti target assenti, senza inventare risultati.
Ogni risultato r contiene line_start e line_end del solo blocco sorgente numerato (massimo 4 righe, estremi INCLUSIVI: se il risultato e su L2, line_start=2 e line_end=2), id, raw_label (nome originale dell'esame, mai una unita), value, unit, ref_min, ref_max, ref_unit. Copia valore e unita dalla stessa riga del nome; non convertire.
${buildReferenceIntervalPrompt()}
Solo target marcati COMPLESSO possono andare in l con line_start e line_end; il blocco deve contenere il relativo esame. Ometti TSH/PSA se assenti. Non duplicare in r componenti di emocromo, urine complete o elettroforesi. Creatinina urinaria e rapporto ACR sono risultati autonomi anche dentro sezioni urine.
Matrice [S]/[P]=siero/plasma, [U]=urine. U/L e una unita enzimatica. Creatinina sierica con eventuale eGFR richiede il valore della creatinina, mai eGFR. Creatinina urinaria per ACR richiede la concentrazione urinaria; il rapporto ACR/RAC in mg/g e distinto. Il target microalbuminuria per calcolo ACR puo ricevere il rapporto ACR come previsto dal gestionale.
d e la data referto/firma/validazione ISO; de e la riga originale completa contenente quella data. Non usare nascita, accettazione o revisione. Data e ora possono precedere la firma sulla stessa riga. Se mancante usa stringhe vuote.
u contiene solo target con dati presenti ma ambigui, con motivo breve. Nessuna diagnosi o interpretazione.`;
  }

  async function extractResidualResolverBatch(
    reportText,
    targetExams,
    chunkIndex,
    totalChunks,
    progressCallback = null
  ) {
    const rows = residualResolverTargetRows(targetExams);
    const idToTarget = new Map(rows.map(row => [row.id, row]));
    const sourceLines = String(reportText || "")
      .replace(/\r/g, "")
      .split("\n");
    const numberedReportText = sourceLines
      .map((line, i) => `[L${i + 1}] ${line}`)
      .join("\n");

    const targetList = rows.map(row => {
      const meta = [];
      if (row.code) meta.push(`catalogo ${row.code}`);
      if (row.kind) meta.push(`COMPLESSO ${row.kind}`);
      if (row.aliases.length) meta.push(`indizi: ${row.aliases.join(" / ")}`);
      return `${row.id} = ${row.exam}${meta.length ? ` [${meta.join("; ")}]` : ""}`;
    }).join("\n");

    const userPrompt = `
TARGET EUMED RESIDUI - scegli SOLO tramite ID:
${targetList}

DATA REFERTO: d = data ISO YYYY-MM-DD, de = riga testuale INTERA contenente sia la data sia la firma/refertazione. Non omettere data e ora dalla citazione.
Se non presente, d e de vuoti. Non usare nascita, accettazione o revisione documento.

FORMATO r (risultati numerici):
{id, raw_label, value, unit, ref_min, ref_max, ref_unit, line_start, line_end}

FORMATO l (referti complessi):
{id, line_start, line_end}

FORMATO u (solo se davvero necessario):
{id, reason}

==============================
BLOCCO ${chunkIndex}/${totalChunks}
DEL REFERTO
==============================
${numberedReportText}
`;

    const schema = buildResidualResolverSchema(rows.map(row => row.id));
    const numericIds=rows.filter(row=>!row.kind).map(row=>row.id);
    const complexIds=rows.filter(row=>row.kind).map(row=>row.id);
    if(numericIds.length) schema.properties.r.items.properties.id={type:"string",enum:numericIds};
    else schema.properties.r.maxItems=0;
    if(complexIds.length) schema.properties.l.items.properties.id={type:"string",enum:complexIds};
    else schema.properties.l.maxItems=0;
    const content = await ollamaChat(
      [
        { role: "system", content: buildResidualResolverSystemPrompt() },
        { role: "user", content: userPrompt }
      ],
      progressCallback,
      CONFIG.aiMaxTokens,
      schema
    );

    const parsed = extractJSONObject(content);
    parsed.r=(parsed.r||[]).map(x=>[x.id,x.value,x.unit,x.ref_min,x.ref_max,x.ref_unit,x.raw_label,x.line_start,x.line_end]);
    parsed.l=(parsed.l||[]).map(x=>[x.id,x.line_start,x.line_end]);
    parsed.u=(parsed.u||[]).map(x=>[x.id,x.reason]);
    const results = [];
    const long_reports = [];
    const uncertain = [];

    for (const row of Array.isArray(parsed?.r) ? parsed.r : []) {
      const target = idToTarget.get(String(row?.[0] || "").trim());
      if (!target) continue;

      // Un target complesso non deve essere valorizzato con un numero isolato.
      if (target.kind) continue;

      const rawLabel = sourceLabelForAiRow({raw_label:row?.[6],value:row?.[1],unit:row?.[2],line_start:row?.[7]}, reportText);
      const normalizedRawLabel = normalizeExamName(rawLabel);
      const normalizedSource = normalizeExamName(reportText);

      // La label sorgente deve essere realmente contenuta nel testo inviato
      // al modello. In questo modo l'ID vincolato non diventa un permesso a
      // creare un dato senza evidenza testuale.
      if (
        !normalizedRawLabel ||
        normalizedRawLabel.length < 2 ||
        !normalizedSource.includes(normalizedRawLabel)
      ) {
        uncertain.push({
          text: target.exam,
          reason: "IA ha scelto il target ma la raw_label dichiarata non è presente nel testo sorgente"
        });
        continue;
      }

      const extracted = validateAiMeasurementEvidence({raw_label:rawLabel,value:String(row[1] ?? ""),unit:String(row[2] ?? ""),
        ref_min:String(row[3] ?? ""),ref_max:String(row[4] ?? ""),ref_unit:String(row[5] ?? ""),line_start:row[7],line_end:row[8]},reportText);
      if (!extracted) {
        uncertain.push({text:target.exam,reason:"Valore, unita o riga sorgente IA non verificabili insieme."});
        continue;
      }
      if (extracted._rangeRejected) uncertain.push({text:target.exam,reason:"Intervallo normale IA non confermato sulla riga sorgente: limiti lasciati vuoti."});
      // Stage 2: bind only verified extraction; concept/specimen checks still run downstream.
      results.push({...extracted, exam:target.exam,_qwenTargetId:target.id,_qwenBoundTarget:true});
    }

    for (const row of Array.isArray(parsed?.l) ? parsed.l : []) {
      const target = idToTarget.get(String(row?.[0] || "").trim());
      if (!target || !target.kind) continue;

      const start = Number(row?.[1]);
      const end = Number(row?.[2]);
      const validRange = Number.isInteger(start) && Number.isInteger(end) &&
        start >= 1 && end >= start && end <= sourceLines.length;

      long_reports.push({
        kind: target.kind,
        exam: target.exam,
        line_start: start,
        line_end: end,
        text: validRange
          ? sourceLines.slice(start - 1, end).join("\n").trim()
          : "",
        invalid_range: !validRange,
        _qwenTargetId: target.id,
        _qwenBoundTarget: true
      });
    }

    for (const row of Array.isArray(parsed?.u) ? parsed.u : []) {
      const key = String(row?.[0] ?? "").trim();
      const target = idToTarget.get(key);
      if (!target) continue;
      uncertain.push({
        text: target.exam,
        reason: String(row?.[1] ?? "").trim()
      });
    }

    return {
      report_date: validatedAiReportDate(parsed.d, parsed.de, reportText),
      report_date_evidence: String(parsed.de || ""),
      results,
      long_reports,
      uncertain
    };
  }


  async function extractResidualResolverBatchAdaptive(
    reportText,
    targetExams,
    chunkIndex,
    totalChunks,
    progressCallback = null,
    depth = 0
  ) {
    try {
      return await extractResidualResolverBatch(
        reportText,
        targetExams,
        chunkIndex,
        totalChunks,
        progressCallback
      );
    } catch (error) {
      const text = String(reportText || "").trim();

      log(
        `Resolver IA target-bound blocco ${chunkIndex}/${totalChunks} non valido ` +
        `a profondità ${depth}; split adattivo.`,
        error?.message || error
      );

      if (
        depth >= CONFIG.adaptiveMaxDepth ||
        text.length <= CONFIG.adaptiveMinChunkChars
      ) {
        throw new Error(
          `IA resolver target-bound non ha prodotto structured output valido ` +
          `anche dopo split adattivo (profondità ${depth}). ` +
          `${error?.message || error}`
        );
      }

      const [left, right] = splitTextAdaptive(text);
      if (!left.trim() || !right.trim() || left === text || right === text) {
        throw error;
      }

      progressCallback?.({
        phase: "adaptive_split",
        current: chunkIndex,
        total: totalChunks,
        depth: depth + 1,
        resolverMode: "bound_targets"
      });

      const a = await extractResidualResolverBatchAdaptive(
        left,
        targetExams,
        chunkIndex,
        totalChunks,
        progressCallback,
        depth + 1
      );
      const b = await extractResidualResolverBatchAdaptive(
        right,
        targetExams,
        chunkIndex,
        totalChunks,
        progressCallback,
        depth + 1
      );

      return {
        report_date: "",
        report_date_evidence: "",
        results: [...(a.results || []), ...(b.results || [])],
        long_reports: [...(a.long_reports || []), ...(b.long_reports || [])],
        uncertain: [...(a.uncertain || []), ...(b.uncertain || [])]
      };
    }
  }

  async function extractGridFirstResidualsBound(
    reportText,
    targetExams,
    progressCallback = null
  ) {
    const results = [];
    const long_reports = [];
    const uncertain = [];
    const dateCandidates = [];
    const candidates = (targetExams || []).filter(Boolean);
    const batchSize = 6;
    let batchesRun = 0;

    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      const batch = candidates.slice(offset, offset + batchSize);
      const context = buildTargetedReportContext(reportText, batch);
      if (context.length < 25) continue;

      batchesRun++;
      const current = Math.floor(offset / batchSize) + 1;
      const total = Math.ceil(candidates.length / batchSize);

      progressCallback?.({
        phase: "target_ai_start",
        current,
        total,
        targets: batch,
        resolverMode: "bound_targets"
      });

      const parsed = await extractResidualResolverBatchAdaptive(
        context,
        batch,
        current,
        total,
        info => progressCallback?.({
          phase: "target_ai_stream",
          targets: batch,
          chars: info?.chars || 0,
          resolverMode: "bound_targets"
        })
      );

      results.push(...(parsed.results || []));
      long_reports.push(...(parsed.long_reports || []));
      uncertain.push(...(parsed.uncertain || []));
    }

    return {
      results,
      long_reports,
      uncertain,
      dateCandidates,
      batchesRun
    };
  }

  function mergeLongReportTexts(items) {
    const seen = new Set();
    const lines = [];

    for (const item of items) {
      const text = normalizeLongReportText(item?.text || "");

      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;

        const key = normalizeExamName(line);

        // Lo split dei referti ha 2 righe di sovrapposizione:
        // elimina quindi le righe duplicate senza alterarne il contenuto.
        if (key && seen.has(key)) continue;

        if (key) seen.add(key);
        lines.push(line);
      }
    }

    return lines.join("\n").trim();
  }

  function parseAnchoredMeasurementLine(line) {
    const s = String(line ?? "")
      .trim()
      .replace(/^\*+\s*/, "");

    const m = s.match(
      /^([<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?)\s*(?:\*\s*)?([%A-Za-zµμ][A-Za-z0-9µμ%/^._-]*)(?:\s+(.*))?$/
    );

    if (!m) return null;

    return {
      value: m[1].replace(/\s+/g, " ").trim(),
      unit: m[2].trim(),
      tail: String(m[3] || "").trim()
    };
  }

  function parsePureBilateralRangeLine(line) {
    const s = String(line ?? "")
      .trim()
      .replace(/^\*+\s*/, "");

    const m = s.match(
      /^([+-]?\d+(?:[.,]\d+)?)\s*[-–]\s*([+-]?\d+(?:[.,]\d+)?)$/
    );

    if (!m) return null;

    return {
      min: m[1],
      max: m[2]
    };
  }

  function parseBilateralRangeFromTail(text) {
    const s = String(text ?? "").trim().replace(/^\[|\]$/g, "").replace(/^Raccomandato\s*:\s*/i, "").replace(/^Fino a\s+/i, "<= ");
    if (/rischio|diminuzione|normale|gravid|\beta\b/i.test(s)) return null;
    const m = s.match(
      /(?:^|\s)([+-]?\d+(?:[.,]\d+)?)\s*[-–]\s*([+-]?\d+(?:[.,]\d+)?)(?:\s|$)/
    );

    if (!m) {
      const one=s.match(/^(<=|>=|[<>\u2264\u2265])\s*([+-]?\d+(?:[.,]\d+)?)$/);
      if (!one) return null;
      return {min:/[>\u2265]/.test(one[1])?one[2]:'',max:/[<\u2264]/.test(one[1])?one[2]:''};
    }

    return {
      min: m[1],
      max: m[2]
    };
  }

  function parseInlineSpecimenMeasurement(line) {
    const s = String(line ?? "")
      .trim()
      .replace(/\s+/g, " ");

    const m = s.match(
      /^(S|SI|P|PL|U|B)\s*-\s*(.+?)\s+([<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?)\s*(?:\*\s*)?([%A-Za-zµμ][A-Za-z0-9µμ%/^._'-]*)(?:\s+(.*))?$/i
    );

    if (!m) return null;

    return {
      specimen: m[1].toUpperCase(),
      label: String(m[2] || "").trim(),
      value: m[3].replace(/\s+/g, " ").trim(),
      unit: String(m[4] || "").trim(),
      tail: String(m[5] || "").trim()
    };
  }

  function parseNearbyBilateralRange(lines, startIndex, maxLines = 5) {
    const usable = [];

    for (
      let j = startIndex;
      j < Math.min(lines.length, startIndex + maxLines);
      j++
    ) {
      const line = String(lines[j] || "").trim();
      if (!line) continue;

      if (/^(S|SI|P|PL|U|B)\s*-\s*/i.test(line)) break;
      if (/^ANALISI\s+RISULTATI/i.test(line)) break;

      // Queste righe possono stare tra risultato e range ma non sono range.
      if (/^METODO\s*:/i.test(line)) continue;
      if (/^VALORI? DI RIFERIMENTO MODIFICATI/i.test(line)) continue;

      usable.push(line);

      // Prima prova sulla singola riga.
      const direct =
        parsePureBilateralRangeLine(line) ||
        parseBilateralRangeFromTail(line);

      if (direct) {
        return {
          min: direct.min,
          max: direct.max,
          text: line
        };
      }

      // Poi prova sul testo ricomposto: gestisce PDF che estraggono
      // "70", "-", "100" su tre righe diverse.
      const joined = usable.join(" ");
      const recomposed = parseBilateralRangeFromTail(joined);

      if (recomposed) {
        return {
          min: recomposed.min,
          max: recomposed.max,
          text: joined
        };
      }

      // Se iniziano descrizioni/categorie, non cerchiamo oltre.
      if (
        /(?:FASE|POSTMENOPAUSA|GRAVIDANZA|CARENZA|INSUFFICIENZA|ADEGUATEZZA|BASSA|BORDERLINE|NORMALE|RISCHIO|DESIDERABILE|UOMINI|DONNE)\b/i.test(line)
      ) {
        break;
      }
    }

    return null;
  }

  function extractSpecimenAnchoredResults(reportText) {
    const lines = String(reportText ?? "")
      .replace(/\r/g, "")
      .split("\n")
      .map(line => line.replace(/\s+/g, " ").trim());

    const out = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      const inline = parseInlineSpecimenMeasurement(line);

      let specimen = "";
      let label = "";
      let measurement = null;
      let measurementIndex = -1;

      if (inline) {
        specimen = inline.specimen;
        label = inline.label;
        measurement = {
          value: inline.value,
          unit: inline.unit,
          tail: inline.tail
        };
        measurementIndex = i;
      } else {
        const header = line.match(
          /^(S|SI|P|PL|U|B)\s*-\s*(.+?)\s*$/i
        );

        if (!header) continue;

        specimen = header[1].toUpperCase();
        label = String(header[2] || "").trim();

        // Nei PDF testuali SYNLAB il risultato è solitamente entro poche
        // righe dall'intestazione, dopo l'eventuale riga "Metodo:".
        for (
          let j = i + 1;
          j < Math.min(lines.length, i + 9);
          j++
        ) {
          const candidate = lines[j];
          if (!candidate) continue;

          if (/^(S|SI|P|PL|U|B)\s*-\s*/i.test(candidate)) break;
          if (/^METODO\s*:/i.test(candidate)) continue;
          if (/^VALORI? DI RIFERIMENTO MODIFICATI/i.test(candidate)) continue;
          if (/^ANALISI\s+RISULTATI/i.test(candidate)) break;

          const parsed = parseAnchoredMeasurementLine(candidate);
          if (parsed) {
            measurement = parsed;
            measurementIndex = j;
            break;
          }
        }
      }

      if (!label || !measurement) continue;

      // Emocromo e urine complete vengono gestiti come referti lunghi.
      if (getLongReportKind(label)) continue;

      let refMin = "";
      let refMax = "";
      let referenceText = String(measurement.tail || "").trim();

      const concept = getExamConcept(label);

      // Per esami con intervalli multipli/contestuali non compiliamo
      // Min/Max anche se nel testo compare un primo range numerico.
      const allowSimpleRange =
        !shouldSuppressAutomaticRange(concept);

      if (allowSimpleRange) {
        const sameLineRange =
          parseBilateralRangeFromTail(measurement.tail);

        if (sameLineRange) {
          refMin = sameLineRange.min;
          refMax = sameLineRange.max;
        } else {
          const nearby = parseNearbyBilateralRange(
            lines,
            measurementIndex + 1,
            5
          );

          if (nearby) {
            refMin = nearby.min;
            refMax = nearby.max;

            if (!referenceText) {
              referenceText = nearby.text;
            }
          }
        }
      }

      out.push({
        exam: specimen === "U" ? `u - ${label}` : label,
        value: measurement.value,
        unit: measurement.unit,
        ref_min: refMin,
        ref_max: refMax,
        ref_unit: refMin && refMax ? measurement.unit : "",
        reference_text:
          refMin && refMax
            ? `${refMin} - ${refMax}`
            : referenceText,
        raw_label: `${specimen.toLowerCase()} - ${label}`,
        evidence:
          `${label} ${measurement.value} ${measurement.unit}` +
          (refMin && refMax ? ` ${refMin} - ${refMax}` : ""),
        _deterministic: true,
        _synlabStructured: true
      });
    }

    return out;
  }

  function normalizeOcrDisplayUnit(unit) {
    const u = normalizeUnit(unit);
    const display = {
      "mg/dl": "mg/dL",
      "mg/l": "mg/L",
      "mmol/l": "mmol/L",
      "umol/l": "µmol/L",
      "ng/ml": "ng/mL",
      "ng/l": "ng/L",
      "pg/ml": "pg/mL",
      "nmol/l": "nmol/L",
      "u/l": "U/L",
      "ui/l": "UI/L",
      "meq/l": "mEq/L",
      "ug/l": "µg/L",
      "ug/dl": "µg/dL",
      "%": "%"
    };
    return display[u] || String(unit || "").trim();
  }

  function isLikelyLabUnitToken(text) {
    const u = normalizeUnit(text).replace(/\s*crea(?:tinina)?$/i, "");
    return /^(?:mg\/g|mg\/dl|mg\/l|mmol\/l|umol\/l|nmol\/l|ng\/ml|ng\/l|pg\/ml|ug\/l|ug\/dl|u\/l|ui\/l|meq\/l|%|g\/dl|g\/l|10\^?[369]\/l|x10\^?[369]\/l|fl|pg)$/.test(u);
  }

  function isUrineComponentLabel(text) {
    const n = normalizeExamName(text);
    return [
      "PESO SPECIFICO","DENSITA","PH","NITRITI","UROBILINOGENO",
      "CORPI CHETONICI","CELLULE EPITELIALI","BATTERI","CILINDRI",
      "CRISTALLI","SEDIMENTO","LEUCOCITI","ERITROCITI","PROTEINE",
      "ALBUMINA","GLUCOSIO","EMOGLOBINA","BILIRUBINA"
    ].some(term => n.includes(term));
  }

  function detectUrineClusterRange(lines) {
    const strong = [
      /PESO SPECIFICO/i, /DENSIT/i, /NITRIT/i, /UROBILINOG/i,
      /CHETON/i, /CELLULE EPITEL/i, /BATTER/i, /CILINDR/i,
      /CRISTALL/i, /SEDIMENTO/i
    ];

    const hitIndexes = [];

    for (let i = 0; i < lines.length; i++) {
      if (strong.some(re => re.test(lines[i]))) hitIndexes.push(i);
    }

    if (hitIndexes.length < 3) return null;

    return {
      start: Math.max(0, hitIndexes[0] - 4),
      end: Math.min(lines.length - 1, hitIndexes[hitIndexes.length - 1] + 4)
    };
  }

  function extractPaddleTabularResults(reportText) {
    const lines = String(reportText || "")
      .replace(/\r/g, "")
      .split("\n");

    // Il parser entra in gioco solo quando Paddle ha realmente ricostruito
    // colonne tramite TAB. Non modifica i normali PDF.js testuali.
    if (!lines.some(line => line.includes("\t"))) return [];

    const urineRange = detectUrineClusterRange(lines);
    const out = [];

    for (let i = 0; i < lines.length; i++) {
      const rawLine = String(lines[i] || "").trim();
      if (!rawLine || !rawLine.includes("\t")) continue;

      const cells = rawLine
        .split(/\t+/)
        .map(x => x.trim())
        .filter(Boolean);

      if (cells.length < 3) continue;

      let unitIndex = -1;

      for (let j = 1; j < cells.length; j++) {
        if (isLikelyLabUnitToken(cells[j])) {
          unitIndex = j;
          break;
        }
      }

      if (unitIndex < 1) continue;

      let valueIndex = -1;

      for (let j = unitIndex - 1; j >= 1; j--) {
        if (/^[<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?$/.test(cells[j])) {
          valueIndex = j;
          break;
        }
      }

      if (valueIndex < 1) continue;

      const label = cells
        .slice(0, valueIndex)
        .filter(cell => !/^[*+!\u2191\u2193HL]+$/.test(cell))
        .join(" ")
        .replace(/^[*+!↑↓HhLl]+\s*/, "")
        .trim();

      if (!label || getLongReportKind(label)) continue;

      // Dentro il cluster urine non trasformare componenti (es. Glucosio
      // urinario) nella corrispondente prestazione sierica.
      if (
        urineRange &&
        i >= urineRange.start &&
        i <= urineRange.end &&
        isUrineComponentLabel(label)
      ) {
        continue;
      }

      const concept = getExamConcept(label);
      const catalog = matchCatalog(label);

      if (!concept && !(catalog && catalog.score >= 900)) continue;

      const value = cells[valueIndex];
      const unit = normalizeOcrDisplayUnit(cells[unitIndex].replace(/\s+crea(?:t(?:inina)?)?\.?$/i, ""));
      const tail = cells.slice(unitIndex + 1).join(" ");
      const range = parseBilateralRangeFromTail(tail);

      if (
        concept &&
        unit &&
        !unitCompatibleWithConcept(concept, unit, label)
      ) {
        continue;
      }

      out.push({
        exam: label,
        value,
        unit,
        ref_min: range?.min || "",
        ref_max: range?.max || "",
        ref_unit: range ? unit : "",
        reference_text: tail || "",
        raw_label: label,
        evidence: rawLine.replace(/\t+/g, " | "),
        _deterministic: true,
        _paddleTabular: true
      });
    }

    return out;
  }

  function countReportTerms(reportText, terms) {
    const n = normalizeExamName(reportText);
    return terms.reduce(
      (count, term) =>
        count + (n.includes(normalizeExamName(term)) ? 1 : 0),
      0
    );
  }

  function reportContainsLongReportCluster(reportText, kind) {
    if (kind === "EMOCROMO") {
      const n = normalizeExamName(reportText);
      if (n.includes("EMOCROMOCITOMETRICO") && countReportTerms(reportText,
        ["LEUCOCITI", "ERITROCITI", "EMOGLOBINA", "EMATOCRITO", "PIASTRINE", "VOLUME CELLULARE MEDIO"]) >= 5) return true;
      const strong = [
        "WBC", "RBC", "HGB", "HCT", "MCV", "MCH",
        "MCHC", "PLT", "RDW", "NEUTROFILI", "LINFOCITI"
      ];
      return countReportTerms(reportText, strong) >= 5;
    }

    if (kind === "URINE") {
      const strong = [
        "PESO SPECIFICO", "DENSITA", "NITRITI",
        "UROBILINOGENO", "CORPI CHETONICI",
        "CELLULE EPITELIALI", "BATTERI", "CILINDRI",
        "CRISTALLI", "SEDIMENTO URINARIO"
      ];
      const generic = [
        "PH", "LEUCOCITI", "ERITROCITI",
        "PROTEINE", "ALBUMINA", "GLUCOSIO", "EMOGLOBINA"
      ];
      return (
        countReportTerms(reportText, strong) >= 3 ||
        (
          countReportTerms(reportText, strong) >= 2 &&
          countReportTerms(reportText, generic) >= 3
        )
      );
    }

    return false;
  }

  function genericLongReportSlice(reportText, kind) {
    if (kind === "EMOCROMO") {
      const explicit = extractExplicitCbcSection(reportText);
      if (explicit) return explicit;
    }
    const lines = String(reportText || "")
      .replace(/\r/g, "")
      .split("\n")
      .map(line => line.trim());

    if (!lines.length) return "";

    const patterns =
      kind === "EMOCROMO"
        ? [
            /\bWBC\b/i, /\bRBC\b/i, /\bHGB\b/i, /\bHCT\b/i,
            /\bMCV\b/i, /\bMCH\b/i, /\bMCHC\b/i, /\bPLT\b/i,
            /NEUTROFIL/i, /LINFOCIT/i, /MONOCIT/i, /EOSINOFIL/i, /BASOFIL/i
          ]
        : kind === "URINE"
          ? [
              /PESO SPECIFICO/i, /\bDENSIT/i, /\bPH\b/i, /NITRIT/i,
              /UROBILINOG/i, /CHETON/i, /CELLULE EPITEL/i, /BATTER/i,
              /CILINDR/i, /CRISTALL/i, /SEDIMENTO/i,
              /LEUCOCIT/i, /ERITROCIT/i, /PROTEIN/i, /ALBUMIN/i,
              /GLUCOS/i, /EMOGLOBIN/i, /BILIRUBIN/i
            ]
          : [];

    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (patterns.some(re => re.test(lines[i]))) hits.push(i);
    }

    if (hits.length < (kind === "EMOCROMO" ? 5 : 4)) return "";

    const start = Math.max(0, hits[0] - 2);
    const end = Math.min(lines.length - 1, hits[hits.length - 1] + 2);

    // Evita di copiare mezzo documento se i match sono troppo dispersi.
    if (end - start > 45) {
      return hits
        .map(i => lines[i])
        .filter(Boolean)
        .join("\n")
        .trim();
    }

    return lines
      .slice(start, end + 1)
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  function psaMeasurementNear(lines, index) {
    const unitRe =
      /(µg\/L|μg\/L|ug\/L|ng\/mL|ng\/ml|ng\/L|µg\/mL|ug\/mL)/i;

    for (
      let i = index;
      i <= Math.min(lines.length - 1, index + 6);
      i++
    ) {
      const line = String(lines[i] || "").trim();

      const sameLine = line.match(
        /([<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?)\s*(µg\/L|μg\/L|ug\/L|ng\/mL|ng\/ml|ng\/L|µg\/mL|ug\/mL)/i
      );

      if (sameLine) {
        return {
          value: sameLine[1].replace(/\s+/g, ""),
          unit: sameLine[2]
        };
      }

      if (
        /^[<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?$/.test(line)
      ) {
        const next = String(lines[i + 1] || "").trim();
        if (unitRe.test(next)) {
          return {
            value: line.replace(/\s+/g, ""),
            unit: next.match(unitRe)[1]
          };
        }
      }
    }

    return null;
  }

  function extractPsaReflexData(reportText) {
    const lines = cleanReportLines(reportText);

    let total = null;
    let free = null;
    let ratio = null;

    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i] || "").trim();
      const n = normalizeExamName(line);

      const mentionsPsa =
        /\\bPSA\\b/.test(n) ||
        n.includes("ANTIGENE PROSTATICO SPECIFICO");

      if (!mentionsPsa) continue;

      const isFree =
        n.includes("LIBERO") ||
        n.includes("FREE") ||
        /\\bFPSA\\b/.test(n) ||
        /\\bF PSA\\b/.test(n);

      const isRatio =
        n.includes("RAPPORTO") ||
        n.includes("RATIO") ||
        n.includes("FPSA PSA") ||
        n.includes("FREE PSA TOTAL PSA");

      if (isRatio) {
        const ratioInline =
          line.match(/([+-]?\d+(?:[.,]\d+)?)\s*%/);

        if (ratioInline) {
          ratio = {
            value: ratioInline[1],
            unit: "%"
          };
        } else {
          for (
            let j = i;
            j <= Math.min(lines.length - 1, i + 4);
            j++
          ) {
            const m = String(lines[j] || "")
              .match(/([+-]?\d+(?:[.,]\d+)?)\s*%/);

            if (m) {
              ratio = {
                value: m[1],
                unit: "%"
              };
              break;
            }
          }
        }
        continue;
      }

      const measurement = psaMeasurementNear(lines, i);
      if (!measurement) continue;

      if (isFree) {
        if (!free) free = measurement;
      } else {
        // "PSA totale", "PSA", "Antigene prostatico specifico":
        // se non è esplicitamente libero viene considerato PSA totale.
        if (!total) total = measurement;
      }
    }

    return { total, free, ratio };
  }

  function normalizePsaDisplayUnit(unit) {
    const u = normalizeUnit(unit);

    if (u === "ug/l") return "µg/L";
    if (u === "ug/ml") return "µg/mL";
    if (u === "ng/ml") return "ng/mL";
    if (u === "ng/l") return "ng/L";

    return String(unit || "").trim();
  }

  function buildPsaReflexLongReportFromRawResults(
    rawResults,
    reportText = ""
  ) {
    let total = null;
    let free = null;

    const normalizedCandidates = [];

    for (const item of rawResults || []) {
      const rawValue = String(item?.value || "").trim();

      if (
        !/^[<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?$/.test(rawValue)
      ) {
        continue;
      }

      const label =
        `${item?.raw_label || ""} ${item?.exam || ""}`;

      const concept = getExamConcept(label);

      if (
        concept !== "PSA_TOTAL" &&
        concept !== "PSA_FREE"
      ) {
        continue;
      }

      const unit = String(item?.unit || "").trim();

      if (
        unit &&
        !unitCompatibleWithConcept(concept, unit, label)
      ) {
        continue;
      }

      const candidate = {
        value: rawValue.replace(/^[<>≤≥]\s*/, ""),
        unit: normalizePsaDisplayUnit(unit),
        concept,
        evidence:
          String(item?.evidence || label).trim()
      };

      normalizedCandidates.push(candidate);

      if (concept === "PSA_FREE" && !free) {
        free = candidate;
      }

      if (concept === "PSA_TOTAL" && !total) {
        total = candidate;
      }
    }

    // Se il parser strutturato ha trovato entrambi, questa è la fonte
    // preferita: evita di rileggere il testo e scambiare PSA totale/libero.
    if (total && free) {
      const lines = [
        `PSA totale: ${total.value}${total.unit ? " " + total.unit : ""}`,
        `PSA libero: ${free.value}${free.unit ? " " + free.unit : ""}`
      ];

      // Il rapporto resta riportato solo se è esplicitamente presente
      // nel referto originale; non viene calcolato.
      const fromText = extractPsaReflexData(reportText);

      if (fromText?.ratio) {
        lines.push(
          `Rapporto fPSA/PSA: ${fromText.ratio.value} ${fromText.ratio.unit}`
        );
      }

      return {
        text: lines.join("\\n"),
        total,
        free,
        candidates: normalizedCandidates
      };
    }

    // Fallback al parser testuale già esistente.
    const fallbackText =
      buildPsaReflexLongReport(reportText);

    return {
      text: fallbackText || "",
      total,
      free,
      candidates: normalizedCandidates
    };
  }

  function buildPsaReflexLongReport(reportText) {
    const data = extractPsaReflexData(reportText);

    if (!data.total || !data.free) return "";

    const lines = [
      `PSA totale: ${data.total.value} ${normalizePsaDisplayUnit(data.total.unit)}`,
      `PSA libero: ${data.free.value} ${normalizePsaDisplayUnit(data.free.unit)}`
    ];

    // Il rapporto viene riportato solo se esiste già nel referto:
    // non viene calcolato/inventato dall'estensione.
    if (data.ratio) {
      lines.push(
        `Rapporto fPSA/PSA: ${data.ratio.value} ${data.ratio.unit}`
      );
    }

    return lines.join("\\n");
  }

  function reportReallyContainsLongReportKind(reportText, kind) {
    const n = normalizeExamName(reportText);

    if (kind === "EMOCROMO") {
      return (
        n.includes("EMOCROM") ||
        n.includes("EMOCITOMETRICO") ||
        n.includes("PROFILO EMATOLOGICO") ||
        reportContainsLongReportCluster(reportText, "EMOCROMO")
      );
    }

    if (kind === "URINE") {
      return (
        n.includes("ESAME URINE") ||
        n.includes("PROFILO URINARIO") ||
        n.includes("ESAME CHIMICO FISICO URINE") ||
        n.includes("ESAME CITOFLUORIMETRICO E MICROSCOPICO URINE") ||
        reportContainsLongReportCluster(reportText, "URINE")
      );
    }

    if (kind === "PROTIDOGRAMMA") {
      return n.includes("PROTIDOGRAM") || n.includes("PROFILO PROTEICO") || (n.includes("ELETTROFORESI") && n.includes("PROTEIN"));
    }

    if (kind === "TIPIZZAZIONE_LINFOCITARIA") {
      return (
        n.includes("IMMUNOFENOTIP") ||
        n.includes("TBNK") ||
        n.includes("TIPIZZAZIONE LINFOCIT")
      );
    }

    if (kind === "TIPIZZAZIONE_MONOCLONALE") {
      return (
        n.includes("TIPIZZAZIONE COMPONENTI MONOCLONALI") ||
        n.includes("TIPIZZAZIONE DELLE COMPONENTI MONOCLONALI") ||
        n.includes("TEST DI IMMUNOSOTTRAZIONE")
      );
    }

    if (kind === "BENCE_JONES") {
      return (
        n.includes("BENCE JONES") ||
        n.includes("PROTEINURIA DI BENCE JONES") ||
        n.includes("CATENE LEGGERE LIBERE MONOCLONALI")
      );
    }

    if (kind === "ANA") {
      return (
        n.includes("ANTICORPI ANTI NUCLEO") ||
        n.includes("IFI SU CELL HEP2") ||
        n.includes("DEBOLE POSITIVO")
      );
    }

    if (kind === "ENA") {
      return (
        n.includes("ANTICORPI ANTI ENA") ||
        n.includes("CTD SCREENING")
      );
    }

    if (kind === "PSA_REFLEX") {
      const psa = extractPsaReflexData(reportText);

      if (psa.total && psa.free) return true;

      const n = normalizeExamName(reportText);
      const hasTotal =
        n.includes("PSA TOTALE") ||
        n.includes("PSA TOTAL") ||
        n.includes("ANTIGENE PROSTATICO SPECIFICO TOTALE");

      const hasFree =
        n.includes("PSA LIBERO") ||
        n.includes("FREE PSA") ||
        n.includes("FPSA");

      return hasTotal && hasFree;
    }

    return false;
  }

  function cleanRejectedItems(items, reportText, extraction) {
    const nReport = normalizeExamName(reportText);
    const longKinds = new Set(
      (extraction.longReports || []).map(x => x.kind)
    );

    const acceptedConcepts = new Set();

    for (const item of extraction.results || []) {
      const c = getExamConcept(
        `${item?.exam || ""} ${item?.raw_label || ""}`
      );
      if (c) acceptedConcepts.add(c);
    }

    for (const item of extraction.uncertain || []) {
      const c = getExamConcept(item?.text || "");
      if (c) acceptedConcepts.add(c);
    }

    const out = [];
    const seen = new Set();

    for (const item of items || []) {
      const label = cleanModelLabLabel(
        `${item?.raw_label || ""} ${item?.exam || ""}`
      );
      const value = String(item?.value || "").trim();
      const n = normalizeExamName(label);

      if (!n) continue;

      // Marcatori Lxx esistono solo nel prompt numerato per Qwen, non nel referto.
      if (/\bL\d+\b/i.test(`${item?.raw_label || ""} ${item?.exam || ""} ${value}`)) {
        continue;
      }

      // Righe di range/categorie, non esami.
      if (
        /\b(FASE FOLLICOLARE|FASE LUTEINICA|POSTMENOPAUSA|PICCO META CICLO|UOMINI|DONNE|ANNI)\b/.test(n)
      ) {
        continue;
      }

      const longKind = getLongReportKind(label);
      if (longKind && longKinds.has(longKind)) continue;

      if (isLongReportComponent(label, longKinds)) continue;

      const concept = getExamConcept(label);
      if (concept && acceptedConcepts.has(concept)) continue;

      // Se Qwen ha inventato una voce partendo dalla lista Grid e il nome non
      // compare realmente nel referto, non mostrarla come errore rosso.
      const tokens = significantTokens(label);
      if (tokens.length) {
        const present = tokens.filter(t => nReport.includes(t)).length;
        const coverage = present / tokens.length;
        if (coverage < 0.5) continue;
      }

      const key = normalizeExamName(
        `${item?.exam || ""} ${item?.raw_label || ""} ${value}`
      );
      if (seen.has(key)) continue;
      seen.add(key);

      out.push(item);
    }

    return out;
  }

  function isLongReportComponent(text, detectedKinds) {
    const n = normalizeExamName(text);
    const specimen = detectSpecimen(text);

    // HbA1c contiene la parola "EMOGLOBINA", ma NON è una componente
    // dell'emocromo. Senza questa esclusione veniva assorbita nel
    // referto lungo e non raggiungeva mai il resolver/catalogo.
    if (
      getExamConcept(n) === "HBA1C" ||
      n.includes("EMOGLOBINA GLICATA") ||
      n.includes("EMOGLOBINA GLICOSILATA")
    ) {
      return false;
    }

    if (detectedKinds.has("EMOCROMO")) {
      const cbcPatterns = [
        "GLOBULI BIANCHI", "WBC", "LEUCOCITI",
        "GLOBULI ROSSI", "RBC", "ERITROCITI",
        "EMOGLOBINA", "HGB", "HB ",
        "EMATOCRITO", "HCT", "PIASTRINE", "PLT",
        "MCV", "MCH", "MCHC", "RDW", "MPV",
        "NEUTROFILI", "LINFOCITI", "MONOCITI",
        "EOSINOFILI", "BASOFILI"
      ];

      if (cbcPatterns.some(x => n.includes(x))) return true;
    }

    if (detectedKinds.has("PSA_REFLEX")) {
      if (
        /\bPSA\b/.test(n) ||
        n.includes("ANTIGENE PROSTATICO SPECIFICO")
      ) {
        return true;
      }
    }

    if (detectedKinds.has("URINE")) {
      // Non assorbire esami urinari autonomi (es. microalbuminuria/ACR
      // o creatinina urinaria) dentro l'esame urine completo.
      const autonomousUrine =
        n.includes("MICROALBUMINURIA") ||
        n.includes("ALBUMINURIA") ||
        n.includes("ACR") ||
        n.includes("CREATININA");

      const urinePatterns = [
        "DENSITA", "PESO SPECIFICO", "CORPI CHETONICI",
        "UROBILINOGENO", "NITRITI", "ESTERASI LEUCOCITARIA",
        "SEDIMENTO URINARIO", "ANALISI DEL SEDIMENTO",
        "CELLULE EPITELIALI", "CILINDRI", "CRISTALLI",
        "BATTERI", "PH", "GLUCOSIO", "ALBUMINA",
        "PROTEINE", "EMOGLOBINA"
      ];

      if (
        !autonomousUrine &&
        specimen !== "SERUM" &&
        urinePatterns.some(x => n.includes(x))
      ) {
        return true;
      }
    }

    if (detectedKinds.has("PROTIDOGRAMMA")) {
      const protoPatterns = [
        "PROTEINE TOTALI",
        "ALFA 1", "ALFA1", "ALFA 2", "ALFA2",
        "BETA 1", "BETA1", "BETA 2", "BETA2",
        "GAMMA GLOBUL", "RAPPORTO A G", "RAPPORTO AG",
        "ALBUMINA GLOBULINE"
      ];

      if (protoPatterns.some(x => n.includes(x))) return true;
    }

    if (detectedKinds.has("TIPIZZAZIONE_LINFOCITARIA")) {
      const lymphPatterns = [
        "CD3", "CD4", "CD8", "CD19", "CD20",
        "CD16", "CD56", "T LINFOC", "B LINFOC",
        "CELLULE NK", "NATURAL KILLER", "CD4 CD8"
      ];

      if (lymphPatterns.some(x => n.includes(x))) return true;
    }

    if (detectedKinds.has("TIPIZZAZIONE_MONOCLONALE")) {
      if (
        n.includes("IMMUNOSOTTRAZIONE") ||
        n.includes("IMMUNOFISSAZIONE") ||
        (n.includes("TIPIZZAZIONE") && n.includes("MONOCLONAL"))
      ) return true;
    }

    if (detectedKinds.has("BENCE_JONES")) {
      if (
        n.includes("BENCE JONES") ||
        n.includes("ANTI CATENA LEGG LIBERA") ||
        n.includes("CATENE LEGGERE LIBERE MONOCLONALI")
      ) return true;
    }

    return false;
  }

  function valuesClinicallyEquivalent(a, b, concept) {
    if (sameNumericValue(a, b)) return true;

    const x = parseItalianNumber(a);
    const y = parseItalianNumber(b);

    if (x === null || y === null) return false;

    if (concept === "HBA1C") {
      return Math.abs(x - y) <= 1.1;
    }

    if (concept === "CREATININE") {
      return Math.abs(x - y) <= 0.03;
    }

    if (concept === "VITAMIN_D") {
      return Math.abs(x - y) <= 1.0;
    }

    if (concept === "BILIRUBIN_TOTAL") {
      return Math.abs(x - y) <= 0.03;
    }

    if (concept === "GLUCOSE") {
      return Math.abs(x - y) <= 1.0;
    }

    if (
      ["CHOLESTEROL_TOTAL", "HDL", "LDL", "TRIGLYCERIDES"].includes(concept)
    ) {
      return Math.abs(x - y) <= 1.1;
    }

    if (concept === "IRON") {
      return Math.abs(x - y) <= 1.0;
    }

    return false;
  }

  function chooseBestEquivalentItem(items) {
    // Preferisce la rappresentazione già nell'unità desiderata,
    // evitando conversioni quando il laboratorio riporta entrambe.
    return (
      items.find(item => !item.converted && PREFERRED_UNITS[item.concept]) ||
      items.find(item => item.rangeAvailable) ||
      items[0]
    );
  }

  function dedupeRecognizedNotInGrid(items) {
    const groups = new Map();

    for (const item of items || []) {
      const concept = getExamConcept(
        `${item.catalogName || ""} ${item.raw_label || ""} ${item.exam || ""}`
      );

      const key =
        item.catalogCode ||
        normalizeExamName(
          item.catalogName ||
          item.raw_label ||
          item.exam ||
          Math.random()
        );

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...item, _concept: concept });
    }

    const output = [];

    for (const group of groups.values()) {
      let chosen = group[0];

      // Quando il laboratorio riporta HbA1c sia in % sia in mmol/mol,
      // mostra una sola voce gialla e preferisci IFCC mmol/mol.
      if (group.some(x => x._concept === "HBA1C")) {
        chosen =
          group.find(x =>
            normalizeUnit(x.unit).includes("mmol/mol")
          ) ||
          group.find(x =>
            normalizeExamName(x.raw_label || "").includes("IFCC")
          ) ||
          group[0];
      }

      delete chosen._concept;
      output.push(chosen);
    }

    return output;
  }

  function resolveLongReportEntry(kind, examHint, availableExams) {
    if (examHint) {
      const direct = resolveExamName(examHint);

      if (
        direct.success &&
        getLongReportKind(direct.exam) === kind
      ) {
        return {
          success: true,
          exam: direct.exam,
          method: direct.method
        };
      }
    }

    const candidates = availableExams.filter(
      exam => getLongReportKind(exam) === kind
    );

    if (candidates.length === 1) {
      return {
        success: true,
        exam: candidates[0],
        method: "long_report_kind"
      };
    }

    return {
      success: false,
      reason: candidates.length > 1 ? "ambiguous" : "not_found",
      candidates
    };
  }

  function cleanModelLabLabel(text) {
    let s = String(text ?? "").trim();
    s = s.replace(/^\[?L\d+\]?\s*/i, "");

    // Alcuni PDF tabellari fanno finire il valore davanti all'etichetta.
    // Esempio: "46 EMOGLOBINA GLICATA (HbA1c - IFCC)".
    s = s.replace(
      /^[+-]?\d+(?:[.,]\d+)?\s*(?:%|mmol\s*\/\s*mol|mg\s*\/\s*dL|mg\s*\/\s*L|g\s*\/\s*L|U\s*\/\s*L|ng\s*\/\s*mL|pg\s*\/\s*mL)?\s+(?=[A-Za-zÀ-ÿ])/i,
      ""
    );

    return s.trim();
  }

  function isHbA1cLabel(text) {
    const n = normalizeExamName(text);
    return (
      n.includes("HBA1C") ||
      n.includes("EMOGLOBINA GLICATA") ||
      n.includes("EMOGLOBINA GLICOSILATA")
    );
  }

  function isHbA1cAuxiliaryLine(text) {
    const n = normalizeExamName(text);
    return n.includes("HB TOTALE") || n.includes("HBTOTALE");
  }

  function parseExplicitReportDateText(reportText) {
    const text = String(reportText ?? "");
    const labels = [
      "DATA\\s+(?:DEL\\s+)?REFERTO",
      "REFERTO\\s+DEL",
      "DATA\\s+(?:DI\\s+)?REFERTAZIONE",
      "REFERTATO(?:\\s+IL)?",
      "DATA\\s+(?:DI\\s+)?VALIDAZIONE",
      "VALIDATO(?:\\s+IL)?",
      "DATA\\s+(?:DI\\s+)?FIRMA",
      "FIRMATO(?:\\s+IL)?",
      "DATA\\s+(?:DI\\s+)?EMISSIONE",
      "EMESSO(?:\\s+IL)?"
    ].join("|");

    const re = new RegExp(
      `(?:${labels})\\s*[:\\-]?\\s*(\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-](?:\\d{4}|\\d{2}))`,
      "gi"
    );

    const matches = [];
    let m;

    while ((m = re.exec(text)) !== null) {
      const raw = m[1];
      const p = raw.split(/[\/.\-]/).map(Number);
      if (p.length !== 3) continue;
      let [d, mo, y] = p;
      if (y < 100) y += 2000;
      const iso = `${String(y).padStart(4,"0")}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      if (!normalizeDateValue(iso)) continue;
      matches.push({ date: iso, evidence: m[0].replace(/\s+/g," ").trim() });
    }

    // A signature timestamp can precede the label in geometrically reconstructed PDFs.
    for (const line of text.split(/\r?\n/)) {
      if (!/Referto\s+firmato|Firmato\s+(?:digitalmente|da)|Data\s+firma/i.test(line)) continue;
      const stamp=line.match(/^\s*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})\s+\d{1,2}[:.]\d{2}\b/);
      if (!stamp) continue;
      const [d,mo,y]=stamp[1].split(/[/.\-]/).map(Number);
      const iso=String(y)+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      if (normalizeDateValue(iso)) matches.push({date:iso,evidence:line.trim()});
    }
    const unique = [...new Set(matches.map(x => x.date))];
    if (unique.length === 1) {
      return matches.find(x => x.date === unique[0]);
    }
    return { date: "", evidence: "", ambiguous: unique };
  }

  function reportDateEvidenceIsExplicit(evidence) {
    const n = normalizeExamName(evidence);
    return (
      n.includes("DATA REFERTO") ||
      n.includes("REFERTAZ") ||
      n.includes("VALIDAZ") ||
      n.includes("DATA FIRMA") ||
      n.includes("FIRMATO") ||
      n.includes("EMISSION") ||
      n.includes("EMESSO")
    );
  }

  function extractHbA1cFallback(reportText) {
    const lines = String(reportText ?? "").replace(/\r/g, "").split("\n");
    const candidates = [];

    for (let i = 0; i < lines.length; i++) {
      if (!isHbA1cLabel(lines[i])) continue;

      // Caso frequente di PDF tabellare: valore prima dell'etichetta IFCC.
      const leading = lines[i].match(/^\s*(\d{1,3}(?:[.,]\d+)?)\s+.*(?:HBA1C|EMOGLOBINA\s+GLICATA).*IFCC/i);
      if (leading) {
        candidates.push({
          exam: "EMOGLOBINA GLICATA (HbA1c)",
          value: normalizeValueString(leading[1]),
          unit: "mmol/mol",
          ref_min: "",
          ref_max: "",
          ref_unit: "",
          raw_label: lines[i].trim()
        });
      }

      const from = Math.max(0, i - 3);
      const to = Math.min(lines.length - 1, i + 3);

      for (let j = from; j <= to; j++) {
        const line = lines[j];
        const re = /(\d{1,3}(?:[.,]\d+)?)\s*(?:\*\s*)?(mmol\s*\/\s*mol|%)/gi;
        let m;
        while ((m = re.exec(line)) !== null) {
          candidates.push({
            exam: "EMOGLOBINA GLICATA (HbA1c)",
            value: normalizeValueString(m[1]),
            unit: m[2].replace(/\s+/g, ""),
            ref_min: "",
            ref_max: "",
            ref_unit: "",
            raw_label: lines[i].trim()
          });
        }
      }
    }

    return (
      candidates.find(x => normalizeUnit(x.unit).includes("mmol/mol")) ||
      candidates.find(x => normalizeUnit(x.unit) === "%") ||
      null
    );
  }

  function normalizeLongReportSourceChunks(chunks) {
    const seen = new Set();
    const lines = [];

    for (const chunk of chunks || []) {
      for (const rawLine of String(chunk ?? "").replace(/\r/g, "").split("\n")) {
        const line = rawLine.trimEnd();
        const key = normalizeExamName(line);
        if (!key) {
          if (lines.length && lines[lines.length - 1] !== "") lines.push("");
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(line);
      }
    }

    return lines.join("\n").trim();
  }

  function parseLongReportPlainResponse(content) {
    const clean = String(content ?? "")
      .replace(/```(?:text)?/gi, "")
      .replace(/```/g, "")
      .trim();

    const start = clean.indexOf("BEGIN_LONG_REPORT");
    const end = clean.lastIndexOf("END_LONG_REPORT");

    if (start >= 0 && end > start) {
      return normalizeLongReportText(
        clean.slice(start + "BEGIN_LONG_REPORT".length, end)
      );
    }

    return "";
  }

  async function extractLongReportPlainText(kind, sourceText, progressCallback = null) {
    const label = longReportKindLabel(kind);
    const specific = {
      EMOCROMO:
        "Includi SOLO emocromo e formula: WBC/leucociti, RBC/eritrociti, Hb/Hgb, Hct, MCV, MCH, MCHC, RDW, PLT/piastrine, MPV, neutrofili, linfociti, monociti, eosinofili, basofili e valori assoluti. ESCLUDI tassativamente HbA1c/emoglobina glicata, glucosio e altri esami biochimici.",
      URINE:
        "Includi SOLO esame urine completo e sedimento. ESCLUDI microalbuminuria/ACR e creatinina urinaria autonome.",
      PROTIDOGRAMMA:
        "Includi SOLO protidogramma/elettroforesi proteica e relative frazioni.",
      TIPIZZAZIONE_LINFOCITARIA:
        "Includi SOLO tipizzazione/immunofenotipizzazione T/B/NK e relativi CD/rapporti.",
      PSA_REFLEX:
        "Includi SOLO PSA totale e PSA libero/fPSA. Includi il rapporto fPSA/PSA soltanto se è esplicitamente presente nel referto. Non calcolarlo."
    }[kind] || "";

    const prompt = `
Estrai dal testo seguente esclusivamente il referto lungo di tipo: ${label}.
${specific}

REGOLE:
- non fare diagnosi e non interpretare;
- non inventare valori;
- mantieni nomi, valori, unità e range presenti nel testo;
- una riga per parametro quando possibile;
- non includere date storiche o altri esami;
- nessun markdown e nessun commento.

Rispondi ESATTAMENTE così:
BEGIN_LONG_REPORT
<solo il referto richiesto>
END_LONG_REPORT

TESTO:
${sourceText}
`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const content = await ollamaChat(
        [{ role: "user", content: prompt }],
        progressCallback,
        attempt === 1 ? 2200 : 3200,
        null
      );

      const parsed = parseLongReportPlainResponse(content);
      if (parsed && parsed.split("\n").filter(Boolean).length >= 3) {
        return parsed;
      }
    }

    return "";
  }

  function resolveReportDateCandidates(candidates, uncertain) {
    const normalized = [];

    for (const item of candidates) {
      const iso = normalizeDateValue(item?.date);
      if (!iso) continue;
      normalized.push({
        date: iso,
        evidence: String(item?.evidence ?? "").trim()
      });
    }

    const uniqueDates = [...new Set(normalized.map(x => x.date))];

    if (uniqueDates.length === 1) {
      const chosen = normalized.find(x => x.date === uniqueDates[0]);
      return {
        date: uniqueDates[0],
        evidence: chosen?.evidence || ""
      };
    }

    if (uniqueDates.length > 1) {
      uncertain.push({
        text: "Data del referto",
        reason:
          "Sono state rilevate più possibili date di refertazione: " +
          uniqueDates.map(formatDateForGrid).join(", ") +
          ". La colonna Data esito non verrà modificata."
      });
    }

    return { date: "", evidence: "" };
  }

  function normalizedUnitLoose(unit) {
    return normalizeUnit(unit)
      .replace("μ", "u")
      .replace("µ", "u");
  }

  function unitCompatibleWithConcept(concept, unit, label = "", targetLabel = "") {
    if (!concept) return true;

    const u = normalizedUnitLoose(unit);
    if (!u) return true;

    if (concept === "ACR" && /MICROALBUMIN|ALBUMINUR/i.test(label) && !/RAPPORTO|RAC/i.test(label) && ["mg/l", "mg/dl", "ug/ml"].includes(u)) return !targetLabel || /MICROALBUMIN|ALBUMINUR/i.test(targetLabel);

    const allowed = {
      TSH: [
        "uiu/ml", "uiu/l",
        "uui/ml", "uui/l",
        "miu/l", "miu/ml",
        "mui/l", "mui/ml"
      ],
      FT4: [
        "pmol/l", "ng/dl", "ng/l", "pg/ml"
      ],
      FT3: [
        "pmol/l", "pg/ml", "ng/l"
      ],
      HBA1C: [
        "%", "mmol/mol"
      ],
      TESTOSTERONE_FREE: [
        "ng/l", "pg/ml", "pmol/l", "nmol/l"
      ],
      TESTOSTERONE_TOTAL: [
        "ng/ml", "ng/dl", "nmol/l"
      ],
      FSH: [
        "mui/ml", "miu/ml", "iu/l", "ui/l"
      ],
      ESTRADIOL: [
        "pg/ml", "pmol/l"
      ],
      GLUCOSE: [
        "mg/dl", "mmol/l"
      ],
      BILIRUBIN_TOTAL: [
        "mg/dl", "umol/l"
      ],
      BILIRUBIN_DIRECT: [
        "mg/dl", "umol/l"
      ],
      BILIRUBIN_INDIRECT: [
        "mg/dl", "umol/l"
      ],
      PHOSPHATE: [
        "mg/dl", "mmol/l"
      ],
      PTH: [
        "pg/ml", "ng/l", "pmol/l"
      ],
      IRON: ["ug/dl", "umol/l"],
      URIC_ACID: ["mg/dl", "umol/l", "mmol/l"],
      UREA: ["mg/dl", "mmol/l"],
      PCR: ["mg/dl", "mg/l"],
      ACR: ["mg/g", "mg/gcreat", "mg/gcreatinina"],
      BNP: ["ng/l", "pg/ml"],
      SODIUM: ["mmol/l", "meq/l"],
      POTASSIUM: ["mmol/l", "meq/l"],
      CHLORIDE: ["mmol/l", "meq/l"],
      CALCIUM_TOTAL: ["mg/dl", "mmol/l"],
      CREATININE: ["mg/dl", "umol/l", "mg/l"],
      CHOLESTEROL_TOTAL: ["mg/dl", "mmol/l"],
      HDL: ["mg/dl", "mmol/l"],
      LDL: ["mg/dl", "mmol/l"],
      TRIGLYCERIDES: ["mg/dl", "mmol/l"],
      VITAMIN_D: ["ng/ml", "ug/l", "nmol/l"],
      ALT: ["u/l", "ui/l"],
      AST: ["u/l", "ui/l"],
      GGT: ["u/l", "ui/l"],
      CK: ["u/l", "ui/l"],
      ALP: ["u/l", "ui/l"],
      PSA_TOTAL: ["ng/ml", "ug/l", "ng/l", "ug/ml"],
      PSA_FREE: ["ng/ml", "ug/l", "ng/l", "ug/ml"]
    };

    const list = allowed[concept];
    if (!list) return true;

    return list.some(x => u === x);
  }

  function chooseResolutionForModelResult(aiExam, rawLabel, unit) {
    const aiConcept = getExamConcept(aiExam);
    const rawConcept = getExamConcept(rawLabel);

    // v0.9.2: se l'etichetta originale contiene una matrice esplicita
    // (U-/P-/S-/B-), questa ha priorità sul nome normalizzato.
    // Evita, ad esempio, che U-GLUCOSIO venga associato a GLUCOSIO [S].
    const rawSpecimen = detectSpecimen(rawLabel);
    const aiSpecimen = detectSpecimen(aiExam);

    if (rawSpecimen) {
      const rawResolution = resolveExamName(rawLabel);

      if (
        rawResolution.success ||
        rawResolution.reason === "known_not_in_grid"
      ) {
        const resolvedExamConcept =
          rawResolution.success
            ? getExamConcept(rawResolution.exam)
            : null;

        // Non permettere che una frazione bilirubinica (diretta/indiretta)
        // venga risolta sulla prestazione BILIRUBINA REFLEX/TOTALE.
        // Più in generale, se il concetto dell'etichetta originale è noto,
        // deve essere coerente con quello della prestazione Eumed scelta.
        if (
          rawResolution.success &&
          rawConcept &&
          resolvedExamConcept &&
          rawConcept !== resolvedExamConcept
        ) {
          return {
            resolution: {
              success: false,
              reason: "concept_mismatch",
              candidates: []
            },
            preferredQuery: rawLabel,
            concept: rawConcept,
            mismatch: true
          };
        }

        const rawResolvedConcept =
          rawConcept || resolvedExamConcept;

        if (
          rawResolvedConcept &&
          unit &&
          !unitCompatibleWithConcept(rawResolvedConcept, unit, rawLabel, rawResolution.exam)
        ) {
          return {
            resolution: {
              success: false,
              reason: "unit_mismatch",
              candidates: []
            },
            preferredQuery: rawLabel,
            concept: rawResolvedConcept,
            mismatch: true
          };
        }

        return {
          resolution: rawResolution,
          preferredQuery: rawLabel,
          concept: rawResolvedConcept,
          mismatch: !!aiSpecimen && rawSpecimen !== aiSpecimen
        };
      }

      // Una voce urinaria che non ha una prestazione urinaria autonoma
      // non deve mai ricadere su una prestazione sierica omonima.
      if (rawSpecimen === "URINE") {
        return {
          resolution: {
            success: false,
            reason: "specimen_mismatch",
            candidates: []
          },
          preferredQuery: rawLabel,
          concept: rawConcept || aiConcept,
          mismatch: true
        };
      }
    }

    // L'etichetta originale del laboratorio ha priorità se identifica
    // chiaramente un concetto diverso da quello "normalizzato" da Qwen.
    if (rawConcept && aiConcept && rawConcept !== aiConcept) {
      const rawResolution = resolveExamName(rawLabel);

      if (
        rawResolution.success ||
        rawResolution.reason === "known_not_in_grid"
      ) {
        return {
          resolution: rawResolution,
          preferredQuery: rawLabel,
          concept: rawConcept,
          mismatch: true
        };
      }

      return {
        resolution: {
          success: false,
          reason: "concept_mismatch",
          candidates: []
        },
        preferredQuery: rawLabel,
        concept: rawConcept,
        mismatch: true
      };
    }

    let resolution = resolveExamName(aiExam);

    if (!resolution.success && rawLabel) {
      const byRaw = resolveExamName(rawLabel);

      if (
        byRaw.success ||
        byRaw.reason === "known_not_in_grid"
      ) {
        resolution = byRaw;
      }
    }

    const concept =
      rawConcept ||
      aiConcept ||
      (resolution.success ? getExamConcept(resolution.exam) : null);

    // Se l'unità è manifestamente incompatibile con il concetto,
    // non permettere il mapping (es. TSH con ng/L da testosterone).
    if (
      concept &&
      unit &&
      !unitCompatibleWithConcept(concept, unit, rawLabel, resolution.exam)
    ) {
      return {
        resolution: {
          success: false,
          reason: "unit_mismatch",
          candidates: []
        },
        preferredQuery: rawLabel || aiExam,
        concept,
        mismatch: true
      };
    }

    return {
      resolution,
      preferredQuery: rawLabel || aiExam,
      concept,
      mismatch: false
    };
  }

  function uncertaintyMatchesKnownItem(item, extraction) {
    const text = String(item?.text || "").trim();
    const reason = String(item?.reason || "").trim();
    const joined = normalizeExamName(`${text} ${reason}`);

    const validNames = [
      ...(extraction.results || []).map(x => x.exam),
      ...(extraction.longReports || []).map(x => x.exam),
      ...(extraction.recognizedNotInGrid || []).flatMap(x => [
        x.catalogName,
        x.raw_label,
        x.exam
      ])
    ].filter(Boolean);

    const itemConcept = getExamConcept(text);

    return validNames.some(name => {
      const n = normalizeExamName(name);

      if (n && joined.includes(n)) return true;

      const concept = getExamConcept(name);
      return itemConcept && concept && itemConcept === concept;
    });
  }

  function resolveComparatorResultForPreview(aiExam, rawLabel, rawValue, unit) {
    const query =
      cleanModelLabLabel(rawLabel) ||
      cleanModelLabLabel(aiExam);

    let resolution = resolveExamName(query);

    if (!resolution.success && aiExam && normalizeExamName(aiExam) !== normalizeExamName(query)) {
      const byAi = resolveExamName(aiExam);
      if (byAi.success || byAi.reason === "known_not_in_grid") {
        resolution = byAi;
      }
    }

    const valueText = `${rawValue}${unit ? " " + unit : ""}`.trim();

    if (resolution?.success) {
      return {
        text: resolution.exam,
        reason:
          `Valore riconosciuto: ${valueText}. ` +
          "Esame riconosciuto in Eumed, ma non compilato automaticamente " +
          "perché l'operatore < / > non è rappresentabile nella cella numerica.",
        matchedExam: resolution.exam,
        matchedInGrid: true
      };
    }

    if (resolution?.reason === "known_not_in_grid" && resolution.catalogEntry) {
      return {
        text: resolution.catalogEntry.name || query || aiExam,
        reason:
          `Valore riconosciuto: ${valueText}. ` +
          "Esame riconosciuto nel catalogo ma non presente in Eumed; " +
          "l'operatore < / > non è rappresentabile nella cella numerica.",
        catalogEntry: resolution.catalogEntry,
        matchedInGrid: false
      };
    }

    const catalogMatch = matchCatalog(query || aiExam);

    if (catalogMatch?.entry) {
      const catalogName = catalogMatch.entry.name || query || aiExam;
      const gridResolution = resolveExamName(catalogName);

      if (gridResolution?.success) {
        return {
          text: gridResolution.exam,
          reason:
            `Valore riconosciuto: ${valueText}. ` +
            "Esame riconosciuto in Eumed, ma non compilato automaticamente " +
            "perché l'operatore < / > non è rappresentabile nella cella numerica.",
          matchedExam: gridResolution.exam,
          matchedInGrid: true
        };
      }

      return {
        text: catalogName,
        reason:
          `Valore riconosciuto: ${valueText}. ` +
          "Esame riconosciuto nel catalogo, ma non compilato automaticamente " +
          "perché l'operatore < / > non è rappresentabile nella cella numerica.",
        catalogEntry: catalogMatch.entry,
        matchedInGrid: false
      };
    }

    return {
      text: query || aiExam || "Risultato di laboratorio",
      reason:
        `Valore riconosciuto: ${valueText}. ` +
        "Non compilato automaticamente perché l'operatore < / > " +
        "non è rappresentabile nella cella numerica.",
      matchedInGrid: false
    };
  }

  function cleanUncertainItems(items, extraction) {
    const longKinds = new Set(
      (extraction.longReports || []).map(x => x.kind)
    );

    const out = [];
    const seen = new Set();

    for (const item of items || []) {
      const text = String(item?.text || "").trim();
      const reason = String(item?.reason || "").trim();

      if (!text && !reason) continue;

      const nText = normalizeExamName(text);
      const nReason = normalizeExamName(reason);
      const all = `${nText} ${nReason}`;

      // Rumore del modello: non è un'incertezza.
      if (
        nReason.includes("NON PRESENTE NEL TESTO") ||
        nReason.includes("NON PRESENTE NEL BLOCCO") ||
        nReason.includes("NON TROVATO NEL TESTO") ||
        nReason.includes("VALORI DI RIFERIMENTO MODIFICATI")
      ) {
        continue;
      }

      if (
        nText === "REASON" ||
        nText === "MOTIVO"
      ) {
        continue;
      }

      // Se esiste già un risultato valido/corrispondenza gialla/referto lungo,
      // non mostrare una seconda incertezza sullo stesso esame.
      if (uncertaintyMatchesKnownItem(item, extraction)) {
        continue;
      }

      if (
        longKinds.has("URINE") &&
        (
          nText.includes("URINE") ||
          nText.includes("SEDIMENTO") ||
          nReason.includes("QUALITATIV") ||
          nReason.includes("CONTAMINAZ")
        )
      ) {
        continue;
      }

      if (
        longKinds.has("PSA_REFLEX") &&
        (
          /\bPSA\b/.test(nText) ||
          /\bPSA\b/.test(nReason) ||
          nText.includes("ANTIGENE PROSTATICO SPECIFICO") ||
          nReason.includes("ANTIGENE PROSTATICO SPECIFICO")
        )
      ) {
        continue;
      }

      if (
        longKinds.has("EMOCROMO") &&
        (
          nText.includes("EMOCROMO") ||
          /WBC|RBC|HGB|HB |HCT|MCV|MCH|MCHC|RDW|PLT|NEUTROFIL|LINFOCIT|MONOCIT|EOSINOFIL|BASOFIL/.test(nText)
        )
      ) {
        continue;
      }

      const key = normalizeExamName(`${text} ${reason}`);
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ text, reason });
    }

    return out;
  }


  // v0.9.0 - parser deterministici per i tre laboratori principali.
  function detectKnownLabLayout(reportText) {
    const n = normalizeExamName(reportText);
    if (n.includes("SYNLAB DATA MEDICA") || (n.includes("WWW SYNLAB IT") && n.includes("DATA REFERTO"))) return "SYNLAB_DATA_MEDICA";
    if ((n.includes("AZIENDA OSPEDALE UNIVERSITA DI PADOVA") || n.includes("U O C MEDICINA DI LABORATORIO")) && n.includes("COSTITUENTE") && n.includes("INT DI RIFERIMENTO")) return "AOU_PADOVA";
    // Schiavonia può comparire come Azienda ULSS 6 Euganea oppure con il nome
    // esplicito del presidio. Manteniamo un unico parser/layout per entrambi.
    if (
      (n.includes("AZIENDA ULSS N 6 EUGANEA") ||
       n.includes("OSPEDALE DI SCHIAVONIA") ||
       n.includes("PRESIDIO OSPEDALIERO DI SCHIAVONIA")) &&
      n.includes("MEDICINA DI LABORATORIO")
    ) return "ULSS6_SCHIAVONIA";
    if (n.includes("EMOCROMOCITOMETRICO") && n.includes("CHIMICA CLINICA") &&
        reportContainsLongReportCluster(reportText, "EMOCROMO") && /(?:^|\n)\s*[PS]\s*-\s*\S+/i.test(reportText)) return "INLINE_CBC_CHEMISTRY";
    return "";
  }

  function extractExplicitCbcSection(reportText) {
    const lines = cleanReportLines(reportText);
    const start = lines.findIndex(line => /^(?:ES\.?\s*|ESAME\s+)?EMOCROMOCITOMETRICO\s*$/i.test(line));
    if (start < 0 || !reportContainsLongReportCluster(reportText, "EMOCROMO")) return "";
    let end = start + 1;
    while (end < lines.length && !/^(?:CHIMICA CLINICA|BIOCHIMICA|IMMUNOLOGIA|ENDOCRINOLOGIA|(?:SI|P|S|U|B)\s*-|FIRMATO|IL RESPONSABILE|VALIDAZIONE)/i.test(lines[end])) end++;
    return lines.slice(start, end).filter(Boolean).join("\n");
  }

  function cleanReportLines(reportText) {
    return String(reportText ?? "").replace(/\r/g, "").replace(/\u00a0/g, " ").split("\n").map(line => line.replace(/[ \t]+/g, " ").trim());
  }

  function normalizeAouNumericToken(value) {
    const s = String(value ?? "").trim().replace(/^\*+\s*/, "").replace(/\s+/g, "");
    if (!s) return "";
    // Non inferire mai una virgola da un intero a quattro cifre: valori reali
    // come B12 1134, ferritina 1200 o NT-proBNP 1500 verrebbero corrotti.
    return s;
  }

  function isNumericOrComparatorToken(value) {
    return /^[<>≤≥]?[+-]?\d+(?:[.,]\d+)?$/.test(normalizeAouNumericToken(value));
  }

  function isAouUnitToken(value) {
    const s = normalizeUnit(value);
    if (!s) return false;
    return s === "%" || /^(?:m?g|u?g|ng|pg|mmol|umol|nmol|pmol|iu|ui|miu|mui|u)\/(?:dl|ml|l|g|mol)$/.test(s) || /^(?:10\^\d+\/l|x10e\d+\/l|fl|pg|g\/l|l\/l|mm\/h|ml\/m['’]?\/1\.73mq|mg\/g)$/.test(s);
  }

  function isAouMajorLabel(line) {
    const s = String(line ?? "").trim();
    return /^[BPSU]-\S+/i.test(s) || /^PROFILO\s+/i.test(s) || /^Rapp\.\s*ALBUMINA-CREATININA/i.test(s) || /^eGFR\b/i.test(s);
  }

  function parseAouBilateralRange(lines, start, end) {
    for (let i=start; i<Math.min(end,start+8); i++) {
      const s=String(lines[i]||"").trim();
      let m=s.match(/^([+-]?\d+(?:[.,]\d+)?)\s*[-–]\s*([+-]?\d+(?:[.,]\d+)?)$/);
      if (m) return {min:m[1],max:m[2]};
      if (/^[+-]?\d+(?:[.,]\d+)?$/.test(s) && String(lines[i+1]||"").trim()==="-" && /^[+-]?\d+(?:[.,]\d+)?$/.test(String(lines[i+2]||"").trim())) return {min:s,max:String(lines[i+2]).trim()};
      m=s.match(/^([+-]?\d+(?:[.,]\d+)?)\s*[-–]\s*$/);
      if (m && /^[+-]?\d+(?:[.,]\d+)?$/.test(String(lines[i+1]||"").trim())) return {min:m[1],max:String(lines[i+1]).trim()};
      if (/^(?:desiderabile|borderline|elevato|alterata|gravidanza|soglia|tossicita|uomini|donne)/i.test(s)) break;
    }
    return {min:"",max:""};
  }

  function parseInlineKnownMeasurement(line) {
    const s=String(line||"").replace(/\s+/g," ").trim();
    const m=s.match(/^(.+?)\s+([<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?)\s*(?:\*\s*)?([A-Za-zµμ%][A-Za-z0-9µμ%/^.'_-]*)(?:\s+(.*))?$/);
    if(!m) return null;
    return {label:m[1].trim(),value:m[2].replace(/\s+/g,""),unit:m[3].trim(),tail:String(m[4]||"").trim()};
  }

  function parseAouContinuationMeasurement(line) {
    const s = String(line || "")
      .replace(/\s+/g, " ")
      .trim();

    const m = s.match(
      /^([<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?)\s*(?:\*\s*)?([A-Za-zµμ%][A-Za-z0-9µμ%/^.'_-]*)(?:\s+(.*))?$/
    );

    if (!m) return null;

    return {
      value: m[1].replace(/\s+/g, ""),
      unit: m[2].trim(),
      tail: String(m[3] || "").trim()
    };
  }

  function extractAouPadovaResults(reportText) {
    const lines = cleanReportLines(reportText);
    const out = [];
    const hasProteinProfile =
      normalizeExamName(reportText).includes("PROFILO PROTEICO");

    for (let i = 0; i < lines.length; i++) {
      const inline = lines[i].match(/^([BPSU])-(.+)$/i);
      if (!inline) continue;

      const specimen = inline[1].toUpperCase();
      let label = String(inline[2] || "").trim();

      // I componenti U-* appartengono al referto lungo urine.
      // L'ACR viene estratto separatamente da extractAcrResult().
      if (specimen === "U") continue;

      // Emocromo B-* viene gestito come referto lungo.
      if (specimen === "B" && !/^VES\b/i.test(label) && !/EMOGLOBINA GLICATA|HBA1C/i.test(label)) {
        continue;
      }

      const inlineMeasurement =
        parseInlineKnownMeasurement(label);

      const measurements = [];

      if (inlineMeasurement) {
        label = inlineMeasurement.label;

        const sameRange =
          parseBilateralRangeFromTail(inlineMeasurement.tail);

        measurements.push({
          value: inlineMeasurement.value,
          unit: inlineMeasurement.unit,
          ref_min: sameRange?.min || "",
          ref_max: sameRange?.max || "",
          tail: inlineMeasurement.tail
        });
      }

      if (
        hasProteinProfile &&
        normalizeExamName(label).includes("PROTEINE TOTALI")
      ) {
        continue;
      }

      let end = Math.min(lines.length, i + 26);

      for (let j = i + 1; j < end; j++) {
        if (isAouMajorLabel(lines[j])) {
          end = j;
          break;
        }
      }

      // Rappresentazioni secondarie: es. 79 mg/dL dopo 4,4 mmol/L.
      for (let j = i + 1; j < end; j++) {
        const continuation =
          parseAouContinuationMeasurement(lines[j]);

        if (continuation && isAouUnitToken(continuation.unit)) {
          const range =
            parseBilateralRangeFromTail(continuation.tail) ||
            parseAouBilateralRange(lines, j + 1, end);

          measurements.push({
            value: continuation.value,
            unit: continuation.unit,
            ref_min: range?.min || "",
            ref_max: range?.max || "",
            tail: continuation.tail
          });

          continue;
        }

        // Mantiene compatibilità con PDF.js che separa valore e unità.
        if (j < end - 1) {
          const value = normalizeAouNumericToken(lines[j]);
          const unit = String(lines[j + 1] || "").trim();

          if (
            isNumericOrComparatorToken(value) &&
            isAouUnitToken(unit)
          ) {
            const previous =
              normalizeExamName(lines[j - 1] || "");

            if (
              previous.includes("SOGLIA TERAPEUTICA") ||
              previous.includes("TOSSICITA") ||
              previous.includes("VALORE OTTIMALE") ||
              previous.includes("RIFERIMENTO TERAPEUTICO")
            ) {
              continue;
            }

            const range =
              parseAouBilateralRange(lines, j + 2, end);

            measurements.push({
              value,
              unit,
              ref_min: range.min,
              ref_max: range.max,
              tail: ""
            });
          }
        }
      }

      // Deduplica rappresentazioni identiche estratte due volte.
      const seen = new Set();

      for (const x of measurements) {
        const key =
          `${normalizeValueString(x.value)}|${normalizeUnit(x.unit)}`;

        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          exam: label,
          value: x.value,
          unit: x.unit,
          ref_min: x.ref_min,
          ref_max: x.ref_max,
          ref_unit:
            x.ref_min && x.ref_max ? x.unit : "",
          reference_text:
            x.ref_min && x.ref_max
              ? `${x.ref_min} - ${x.ref_max}`
              : x.tail || "",
          raw_label: `${specimen}-${label}`,
          evidence: `${label} ${x.value} ${x.unit}`,
          _deterministic: true,
          _layout: "AOU_PADOVA"
        });
      }
    }

    return out;
  }

  function extractAcrResult(reportText, layout) {
    const lines=cleanReportLines(reportText);
    for(let i=0;i<lines.length;i++){
      if(!/(Rapp(?:orto)?\.?\s+(?:U[- ]?)?ALBUMINA\s*[-/]\s*(?:U[- ]?)?CREATININA|Rapporto\s+Alb\/Cre|Rapporto\s+Albumina.Cre|\bRAC\b|\bACR\b)/i.test(lines[i])) continue;
      const joined=[lines[i],lines[i+1]||"",lines[i+2]||""].join(" ").replace(/\s+/g," ");
      let m=joined.match(/([<≤>]?[ ]*\d+(?:[.,]\d+)?)\s*(mg\s*\/\s*g(?:\s*Creat\.)?)/i);
      if(!m) continue;
      return {exam:"RAPPORTO ALBUMINA-CREATININA (ACR) URINE",value:m[1].replace(/\s+/g,""),unit:"mg/g",ref_min:"",ref_max:"",ref_unit:"",reference_text:"",raw_label:lines[i],evidence:joined,_deterministic:true,_layout:layout};
    }
    return null;
  }

  function extractUlss6DirectResults(reportText) {
    const lines=cleanReportLines(reportText), out=[];
    const patterns=[
      /^(VES)\s+([<>≤≥]?\s*\d+(?:[.,]\d+)?)\s*(?:\*\s*)?(mm\/h)(?:\s+(.*))?$/i,
      /^(NT[- ]?proBNP)\s+([<>≤≥]?\s*\d+(?:[.,]\d+)?)\s*(?:\*\s*)?(ng\/L)(?:\s+(.*))?$/i,
      /^(P-?PROTEINA C REATTIVA(?: ultra-sensibile)?)\s+([<>≤≥]?\s*\d+(?:[.,]\d+)?)\s*(?:\*\s*)?(mg\/L|mg\/dL)(?:\s+(.*))?$/i
    ];
    for(const line of lines){
      for(const re of patterns){const m=line.match(re);if(!m)continue;const range=parseBilateralRangeFromTail(m[4]||"");out.push({exam:m[1],value:m[2].replace(/\s+/g,""),unit:m[3],ref_min:range?.min||"",ref_max:range?.max||"",ref_unit:range?m[3]:"",reference_text:m[4]||"",raw_label:m[1],evidence:line,_deterministic:true,_layout:"ULSS6_SCHIAVONIA"});break;}
    }
    return out;
  }

  function knownLongReportKinds(layout, reportText) {
    const n=normalizeExamName(reportText), kinds=[];
    if (layout === "INLINE_CBC_CHEMISTRY" && reportContainsLongReportCluster(reportText, "EMOCROMO")) kinds.push("EMOCROMO");
    if(layout==="SYNLAB_DATA_MEDICA"){
      if(n.includes("EMOCROMOCITOMETRICO")||n.includes("EMOCROMO")) kinds.push("EMOCROMO");
      if(n.includes("ESAME URINE COMPLETO")) kinds.push("URINE");
      if(n.includes("PROTIDOGRAMMA")||(n.includes("ELETTROFORESI")&&n.includes("PROTEIN"))) kinds.push("PROTIDOGRAMMA");
    }
    if(layout==="AOU_PADOVA"){
      if(n.includes("PROFILO EMATOLOGICO")) kinds.push("EMOCROMO");
      if(n.includes("PROFILO PROTEICO")) kinds.push("PROTIDOGRAMMA");
      if(n.includes("PROFILO URINARIO")) kinds.push("URINE");
      if(n.includes("ANTICORPI ANTI ENA") || n.includes("CTD SCREENING")) kinds.push("ENA");
      if(n.includes("ANTICORPI ANTI NUCLEO") || n.includes("IFI SU CELL HEP2")) kinds.push("ANA");
    }
    if(layout==="ULSS6_SCHIAVONIA"){
      if(/\bEMOCROMO\b/.test(n)) kinds.push("EMOCROMO");
      if(n.includes("ELETTROFORESI PROTEICA")) kinds.push("PROTIDOGRAMMA");
      if(n.includes("ESAME CHIMICO FISICO URINE")||n.includes("ESAME CITOFLUORIMETRICO E MICROSCOPICO URINE")) kinds.push("URINE");
    }

    if (reportReallyContainsLongReportKind(reportText, "TIPIZZAZIONE_MONOCLONALE")) {
      kinds.push("TIPIZZAZIONE_MONOCLONALE");
    }
    if (reportReallyContainsLongReportKind(reportText, "BENCE_JONES")) {
      kinds.push("BENCE_JONES");
    }
    if (reportReallyContainsLongReportKind(reportText, "PSA_REFLEX")) {
      kinds.push("PSA_REFLEX");
    }

    return [...new Set(kinds)];
  }

  function sliceKnownSection(lines,startTest,endTest){const start=lines.findIndex(startTest);if(start<0)return[];let end=lines.length;for(let i=start+1;i<lines.length;i++){if(endTest(lines[i],i)){end=i;break;}}return lines.slice(start,end);}
  function cleanupKnownLongReportLines(lines){const out=[];for(const raw of lines){const line=String(raw||"").trim();if(!line)continue;if(/^Pag(?:ina)?\.?\s*\d+/i.test(line)||/^Costituente$/i.test(line)||/^Risultato$/i.test(line)||/^Unita'?$/i.test(line)||/^Int\.\s*di Riferimento/i.test(line)||/^Ris\.\s*Prec/i.test(line)||/^Metodo\s*:/i.test(line))continue;if(/^(?:Provenienza|Codice Fiscale|Prelievo del|Ricevuto il|Data di Nascita|Riferimento|ASSIPCA|Referto del|Data Referto|Data Check-in|Prenotazione CUP)\b/i.test(line)||/^Richiesta\s*:/i.test(line))continue;out.push(line);}return out;}

  function buildAouCbcLongReport(reportText) {
    const lines = cleanReportLines(reportText);
    const section = sliceKnownSection(
      lines,
      line => /^PROFILO EMATOLOGICO$/i.test(line),
      line =>
        /^B-VES\b/i.test(line) ||
        /^[PSU]-/i.test(line)
    );

    return cleanupKnownLongReportLines(section)
      .join("\n")
      .trim();
  }

  function buildAouProteinLongReport(reportText) {
    const lines = cleanReportLines(reportText);
    const start =
      lines.findIndex(line => /^PROFILO PROTEICO$/i.test(line));

    if (start < 0) return "";

    const out = [];

    for (let i = start; i < lines.length; i++) {
      const line = lines[i];

      if (
        i > start &&
        /^P-/i.test(line)
      ) {
        break;
      }

      if (
        i > start &&
        /^S-/i.test(line) &&
        !/S-PROTEINE TOTALI/i.test(line)
      ) {
        break;
      }

      out.push(line);
    }

    return cleanupKnownLongReportLines(out)
      .filter(line => line !== '"')
      .join("\n")
      .trim();
  }

  function buildAouUrineLongReport(reportText) {
    const lines = cleanReportLines(reportText);
    const start =
      lines.findIndex(line => /^PROFILO URINARIO$/i.test(line));

    if (start < 0) return "";

    const out = [];
    let skipAcr = false;

    for (let i = start; i < lines.length; i++) {
      const line = lines[i];

      // Il primo esame ematico/sierico dopo il profilo urine chiude la sezione.
      if (
        i > start &&
        /^[BPS]-/i.test(line)
      ) {
        break;
      }

      if (/^Rapp\.\s*ALBUMINA-CREATININA/i.test(line)) {
        skipAcr = true;
        continue;
      }

      if (
        skipAcr &&
        /^Esame Citofluorimetrico/i.test(line)
      ) {
        skipAcr = false;
      }

      if (skipAcr) continue;
      out.push(line);
    }

    return cleanupKnownLongReportLines(out)
      .join("\n")
      .trim();
  }
  function buildSynlabLongReport(reportText,kind){const lines=cleanReportLines(reportText);if(kind==="EMOCROMO"){const section=sliceKnownSection(lines,line=>/ESAME EMOCROMOCITOMETRICO|EMOCROMO COMPLETO/i.test(line),line=>/^(?:SI|P|S|U|B)\s*-\s*/i.test(line)&&!/EMOCROM/i.test(line));return cleanupKnownLongReportLines(section).join("\n").trim();}if(kind==="URINE"){const section=sliceKnownSection(lines,line=>/^(?:U\s*-\s*)?ESAME URINE COMPLETO/i.test(line),line=>/^\(\*\)\s*=/.test(line)||/^\[SIGNIT_/i.test(line)||/^Firmato digitalmente/i.test(line));return cleanupKnownLongReportLines(section).join("\n").trim();}if(kind==="PROTIDOGRAMMA"){const section=sliceKnownSection(lines,line=>/PROTIDOGRAMMA/i.test(line)||(/ELETTROFORESI/i.test(line)&&/PROTEIN/i.test(line)),line=>/^(?:P|S|U)\s*-\s*/i.test(line));return cleanupKnownLongReportLines(section).join("\n").trim();}return "";}

  function buildUlss6LongReport(reportText,kind){
    const lines=cleanReportLines(reportText);
    if(kind==="EMOCROMO"){
      const section=sliceKnownSection(lines,line=>/^EMOCROMO$/i.test(line),line=>/^(?:MARCATORI CARDIACI|INDICI DI FLOGOSI|BIOCHIMICA CLINICA)$/i.test(line));
      return cleanupKnownLongReportLines(section).filter(x=>!/^EMATOLOGIA$/i.test(x)).join("\n").trim();
    }
    if(kind==="PROTIDOGRAMMA"){
      const section=sliceKnownSection(lines,line=>/^S-PROTEINE TOTALI\b/i.test(line)||/^S-ELETTROFORESI PROTEICA\b/i.test(line),line=>/^Validazione clinica:/i.test(line)||/^MICROSCOPIA CLINICA$/i.test(line));
      return cleanupKnownLongReportLines(section).join("\n").trim();
    }
    if(kind==="URINE"){
      const section=sliceKnownSection(lines,line=>/^U[_ -]ESAME CHIMICO FISICO URINE/i.test(line),line=>/^IMPORTANTE:/i.test(line));
      const filtered=section.filter(line=>!/(Rapporto Alb\/Cre|Fisiologico:|Moderatamente aumentato:|Severamente aumentato:)/i.test(line));
      return cleanupKnownLongReportLines(filtered).join("\n").trim();
    }
    return "";
  }

  function buildAouMonoclonalTypingLongReport(reportText) {
    const lines = cleanReportLines(reportText);
    const section = sliceKnownSection(
      lines,
      line => /^(?:TIPIZZAZIONE (?:DELLE )?COMPONENTI MONOCLONALI|TEST DI IMMUNOSOTTRAZIONE)\b/i.test(line),
      line => /^P-/i.test(line) || /^PROFILO URINARIO$/i.test(line) || /^RICERCA DELLA PROTEINURIA DI BENCE JONES$/i.test(line)
    );
    return cleanupKnownLongReportLines(section).join("\n").trim();
  }

  function buildAouBenceJonesLongReport(reportText) {
    const lines = cleanReportLines(reportText);
    const section = sliceKnownSection(
      lines,
      line => /^(?:RICERCA DELLA PROTEINURIA DI )?BENCE[ -]?JONES\b/i.test(line) || /^RICERCA DELLA PROTEINURIA DI BENCE JONES$/i.test(line),
      line => /^P-/i.test(line) || /^PROFILO URINARIO$/i.test(line)
    );
    return cleanupKnownLongReportLines(section).join("\n").trim();
  }

  function buildAouEnaLongReport(reportText) {
    const lines = cleanReportLines(reportText);
    const section = sliceKnownSection(
      lines,
      line => /^ANTICORPI ANTI ENA\b/i.test(line),
      line => /^ANTICORPI ANTI NUCLEO\b/i.test(line)
    );
    return cleanupKnownLongReportLines(section).join("\n").trim();
  }

  function buildAouAnaLongReport(reportText) {
    const lines = cleanReportLines(reportText);
    const start = lines.findIndex(line => /^ANTICORPI ANTI NUCLEO\b/i.test(line));
    if (start < 0) return "";
    const out = [];
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (i > start && (/^\*{3}\s*Referto Finale/i.test(line) || /^Validato da:/i.test(line) || /^INFORMAZIONE AI SENSI/i.test(line) || /^Copia di referto/i.test(line))) break;
      out.push(line);
    }
    return cleanupKnownLongReportLines(out).join("\n").trim();
  }

  function extractKnownLongReportText(layout,kind,reportText){
    if (layout === "INLINE_CBC_CHEMISTRY" && kind === "EMOCROMO") return extractExplicitCbcSection(reportText);
    if(kind==="PSA_REFLEX")return buildPsaReflexLongReport(reportText);
    if(layout==="SYNLAB_DATA_MEDICA")return buildSynlabLongReport(reportText,kind);
    if(layout==="AOU_PADOVA"){
      if(kind==="EMOCROMO")return buildAouCbcLongReport(reportText);
      if(kind==="PROTIDOGRAMMA")return buildAouProteinLongReport(reportText);
      if(kind==="URINE")return buildAouUrineLongReport(reportText);
      if(kind==="TIPIZZAZIONE_MONOCLONALE")return buildAouMonoclonalTypingLongReport(reportText);
      if(kind==="BENCE_JONES")return buildAouBenceJonesLongReport(reportText);
      if(kind==="ENA")return buildAouEnaLongReport(reportText);
      if(kind==="ANA")return buildAouAnaLongReport(reportText);
    }
    if(layout==="ULSS6_SCHIAVONIA")return buildUlss6LongReport(reportText,kind);
    return "";
  }
  function getKnownLayoutDisplayName(layout){if(layout==="INLINE_CBC_CHEMISTRY")return "Tabella emocromo / chimica clinica";if(layout==="SYNLAB_DATA_MEDICA")return "SYNLAB / Data Medica";if(layout==="AOU_PADOVA")return "AOU Padova";if(layout==="ULSS6_SCHIAVONIA")return "ULSS 6 / Schiavonia";return "";}

  function sourceSupportScoreForResult(item, reportText) {
    const report = normalizeExamName(reportText);
    if (!report) return 0;

    const rawLabel =
      normalizeExamName(cleanModelLabLabel(item?.raw_label || ""));
    const aiExam =
      normalizeExamName(cleanModelLabLabel(item?.exam || ""));
    const value =
      normalizeExamName(String(item?.value || "").trim());

    let score = 0;

    if (rawLabel && rawLabel.length >= 4 && report.includes(rawLabel)) {
      score += 8;
    }

    if (aiExam && aiExam.length >= 4 && report.includes(aiExam)) {
      score += 4;
    }

    const concept =
      getExamConcept(rawLabel) ||
      getExamConcept(aiExam);

    const conceptTerms = {
      PHOSPHATE: ["FOSFATO", "FOSFATI", "FOSFORO"],
      BILIRUBIN_TOTAL: ["BILIRUBINA"],
      BILIRUBIN_DIRECT: ["BILIRUBINA DIRETTA"],
      BILIRUBIN_INDIRECT: ["BILIRUBINA INDIRETTA"],
      PTH: ["PTH", "PARATORMONE"],
      TSH: ["TSH", "TIREOTROPINA"],
      VITAMIN_D: ["VITAMINA D", "25 OH", "25OH"],
      ALP: ["ALP", "FOSFATASI ALCALINA"],
      PSA_TOTAL: ["PSA", "PSA TOTALE", "ANTIGENE PROSTATICO SPECIFICO"],
      PSA_FREE: ["PSA LIBERO", "FREE PSA", "FPSA"]
    }[concept] || [];

    if (conceptTerms.some(term => report.includes(normalizeExamName(term)))) {
      score += 3;
    }

    if (value && report.includes(value)) {
      score += 1;
    }

    return score;
  }

  function removeUnsupportedDuplicateAssignments(items, reportText) {
    const groups = new Map();

    for (const item of items || []) {
      const value = normalizeValueString(item?.value || "");
      const unit = normalizeUnit(item?.unit || "");

      if (!value || !unit) continue;

      const key = `${value}|${unit}`;

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    const remove = new Set();

    for (const group of groups.values()) {
      if (group.length < 2) continue;

      const concepts = new Set(
        group
          .map(item =>
            getExamConcept(
              `${item?.raw_label || ""} ${item?.exam || ""}`
            )
          )
          .filter(Boolean)
      );

      if (concepts.size < 2) continue;

      const scored = group.map(item => ({
        item,
        score: sourceSupportScoreForResult(item, reportText)
      }));

      const bestScore = Math.max(...scored.map(x => x.score));

      // Interviene solo quando c'è una differenza chiara di supporto
      // testuale; valori uguali realmente presenti per due esami restano.
      for (const entry of scored) {
        if (
          bestScore >= 6 &&
          entry.score <= bestScore - 5
        ) {
          remove.add(entry.item);

          console.warn(
            "Segretario MMG: risultato OCR scartato per scarso supporto nel testo:",
            entry.item
          );
        }
      }
    }

    return (items || []).filter(item => !remove.has(item));
  }

  function aiLineHasMeasurement(line) {
    const s = String(line || "");
    return (
      /\d/.test(s) &&
      /(?:mg|mmol|mol|ng|pg|ug|µg|μg|u\/l|ui\/l|mm\/h|%|ml|min|10\^|x10)/i.test(s)
    );
  }

  function aiLineIsClinicalContext(line) {
    const n = normalizeExamName(line);

    if (!n) return false;
    if (aiLineHasMeasurement(line)) return true;

    return (
      /\b(?:SIERO|PLASMA|SANGUE|URINE|EMATOLOGIA|BIOCHIMICA|IMMUNOLOGIA|ENDOCRINOLOGIA|PROFILO|EMOCROMO|URINARIO|PROTEICO)\b/.test(n) ||
      /(?:CREATIN|GLUC|SODIO|POTASS|CALCIO|CLOR|COLESTER|TRIGLIC|ALT|AST|GGT|ALP|FOSFAT|PSA|TSH|FT3|FT4|VITAMINA|PCR|VES|FERRO|FERRIT|BILIR|UREA|URATO|PTH|BNP|HBA1C)/.test(n)
    );
  }

  function isKnownAiChromeLine(line, layout) {
    const s = String(line || "").trim();
    const n = normalizeExamName(s);

    if (!s) return true;
    if (/^(?:AZIENDA\s+ULSS|REGIONE\s+(?:DEL\s+)?VENETO|IMPORTANTE:.*(?:INTERPRETAZIONE|MEDICO))/i.test(s)) return true;

    if (/^===\s*PAGINA\b/i.test(s)) return true;
    if (/^PAG(?:INA)?\.?\s*\d+(?:\s+DI\s+\d+)?$/i.test(s)) return true;

    if (
      /(?:FIRMATO DIGITALMENTE|FIRMA DIGITALE|ELECTRONIC SIGNATURE|QUALIFIED ELECTRONIC SIGNATURE|REFERT[OA]\s+FIRMAT[OA]|EMESSO DA|VALIDATO DA|VALIDAZIONE CLINICA|COPIA DI REFERTO|INFORMAZIONE AI SENSI|DOCUMENTO INFORMATICO)/i.test(s)
    ) return true;

    if (
      /(?:WWW\.|HTTPS?:\/\/|@[\w.-]+|TEL\.?|TELEFONO|FAX|P\.?\s*IVA|CODICE FISCALE|C\.F\.|REA\b|CAP\.?\s*SOCIALE)/i.test(s)
    ) return true;

    if (
      /^(?:INDIRIZZO|VIA|VIALE|PIAZZA|CORSO)\b/i.test(s) &&
      !aiLineHasMeasurement(s)
    ) return true;

    if (
      /(?:CODICE A BARRE|BARCODE|ACCETTAZIONE|NUMERO ACCETTAZIONE|N\.?\s*ACCETTAZIONE|PRENOTAZIONE CUP)/i.test(s)
    ) return true;

    if (layout === "AOU_PADOVA") {
      if (
        /(?:AZIENDA OSPEDALE UNIVERSITA DI PADOVA|AZIENDA OSPEDALIERA DI PADOVA|U\.?\s*O\.?\s*C\.?\s+MEDICINA DI LABORATORIO|DIPARTIMENTO DI MEDICINA DI LABORATORIO|DIRETTORE)/i.test(s)
      ) return true;
    }

    if (layout === "SYNLAB_DATA_MEDICA") {
      if (
        /(?:SYNLAB|DATA MEDICA|LABORATORIO ANALISI DATA MEDICA)/i.test(s) &&
        !aiLineIsClinicalContext(s)
      ) return true;
    }

    if (layout === "ULSS6_SCHIAVONIA") {
      if (
        /(?:AZIENDA ULSS\s*N?\.?\s*6\s*EUGANEA|OSPEDALE DI SCHIAVONIA|MEDICINA DI LABORATORIO|DIRETTORE|RESPONSABILE)/i.test(s) &&
        !aiLineIsClinicalContext(s)
      ) return true;
    }

    return false;
  }

  function stripKnownPageChrome(reportText, layout = "") {
    const lines = String(reportText || "")
      .replace(/\r/g, "")
      .split("\n");

    // Individua le pagine usando i marker prodotti da PDF.js/Paddle/Qwen.
    let pageIndex = 0;
    const pageLines = [[]];

    for (const line of lines) {
      if (/^===\s*PAGINA\b/i.test(String(line || "").trim())) {
        pageIndex += 1;
        if (!pageLines[pageIndex]) pageLines[pageIndex] = [];
        continue;
      }
      pageLines[pageIndex].push(line);
    }

    // Righe ripetute su almeno due pagine e non cliniche sono quasi sempre
    // intestazioni/piè pagina. Le rimuoviamo solo dal testo destinato a Qwen.
    const repeatedCount = new Map();

    for (const page of pageLines) {
      const seen = new Set();

      for (const raw of page) {
        const line = String(raw || "").trim();
        const key = normalizeExamName(line);

        if (
          !key ||
          key.length < 5 ||
          aiLineIsClinicalContext(line) ||
          aiLineHasMeasurement(line)
        ) {
          continue;
        }

        seen.add(key);
      }

      for (const key of seen) {
        repeatedCount.set(
          key,
          (repeatedCount.get(key) || 0) + 1
        );
      }
    }

    const repeatedNoise = new Set(
      [...repeatedCount.entries()]
        .filter(([, count]) => count >= 2)
        .map(([key]) => key)
    );

    const kept = [];

    for (const raw of lines) {
      const line = String(raw || "").trim();
      if (!line) continue;

      const key = normalizeExamName(line);

      if (isKnownAiChromeLine(line, layout)) continue;

      if (
        repeatedNoise.has(key) &&
        !aiLineIsClinicalContext(line) &&
        !aiLineHasMeasurement(line)
      ) {
        continue;
      }

      kept.push(line);
    }

    return kept.join("\n").trim();
  }

  function collectConsumedAiLineKeys(parserExtraction) {
    const keys = new Set();

    for (const item of parserExtraction?.results || []) {
      for (const value of [
        item?.evidence,
        item?.raw_label
      ]) {
        const key = normalizeExamName(String(value || ""));
        if (key.length >= 5) keys.add(key);
      }
    }

    // Anche un esame riconosciuto deterministicamente ma non presente nella
    // Grid è già "spiegato" dal parser. Non deve far scattare il recupero
    // semantico di Qwen per target Eumed del tutto assenti.
    for (const item of parserExtraction?.recognizedNotInGrid || []) {
      for (const value of [
        item?.evidence,
        item?.raw_label
      ]) {
        const key = normalizeExamName(String(value || ""));
        if (key.length >= 5) keys.add(key);
      }
    }

    for (const item of parserExtraction?.longReports || []) {
      for (const line of String(item?.text || "").split(/\r?\n/)) {
        const key = normalizeExamName(line);
        if (key.length >= 5) keys.add(key);
      }
    }

    return keys;
  }

  function removeConsumedAiLines(reportText, parserExtraction) {
    const consumed = collectConsumedAiLineKeys(parserExtraction);

    if (!consumed.size) return String(reportText || "").trim();

    const out = [];

    for (const raw of String(reportText || "").split(/\r?\n/)) {
      const line = String(raw || "").trim();
      if (!line) continue;

      const key = normalizeExamName(line);

      let remove = false;

      if (consumed.has(key)) {
        remove = true;
      } else if (aiLineHasMeasurement(line)) {
        // Evidence dei parser tabellari può essere "nome | valore | unità"
        // mentre nel testo originale ci sono TAB/spazi. Per le sole righe
        // con misura accettiamo anche containment forte.
        for (const consumedKey of consumed) {
          if (
            consumedKey.length >= 10 &&
            (
              key.includes(consumedKey) ||
              consumedKey.includes(key)
            )
          ) {
            remove = true;
            break;
          }
        }
      }

      if (!remove) out.push(line);
    }

    return out.join("\n").trim();
  }

  function collectStrongResolvedTargets(parserExtraction, targetExams) {
    const targets = new Set(targetExams || []);
    const resolved = new Set();

    for (const item of parserExtraction?.results || []) {
      if (!targets.has(item?.exam)) continue;

      // Una prestazione gestita come referto lungo (es. PSA Reflex,
      // emocromo, urine) NON può essere considerata risolta da un singolo
      // valore numerico. Deve esistere il relativo longReport.
      if (getLongReportKind(item.exam)) continue;

      resolved.add(item.exam);
    }

    for (const item of parserExtraction?.longReports || []) {
      if (targets.has(item?.exam) && String(item?.text || "").trim()) {
        resolved.add(item.exam);
      }
    }

    return resolved;
  }

  function buildResidualAiText(
    reportText,
    parserExtraction,
    residualTargets
  ) {
    const layout =
      parserExtraction?.labLayout ||
      detectKnownLabLayout(reportText);

    const withoutChrome =
      stripKnownPageChrome(reportText, layout);

    const withoutConsumed =
      removeConsumedAiLines(
        withoutChrome,
        parserExtraction
      );

    // Ultimo filtro: conserva soltanto le zone pertinenti ai target
    // realmente irrisolti. Se un target non ha keyword forti,
    // buildTargetedReportContext mantiene un fallback clinico/numerico.
    const targeted =
      buildTargetedReportContext(
        withoutConsumed,
        residualTargets
      );

    return (
      targeted ||
      withoutConsumed
    ).trim();
  }

  function targetConceptTerms(exam) {
    const concept = getExamConcept(exam);
    const kind = getLongReportKind(exam);

    const map = {
      TSH:["TSH","TIREOTROPINA"],
      FT4:["FT4","TIROXINA"],
      FT3:["FT3","TRIIODOTIRONINA"],
      CREATININE:["CREATININA"],
      HBA1C:["HBA1C","GLICATA"],
      CALCIUM_TOTAL:["CALCIO"],
      CHOLESTEROL_TOTAL:["COLESTEROLO TOTALE","COLESTEROLO"],
      HDL:["HDL"],
      LDL:["LDL"],
      TRIGLYCERIDES:["TRIGLICERIDI"],
      GLUCOSE:["GLUCOSIO","GLICEMIA"],
      IRON:["FERRO","SIDEREMIA"],
      FERRITIN:["FERRITINA"],
      VITAMIN_D:["VITAMINA D","25 OH","25OH"],
      PHOSPHATE:["FOSFATO","FOSFATI","FOSFORO"],
      PTH:["PTH","PARATORMONE"],
      BILIRUBIN_TOTAL:["BILIRUBINA TOTALE","BILIRUBINA"],
      PCR:["PCR","PROTEINA C REATTIVA"],
      ALT:["ALT","GPT","ALANINA AMINOTRANSFERASI"],
      AST:["AST","GOT","ASPARTATO AMINOTRANSFERASI"],
      GGT:["GGT","GAMMA GLUTAMIL"],
      CK:["CK","CPK","CREATINCHINASI","CREATINA CHINASI"],
      ALP:["ALP","FOSFATASI ALCALINA"],
      PSA_TOTAL:["PSA TOTALE","PSA","ANTIGENE PROSTATICO SPECIFICO"],
      PSA_FREE:["PSA LIBERO","FREE PSA","FPSA"],
      ACR:["RAC","ACR","ALB CRE","ALBUMINA CREATININA"],
      BNP:["BNP","NT PROBNP"],
      UREA:["UREA","AZOTEMIA"],
      URIC_ACID:["ACIDO URICO","URATO"],
      SODIUM:["SODIO"],
      POTASSIUM:["POTASSIO"],
      CHLORIDE:["CLORO","CLORURO"],
      B12:["B12","COBALAMINA"],
      FOLATE:["FOLATO","ACIDO FOLICO"],
      VES:["VES","SEDIMENTAZIONE"],
      LDH:["LDH","LAD","LATTATO DEIDROGENASI"],
      FLC_KAPPA:["FLC KAPPA","CATENE LEGGERE LIBERE KAPPA","KAPPA"],
      FLC_LAMBDA:["FLC LAMBDA","CATENE LEGGERE LIBERE LAMBDA","CATENE LEGGERE LIBERE LAMBA","LAMBDA","LAMBA"],
      FLC_RATIO:["FLC KAPPA LAMBDA","FLC KAPPA/LAMBDA","KAPPA LAMBDA"]
    };

    const terms = new Set(
      (map[concept] || []).map(normalizeExamName).filter(Boolean)
    );

    if (kind === "EMOCROMO") {
      ["EMOCROMO","EMOCITOMETRICO","PROFILO EMATOLOGICO","WBC","RBC","HGB","HCT","PLT"]
        .forEach(x => terms.add(normalizeExamName(x)));
    } else if (kind === "URINE") {
      ["ESAME URINE","URINE","PESO SPECIFICO","NITRITI","UROBILINOGENO","SEDIMENTO"]
        .forEach(x => terms.add(normalizeExamName(x)));
    } else if (kind === "PROTIDOGRAMMA") {
      ["PROTIDOGRAMMA","ELETTROFORESI","PROFILO PROTEICO"]
        .forEach(x => terms.add(normalizeExamName(x)));
    } else if (kind === "TIPIZZAZIONE_MONOCLONALE") {
      ["TIPIZZAZIONE COMPONENTI MONOCLONALI","IMMUNOSOTTRAZIONE","IMMUNOFISSAZIONE"]
        .forEach(x => terms.add(normalizeExamName(x)));
    } else if (kind === "BENCE_JONES") {
      ["BENCE JONES","PROTEINURIA BENCE JONES","CATENE LEGGERE LIBERE MONOCLONALI"]
        .forEach(x => terms.add(normalizeExamName(x)));
    } else if (kind === "PSA_REFLEX") {
      [
        "PSA TOTALE",
        "PSA LIBERO",
        "FREE PSA",
        "FPSA",
        "ANTIGENE PROSTATICO SPECIFICO"
      ].forEach(x => terms.add(normalizeExamName(x)));
    }

    const examName = normalizeExamName(exam);

    if (
      examName.includes("ANTI ANTIGENI INTRACELLULARI") ||
      /\bANA\b/.test(examName) ||
      /\bENA\b/.test(examName)
    ) {
      if (examName.includes("SPECIFICI") || /\bENA\b/.test(examName)) {
        ["ENA","CTD SCREENING","ANTI ENA"].forEach(t => terms.add(normalizeExamName(t)));
      } else {
        ["ANA","ANTI NUCLEO","HEP2","TITOLO","ASPETTO"].forEach(t => terms.add(normalizeExamName(t)));
      }
    }

    // Solo se non abbiamo già un concetto/cluster forte usiamo i token
    // amministrativi del nome Eumed. Evita termini troppo generici come
    // TOTALE, INCLUSO, TEST, ecc. che allargavano il contesto di Qwen.
    if (!terms.size) {
      for (const token of significantTokens(exam)) {
        if (
          token.length >= 4 &&
          !["TOTALE","INCLUSO","EVENTUALE","ESECUZIONE","AUTOMATICA","RISULTATO","REFLEX"].includes(token)
        ) {
          terms.add(token);
        }
      }

      const cat = matchCatalog(exam)?.entry;
      if (cat) {
        for (const alias of [cat.name, ...(cat.aliases || [])].filter(Boolean)) {
          for (const token of significantTokens(alias)) {
            if (token.length >= 5) terms.add(token);
          }
        }
      }
    }

    return [...terms].filter(x => x.length >= 3);
  }

  function buildTargetedReportContext(reportText, targetExams) {
    const lines =
      String(reportText || "")
        .replace(/\r/g, "")
        .split("\n");

    const selected = new Set();
    // Keep explicit report/signature date evidence for the AI fallback.
    lines.forEach((line,i) => {
      if (/data\s+(?:del\s+)?referto|referto\s+(?:del|firmato)|data\s+(?:firma|validazione)|firmato\s+(?:da|il|digitalmente)/i.test(line)) {
        selected.add(i);
      }
    });

    const lineHasMeasurement = line =>
      /\d/.test(String(line || "")) &&
      /(?:mg|mmol|mol|ng|pg|ug|µg|u\/l|ui\/l|%|ml|min)/i.test(String(line || ""));

    for (const exam of targetExams) {
      const terms = targetConceptTerms(exam);
      const longKind = getLongReportKind(exam);

      for (let i = 0; i < lines.length; i++) {
        const n = normalizeExamName(lines[i]);
        if (!n) continue;

        const hits = terms.filter(term => n.includes(term));
        if (!hits.length) continue;

        const tabular = String(lines[i]).includes("\t");

        let before = 1;
        let after = 2;

        if (longKind) {
          before = 3;
          after = 12;
        } else if (tabular && lineHasMeasurement(lines[i])) {
          // Output Paddle layout-aware: nome, valore, unità e range sono
          // già sulla stessa riga. Non includere risultati delle righe vicine.
          before = 0;
          after = 0;
          for (let j=i+1; j<Math.min(lines.length,i+4); j++) {
            if (/^\s*(?:Metodo|Materiale)\s*:/i.test(lines[j])) selected.add(j);
            else break;
          }
        }

        for (
          let j = Math.max(0, i - before);
          j <= Math.min(lines.length - 1, i + after);
          j++
        ) {
          selected.add(j);
        }
      }
    }

    let ordered = [...selected].sort((a, b) => a - b);

    if (!ordered.length) {
      ordered = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => {
          const s = String(line || "").trim();
          if (!s) return false;

          return (
            /\d/.test(s) ||
            /EMOCROM|URIN|PROTE|TSH|FT[34]|VITAM|BILIR|CREAT|GLUC|COLESTER|TRIGLIC|FERRO|FERRIT|PCR|VES|BNP|PTH|PSA|CPK|CK|SODIO|POTASSIO|CALCIO|ALT|AST/i.test(s)
          );
        })
        .map(x => x.index);
    }

    let out = "";
    const maxChars = Math.min(
      7200,
      Math.max(
        2600,
        (targetExams?.length || 1) * 1350
      )
    );

    for (const i of ordered) {
      const piece = String(lines[i] || "").trim();
      if (!piece) continue;

      if (out.length + piece.length + 1 > maxChars) break;
      out += piece + "\n";
    }

    return out.trim();
  }


  function chooseBoundQwenTargetResolution(item) {
    const targetExam = cleanModelLabLabel(item?.exam || "");
    const rawLabel = cleanModelLabLabel(item?.raw_label || "");
    const unit = String(item?.unit || "").trim();

    const exactAvailable = getAvailableExams().find(
      exam => normalizeExamName(exam) === normalizeExamName(targetExam)
    );

    if (!exactAvailable) {
      return {
        resolution: {
          success: false,
          reason: "bound_target_missing",
          candidates: []
        },
        preferredQuery: targetExam,
        concept: getExamConcept(targetExam),
        mismatch: true
      };
    }

    const targetConcept = getExamConcept(exactAvailable);
    const rawConcept = getExamConcept(rawLabel);
    const targetSpecimen = detectSpecimen(exactAvailable);
    const rawSpecimen = detectSpecimen(rawLabel);

    // Un resolver semantico non può scavalcare una matrice esplicita.
    if (rawSpecimen) {
      if (targetSpecimen && rawSpecimen !== targetSpecimen) {
        return {
          resolution: {
            success: false,
            reason: "specimen_mismatch",
            candidates: []
          },
          preferredQuery: rawLabel || targetExam,
          concept: rawConcept || targetConcept,
          mismatch: true
        };
      }

      // Per una riga urinaria, se il target non dichiara alcuna matrice,
      // richiediamo almeno che il nome Eumed sia esplicitamente urinario.
      if (
        rawSpecimen === "URINE" &&
        !targetSpecimen &&
        !/URIN|URINA|URINAR|MICROALBUMIN|ALBUMINUR/i.test(exactAvailable)
      ) {
        return {
          resolution: {
            success: false,
            reason: "specimen_mismatch",
            candidates: []
          },
          preferredQuery: rawLabel || targetExam,
          concept: rawConcept || targetConcept,
          mismatch: true
        };
      }
    }

    if (
      rawConcept &&
      targetConcept &&
      rawConcept !== targetConcept
    ) {
      return {
        resolution: {
          success: false,
          reason: "concept_mismatch",
          candidates: []
        },
        preferredQuery: rawLabel || targetExam,
        concept: rawConcept,
        mismatch: true
      };
    }

    const concept = rawConcept || targetConcept;

    if (
      concept &&
      unit &&
      !unitCompatibleWithConcept(concept, unit, rawLabel, exactAvailable)
    ) {
      return {
        resolution: {
          success: false,
          reason: "unit_mismatch",
          candidates: []
        },
        preferredQuery: rawLabel || targetExam,
        concept,
        mismatch: true
      };
    }

    return {
      resolution: {
        success: true,
        exam: exactAvailable,
        reason: "qwen_bound_target",
        candidates: [exactAvailable]
      },
      preferredQuery: rawLabel || targetExam,
      concept,
      mismatch: false
    };
  }

  function estimateResolvedGridTargets(rawResults) {
    const groups = new Map();

    for (const item of rawResults || []) {
      const rawValue = String(item?.value || "").trim();

      if (
        !/^[<>≤≥]?\s*[+-]?\d+(?:[.,]\d+)?$/.test(rawValue)
      ) {
        continue;
      }

      const model = item?._qwenBoundTarget
        ? chooseBoundQwenTargetResolution(item)
        : chooseResolutionForModelResult(
            cleanModelLabLabel(item?.exam || ""),
            cleanModelLabLabel(item?.raw_label || ""),
            String(item?.unit || "")
          );

      if (!model?.resolution?.success) continue;

      const exam = model.resolution.exam;

      // Non usare un valore numerico per dichiarare risolta una prestazione
      // complessa: il relativo long report verrà costruito separatamente.
      if (getLongReportKind(exam)) continue;

      const concept =
        model.concept ||
        getExamConcept(exam);

      const numericValue =
        rawValue.replace(/^[<>≤≥]\s*/, "");

      const converted = convertMeasurement(
        concept,
        numericValue,
        String(item?.unit || "")
      );

      if (!converted.ok) continue;

      if (!groups.has(exam)) groups.set(exam, []);

      groups.get(exam).push({
        value: converted.value,
        unit: converted.unit,
        concept,
        rawLabel: item?.raw_label || ""
      });
    }

    const resolved = new Set();

    for (const [exam, items] of groups.entries()) {
      if (!items.length) continue;

      const first = items[0];

      const agree = items.every(item =>
        valuesClinicallyEquivalent(
          item.value,
          first.value,
          first.concept
        )
      );

      if (agree) {
        resolved.add(exam);
      }
    }

    return resolved;
  }

  async function extractGridFirstResiduals(reportText, targetExams, progressCallback=null) {
    const results=[], long_reports=[], uncertain=[], dateCandidates=[];
    const candidates=(targetExams||[]).filter(Boolean);
    const batchSize=6;
    let batchesRun=0;
    for(let offset=0;offset<candidates.length;offset+=batchSize){
      const batch=candidates.slice(offset,offset+batchSize);
      const context=buildTargetedReportContext(reportText,batch);
      if(context.length<25)continue;
      batchesRun++;
      progressCallback?.({phase:"target_ai_start",current:offset/batchSize+1,total:Math.ceil(candidates.length/batchSize),targets:batch});
      const parsed=await extractReportChunk(context,batch,Math.floor(offset/batchSize)+1,Math.ceil(candidates.length/batchSize),info=>progressCallback?.({phase:"target_ai_stream",targets:batch,chars:info?.chars||0}));
      results.push(...(parsed.results||[]));
      long_reports.push(...(parsed.long_reports||[]));
      uncertain.push(...(parsed.uncertain||[]));
      if(String(parsed.report_date||"").trim())dateCandidates.push({date:parsed.report_date,evidence:parsed.report_date_evidence});
    }
    return {results,long_reports,uncertain,dateCandidates,batchesRun};
  }

  async function extractFromReport(reportText, progressCallback = null, options = {}) {
    const deterministicOnly=!!options.deterministicOnly;
    const availableExams=getAvailableExams();
    if(!availableExams.length)throw new Error("Nessun esame trovato in Eumed.");
    await ensureLabCatalog();

    const knownLayout=detectKnownLabLayout(reportText);
    const fastMode=!!knownLayout;
    const chunks=[];
    let rawResults=[];
    const rawLongReports=[];
    const uncertain=[];
    const reportDateCandidates=[];
    const longReportSourceChunks=new Map();
    const explicitReportDate=parseExplicitReportDateText(reportText);

    progressCallback?.({phase:"grid_first_parse",layout:knownLayout});

    // 1) Parser deterministico. Anche per layout non noti proviamo prima
    // le righe con matrice (s-/p-/b-/u-), senza IA.
    if(knownLayout==="SYNLAB_DATA_MEDICA"){
      rawResults.push(...extractSpecimenAnchoredResults(reportText));
    } else if(knownLayout==="AOU_PADOVA"){
      rawResults.push(...extractAouPadovaResults(reportText));
      const acr=extractAcrResult(reportText,"AOU_PADOVA"); if(acr)rawResults.push(acr);
    } else if(knownLayout==="ULSS6_SCHIAVONIA"){
      rawResults.push(...extractSpecimenAnchoredResults(reportText));
      rawResults.push(...extractUlss6DirectResults(reportText));
      const acr=extractAcrResult(reportText,"ULSS6_SCHIAVONIA"); if(acr)rawResults.push(acr);
    } else {
      rawResults.push(...extractSpecimenAnchoredResults(reportText));
    }

    // v0.12.7: se il testo proviene dal PaddleOCR layout-aware, prova anche
    // la lettura deterministica delle colonne nome/valore/unità/range.
    rawResults.push(...extractPaddleTabularResults(reportText));

    for(const kind of knownLongReportKinds(knownLayout,reportText)){
      rawLongReports.push({kind,exam:""});
      longReportSourceChunks.set(kind,[reportText]);
    }

    // I referti lunghi possono essere individuati dalla Grid anche in layout
    // non ancora noti, senza chiedere a Qwen di scoprirli.
    for(const exam of availableExams){
      const kind=getLongReportKind(exam);
      if(kind&&reportReallyContainsLongReportKind(reportText,kind)){
        if(!rawLongReports.some(x=>(x.kind||getLongReportKind(x.exam||""))===kind)) rawLongReports.push({kind,exam});
        if(!longReportSourceChunks.has(kind))longReportSourceChunks.set(kind,[reportText]);
      }
    }

    // Ogni layout è già stato parsato una volta nel blocco precedente.
    // Non rieseguire extractSpecimenAnchoredResults(): su AOU questo
    // reintroduceva componenti U-* (es. U-GLUCOSIO 0) accanto al
    // corrispondente esame plasmatico.
    rawResults=removeUnsupportedDuplicateAssignments(
      rawResults,
      reportText
    );

    const parsedPsaReflex =
      buildPsaReflexLongReportFromRawResults(
        rawResults,
        reportText
      );

    if (parsedPsaReflex.text) {
      const psaReflexExam =
        availableExams.find(
          exam => getLongReportKind(exam) === "PSA_REFLEX"
        ) || "";

      if (
        psaReflexExam &&
        !rawLongReports.some(
          x =>
            (
              x.kind ||
              getLongReportKind(x.exam || "")
            ) === "PSA_REFLEX"
        )
      ) {
        rawLongReports.push({
          kind: "PSA_REFLEX",
          exam: psaReflexExam,
          _deterministicText:
            parsedPsaReflex.text
        });

        longReportSourceChunks.set(
          "PSA_REFLEX",
          [reportText]
        );
      }
    }

    const deterministicResolved=estimateResolvedGridTargets(rawResults);
    const longResolved=new Set();
    for(const item of rawLongReports){
      const kind=String(item?.kind||"").trim()||getLongReportKind(item?.exam||"");
      if(!kind)continue;
      const r=resolveLongReportEntry(kind,item?.exam||"",availableExams);
      if(r.success)longResolved.add(r.exam);
    }

    let aiBatches = 0;
    let aiTargets = [];
    let aiResolvedTargets = [];
    let aiLongResolvedTargets = [];

    if (!deterministicOnly) {
      const overrideTargets =
        Array.isArray(options.aiTargetsOverride)
          ? options.aiTargetsOverride.filter(Boolean)
          : null;

      aiTargets =
        overrideTargets ||
        availableExams.filter(
          exam =>
            !deterministicResolved.has(exam) &&
            !longResolved.has(exam)
        );

      progressCallback?.({
        phase: "target_ai_plan",
        targets: aiTargets,
        total: aiTargets.length
      });

      const aiSourceText =
        String(
          options.aiReportTextOverride ||
          reportText ||
          ""
        ).trim();

      progressCallback?.({
        phase: "target_ai_input",
        originalChars: String(reportText || "").length,
        aiChars: aiSourceText.length,
        targets: aiTargets
      });

      const ai =
        await (overrideTargets
          ? extractGridFirstResidualsBound(
              aiSourceText,
              aiTargets,
              progressCallback
            )
          : extractGridFirstResiduals(
              aiSourceText,
              aiTargets,
              progressCallback
            ));

      aiBatches = ai.batchesRun;

      aiResolvedTargets = [
        ...estimateResolvedGridTargets(ai.results)
      ];

      for (const lr of ai.long_reports || []) {
        const kind =
          String(lr?.kind || "").trim() ||
          getLongReportKind(lr?.exam || "");

        if (!kind) continue;

        const resolved =
          resolveLongReportEntry(
            kind,
            lr?.exam || "",
            availableExams
          );

        if (resolved.success) {
          aiLongResolvedTargets.push(resolved.exam);
          longReportSourceChunks.set(kind, [reportText]);
        }
      }

      rawResults.push(...ai.results);
      rawLongReports.push(...ai.long_reports);
      uncertain.push(...ai.uncertain);
      reportDateCandidates.push(...ai.dateCandidates);
    }

    // HbA1c nei PDF tabellari è frequentemente spezzata in più righe
    // (es. "Hb Totale", data storica, %, IFCC). Le rappresentazioni Qwen
    // diventano quindi rumorose/ambigue. Per HbA1c usiamo sempre una sola
    // estrazione deterministica dal testo originale e scartiamo tutte le
    // righe modello correlate.
    const reportContainsHbA1c = isHbA1cLabel(reportText);

    if (reportContainsHbA1c) {
      for (let i = rawResults.length - 1; i >= 0; i--) {
        const originalText = `${rawResults[i]?.exam || ""} ${rawResults[i]?.raw_label || ""}`;
        const cleanedText = cleanModelLabLabel(originalText);

        if (
          isHbA1cLabel(originalText) ||
          isHbA1cLabel(cleanedText) ||
          isHbA1cAuxiliaryLine(originalText) ||
          isHbA1cAuxiliaryLine(cleanedText)
        ) {
          rawResults.splice(i, 1);
        }
      }

      const fallbackHbA1c = extractHbA1cFallback(reportText);
      if (fallbackHbA1c) rawResults.push(fallbackHbA1c);
    }

    let reportDateInfo;

    if (explicitReportDate?.date) {
      reportDateInfo = {
        date: explicitReportDate.date,
        evidence: explicitReportDate.evidence || ""
      };
    } else {
      const safeDateCandidates = reportDateCandidates.filter(item =>
        reportDateEvidenceIsExplicit(item?.evidence || "")
      );

      reportDateInfo = resolveReportDateCandidates(
        safeDateCandidates,
        uncertain
      );
    }

    const longReportGroups = new Map();

    for (const item of rawLongReports) {
      const kind =
        String(item?.kind || "").trim() ||
        getLongReportKind(item?.exam || "");

      if (!kind) continue;

      // Non accettare un referto lungo solo perché Qwen lo ha nominato:
      // deve esserci davvero un'intestazione/cluster compatibile nel testo.
      if (!reportReallyContainsLongReportKind(reportText, kind)) {
        continue;
      }

      if (!longReportGroups.has(kind)) longReportGroups.set(kind, []);
      longReportGroups.get(kind).push(item);
    }

    if (fastMode) {
      for (const kind of knownLongReportKinds(knownLayout, reportText)) {
        if (!longReportGroups.has(kind)) longReportGroups.set(kind, [{kind,exam:""}]);
        longReportSourceChunks.set(kind, [reportText]);
      }
    }

    // Fallback: se il testo contiene esplicitamente una prestazione lunga
    // presente nella Grid, considerala anche se Qwen l'ha persa in uno split.
    for (const exam of availableExams) {
      const kind = getLongReportKind(exam);
      if (!kind) continue;

      const nReport = normalizeExamName(reportText);
      const nExam = normalizeExamName(exam);

      const keywordPresent =
        (kind === "EMOCROMO" && (/EMOCROM/.test(nReport) || reportContainsLongReportCluster(reportText, "EMOCROMO"))) ||
        (kind === "URINE" && (nReport.includes("ESAME URINE") || reportContainsLongReportCluster(reportText, "URINE"))) ||
        (kind === "PROTIDOGRAMMA" && (nReport.includes("PROTIDOGRAM") || nReport.includes("ELETTROFORESI"))) ||
        (kind === "TIPIZZAZIONE_LINFOCITARIA" && (nReport.includes("IMMUNOFENOTIP") || nReport.includes("TBNK"))) ||
        (kind === "PSA_REFLEX" && reportReallyContainsLongReportKind(reportText, "PSA_REFLEX"));

      if (keywordPresent && !longReportGroups.has(kind)) {
        longReportGroups.set(kind, [{ kind, exam }]);
        longReportSourceChunks.set(kind, fastMode ? [reportText] : chunks.slice());
      }
    }

    const detectedLongKinds = new Set(longReportGroups.keys());
    const longReports = [];

    for (const [kind, items] of longReportGroups.entries()) {
      const examHint =
        items.map(x => String(x?.exam || "").trim()).find(Boolean) || "";

      const resolution = resolveLongReportEntry(
        kind,
        examHint,
        availableExams
      );

      if (!resolution.success) {
        uncertain.push({
          text: longReportKindLabel(kind),
          reason:
            resolution.reason === "ambiguous"
              ? "Più righe compatibili presenti in Eumed: " +
                (resolution.candidates || []).join(" | ")
              : "Referto lungo riconosciuto, ma la relativa prestazione non è presente in Eumed."
        });
        continue;
      }

      let source = normalizeLongReportSourceChunks(
        longReportSourceChunks.get(kind) || []
      );

      if (!source) source = String(reportText || "").trim();

      progressCallback?.({
        phase: "long_report_extract",
        current: longReports.length + 1,
        total: longReportGroups.size,
        kind
      });

      let text = "";
      let usedLongReportAi = false;

      const skipLongReportAi =
        Array.isArray(options.skipLongReportAiKinds) &&
        options.skipLongReportAiKinds.includes(kind);

      if (kind === "PSA_REFLEX") {
        text =
          items
            .map(x => String(x?._deterministicText || "").trim())
            .find(Boolean) ||
          buildPsaReflexLongReportFromRawResults(
            rawResults,
            reportText
          ).text ||
          buildPsaReflexLongReport(reportText);
      }

      // Su scansioni OCR con intestazione danneggiata, se il cluster è
      // inequivocabile ricostruisci prima il blocco dal testo Paddle.
      if (
        (kind === "EMOCROMO" || kind === "URINE") &&
        reportContainsLongReportCluster(reportText, kind)
      ) {
        text = genericLongReportSlice(reportText, kind);
      }

      if (!text && fastMode) {
        text =
          extractKnownLongReportText(
            knownLayout,
            kind,
            reportText
          );

        // Se il parser del laboratorio riconosce il blocco ma non riesce
        // a ricostruirne il testo, nella modalità completa usa Qwen
        // SOLO per quel referto lungo.
        if (!text && !deterministicOnly && !skipLongReportAi) {
          progressCallback?.({
            phase: "long_report_ai_fallback",
            kind
          });

          text = await extractLongReportPlainText(
            kind,
            source,
            streamInfo =>
              progressCallback?.({
                phase: "long_report_stream",
                kind,
                chars: streamInfo.chars || 0
              })
          );

          usedLongReportAi = !!text;
        }
      } else if (!text && !deterministicOnly && !skipLongReportAi) {
        text = await extractLongReportPlainText(
          kind,
          source,
          streamInfo =>
            progressCallback?.({
              phase: "long_report_stream",
              kind,
              chars: streamInfo.chars || 0
            })
        );

        usedLongReportAi = !!text;
      }

      if (!text) text = mergeLongReportTexts(items);

      if (!text) {
        uncertain.push({
          text: longReportKindLabel(kind),
          reason: "Referto lungo riconosciuto ma testo non estratto con sufficiente affidabilità."
        });
        continue;
      }

      longReports.push({
        kind,
        exam: resolution.exam,
        text,
        reportDate: reportDateInfo.date,
        evidence: "",
        aiFallback: usedLongReportAi
      });
    }

    const candidates = [];
    const rejected = [];
    const recognizedNotInGrid = [];

    for (const item of rawResults) {
      let aiExam = cleanModelLabLabel(item.exam ?? "");
      let rawLabel = cleanModelLabLabel(item.raw_label ?? "");
      let rawValue = String(item.value ?? "").trim();
      const unit = String(item.unit ?? "").trim();

      let comparatorOriginal = "";
      let comparatorOperator = "";

      if (isHbA1cLabel(`${aiExam} ${rawLabel}`)) {
        aiExam = "EMOGLOBINA GLICATA (HbA1c)";
      }

      const comparatorMatch = rawValue.match(
        /^([<≤>≥])\s*([+-]?\d+(?:[.,]\d+)?)$/
      );

      if (comparatorMatch) {
        if (
          isLongReportComponent(`${rawLabel} ${aiExam}`, detectedLongKinds) ||
          isHbA1cLabel(`${rawLabel} ${aiExam}`) ||
          isHbA1cAuxiliaryLine(`${rawLabel} ${aiExam}`)
        ) {
          continue;
        }

        comparatorOriginal = rawValue;
        comparatorOperator = comparatorMatch[1];

        // Preferenza operativa: <x / ≤x viene scritto come x nel campo Valore,
        // conservando però il referto originale nell'anteprima. Per > / ≥
        // manteniamo il controllo manuale perché la stessa semplificazione è
        // meno intuitiva e non è stata richiesta.
        if (comparatorOperator === "<" || comparatorOperator === "≤") {
          rawValue = comparatorMatch[2];
        } else {
          uncertain.push(
            resolveComparatorResultForPreview(
              aiExam,
              rawLabel,
              rawValue,
              unit
            )
          );
          continue;
        }
      }

      if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(rawValue)) {
        if (
          isLongReportComponent(
            `${rawLabel} ${aiExam}`,
            detectedLongKinds
          )
        ) {
          continue;
        }

        if (
          isHbA1cLabel(`${rawLabel} ${aiExam}`) ||
          isHbA1cAuxiliaryLine(`${rawLabel} ${aiExam}`)
        ) {
          continue;
        }

        // Le risposte del modello possono contenere frammenti di colonne,
        // intestazioni o range. Non mostrarli come errori rossi.
        // Manteniamo soltanto eventuali risultati qualitativi reali come incerti.
        if (/^(POSITIV|NEGATIV|PRESENT|ASSENT|DUBBI|REATTIV)/i.test(rawValue)) {
          uncertain.push({
            text: rawLabel || aiExam || "Risultato qualitativo",
            reason: `Risultato qualitativo riconosciuto: ${rawValue}. Non compilato automaticamente.`
          });
        }
        continue;
      }

      if (
        isHbA1cAuxiliaryLine(`${rawLabel} ${aiExam}`) &&
        rawResults.some(x => isHbA1cLabel(`${x?.exam || ""} ${x?.raw_label || ""}`))
      ) {
        continue;
      }

      // Il rapporto FLC kappa/lambda è spesso riportato come dato accessorio
      // insieme alle due catene. Se non esiste una riga prescritta specifica
      // per il rapporto, non deve diventare un falso errore "non presente in
      // Eumed". Kappa e Lambda restano invece risultati numerici autonomi.
      const rawConceptBeforeResolution = getExamConcept(`${rawLabel} ${aiExam}`);
      if (rawConceptBeforeResolution === "FLC_RATIO") {
        const hasRatioTarget = getAvailableExams().some(exam =>
          getExamConcept(exam) === "FLC_RATIO"
        );
        if (!hasRatioTarget) continue;
      }

      const resolvedModel = item?._qwenBoundTarget
        ? chooseBoundQwenTargetResolution({
            ...item,
            exam: aiExam,
            raw_label: rawLabel,
            unit
          })
        : chooseResolutionForModelResult(
            aiExam,
            rawLabel,
            unit
          );

      let resolution = resolvedModel.resolution;

      if (
        resolution.success &&
        getLongReportKind(resolution.exam) &&
        isLongReportComponent(
          `${rawLabel} ${aiExam}`,
          detectedLongKinds
        )
      ) {
        // Es. PSA totale/libero -> PSA Reflex:
        // non creare un risultato numerico per una riga Eumed complessa.
        continue;
      }

      if (!resolution.success) {
        const componentText = `${rawLabel} ${aiExam}`;

        if (
          isLongReportComponent(
            componentText,
            detectedLongKinds
          )
        ) {
          continue;
        }

        if (
          resolution.reason === "known_not_in_grid" &&
          resolution.catalogEntry
        ) {
          recognizedNotInGrid.push({
            ...item,
            exam: aiExam,
            raw_label: rawLabel,
            catalogName: resolution.catalogEntry.name || "",
            catalogCode: resolution.catalogEntry.code || "",
            reason: "Esame di laboratorio riconosciuto dal catalogo, ma non presente in Eumed"
          });
          continue;
        }

        rejected.push({
          ...item,
          exam: aiExam,
          raw_label: rawLabel,
          reason:
            resolution.reason === "ambiguous"
              ? "Esame ambiguo in Eumed"
              : resolution.reason === "concept_mismatch"
                ? "Etichetta originale e nome interpretato da IA non coerenti"
                : resolution.reason === "specimen_mismatch"
                  ? "Matrice biologica non compatibile con la prestazione in Eumed"
                  : resolution.reason === "unit_mismatch"
                    ? "Unità incompatibile con l'esame interpretato"
                    : "Esame non presente in Eumed",
          candidates: resolution.candidates || []
        });
        continue;
      }

      const resolvedExam = resolution.exam;
      const concept =
        resolvedModel.concept ||
        getExamConcept(`${resolvedExam} ${rawLabel || aiExam}`);

      const resultConversion = convertMeasurement(
        concept,
        rawValue,
        unit
      );

      if (!resultConversion.ok) {
        rejected.push({
          ...item,
          exam: resolvedExam,
          reason: resultConversion.reason
        });
        continue;
      }

      const rangeInput = prepareRangeInput(item, unit);

      const rangeConversion = convertRange(
        concept,
        rangeInput.min,
        rangeInput.max,
        rangeInput.unit,
        // IMPORTANT: il risultato può essere stato normalizzato, ad esempio
        // colesterolo 4,29 mmol/L -> 166 mg/dL. Min/Max devono seguire
        // l'unità FINALE del valore, non quella originale del laboratorio.
        resultConversion.unit
      );

      // Guardia finale: un range automatico non può essere scritto se
      // la sua unità finale non coincide con quella del risultato.
      // Per concetti convertibili riprova esplicitamente nella unità
      // preferita; in caso contrario sopprime Min/Max.
      if (
        rangeConversion.available &&
        !unitsCompatible(
          rangeConversion.unit,
          resultConversion.unit
        )
      ) {
        const repairedRange =
          convertRange(
            concept,
            rangeInput.min,
            rangeInput.max,
            rangeInput.unit,
            resultConversion.unit
          );

        if (
          repairedRange.available &&
          unitsCompatible(
            repairedRange.unit,
            resultConversion.unit
          )
        ) {
          Object.assign(
            rangeConversion,
            repairedRange
          );
        } else {
          rangeConversion.available = false;
          rangeConversion.reason =
            `Min/Max soppressi: unità intervallo (${rangeConversion.unit}) diversa dal valore (${resultConversion.unit})`;
        }
      }

      candidates.push({
        exam: resolvedExam,

        value: resultConversion.value,
        unit: resultConversion.unit,

        originalValue: resultConversion.originalValue,
        originalUnit: resultConversion.originalUnit,
        converted: resultConversion.converted,

        refMin: rangeConversion.available ? rangeConversion.min : "",
        refMax: rangeConversion.available ? rangeConversion.max : "",
        refUnit: rangeConversion.available ? rangeConversion.unit : "",

        originalRefMin:
          rangeConversion.available ? rangeConversion.originalMin : "",
        originalRefMax:
          rangeConversion.available ? rangeConversion.originalMax : "",
        originalRefUnit:
          rangeConversion.available ? rangeConversion.originalUnit : "",

        rangeConverted:
          rangeConversion.available ? rangeConversion.converted : false,

        rangeAvailable: rangeConversion.available,
        rangeReason: rangeConversion.reason || "",

        referenceText: String(item.reference_text ?? "").trim(),
        raw_label: rawLabel,
        evidence: String(item.evidence ?? ""),
        sourceEvidence: item._sourceEvidence || null,
        ai_exam: aiExam,
        concept,

        comparatorOriginal,
        comparatorOperator,
        comparatorOriginalWithUnit:
          comparatorOriginal
            ? `${comparatorOriginal}${unit ? " " + unit : ""}`
            : "",

        reportDate: reportDateInfo.date
      });
    }

    const hasBilirubinTotalCandidate = candidates.some(item =>
      item.concept === "BILIRUBIN_TOTAL" &&
      normalizeExamName(item.exam || "").includes("BILIRUBINA REFLEX")
    );

    if (hasBilirubinTotalCandidate) {
      for (let i = rejected.length - 1; i >= 0; i--) {
        const concept = getExamConcept(
          `${rejected[i]?.raw_label || ""} ${rejected[i]?.exam || ""}`
        );
        if (["BILIRUBIN_DIRECT", "BILIRUBIN_INDIRECT"].includes(concept)) {
          rejected.splice(i, 1);
        }
      }

      for (let i = recognizedNotInGrid.length - 1; i >= 0; i--) {
        const concept = getExamConcept(
          `${recognizedNotInGrid[i]?.catalogName || ""} ${recognizedNotInGrid[i]?.raw_label || ""} ${recognizedNotInGrid[i]?.exam || ""}`
        );
        if (["BILIRUBIN_DIRECT", "BILIRUBIN_INDIRECT"].includes(concept)) {
          recognizedNotInGrid.splice(i, 1);
        }
      }
    }

    const grouped = new Map();

    for (const item of candidates) {
      if (!grouped.has(item.exam)) grouped.set(item.exam, []);
      grouped.get(item.exam).push(item);
    }

    const results = [];

    for (const [exam, items] of grouped.entries()) {
      const first = items[0];
      const concept = first.concept;

      const preferredUnit =
        normalizeUnit(PREFERRED_UNITS[concept] || "");

      const directPreferred = preferredUnit
        ? items.filter(item =>
            !item.converted &&
            normalizeUnit(item.unit) === preferredUnit
          )
        : [];

      const comparisonItems =
        directPreferred.length
          ? directPreferred
          : items;

      const comparisonFirst = comparisonItems[0];

      const sameResults = comparisonItems.every(
        item => valuesClinicallyEquivalent(
          item.value,
          comparisonFirst.value,
          concept
        )
      );

      if (!sameResults) {
        uncertain.push({
          text: exam,
          reason:
            "Più risultati differenti rilevati nel referto: " +
            comparisonItems
              .map(x => `${x.value}${x.unit ? " " + x.unit : ""}`)
              .join(", ")
        });
        continue;
      }

      const best =
        directPreferred[0] ||
        chooseBestEquivalentItem(items);
      const validRanges = items.filter(item => item.rangeAvailable);

      // Se il laboratorio riporta anche una seconda rappresentazione già
      // nell'unità preferita (es. glucosio 76 mg/dL), conserva comunque
      // il range convertito della rappresentazione mmol/L equivalente.
      if (!best.rangeAvailable && validRanges.length === 1) {
        const sourceRange = validRanges[0];

        // Copia il range solo se è già nella stessa unità del risultato
        // selezionato. Per lipidi/glucosio/etc. il range viene convertito
        // prima in mg/dL.
        if (
          unitsCompatible(
            sourceRange.refUnit,
            best.unit
          )
        ) {
          best.refMin = sourceRange.refMin;
          best.refMax = sourceRange.refMax;
          best.refUnit = sourceRange.refUnit;
          best.originalRefMin = sourceRange.originalRefMin;
          best.originalRefMax = sourceRange.originalRefMax;
          best.originalRefUnit = sourceRange.originalRefUnit;
          best.rangeConverted = sourceRange.rangeConverted;
          best.rangeAvailable = true;
          best.rangeReason = sourceRange.rangeReason || "";
        } else {
          best.rangeReason =
            `Intervallo disponibile solo in ${sourceRange.refUnit}; risultato normalizzato in ${best.unit}`;
        }
      }

      if (validRanges.length > 1) {
        const baseRange = validRanges[0];

        const rangesAgree = validRanges.every(item =>
          sameNumericValue(item.refMin, baseRange.refMin) &&
          sameNumericValue(item.refMax, baseRange.refMax)
        );

        if (!rangesAgree) {
          best.refMin = "";
          best.refMax = "";
          best.refUnit = "";
          best.rangeAvailable = false;
          best.rangeReason =
            "Intervalli di riferimento discordanti rilevati nel referto";
        }
      }

      const comparatorSource =
        items.find(item => item.comparatorOriginal) || null;

      if (comparatorSource) {
        best.comparatorOriginal =
          comparatorSource.comparatorOriginal;
        best.comparatorOperator =
          comparatorSource.comparatorOperator;
        best.comparatorOriginalWithUnit =
          comparatorSource.comparatorOriginalWithUnit;
      }

      best.reportDate = reportDateInfo.date;
      results.push(best);
    }

    const hasBilirubinReflexResult = results.some(item =>
      getExamConcept(`${item.exam || ""} ${item.raw_label || ""}`) === "BILIRUBIN_TOTAL" &&
      normalizeExamName(item.exam || "").includes("BILIRUBINA REFLEX")
    );

    function recognizedItemShadowedByResolved(item) {
      const itemConcept = getExamConcept(
        `${item?.catalogName || ""} ${item?.raw_label || ""} ${item?.exam || ""}`
      );

      if (!itemConcept) return false;

      const itemSpecimen =
        detectSpecimen(item?.raw_label || item?.exam || "");

      return results.some(result => {
        const resultConcept = getExamConcept(
          `${result?.exam || ""} ${result?.raw_label || ""}`
        );

        if (resultConcept !== itemConcept) return false;

        const resultSpecimen =
          detectSpecimen(result?.raw_label || result?.exam || "");

        // Mai assorbire un risultato urinario dentro uno sierico o viceversa.
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

    const recognizedAfterInclusions = hasBilirubinReflexResult
      ? recognizedNotInGrid.filter(item => {
          const concept = getExamConcept(
            `${item.catalogName || ""} ${item.raw_label || ""} ${item.exam || ""}`
          );
          return !["BILIRUBIN_DIRECT", "BILIRUBIN_INDIRECT"].includes(concept);
        })
      : recognizedNotInGrid;

    if (hasBilirubinReflexResult) {
      for (let i = rejected.length - 1; i >= 0; i--) {
        const concept = getExamConcept(
          `${rejected[i]?.raw_label || ""} ${rejected[i]?.exam || ""}`
        );

        if (["BILIRUBIN_DIRECT", "BILIRUBIN_INDIRECT"].includes(concept)) {
          rejected.splice(i, 1);
        }
      }
    }

    const cleanedRecognized =
      dedupeRecognizedNotInGrid(
        recognizedAfterInclusions.filter(
          item => !recognizedItemShadowedByResolved(item)
        )
      );

    const cleanedUncertain = cleanUncertainItems(
      uncertain,
      {
        results,
        longReports,
        recognizedNotInGrid: cleanedRecognized
      }
    );

    const cleanedRejected = cleanRejectedItems(
      rejected,
      reportText,
      {
        results,
        longReports,
        recognizedNotInGrid: cleanedRecognized,
        uncertain: cleanedUncertain
      }
    );

    return {
      results,
      longReports,
      recognizedNotInGrid: cleanedRecognized,
      rejected: cleanedRejected,
      uncertain: cleanedUncertain,
      chunks: chunks.length,
      analysisMode: deterministicOnly ? "grid_first_deterministic" : "grid_first_hybrid",
      deterministicResolvedCount: deterministicResolved.size,
      targetedAiBatches: aiBatches,
      targetedAiTargets: aiTargets,
      targetedAiResolvedTargets: aiResolvedTargets,
      targetedAiLongResolvedTargets:
        [...new Set(aiLongResolvedTargets)],
      longReportAiFallbacks:
        longReports.filter(x => x.aiFallback).length,
      labLayout: knownLayout,
      labLayoutName: getKnownLayoutDisplayName(knownLayout),
      reportDate: reportDateInfo.date,
      reportDateEvidence: reportDateInfo.evidence
    };
  }

  // Ricostruzione delle righe di testo dalle pagine PDF.

  function textContentToLines(textContent) {
    const items = (textContent?.items || [])
      .filter(item => typeof item?.str === "string" && item.str.trim());

    if (!items.length) return "";

    // Content-stream order is not reading order: group baselines first.
    const rows = [];
    for (const item of items.slice().sort((a,b) => b.transform[5]-a.transform[5])) {
      const y = Number(item.transform[5]);
      let row = rows.find(r => Math.abs(r.y-y) <= 2.5);
      if (!row) { row = {y, items:[]}; rows.push(row); }
      row.items.push(item);
    }
    return rows.map(row => {
      const ordered = row.items.sort((a,b) => a.transform[4]-b.transform[4]);
      let text = '', right = null;
      for (const item of ordered) {
        const x = Number(item.transform[4]);
        const gap = right === null ? 0 : x-right;
        text += (right === null ? '' : gap > 12 ? '\t' : ' ') + item.str.trim();
        right = x + Number(item.width || 0);
      }
      return text.trim();
    }).filter(Boolean).join('\n');
  }

  // Analisi per inserimento senza prescrizioni ed elenco prescrizioni.


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

  // Flusso esiti prescritti: piano parser, residui IA, merge e audit.


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

  // Content script Eumed: interfaccia, automazione Vaadin, file locali e collegamento a Ollama.


  function extensionContextIsValid() {
    try {
      if (
        typeof chrome === "undefined" ||
        !chrome.runtime ||
        !chrome.runtime.id
      ) {
        return false;
      }

      const testUrl =
        chrome.runtime.getURL("manifest.json");

      return !!testUrl;
    } catch {
      return false;
    }
  }

  function makeExtensionContextError(stage = "") {
    const suffix = stage ? ` (${stage})` : "";
    const error = new Error(
      "Il contesto dell'estensione Chrome è stato invalidato" +
      suffix +
      ". Ricarica la pagina Eumed (Ctrl+Shift+R) e riseleziona il file. " +
      "Non è necessario riavviare Ollama."
    );
    error.code = "EXTENSION_CONTEXT_INVALIDATED";
    return error;
  }

  function assertExtensionContext(stage = "") {
    if (!extensionContextIsValid()) {
      throw makeExtensionContextError(stage);
    }
  }

  function extensionUrl(path, stage = "") {
    assertExtensionContext(stage);

    try {
      return chrome.runtime.getURL(path);
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        throw makeExtensionContextError(stage);
      }
      throw error;
    }
  }

  // Evita doppie istanze dopo reload manuale dell'estensione.
  try {
    document.getElementById("segretario-mmg-host")?.remove();
  } catch {}

  // v0.14.3: attese adattive. Invece di pagare sempre una pausa fissa
  // prima di controllare il DOM Vaadin, verifica subito e poi riprova a
  // intervalli brevi fino allo stesso timeout massimo usato in precedenza.
  // Sui PC/pagine veloci si prosegue quasi subito; sulle pagine lente la
  // tolleranza resta invariata.
  async function pollUntil(check, timeoutMs, intervalMs = 30) {
    const startedAt = Date.now();

    while (true) {
      try {
        const value = check();
        if (value) return value;
      } catch {}

      if (Date.now() - startedAt >= timeoutMs) {
        return null;
      }

      await sleep(intervalMs);
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function sameDateValue(a, b) {
    const x = normalizeDateValue(a);
    const y = normalizeDateValue(b);
    return Boolean(x && y && x === y);
  }

  function vaadinClick(el) {
    if (!el) throw new Error("Elemento da cliccare assente.");

    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;

    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0
    };

    el.dispatchEvent(new MouseEvent("mouseover", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mousemove", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
  }

  function getGridRows() {
    return [
      ...document.querySelectorAll(
        ".v-grid-body tr.v-grid-row.v-grid-row-has-data"
      )
    ];
  }

  // Vaadin 8 usa una Grid virtualizzata: il DOM contiene soltanto le righe
  // visibili e un piccolo buffer. Manteniamo quindi un indice locale di
  // tutte le prestazioni incontrate durante una scansione verticale.
  const eumedGridIndex = new Map();

  // v0.13.3:
  // Vaadin virtualizza la Grid e la stessa prestazione può essere presente
  // più volte con differenti "Data prescriz.". eumedGridIndex resta l'indice
  // dei nomi unici; qui conserviamo invece TUTTE le varianti datate viste
  // durante la scansione.
  const eumedGridSnapshots = new Map();

  // Data referto da usare per scegliere, tra righe duplicate, la prescrizione
  // valida più recente con Data prescriz. <= Data referto.
  const preferredReportDateByExam = new Map();

  let eumedGridScrollContainer = null;

  function findEumedGridScrollContainer() {
    if (eumedGridScrollContainer && eumedGridScrollContainer.isConnected) return eumedGridScrollContainer;
    const body = document.querySelector(".v-grid-body");
    if (!body) return null;
    const grid = body.closest(".v-grid") || body.parentElement?.closest(".v-grid");
    const direct = grid?.querySelector(".v-grid-scroller-vertical") || document.querySelector(".v-grid-scroller-vertical");
    if (direct) {
      eumedGridScrollContainer = direct;
      return direct;
    }
    let current = body;
    while (current) {
      if (Number(current.scrollHeight||0) > Number(current.clientHeight||0) + 4) {
        eumedGridScrollContainer = current;
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function scoreEumedSnapshot(cells) {
    const columns = [
      CONFIG.resultDateColumn,
      CONFIG.valueColumn,
      CONFIG.resultColumn,
      CONFIG.minColumn,
      CONFIG.maxColumn
    ].filter(Number.isInteger);

    let empty = 0;

    for (const index of columns) {
      if (!String(cells[index] || "").trim()) {
        empty += 1;
      }
    }

    return empty;
  }

  function snapshotPrescriptionDate(snapshot) {
    return normalizeDateValue(
      snapshot?.cells?.[
        CONFIG.prescriptionDateColumn
      ] || ""
    );
  }

  function rowPrescriptionDate(row) {
    if (!row) return "";

    const cells = [
      ...row.querySelectorAll("td.v-grid-cell")
    ];

    return normalizeDateValue(
      cells[
        CONFIG.prescriptionDateColumn
      ]?.textContent?.trim() || ""
    );
  }

  function dateToDayNumber(value) {
    const iso = normalizeDateValue(value);
    if (!iso) return null;

    const [y, m, d] = iso
      .split("-")
      .map(Number);

    return Math.floor(
      Date.UTC(y, m - 1, d) / 86400000
    );
  }

  function setPreferredReportDateForExam(
    examName,
    reportDate
  ) {
    const iso =
      normalizeDateValue(reportDate);

    if (!examName || !iso) return;

    const previous =
      preferredReportDateByExam.get(examName);

    if (previous !== iso) {
      preferredReportDateByExam.set(
        examName,
        iso
      );

      // La cache riga deve essere rivalutata quando cambia il referto.
      examRowSelectionCache.delete(examName);
    }
  }

  function rememberEumedSnapshot(snapshot) {
    const name = snapshot?.name;
    if (!name) return;

    if (!eumedGridSnapshots.has(name)) {
      eumedGridSnapshots.set(name, []);
    }

    const list = eumedGridSnapshots.get(name);

    const prescriptionRaw =
      String(
        snapshot.cells[
          CONFIG.prescriptionDateColumn
        ] || ""
      ).trim();

    const prescriptionIso =
      normalizeDateValue(
        prescriptionRaw
      );

    // La data di prescrizione è il discriminante principale. Se due righe
    // hanno la stessa data, per la scrittura sono equivalenti: conserva
    // quella più vuota / meglio utilizzabile.
    const existingIndex =
      list.findIndex(item =>
        (
          snapshotPrescriptionDate(item) &&
          snapshotPrescriptionDate(item) === prescriptionIso
        ) ||
        (
          !prescriptionIso &&
          String(
            item.cells[
              CONFIG.prescriptionDateColumn
            ] || ""
          ).trim() === prescriptionRaw
        )
      );

    if (existingIndex < 0) {
      list.push(snapshot);
      return;
    }

    if (
      snapshot.score >
      Number(list[existingIndex]?.score || 0)
    ) {
      list[existingIndex] = snapshot;
    }
  }

  function chooseSnapshotForReportDate(
    examName,
    reportDate = ""
  ) {
    const list =
      eumedGridSnapshots.get(examName) ||
      [];

    if (!list.length) {
      return eumedGridIndex.get(examName) || null;
    }

    const reportIso =
      normalizeDateValue(
        reportDate ||
        preferredReportDateByExam.get(examName) ||
        ""
      );

    // Se non abbiamo ancora una data referto (fase di lettura/analisi),
    // manteniamo il comportamento storico: riga più vuota.
    if (!reportIso) {
      return [...list]
        .sort((a, b) =>
          Number(b.score || 0) -
          Number(a.score || 0)
        )[0] || null;
    }

    const reportDay =
      dateToDayNumber(reportIso);

    const dated = list
      .map(snapshot => ({
        snapshot,
        prescriptionIso:
          snapshotPrescriptionDate(snapshot),
        day:
          dateToDayNumber(
            snapshotPrescriptionDate(snapshot)
          )
      }))
      .filter(item =>
        item.prescriptionIso &&
        Number.isFinite(item.day)
      );

    const validPrior = dated
      .filter(item =>
        item.day <= reportDay
      )
      .sort((a, b) =>
        // Più vicina al referto = data prescrizione più recente.
        b.day - a.day ||
        Number(b.snapshot.score || 0) -
        Number(a.snapshot.score || 0)
      );

    if (validPrior.length) {
      return validPrior[0].snapshot;
    }

    // Se c'è una sola riga, non cambiamo il comportamento storico.
    // Il vincolo forte viene applicato alle duplicazioni reali.
    if (list.length === 1) {
      return list[0];
    }

    // Più righe ma nessuna prescrizione precedente/uguale al referto:
    // NON scegliere automaticamente una prescrizione futura.
    return null;
  }

  function getDuplicateExamCount(examName) {
    return (
      eumedGridSnapshots.get(examName)?.length ||
      0
    );
  }

  function captureVisibleEumedRows() {
    const container =
      findEumedGridScrollContainer();

    const scrollTop =
      Number(container?.scrollTop || 0);

    for (const row of getGridRows()) {
      const cells = [
        ...row.querySelectorAll("td.v-grid-cell")
      ].map(cell => cell.textContent.trim());

      const name =
        cells[CONFIG.examNameColumn]?.trim();

      if (!name) continue;

      const snapshot = {
        name,
        cells,
        scrollTop,
        score: scoreEumedSnapshot(cells)
      };

      rememberEumedSnapshot(snapshot);

      const previous =
        eumedGridIndex.get(name);

      // L'indice principale continua a rappresentare una riga generica
      // utilizzabile per discovery/target. Le duplicazioni reali vengono
      // gestite da eumedGridSnapshots al momento della scrittura.
      if (
        !previous ||
        snapshot.score > previous.score
      ) {
        eumedGridIndex.set(name, snapshot);
      }
    }
  }

  async function scanAllEumedRows(
    onProgress = null,
    { clear = true } = {}
  ) {
    if (clear) {
      eumedGridIndex.clear();
      eumedGridSnapshots.clear();
      examRowSelectionCache.clear();
    }

    captureVisibleEumedRows();

    const container =
      findEumedGridScrollContainer();

    if (!container) {
      return {
        count: eumedGridIndex.size,
        virtualized: false
      };
    }

    const originalTop =
      Number(container.scrollTop || 0);

    const maxScroll = Math.max(
      0,
      container.scrollHeight -
        container.clientHeight
    );

    const step = Math.max(
      140,
      Math.floor(
        Number(container.clientHeight || 300) * 0.72
      )
    );

    const positions = [0];

    for (
      let pos = step;
      pos < maxScroll;
      pos += step
    ) {
      positions.push(pos);
    }

    if (
      maxScroll > 0 &&
      positions[positions.length - 1] !== maxScroll
    ) {
      positions.push(maxScroll);
    }

    for (let i = 0; i < positions.length; i++) {
      container.scrollTop = positions[i];
      container.dispatchEvent(
        new Event("scroll", { bubbles: true })
      );

      await sleep(260);
      captureVisibleEumedRows();

      onProgress?.({
        current: i + 1,
        total: positions.length,
        count: eumedGridIndex.size
      });
    }

    container.scrollTop =
      Math.min(
        originalTop,
        Math.max(
          0,
          container.scrollHeight -
            container.clientHeight
        )
      );

    container.dispatchEvent(
      new Event("scroll", { bubbles: true })
    );

    await sleep(180);
    captureVisibleEumedRows();

    return {
      count: eumedGridIndex.size,
      virtualized: positions.length > 1
    };
  }

  async function ensureExamRowVisible(
    examName,
    attempts = 2,
    reportDate = ""
  ) {
    const reportIso =
      normalizeDateValue(
        reportDate ||
        preferredReportDateByExam.get(examName) ||
        ""
      );

    let row =
      getPreferredExamRow(
        examName,
        reportIso
      );

    if (row) return row;

    const container =
      findEumedGridScrollContainer();

    if (!container) return null;

    const snapshot =
      chooseSnapshotForReportDate(
        examName,
        reportIso
      );

    // Se è un duplicato e non esiste alcuna prescrizione valida precedente
    // al referto, non cercare/forzare una riga futura.
    if (
      reportIso &&
      getDuplicateExamCount(examName) > 1 &&
      !snapshot
    ) {
      return null;
    }

    if (snapshot) {
      container.scrollTop =
        Number(snapshot.scrollTop || 0);

      container.dispatchEvent(
        new Event("scroll", { bubbles: true })
      );

      row = await pollUntil(() => {
        captureVisibleEumedRows();
        return getPreferredExamRow(
          examName,
          reportIso
        );
      }, 220, 25);

      if (row) return row;
    }

    // Fallback mirato: riscorri la Grid finché compare la riga corretta
    // (nome + Data prescriz. quando il referto la rende discriminante).
    for (
      let attempt = 0;
      attempt < attempts;
      attempt++
    ) {
      const maxScroll = Math.max(
        0,
        container.scrollHeight -
          container.clientHeight
      );

      const step = Math.max(
        140,
        Math.floor(
          Number(container.clientHeight || 300) *
          0.72
        )
      );

      for (
        let pos = 0;
        pos <= maxScroll;
        pos += step
      ) {
        container.scrollTop =
          Math.min(pos, maxScroll);

        container.dispatchEvent(
          new Event("scroll", { bubbles: true })
        );

        row = await pollUntil(() => {
          captureVisibleEumedRows();
          return getPreferredExamRow(
            examName,
            reportIso
          );
        }, 150, 25);

        if (row) return row;
      }

      if (maxScroll > 0) {
        container.scrollTop = maxScroll;

        container.dispatchEvent(
          new Event("scroll", { bubbles: true })
        );

        row = await pollUntil(() => {
          captureVisibleEumedRows();
          return getPreferredExamRow(
            examName,
            reportIso
          );
        }, 170, 25);

        if (row) return row;
      }
    }

    return null;
  }

  function getAvailableExams() {
    captureVisibleEumedRows();

    return [
      ...eumedGridIndex.keys()
    ];
  }

  function getCachedExamCells(examName) {
    const visible =
      findExamRows(examName)[0] || null;

    if (visible) {
      return [
        ...visible.querySelectorAll("td.v-grid-cell")
      ].map(cell => cell.textContent.trim());
    }

    return (
      eumedGridIndex.get(examName)?.cells ||
      null
    );
  }

  function isEumedExamEmpty(examName) {
    const cells =
      getCachedExamCells(examName);

    if (!cells) return false;

    const value =
      cells[CONFIG.valueColumn]?.trim() || "";

    const result =
      cells[CONFIG.resultColumn]?.trim() || "";

    if (getLongReportKind(examName)) {
      return (
        normalizeExamName(result) !== "VEDI REFERTO"
      );
    }

    return !value && !result;
  }

  function getEmptyEumedExams() {
    return getAvailableExams()
      .filter(isEumedExamEmpty);
  }

  function findExamRows(examName) {
    return getGridRows().filter(row => {
      const cells = [...row.querySelectorAll("td.v-grid-cell")];

      return cells.some(cell => cell.textContent.trim() === examName);
    });
  }

  // Se la stessa prestazione compare più volte nella Grid:
  // - scegli una Data prescriz. <= Data referto;
  // - se sono più di una, usa la più vicina al referto;
  // - a parità di data, preferisci la riga più vuota.
  const examRowSelectionCache = new Map();

  function scoreExamRowForSelection(row) {
    const cells = [...row.querySelectorAll("td.v-grid-cell")];

    const interestingColumns = [
      CONFIG.resultDateColumn,
      CONFIG.valueColumn,
      CONFIG.resultColumn,
      CONFIG.minColumn,
      CONFIG.maxColumn
    ].filter(index => Number.isInteger(index));

    let emptyCount = 0;

    for (const index of interestingColumns) {
      const value = cells[index]?.textContent?.trim() || "";
      if (!value) emptyCount += 1;
    }

    let score = emptyCount * 10;

    try {
      if (isVisibleElement(row)) score += 3;
    } catch {}

    return score;
  }

  function getPreferredExamRow(
    examName,
    reportDate = ""
  ) {
    captureVisibleEumedRows();

    const rows = findExamRows(examName);
    if (!rows.length) return null;

    const reportIso =
      normalizeDateValue(
        reportDate ||
        preferredReportDateByExam.get(examName) ||
        ""
      );

    const targetSnapshot =
      chooseSnapshotForReportDate(
        examName,
        reportIso
      );

    const desiredPrescriptionDate =
      snapshotPrescriptionDate(
        targetSnapshot
      );

    const selectionKey =
      `${reportIso}|${desiredPrescriptionDate}`;

    const cached =
      examRowSelectionCache.get(examName);

    if (
      cached?.row &&
      cached.row.isConnected &&
      rows.includes(cached.row) &&
      cached.selectionKey === selectionKey
    ) {
      return cached.row;
    }

    let candidates = [...rows];

    if (
      desiredPrescriptionDate
    ) {
      const exact = candidates.filter(
        row =>
          rowPrescriptionDate(row) ===
          desiredPrescriptionDate
      );

      if (exact.length) {
        candidates = exact;
      } else if (
        getDuplicateExamCount(examName) > 1
      ) {
        // La riga giusta non è nel viewport corrente.
        return null;
      }
    } else if (
      reportIso &&
      getDuplicateExamCount(examName) > 1
    ) {
      console.warn(
        `Segretario MMG: "${examName}" presente in più righe, ` +
        `ma nessuna Data prescriz. è <= Data referto ${formatDateForGrid(reportIso)}. ` +
        "Inserimento automatico non eseguito su una prescrizione futura."
      );
      return null;
    }

    const selected =
      candidates
        .map((row, index) => ({
          row,
          index,
          score:
            scoreExamRowForSelection(row)
        }))
        .sort((a, b) =>
          b.score - a.score ||
          a.index - b.index
        )[0]?.row || null;

    if (!selected) return null;

    if (
      getDuplicateExamCount(examName) > 1
    ) {
      const chosenPrescription =
        rowPrescriptionDate(selected);

      log(
        `Prestazione duplicata in Eumed: "${examName}" ` +
        `(${getDuplicateExamCount(examName)} date). ` +
        `Referto ${formatDateForGrid(reportIso)} -> ` +
        `prescrizione ${formatDateForGrid(chosenPrescription)}.`
      );
    }

    examRowSelectionCache.set(
      examName,
      {
        row: selected,
        selectionKey
      }
    );

    return selected;
  }

  function readExamRow(examName) {
    const row = getPreferredExamRow(examName);
    if (!row) return null;

    return [...row.querySelectorAll("td.v-grid-cell")]
      .map(cell => cell.textContent.trim());
  }

  async function loadLabCatalogData() {
    const response = await fetch(
      extensionUrl("lab_catalog.json", "catalogo locale")
    );
    if (!response.ok) {
      throw new Error(`Catalogo laboratorio HTTP ${response.status}`);
    }
    return response.json();
  }

  function typeVaadinChar(input, char) {
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: char,
      bubbles: true,
      cancelable: true
    }));

    input.dispatchEvent(new KeyboardEvent("keypress", {
      key: char,
      bubbles: true,
      cancelable: true
    }));

    input.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertText",
      data: char,
      bubbles: true,
      cancelable: true
    }));

    document.execCommand("insertText", false, char);

    input.dispatchEvent(new KeyboardEvent("keyup", {
      key: char,
      bubbles: true
    }));
  }

  function dispatchVaadinKey(input, type, key, code, keyCode) {
    const event = new KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true
    });

    // GWT/Vaadin 8 può leggere keyCode/which invece di key.
    for (const prop of ["keyCode", "which"]) {
      try {
        Object.defineProperty(event, prop, {
          configurable: true,
          get: () => keyCode
        });
      } catch {}
    }

    input.dispatchEvent(event);
  }

  function vaadinDoubleClick(el) {
    if (!el) return;
    vaadinClick(el);
    vaadinClick(el);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width/2,
      clientY: r.top + r.height/2,
      button: 0, detail: 2
    }));
  }

  async function openGridEditorForExam(examName, preferredColumn, mode = "numeric") {
    await ensureExamRowVisible(examName);
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = getPreferredExamRow(examName);
      if (!row) return null;
      const cells = [...row.querySelectorAll("td.v-grid-cell")];
      const preferred = cells[preferredColumn] || cells[CONFIG.examNameColumn];
      const examCell = cells[CONFIG.examNameColumn];
      const target = attempt < 2 ? preferred : examCell;
      if (!target) return null;
      if (attempt % 2 === 0) vaadinClick(target); else vaadinDoubleClick(target);
      if (mode === "result") {
        const filter = await waitForWritableResultFilter();
        if (filter) return { row: getPreferredExamRow(examName) || row, filter };
      } else {
        // In condizioni normali l'editor compare quasi subito. Il polling
        // parte immediatamente e conserva i retry storici se non compare.
        const fields = await waitForNumericEditor(900);
        if (fields) return { row: getPreferredExamRow(examName) || row, fields };
      }
      await sleep(40);
    }
    return null;
  }

  async function waitForNumericEditor(timeoutMs = CONFIG.editorWaitMs) {
    return await pollUntil(() => {
      const fields = [
        ...document.querySelectorAll(
          ".v-customcomponent.numeric-field input.v-textfield"
        )
      ].filter(el => {
        const r = el.getBoundingClientRect();

        return (
          r.width > 0 &&
          r.height > 0 &&
          getComputedStyle(el).visibility !== "hidden"
        );
      });

      return fields.length === 3 ? fields : null;
    }, timeoutMs, 30);
  }

  async function setExamField(examName, fieldIndex, gridColumn, value, fieldLabel) {
    if (value === null || value === undefined || String(value).trim() === "") {
      return true;
    }

    value = String(value).trim();

    const opened = await openGridEditorForExam(examName, gridColumn, "numeric");

    if (!opened?.fields) {
      console.error(`Segretario MMG: ${fieldLabel} "${examName}": editor numerico Vaadin non aperto.`);
      return false;
    }

    const fields = opened.fields;
    const input = fields[fieldIndex];

    if (!input) {
      console.error(`Segretario MMG: campo ${fieldLabel} non trovato.`);
      return false;
    }

    vaadinClick(input);
    await sleep(80);

    input.select();
    await sleep(40);

    for (const char of value) {
      typeVaadinChar(input, char);
    }

    await sleep(80);

    if (!sameNumericValue(input.value, value)) {
      console.error(
        `Segretario MMG: STOP ${fieldLabel}, input="${input.value}", atteso="${value}".`
      );
      return false;
    }

    input.dispatchEvent(new Event("change", { bubbles: true }));

    input.dispatchEvent(new FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: document.body
    }));

    input.blur();

    await sleep(CONFIG.commitWaitMs);

    const cells = readExamRow(examName);
    if (!cells) return false;

    const gridValue = cells[gridColumn];

    if (!sameNumericValue(gridValue, value)) {
      console.error(
        `Segretario MMG: STOP ${fieldLabel}, Grid="${gridValue}", atteso="${value}".`
      );
      return false;
    }

    log(`${fieldLabel} verificato`, examName, gridValue);
    return true;
  }

  function isUsableDateInput(el) {
    if (!el || el.tagName !== "INPUT") return false;

    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;

    const style = getComputedStyle(el);
    if (
      style.visibility === "hidden" ||
      style.display === "none" ||
      el.disabled ||
      el.readOnly
    ) {
      return false;
    }

    // Escludi gli editor che sappiamo non essere la data.
    if (el.classList.contains("v-filterselect-input")) return false;

    if (
      el.closest(".numeric-field") ||
      el.closest(".v-customcomponent.numeric-field")
    ) {
      return false;
    }

    return true;
  }

  function scoreDateInputForCell(input, dateCell) {
    const ir = input.getBoundingClientRect();
    const cr = dateCell.getBoundingClientRect();

    const ix = ir.left + ir.width / 2;
    const iy = ir.top + ir.height / 2;
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;

    let score = 0;

    const classText = String(input.className || "");
    const parentClass = String(input.parentElement?.className || "");

    if (/datefield/i.test(classText)) score += 300;
    if (/datefield/i.test(parentClass)) score += 220;
    if (input.closest(".v-datefield")) score += 300;

    // Sovrapposizione verticale con la riga e vicinanza alla colonna Data esito.
    const verticalOverlap =
      Math.max(0, Math.min(ir.bottom, cr.bottom) - Math.max(ir.top, cr.top));

    const horizontalOverlap =
      Math.max(0, Math.min(ir.right, cr.right) - Math.max(ir.left, cr.left));

    if (verticalOverlap > 0) score += 120;
    if (horizontalOverlap > 0) score += 180;

    const distance =
      Math.sqrt((ix - cx) ** 2 + (iy - cy) ** 2);

    score -= Math.min(distance, 1000) / 5;

    if (
      /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(
        String(input.value || "")
      )
    ) {
      score += 80;
    }

    return score;
  }

  async function waitForDateInput(dateCell, timeoutMs = CONFIG.editorWaitMs) {
    return await pollUntil(() => {
      // Se il click sulla cella ha portato direttamente il focus
      // sull'input della data, questa è la fonte più affidabile.
      const active = document.activeElement;

      if (isUsableDateInput(active)) {
        const activeScore =
          scoreDateInputForCell(active, dateCell);

        if (activeScore > 80) {
          return active;
        }
      }

      // Vaadin 8 DateField standard.
      const direct = [
        ...document.querySelectorAll(
          ".v-datefield input, " +
          "input.v-datefield-textfield, " +
          "input[class*='datefield']"
        )
      ].filter(isUsableDateInput);

      if (direct.length) {
        direct.sort(
          (a, b) =>
            scoreDateInputForCell(b, dateCell) -
            scoreDateInputForCell(a, dateCell)
        );

        return direct[0];
      }

      // Fallback: input testuale visibile realmente sovrapposto alla cella.
      const allInputs = [
        ...document.querySelectorAll("input")
      ].filter(isUsableDateInput);

      const scored = allInputs
        .map(el => ({
          el,
          score: scoreDateInputForCell(el, dateCell)
        }))
        .sort((a, b) => b.score - a.score);

      return scored[0]?.score > 100
        ? scored[0].el
        : null;
    }, timeoutMs, 30);
  }

  function logDateEditorDiagnostics(dateCell) {
    try {
      const cr = dateCell?.getBoundingClientRect();

      const inputs = [
        ...document.querySelectorAll("input")
      ]
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map(el => ({
          class: String(el.className || ""),
          value: el.value || "",
          readonly: !!el.readOnly,
          disabled: !!el.disabled,
          rect: {
            left: Math.round(el.getBoundingClientRect().left),
            top: Math.round(el.getBoundingClientRect().top),
            width: Math.round(el.getBoundingClientRect().width),
            height: Math.round(el.getBoundingClientRect().height)
          },
          html: el.outerHTML.slice(0, 1200)
        }));

      const dateButtons = [
        ...document.querySelectorAll(".v-datefield-button")
      ]
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map(el => el.parentElement?.outerHTML?.slice(0, 2500) || el.outerHTML);

      console.error(
        "Segretario MMG: diagnostica DateField",
        {
          dateCell: cr ? {
            left: Math.round(cr.left),
            top: Math.round(cr.top),
            width: Math.round(cr.width),
            height: Math.round(cr.height)
          } : null,
          activeElement: document.activeElement?.outerHTML?.slice(0, 1500) || "",
          visibleInputs: inputs,
          visibleDateFields: dateButtons
        }
      );
    } catch {}
  }

  function selectWholeVaadinInput(input) {
    if (!input) return;

    try { input.focus(); } catch {}

    try {
      input.select();
    } catch {}

    try {
      input.setSelectionRange(
        0,
        String(input.value || "").length
      );
    } catch {}

    // Evento legacy utile a GWT; la selezione vera viene comunque
    // applicata tramite select()/setSelectionRange().
    try {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "a",
          code: "KeyA",
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      );
      input.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "a",
          code: "KeyA",
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    } catch {}
  }

  function setNativeInputValue(input, value) {
    try {
      const proto =
        typeof HTMLTextAreaElement !== "undefined" && input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;

      const setter =
        Object.getOwnPropertyDescriptor(
          proto,
          "value"
        )?.set;

      if (setter) {
        setter.call(input, value);
      } else {
        input.value = value;
      }

      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          inputType: "insertReplacementText",
          data: value
        })
      );

      return true;
    } catch {
      return false;
    }
  }

  async function replaceVaadinDateInputFast(
    input,
    target,
    isoDate
  ) {
    vaadinClick(input);
    await sleep(35);

    // FAST PATH: sostituisce l'intera data in un'unica operazione.
    selectWholeVaadinInput(input);
    await sleep(20);

    try {
      document.execCommand(
        "insertText",
        false,
        target
      );
    } catch {}

    await sleep(35);

    if (sameDateValue(input.value, isoDate)) {
      return true;
    }

    // Secondo fast path: setter nativo + evento input.
    selectWholeVaadinInput(input);
    setNativeInputValue(input, target);
    await sleep(35);

    if (sameDateValue(input.value, isoDate)) {
      return true;
    }

    // Fallback legacy: pulizia e digitazione carattere per carattere,
    // conservata per le build Vaadin/GWT che ignorano insertText.
    selectWholeVaadinInput(input);

    try {
      document.execCommand("delete", false);
    } catch {}

    if (String(input.value || "").trim()) {
      try {
        const setter =
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
          )?.set;

        setter?.call(input, "");
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentBackward"
          })
        );
      } catch {}
    }

    for (const char of target) {
      typeVaadinChar(input, char);
    }

    await sleep(55);

    return sameDateValue(
      input.value,
      isoDate
    );
  }

  async function setExamDate(examName, reportDate) {
    const isoDate = normalizeDateValue(reportDate);
    if (!isoDate) return true;

    setPreferredReportDateForExam(
      examName,
      isoDate
    );

    const visibleRow =
      await ensureExamRowVisible(
        examName,
        2,
        isoDate
      );

    if (!visibleRow) {
      console.error(
        `Segretario MMG: Data referto "${examName}": nessuna riga Eumed compatibile con Data prescriz. <= ${formatDateForGrid(isoDate)}.`
      );
      return false;
    }

    const target = formatDateForGrid(isoDate);
    const current = readExamRow(examName)?.[CONFIG.resultDateColumn] || "";

    if (sameDateValue(current, isoDate)) {
      log("Data già corretta", examName, current);
      return true;
    }

    const row = getPreferredExamRow(examName);

    if (!row) {
      console.error(
        `Segretario MMG: Data referto "${examName}": nessuna riga trovata.`
      );
      return false;
    }
    const cells = [...row.querySelectorAll("td.v-grid-cell")];

    const dateCell = cells[CONFIG.resultDateColumn];

    if (!dateCell) {
      console.error(
        `Segretario MMG: STOP, cella Data esito non trovata per "${examName}".`
      );
      return false;
    }

    // Apri l'editor direttamente sulla colonna Data esito.
    // È più affidabile che aprire la riga cliccando sul nome esame.
    vaadinClick(dateCell);

    let input = await waitForDateInput(dateCell, 650);

    // Alcune build Vaadin richiedono un secondo click sulla cella già
    // focalizzata prima di materializzare l'editor. Manteniamo il fallback
    // ma senza pagare 120 ms fissi quando il primo click è sufficiente.
    if (!input) {
      vaadinClick(dateCell);
      input = await waitForDateInput(dateCell, CONFIG.editorWaitMs);
    }

    if (!input) {
      logDateEditorDiagnostics(dateCell);

      console.error(
        "Segretario MMG: STOP, campo Data esito non individuato nell'editor."
      );
      return false;
    }

    const replaced =
      await replaceVaadinDateInputFast(
        input,
        target,
        isoDate
      );

    if (!replaced) {
      console.error(
        `Segretario MMG: STOP Data referto, input="${input.value}", atteso="${target}".`
      );
      return false;
    }

    // Vaadin 8 DateField non sempre committa con il solo blur.
    // Enter forza il parsing/commit del valore digitato nel widget GWT.
    dispatchVaadinKey(input, "keydown", "Enter", "Enter", 13);
    dispatchVaadinKey(input, "keypress", "Enter", "Enter", 13);
    dispatchVaadinKey(input, "keyup", "Enter", "Enter", 13);

    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: document.body
    }));
    input.blur();

    // Forza anche l'uscita dall'editor della riga, come per il FilterSelect.
    const commitCell =
      cells[CONFIG.prescriptionDateColumn ?? 1] ||
      cells[CONFIG.examNameColumn];

    if (commitCell) {
      vaadinClick(commitCell);
    }

    const verifyTimeoutMs =
      Math.max(
        CONFIG.commitWaitMs,
        1400
      );

    const startedAt = Date.now();
    let gridDate =
      readExamRow(examName)?.[CONFIG.resultDateColumn] || "";

    while (
      !sameDateValue(gridDate, isoDate) &&
      Date.now() - startedAt < verifyTimeoutMs
    ) {
      await sleep(35);
      gridDate =
        readExamRow(examName)?.[CONFIG.resultDateColumn] || "";
    }

    if (!sameDateValue(gridDate, isoDate)) {
      console.error(
        `Segretario MMG: STOP Data referto dopo commit, Grid="${gridDate}", atteso="${target}".`
      );
      return false;
    }

    log("Data referto verificata", examName, gridDate);
    return true;
  }

  async function resetGridEditorForFieldRetry(examName) {
    try {
      const row = getPreferredExamRow(examName);
      if (!row) return;

      const cells = [...row.querySelectorAll("td.v-grid-cell")];
      const resetCell =
        cells[CONFIG.examNameColumn] ||
        cells[CONFIG.prescriptionDateColumn ?? 1];

      if (resetCell) {
        vaadinClick(resetCell);
        await sleep(180);
      }

      const target = document.activeElement || document.body;
      dispatchVaadinKey(target, "keydown", "Escape", "Escape", 27);
      dispatchVaadinKey(target, "keyup", "Escape", "Escape", 27);
      await sleep(100);
    } catch {}
  }

  async function setExamFieldResilient(
    examName,
    fieldIndex,
    gridColumn,
    value,
    label,
    attempts = 3
  ) {
    if (value === null || value === undefined || String(value).trim() === "") {
      return {
        requested: false,
        verified: true,
        label,
        expected: "",
        current: ""
      };
    }

    const expected = String(value).trim();

    const already =
      readExamRow(examName)?.[gridColumn]?.trim() || "";

    if (sameNumericValue(already, expected)) {
      return {
        requested: true,
        verified: true,
        label,
        expected,
        current: already
      };
    }

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        await resetGridEditorForFieldRetry(examName);
      }

      const ok = await setExamField(
        examName,
        fieldIndex,
        gridColumn,
        expected,
        label
      );

      if (ok) {
        const current =
          readExamRow(examName)?.[gridColumn]?.trim() || "";

        return {
          requested: true,
          verified: true,
          label,
          expected,
          current
        };
      }

      // Vaadin può aggiornare la cella leggermente dopo il timeout interno.
      for (let i = 0; i < 6; i++) {
        await sleep(150);

        const current =
          readExamRow(examName)?.[gridColumn]?.trim() || "";

        if (sameNumericValue(current, expected)) {
          log(
            `${label} confermato in ritardo`,
            examName,
            current
          );

          return {
            requested: true,
            verified: true,
            label,
            expected,
            current
          };
        }
      }
    }

    const current =
      readExamRow(examName)?.[gridColumn]?.trim() || "";

    console.warn(
      `Segretario MMG: ${label} non verificato per "${examName}". ` +
      `Grid="${current}", atteso="${expected}". La compilazione prosegue.`
    );

    return {
      requested: true,
      verified: false,
      label,
      expected,
      current
    };
  }

  async function setExamRecord(item) {
    if (item.reportDate) {
      setPreferredReportDateForExam(
        item.exam,
        item.reportDate
      );
    }

    await ensureExamRowVisible(
      item.exam,
      2,
      item.reportDate || ""
    );

    // v0.14.1:
    // FAST PATH: apre UNA sola volta l'editor numerico Vaadin e compila
    // Min / Max / Valore nello stesso editor. Dopo un unico commit verifica
    // tutte le celle. Solo i campi non confermati ricadono nel vecchio
    // percorso resiliente, mantenendo quindi le stesse garanzie di sicurezza.
    const defs = [
      {
        key: "min",
        label: "Min",
        fieldIndex: 1,
        gridColumn: CONFIG.minColumn,
        value: item.refMin
      },
      {
        key: "max",
        label: "Max",
        fieldIndex: 2,
        gridColumn: CONFIG.maxColumn,
        value: item.refMax
      },
      {
        key: "value",
        label: "Valore",
        fieldIndex: 0,
        gridColumn: CONFIG.valueColumn,
        value: item.value
      }
    ];

    const fieldResults = {
      min: null,
      max: null,
      value: null
    };

    const pending = [];

    for (const def of defs) {
      const expected =
        def.value === null || def.value === undefined
          ? ""
          : String(def.value).trim();

      if (!expected) {
        fieldResults[def.key] = {
          requested: false,
          verified: true,
          label: def.label,
          expected: "",
          current: ""
        };
        continue;
      }

      const current =
        readExamRow(item.exam)?.[def.gridColumn]?.trim() || "";

      if (sameNumericValue(current, expected)) {
        fieldResults[def.key] = {
          requested: true,
          verified: true,
          label: def.label,
          expected,
          current
        };
        continue;
      }

      pending.push({
        ...def,
        expected
      });
    }

    if (pending.length) {
      const preferredColumn =
        pending.find(x => x.key === "value")?.gridColumn ||
        pending[0].gridColumn;

      const opened =
        await openGridEditorForExam(
          item.exam,
          preferredColumn,
          "numeric"
        );

      if (opened?.fields) {
        for (const def of pending) {
          const input =
            opened.fields[def.fieldIndex];

          if (!input) continue;

          vaadinClick(input);
          await sleep(25);

          selectWholeVaadinInput(input);
          await sleep(15);

          // Manteniamo la digitazione legacy che sappiamo essere accettata
          // da GWT/Vaadin; il guadagno deriva dall'aprire/committare la riga
          // una sola volta, non dal forzare setter DOM più aggressivi.
          for (const char of def.expected) {
            typeVaadinChar(input, char);
          }

          await sleep(30);

          if (sameNumericValue(input.value, def.expected)) {
            input.dispatchEvent(
              new Event("change", { bubbles: true })
            );
          }
        }

        // Un solo commit dell'intera riga.
        const row =
          getPreferredExamRow(item.exam) ||
          opened.row;

        const cells =
          row
            ? [...row.querySelectorAll("td.v-grid-cell")]
            : [];

        const commitCell =
          cells[CONFIG.examNameColumn] ||
          cells[CONFIG.prescriptionDateColumn ?? 1];

        if (commitCell) {
          vaadinClick(commitCell);
        } else {
          const active =
            document.activeElement;

          try {
            active?.dispatchEvent(
              new FocusEvent("focusout", {
                bubbles: true,
                relatedTarget: document.body
              })
            );
            active?.blur?.();
          } catch {}
        }

        const verifyTimeoutMs =
          Math.max(
            CONFIG.commitWaitMs + 250,
            900
          );

        const startedAt =
          Date.now();

        let allConfirmed = false;

        while (
          !allConfirmed &&
          Date.now() - startedAt < verifyTimeoutMs
        ) {
          await sleep(35);

          const currentRow =
            readExamRow(item.exam);

          allConfirmed =
            !!currentRow &&
            pending.every(def =>
              sameNumericValue(
                currentRow[def.gridColumn],
                def.expected
              )
            );
        }
      }

      // Verifica finale del fast path. Ogni campo rimasto non confermato
      // usa il percorso resiliente storico, indipendentemente dagli altri.
      for (const def of pending) {
        const current =
          readExamRow(item.exam)?.[def.gridColumn]?.trim() || "";

        if (sameNumericValue(current, def.expected)) {
          fieldResults[def.key] = {
            requested: true,
            verified: true,
            label: def.label,
            expected: def.expected,
            current
          };

          log(
            `${def.label} verificato (fast row)`,
            item.exam,
            current
          );

          continue;
        }

        fieldResults[def.key] =
          await setExamFieldResilient(
            item.exam,
            def.fieldIndex,
            def.gridColumn,
            def.expected,
            def.label,
            3
          );
      }
    }

    return {
      exam: item.exam,
      fields: fieldResults,
      allVerified:
        fieldResults.min.verified &&
        fieldResults.max.verified &&
        fieldResults.value.verified
    };
  }

  async function resetGridEditorForDateRetry(examName) {
    try {
      const row = getPreferredExamRow(examName);
      if (!row) return;

      const cells = [...row.querySelectorAll("td.v-grid-cell")];
      const resetCell =
        cells[CONFIG.examNameColumn] ||
        cells[CONFIG.prescriptionDateColumn ?? 1];

      if (resetCell) {
        vaadinClick(resetCell);
        await sleep(220);
      }

      // Escape aiuta a chiudere eventuali editor GWT rimasti sospesi.
      const target = document.activeElement || document.body;
      dispatchVaadinKey(target, "keydown", "Escape", "Escape", 27);
      dispatchVaadinKey(target, "keyup", "Escape", "Escape", 27);
      await sleep(120);
    } catch {}
  }

  async function setExamDateResilient(
    examName,
    reportDate,
    attempts = 3
  ) {
    await ensureExamRowVisible(examName);

    const isoDate = normalizeDateValue(reportDate);
    if (!isoDate) return true;

    const already =
      readExamRow(examName)?.[CONFIG.resultDateColumn] || "";

    if (sameDateValue(already, isoDate)) return true;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        await resetGridEditorForDateRetry(examName);
      }

      const ok = await setExamDate(examName, reportDate);
      if (ok) return true;

      // Prima di riprovare controlla comunque la Grid:
      // talvolta Vaadin aggiorna in ritardo dopo che setExamDate
      // ha già concluso il proprio timeout.
      for (let i = 0; i < 4; i++) {
        await sleep(120);

        const current =
          readExamRow(examName)?.[CONFIG.resultDateColumn] || "";

        if (sameDateValue(current, isoDate)) {
          log(
            "Data referto confermata in ritardo",
            examName,
            current
          );
          return true;
        }
      }
    }

    return false;
  }

  async function setExamRecords(items, onProgress = null) {
    const completed = [];
    const fieldStatus = [];
    const fieldWarnings = [];
    const dateVerified = [];
    const dateWarnings = [];

    // v0.14.4: la Data esito resta SEMPRE la prima modifica della riga.
    // Se Vaadin non rende subito visibile il commit, non generiamo però
    // immediatamente un warning: il successivo commit dell'editor numerico
    // può completare anche il DateField rimasto pendente. In quel caso la
    // data viene ricontrollata dopo Min/Max/Valore e, solo se ancora diversa,
    // viene eseguito un unico rescue mirato prima del warning finale.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let dateWasImmediatelyVerified = !item.reportDate;

      if (item.reportDate) {
        onProgress?.(
          i + 1,
          items.length,
          item,
          "dates"
        );

        dateWasImmediatelyVerified =
          await setExamDateResilient(
            item.exam,
            item.reportDate,
            3
          );

        if (dateWasImmediatelyVerified) {
          dateVerified.push(item.exam);
        } else {
          console.info(
            `Segretario MMG: Data esito di "${item.exam}" non ancora confermata; ` +
            "verifica rinviata dopo il commit della riga."
          );
        }

        await sleep(20);
      }

      onProgress?.(
        i + 1,
        items.length,
        item,
        "values"
      );

      const status =
        await setExamRecord(item);

      completed.push(item);
      fieldStatus.push(status);

      for (const key of ["min", "max", "value"]) {
        const field = status.fields[key];

        if (
          field?.requested &&
          !field.verified
        ) {
          fieldWarnings.push({
            exam: item.exam,
            field: field.label,
            expected: field.expected,
            current: field.current
          });
        }
      }

      // Seconda fase di verifica data: prima osserva se il commit numerico
      // ha reso visibile la data già inserita. Solo in caso contrario tenta
      // una singola correzione finale. Questo elimina i falsi warning senza
      // indebolire la verifica e senza rallentare le righe normali.
      if (item.reportDate && !dateWasImmediatelyVerified) {
        const isoDate = normalizeDateValue(item.reportDate);
        let gridValue = "";

        const becameVisible = await pollUntil(() => {
          gridValue =
            readExamRow(item.exam)?.[
              CONFIG.resultDateColumn
            ] || "";

          return sameDateValue(gridValue, isoDate)
            ? gridValue
            : null;
        }, 650, 35);

        let finalDateOk = !!becameVisible;

        if (!finalDateOk) {
          finalDateOk =
            await setExamDateResilient(
              item.exam,
              item.reportDate,
              1
            );
        }

        gridValue =
          readExamRow(item.exam)?.[
            CONFIG.resultDateColumn
          ] || gridValue || "";

        if (finalDateOk || sameDateValue(gridValue, isoDate)) {
          dateVerified.push(item.exam);
          log(
            "Data referto confermata dopo commit riga",
            item.exam,
            gridValue
          );
        } else {
          dateWarnings.push({
            exam: item.exam,
            expected:
              formatDateForGrid(
                item.reportDate
              ),
            current: gridValue
          });

          console.warn(
            `Segretario MMG: Data esito realmente non verificata per "${item.exam}". ` +
            `Grid="${gridValue}", atteso="${formatDateForGrid(item.reportDate)}".`
          );
        }
      }

      await sleep(30);
    }

    return {
      success: true,
      completed,
      fieldStatus,
      fieldWarnings,
      dateVerified,
      dateWarnings
    };
  }


  // ============================================================
  // REFERTO LUNGO VAADIN
  // ============================================================

  function isVisibleElement(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);

    return (
      r.width > 0 &&
      r.height > 0 &&
      s.display !== "none" &&
      s.visibility !== "hidden"
    );
  }

  async function waitForWritableResultFilter() {
    const loops = Math.ceil(CONFIG.editorWaitMs / 100);

    for (let i = 0; i < loops; i++) {
      await sleep(100);

      const inputs = [
        ...document.querySelectorAll(".v-filterselect-input")
      ].filter(el =>
        isVisibleElement(el) &&
        !el.disabled &&
        !el.readOnly &&
        !el.classList.contains("v-filterselect-input-readonly")
      );

      if (inputs.length === 1) return inputs[0];

      // Nell'editor noto ci sono due filterselect:
      // il primo editabile = Risultato, il secondo readonly = Eseguito presso.
      if (inputs.length > 1) return inputs[0];
    }

    return null;
  }

  function dispatchLegacyKey(input, type, key, code, keyCode) {
    const event = new KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true
    });

    for (const prop of ["keyCode", "which", "charCode"]) {
      try {
        Object.defineProperty(event, prop, {
          configurable: true,
          get: () => keyCode
        });
      } catch {}
    }

    input.dispatchEvent(event);
  }

  function filterSelectCandidateScore(candidateText, targetText) {
    const rawCandidate = String(candidateText || "").trim().toUpperCase();
    const rawTarget = String(targetText || "").trim().toUpperCase();

    // v0.15.33: quando il filtro è un codice CVP/Eumed, il codice della
    // proposta deve coincidere ESATTAMENTE. Un codice padre/prefisso non deve
    // poter selezionare un fratello (es. 90.56.3_2 CEA vs 90.56.3_3 GLYPICAN).
    const codePattern = /^\d{2}\.\d{2}\.[A-Z0-9]+(?:_[A-Z0-9]+)?$/;
    if (codePattern.test(rawTarget)) {
      const codes = rawCandidate.match(/\b\d{2}\.\d{2}\.[A-Z0-9]+(?:_[A-Z0-9]+)?\b/g) || [];
      if (codes.length) {
        return codes.includes(rawTarget) ? 12000 : 0;
      }
    }

    const text = normalizeExamName(candidateText);
    const target = normalizeExamName(targetText);
    if (!text || !target) return 0;

    if (text === target) return 10000;

    // Vaadin/GWT puo' aggiungere alla stessa cella codice amministrativo,
    // spazi o markup non visibili: se il nome catalogo completo e' contenuto
    // nella proposta, la consideriamo comunque una corrispondenza fortissima.
    if (text.includes(target)) {
      return 9000 - Math.min(1000, Math.max(0, text.length - target.length));
    }

    if (target.includes(text) && text.length >= Math.min(18, target.length)) {
      return 8000 - Math.min(1000, Math.max(0, target.length - text.length));
    }

    const tTokens = significantTokens(target);
    const cTokens = significantTokens(text);
    if (!tTokens.length || !cTokens.length) return 0;

    const cSet = new Set(cTokens);
    const matched = tTokens.filter(token => cSet.has(token)).length;
    const coverage = matched / tTokens.length;
    const reverse = matched / cTokens.length;

    if (coverage === 1 && reverse >= 0.55) {
      return 7000 + Math.round(reverse * 500);
    }
    if (coverage >= 0.8 && matched >= 3 && reverse >= 0.5) {
      return 5000 + Math.round(coverage * 500 + reverse * 250);
    }

    return 0;
  }

  function findVisibleFilterSelectOption(targetText) {
    const selectors = [
      ".v-filterselect-suggestpopup .gwt-MenuItem",
      ".v-filterselect-suggestpopup td",
      ".v-filterselect-suggestpopup tr",
      ".gwt-SuggestBoxPopup .gwt-MenuItem",
      ".gwt-SuggestBoxPopup td",
      ".gwt-SuggestBoxPopup tr",
      ".v-filterselect-suggestmenu .gwt-MenuItem",
      ".v-filterselect-suggestmenu td",
      "[role='option']"
    ];

    const seen = new Set();
    let best = null;
    let bestScore = 0;

    for (const selector of selectors) {
      for (const candidate of document.querySelectorAll(selector)) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        if (!isActuallyVisibleInViewport(candidate) && !isVisibleElement(candidate)) continue;

        const score = filterSelectCandidateScore(
          String(candidate.textContent || "").trim(),
          targetText
        );
        if (!score || score <= bestScore) continue;

        const clickable =
          candidate.closest(
            ".gwt-MenuItem, td.gwt-MenuItem, [role='option'], tr"
          ) || candidate;

        if (clickable.closest(".v-grid-body")) continue;

        best = clickable;
        bestScore = score;
      }
    }

    return best;
  }

  async function waitForFilterSelectOption(targetText, timeoutMs = 1800) {
    const loops = Math.ceil(timeoutMs / 100);

    for (let i = 0; i < loops; i++) {
      const option = findVisibleFilterSelectOption(targetText);
      if (option) return option;
      await sleep(100);
    }

    return null;
  }

  async function typeFilterText(input, targetText) {
    vaadinClick(input);
    await sleep(80);
    input.select();
    await sleep(30);

    for (const char of targetText) {
      typeVaadinChar(input, char);
    }

    await sleep(220);
  }

  async function chooseFilterSelectOption(input, targetText) {
    const wrapper = input.closest(".v-filterselect");
    const dropButton = wrapper?.querySelector(".v-filterselect-button");

    // 1) Apri la vera tendina e prova a cliccare la voce reale.
    vaadinClick(input);
    await sleep(80);

    if (dropButton) {
      vaadinClick(dropButton);
      await sleep(180);
    }

    let option = await waitForFilterSelectOption(targetText, 1000);

    if (option) {
      vaadinClick(option);
      await sleep(300);

      // Non richiediamo che il vecchio input conservi il valore:
      // Vaadin può chiudere/ricreare l'editor subito dopo la selezione.
      return true;
    }

    // 2) Filtra digitando e clicca la proposta reale.
    await typeFilterText(input, targetText);
    option = await waitForFilterSelectOption(targetText, 1200);

    if (option) {
      vaadinClick(option);
      await sleep(300);
      return true;
    }

    // 3) Fallback GWT: testo filtrato + ArrowDown + Enter con keyCode/which.
    // È importante usare gli eventi legacy perché Vaadin 8/GWT spesso
    // non legge soltanto KeyboardEvent.key.
    dispatchLegacyKey(input, "keydown", "ArrowDown", "ArrowDown", 40);
    dispatchLegacyKey(input, "keyup", "ArrowDown", "ArrowDown", 40);
    await sleep(100);

    dispatchLegacyKey(input, "keydown", "Enter", "Enter", 13);
    dispatchLegacyKey(input, "keypress", "Enter", "Enter", 13);
    dispatchLegacyKey(input, "keyup", "Enter", "Enter", 13);
    await sleep(320);

    // A questo punto la verifica vera viene fatta sulla Grid dal chiamante.
    return true;
  }

  async function waitForGridText(examName, column, expectedText, timeoutMs = 3000) {
    const expected = normalizeExamName(expectedText);
    const loops = Math.ceil(timeoutMs / 100);

    for (let i = 0; i < loops; i++) {
      const value = readExamRow(examName)?.[column]?.trim() || "";
      if (normalizeExamName(value) === expected) return value;
      await sleep(100);
    }

    return "";
  }

  async function setExamResultVediReferto(examName) {
    await ensureExamRowVisible(examName);

    const current = readExamRow(examName)?.[CONFIG.resultColumn]?.trim() || "";
    if (normalizeExamName(current) === "VEDI REFERTO") return true;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const opened = await openGridEditorForExam(examName, CONFIG.resultColumn, "result");

      if (!opened?.filter) {
        console.error(`Segretario MMG: Risultato "${examName}": editor Risultato non aperto.`);
        return false;
      }

      const input = opened.filter;
      await chooseFilterSelectOption(input, "Vedi referto");
      await sleep(250);

      // Forza la chiusura/commit dell'editor cliccando una cella non editabile.
      const freshRow = getPreferredExamRow(examName);
      const commitCell = freshRow
        ? [...freshRow.querySelectorAll("td.v-grid-cell")][CONFIG.prescriptionDateColumn]
        : null;

      if (commitCell) {
        vaadinClick(commitCell);
        await sleep(250);
      }

      const gridResult = await waitForGridText(
        examName,
        CONFIG.resultColumn,
        "Vedi referto",
        2600
      );

      if (gridResult) {
        log("Risultato Vedi referto verificato", examName);
        return true;
      }

      if (attempt === 1) {
        log("Primo tentativo Vedi referto non confermato; riprovo.", examName);
        await sleep(250);
      }
    }

    const currentValue = readExamRow(examName)?.[CONFIG.resultColumn]?.trim() || "";
    const popups = [
      ...document.querySelectorAll(
        ".v-filterselect-suggestpopup, .gwt-SuggestBoxPopup"
      )
    ]
      .filter(isVisibleElement)
      .map(x => x.outerHTML.slice(0, 6000));

    console.error(
      `Segretario MMG: STOP Risultato, Grid="${currentValue}", atteso="Vedi referto".`,
      popups.length ? popups : "Nessun popup FilterSelect visibile"
    );
    return false;
  }

  async function waitForLongReportPopup() {
    const loops = Math.ceil(CONFIG.editorWaitMs / 100);

    for (let i = 0; i < loops; i++) {
      await sleep(100);

      const windows = [
        ...document.querySelectorAll(".v-window[role='dialog'], .v-window")
      ].filter(isVisibleElement);

      for (const popup of windows.reverse()) {
        const header =
          popup.querySelector(".v-window-header")?.textContent?.trim() || "";

        const textarea =
          popup.querySelector("textarea.v-textarea, textarea");

        if (
          normalizeExamName(header) === "REFERTO" &&
          textarea &&
          isVisibleElement(textarea)
        ) {
          return { popup, textarea };
        }
      }
    }

    return null;
  }

  async function openLongReportPopup(examName) {
    await ensureExamRowVisible(examName);

    const row = getPreferredExamRow(examName);

    if (!row) {
      console.error(
        `Segretario MMG: apertura referto lungo "${examName}": nessuna riga trovata.`
      );
      return null;
    }
    const cells = [...row.querySelectorAll("td.v-grid-cell")];
    const cell = cells[CONFIG.longReportButtonColumn];

    if (!cell) {
      console.error(
        `Segretario MMG: cella referto lungo ${CONFIG.longReportButtonColumn} assente.`
      );
      return null;
    }

    const button = cell.querySelector(
      "button, .v-nativebutton, .v-button, [role='button']"
    );

    if (!button) {
      console.error("Segretario MMG: pulsante Visualizza referto lungo non trovato.");
      return null;
    }

    vaadinClick(button);

    const found = await waitForLongReportPopup();

    if (!found) {
      console.error("Segretario MMG: popup Referto non comparso.");
      return null;
    }

    return found;
  }

  async function closeLongReportPopup(popup) {
    const closeBox = popup?.querySelector(".v-window-closebox");

    if (!closeBox) {
      console.error("Segretario MMG: X di chiusura popup Referto non trovata.");
      return false;
    }

    vaadinClick(closeBox);

    for (let i = 0; i < 20; i++) {
      await sleep(100);
      if (!isVisibleElement(popup)) return true;
    }

    return !isVisibleElement(popup);
  }

  async function writeLongReportText(examName, text) {
    const target = normalizeLongReportText(text);

    if (!target) {
      console.error("Segretario MMG: referto lungo vuoto.");
      return false;
    }

    let opened = await openLongReportPopup(examName);
    if (!opened) return false;

    const { popup, textarea } = opened;

    vaadinClick(textarea);
    textarea.focus();
    textarea.select();
    await sleep(40);

    let inserted = false;

    try {
      inserted = document.execCommand("insertText", false, target);
    } catch {
      inserted = false;
    }

    if (!inserted || normalizeLongReportText(textarea.value) !== target) {
      textarea.value = target;
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: target
      }));
    }

    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    textarea.dispatchEvent(new FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: document.body
    }));
    textarea.blur();

    await sleep(250);

    if (normalizeLongReportText(textarea.value) !== target) {
      console.error("Segretario MMG: testo del referto non presente nel textarea dopo la scrittura.");
      return false;
    }

    if (!(await closeLongReportPopup(popup))) {
      console.error("Segretario MMG: impossibile chiudere il popup Referto.");
      return false;
    }

    await sleep(300);

    // Verifica forte: riapri e controlla che Vaadin abbia mantenuto il testo.
    opened = await openLongReportPopup(examName);
    if (!opened) return false;

    const persisted =
      normalizeLongReportText(opened.textarea.value) === target;

    if (!persisted) {
      console.error(
        "Segretario MMG: STOP, il testo del referto lungo non è persistito dopo la chiusura."
      );
    }

    await closeLongReportPopup(opened.popup);
    await sleep(200);

    return persisted;
  }

  async function setExamResultVediRefertoResilient(examName, attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ok = await setExamResultVediReferto(examName);
      if (ok) return true;
      await resetGridEditorForFieldRetry(examName);
      await sleep(180);
    }
    return false;
  }

  async function writeLongReportTextResilient(examName, text, attempts = 2) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ok = await writeLongReportText(examName, text);
      if (ok) return true;
      await resetGridEditorForFieldRetry(examName);
      await sleep(220);
    }
    return false;
  }

  async function setLongReportRecordDetailed(item) {
    if (item.reportDate) {
      setPreferredReportDateForExam(
        item.exam,
        item.reportDate
      );
    }

    const compatibleRow =
      await ensureExamRowVisible(
        item.exam,
        2,
        item.reportDate || ""
      );

    const status = {
      exam: item.exam,
      resultVerified: false,
      textVerified: false,
      dateVerified: !item.reportDate,
      warnings: []
    };

    if (!compatibleRow) {
      status.warnings.push({
        exam: item.exam,
        field: "Data prescriz./riga Eumed"
      });
      return status;
    }

    // Anche per i referti lunghi la Data esito è la PRIMA modifica
    // effettuata sulla riga.
    if (item.reportDate) {
      status.dateVerified =
        await setExamDateResilient(
          item.exam,
          item.reportDate,
          3
        );

      if (!status.dateVerified) {
        status.warnings.push({
          exam: item.exam,
          field: "Data esito"
        });
      }

      await sleep(100);
    }

    status.resultVerified =
      await setExamResultVediRefertoResilient(
        item.exam,
        3
      );

    if (!status.resultVerified) {
      status.warnings.push({
        exam: item.exam,
        field: "Vedi referto"
      });
      return status;
    }

    await sleep(180);

    status.textVerified =
      await writeLongReportTextResilient(
        item.exam,
        item.text,
        2
      );

    if (!status.textVerified) {
      status.warnings.push({
        exam: item.exam,
        field: "Testo referto lungo"
      });
      return status;
    }

    return status;
  }

  async function setLongReportRecord(item) {
    const status = await setLongReportRecordDetailed(item);
    return status.resultVerified && status.textVerified;
  }

  async function setLongReportRecords(items, onProgress = null) {
    const completed = [];

    for (let i = 0; i < items.length; i++) {
      onProgress?.(i + 1, items.length, items[i]);

      const ok = await setLongReportRecord(items[i]);

      if (!ok) {
        return {
          success: false,
          completed,
          failed: items[i]
        };
      }

      completed.push(items[i]);
      await sleep(300);
    }

    return {
      success: true,
      completed
    };
  }

  function parseDirectLine(line) {
    line = line.trim();
    if (!line) return null;

    line = line.replace(/^[\-\*\u2022]\s*/, "");

    const match = line.match(
      /^(.*?)\s*(?:[:=]\s*)?([+-]?\d+(?:[.,]\d+)?)\s*$/
    );

    if (!match) {
      return {
        success: false,
        original: line,
        error: "Formato non riconosciuto"
      };
    }

    return {
      success: true,
      exam: match[1].replace(/[:=]\s*$/, "").trim(),
      value: normalizeValueString(match[2]),
      original: line
    };
  }

  function parseDirectText(text) {
    return String(text)
      .split(/[\n;]+/)
      .map(parseDirectLine)
      .filter(Boolean);
  }

  const OCR_SCHEMA = {
    type: "object",
    properties: {
      text: { type: "string" }
    },
    required: ["text"]
  };

  async function ollamaChatOnce(
    messages,
    onProgress = null,
    numPredict = CONFIG.aiMaxTokens,
    formatSchema = null
  ) {
    const aiRequestStarted = Date.now();
    await aiModelInitialization;
    await aiModelSelectionTask;
    if (!selectedAiModelInfo || selectedAiModelInfo.completion === false) {
      throw new Error("Scegli un modello IA disponibile nella schermata iniziale. Se Ollama non risponde, avvialo e aggiorna l’elenco.");
    }
    if (selectedAiModelInfo.vision === false && messages.some(message => message.images?.length)) {
      throw new Error("Il modello scelto legge soltanto testo. Torna alla schermata iniziale e seleziona un modello che legga anche immagini.");
    }
    return new Promise((resolve, reject) => {
      try {
        assertExtensionContext(
          "connessione a IA/Ollama"
        );
      } catch (error) {
        reject(error);
        return;
      }

      const requestId =
        `mmg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      let port;

      try {
        port = chrome.runtime.connect({
          name: "segretario-mmg-ollama"
        });
      } catch (error) {
        if (isExtensionContextInvalidatedError(error)) {
          reject(
            makeExtensionContextError(
              "connessione a IA/Ollama"
            )
          );
        } else {
          reject(error);
        }
        return;
      }

      let finished = false;

      function cleanup() {
        if (finished) return;
        finished = true;
        try { port.disconnect(); } catch {}
      }

      port.onMessage.addListener(message => {
        if (message?.requestId !== requestId) return;

        if (message.type === "OLLAMA_PROGRESS") {
          onProgress?.(message);
          return;
        }

        if (message.type === "OLLAMA_RESULT") {
          recordDiagnosticEvent("ia_completata", { durationMs: Date.now() - aiRequestStarted,
            inputCharacters: messages.reduce((n, item) => n + String(item.content || "").length, 0),
            outputCharacters: String(message.content || "").length,
            images: messages.reduce((n, item) => n + (item.images?.length || 0), 0) });
          const content = message.content;
          cleanup();
          resolve(content);
          return;
        }

        if (message.type === "OLLAMA_ERROR") {
          recordDiagnosticEvent("ia_errore", { durationMs: Date.now() - aiRequestStarted });
          cleanup();
          reject(
            new Error(
              message.message ||
              "Errore Ollama."
            )
          );
        }
      });

      port.onDisconnect.addListener(() => {
        if (finished) return;

        finished = true;

        let lastErrorMessage = "";
        try {
          lastErrorMessage =
            chrome.runtime.lastError?.message || "";
        } catch {}

        if (
          !extensionContextIsValid() ||
          /extension context invalidated/i.test(
            lastErrorMessage
          )
        ) {
          reject(
            makeExtensionContextError(
              "durante l'analisi IA"
            )
          );
          return;
        }

        reject(
          new Error(
            lastErrorMessage ||
            "Connessione interna all'estensione interrotta durante l'analisi."
          )
        );
      });

      try {
        port.postMessage({
          type: "OLLAMA_CHAT",
          requestId,
          payload: {
            model: CONFIG.aiModel,
            messages,
            num_predict: numPredict,
            keep_alive: "30m",
            format: formatSchema
          }
        });
      } catch (error) {
        cleanup();

        if (isExtensionContextInvalidatedError(error)) {
          reject(
            makeExtensionContextError(
              "invio richiesta a IA"
            )
          );
        } else {
          reject(error);
        }
      }
    });
  }

  function resultIdentityForOverride(item) {
    const label = cleanModelLabLabel(
      `${item?.raw_label || ""} ${item?.exam || ""}`
    );

    const concept = getExamConcept(label);
    if (concept) return `CONCEPT:${concept}`;

    const catalog = matchCatalog(label);
    if (catalog?.entry?.code) {
      return `CATALOG:${catalog.entry.code}`;
    }

    return "";
  }

  function applyDeterministicResultOverrides(rawResults, deterministicResults) {
    if (!deterministicResults?.length) return rawResults;

    const identities = new Set(
      deterministicResults
        .map(resultIdentityForOverride)
        .filter(Boolean)
    );

    const kept = rawResults.filter(item => {
      const identity = resultIdentityForOverride(item);
      return !identity || !identities.has(identity);
    });

    return [...kept, ...deterministicResults];
  }

  function conceptsCompatible(aiExam, rawLabel) {
    const aiConcept = getExamConcept(aiExam);
    const rawConcept = getExamConcept(rawLabel);

    if (!aiConcept || !rawConcept) {
      return {
        ok: true,
        aiConcept,
        rawConcept
      };
    }

    return {
      ok: aiConcept === rawConcept,
      aiConcept,
      rawConcept
    };
  }

  // ============================================================
  // FILE LOCALI: PDF / JPEG / PNG
  // ============================================================

  let pdfJsPromise = null;

  async function getPdfJs() {
    if (!pdfJsPromise) {
      const url =
        extensionUrl(
          "vendor/pdf.mjs",
          "caricamento PDF.js"
        );

      pdfJsPromise = import(url).then(module => {
        if (module.__SEGRETARIO_PDFJS_STUB__) {
          throw new Error(
            "PDF.js non è ancora installato. Esegui una volta INSTALLA_PDFJS.bat " +
            "nella cartella dell'estensione, poi ricarica l'estensione da chrome://extensions."
          );
        }

        if (!module?.getDocument || !module?.GlobalWorkerOptions) {
          throw new Error("PDF.js locale non valido o incompleto.");
        }

        module.GlobalWorkerOptions.workerSrc =
          extensionUrl("vendor/pdf.worker.mjs", "worker PDF.js");

        return module;
      }).catch(error => {
        pdfJsPromise = null;
        throw error;
      });
    }

    return pdfJsPromise;
  }

  async function canvasToJpegBase64(canvas, quality = 0.92) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  }

  async function renderPdfPageToBase64(page) {
    const baseViewport = page.getViewport({ scale: 1 });
    const targetWidth = 1800;
    const scale = Math.min(3.2, Math.max(1.7, targetWidth / baseViewport.width));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: context,
      viewport
    }).promise;

    return canvasToJpegBase64(canvas, 0.92);
  }

  async function imageFileToBase64(file) {
    const bitmap = await createImageBitmap(file);

    try {
      const maxDimension = CONFIG.imageMaxDimension;
      const scale = Math.min(
        1,
        maxDimension / Math.max(bitmap.width, bitmap.height)
      );

      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "white";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);

      return await canvasToJpegBase64(canvas, 0.93);
    } finally {
      bitmap.close?.();
    }
  }

  let paddleBrowserPromise = null;
  let paddleSandboxFrame = null;
  let paddleSandboxClient = null;

  function base64ToBlob(base64, mime = "image/jpeg") {
    const binary = atob(String(base64 || ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }

  function paddleItemGeometry(item) {
    const poly = Array.isArray(item?.poly) ? item.poly : [];
    const xs = poly.map(p => Number(p?.[0])).filter(Number.isFinite);
    const ys = poly.map(p => Number(p?.[1])).filter(Number.isFinite);
    if (!xs.length || !ys.length) return { x1:0, x2:0, y1:0, y2:0, h:1, cy:0 };
    const x1=Math.min(...xs), x2=Math.max(...xs), y1=Math.min(...ys), y2=Math.max(...ys);
    return { x1,x2,y1,y2,h:Math.max(1,y2-y1),cy:(y1+y2)/2 };
  }

  function paddleItemsToLayoutText(items, minScore = CONFIG.paddleOcrMinScore) {
    const clean=(items||[]).map(item=>({
      text:String(item?.text||"").trim(),
      score:Number(item?.score ?? 1),
      ...paddleItemGeometry(item)
    })).filter(x=>x.text && Number.isFinite(x.score) && x.score>=minScore);

    clean.sort((a,b)=>a.cy-b.cy || a.x1-b.x1);
    const rows=[];
    for(const item of clean){
      let best=null, dist=Infinity;
      for(const row of rows){
        const tol=Math.max(7,0.52*Math.max(row.h,item.h));
        const d=Math.abs(item.cy-row.cy);
        if(d<=tol && d<dist){best=row;dist=d;}
      }
      if(!best) rows.push({cy:item.cy,h:item.h,items:[item]});
      else {
        best.items.push(item);
        const n=best.items.length;
        best.cy=(best.cy*(n-1)+item.cy)/n;
        best.h=Math.max(best.h,item.h);
      }
    }
    rows.sort((a,b)=>a.cy-b.cy);
    const lines=rows.map(row=>row.items.sort((a,b)=>a.x1-b.x1).map(x=>x.text).join("\t"));
    const avg=clean.length?clean.reduce((s,x)=>s+x.score,0)/clean.length:0;
    return {text:lines.join("\n").trim(),lines:lines.length,averageScore:avg,items:clean};
  }

  function destroyPaddleSandbox() {
    try { paddleSandboxClient?.port?.close?.(); } catch {}
    try { paddleSandboxFrame?.remove?.(); } catch {}
    paddleSandboxClient = null;
    paddleSandboxFrame = null;
    paddleBrowserPromise = null;
  }

  async function createPaddleSandboxClient() {
    assertExtensionContext("PaddleOCR sandbox");

    const sandboxUrl = extensionUrl(CONFIG.paddleSandboxPath, "PaddleOCR sandbox");
    const bundleUrl = extensionUrl(CONFIG.paddleModulePath, "PaddleOCR bundle");

    // Controllo esplicito del bundle prima di aprire la sandbox.
    const bundleResponse = await fetch(bundleUrl, { cache: "no-store" });
    if (!bundleResponse.ok) {
      throw new Error(`bundle PaddleOCR mancante (${bundleResponse.status})`);
    }

    const iframe = document.createElement("iframe");
    iframe.src = sandboxUrl;
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.position = "fixed";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.left = "-10000px";
    iframe.style.top = "-10000px";
    iframe.style.border = "0";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";

    // Lo inseriamo nello shadow root del pannello per non interferire con Eumed.
    shadow.appendChild(iframe);
    paddleSandboxFrame = iframe;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout caricamento sandbox PaddleOCR.")),
        20_000
      );
      iframe.addEventListener("load", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      iframe.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Impossibile caricare paddle_sandbox.html."));
      }, { once: true });
    });

    const channel = new MessageChannel();
    const port = channel.port1;
    const pending = new Map();
    let sequence = 0;

    port.onmessage = event => {
      const msg = event.data || {};
      const waiter = pending.get(msg.id);
      if (!waiter) return;

      if (msg.type === "READY" || msg.type === "RESULT" || msg.type === "PONG") {
        pending.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve(msg.result);
        return;
      }

      if (msg.type === "ERROR") {
        pending.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(msg?.error?.message || "Errore PaddleOCR sandbox."));
      }
    };
    port.start?.();

    function request(type, payload = {}, transfer = [], timeoutMs = 120_000) {
      return new Promise((resolve, reject) => {
        const id = `paddle-${Date.now()}-${++sequence}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timeout PaddleOCR sandbox durante ${type}.`));
        }, timeoutMs);

        pending.set(id, { resolve, reject, timer });

        try {
          port.postMessage({ type, id, ...payload }, transfer);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    }

    const initOptions = {
      detectionModelUrl: extensionUrl(CONFIG.paddleDetModelPath,"modello Paddle detection"),
      recognitionModelUrl: extensionUrl(CONFIG.paddleRecModelPath,"modello Paddle recognition"),
      wasmPaths: extensionUrl(CONFIG.paddleWasmPath,"runtime ONNX WASM")
    };

    iframe.contentWindow.postMessage(
      {
        type: "SEGRETARIO_PADDLE_CONNECT",
        options: initOptions
      },
      "*",
      [channel.port2]
    );

    await request("INIT", {}, [], 120_000);

    return {
      port,
      async predict(blob, options = {}) {
        const bytes = await blob.arrayBuffer();
        return request(
          "PREDICT",
          {
            bytes,
            mime: blob.type || "image/jpeg",
            options
          },
          [bytes],
          180_000
        );
      },
      async ping() {
        await request("PING", {}, [], 10_000);
        return true;
      }
    };
  }

  async function getPaddleBrowserOcr() {
    if (paddleBrowserPromise) return paddleBrowserPromise;

    paddleBrowserPromise = (async () => {
      try {
        const client = await createPaddleSandboxClient();
        paddleSandboxClient = client;
        return client;
      } catch (error) {
        destroyPaddleSandbox();
        throw new Error(
          "PaddleOCR integrato non disponibile nella sandbox Chrome. " +
          "Esegui INSTALLA_PADDLEOCR_BROWSER.bat, poi VERIFICA_PADDLEOCR_BROWSER.bat, " +
          "ricarica l'estensione e fai Ctrl+Shift+R su Eumed. Dettaglio: " +
          (error?.message || "")
        );
      }
    })();

    try {
      return await paddleBrowserPromise;
    } catch (error) {
      paddleBrowserPromise = null;
      throw error;
    }
  }

  async function paddleOcrHealth() {
    const ocr = await getPaddleBrowserOcr();
    await ocr.ping();
    return {
      ok: true,
      engine: "PaddleOCR sandbox",
      model: "PP-OCRv6 tiny"
    };
  }

  async function paddleOcrImageBase64(imageBase64, label, progressCallback=null) {
    progressCallback?.({phase:"paddle_ocr_start",label});
    const started=performance.now();
    const ocr=await getPaddleBrowserOcr();
    const blob=base64ToBlob(imageBase64,"image/jpeg");
    const results=await ocr.predict(blob,{
      textRecScoreThresh: CONFIG.paddleOcrMinScore,
      textDetLimitSideLen: 1800,
      textDetLimitType: "max"
    });
    const result=results?.[0];
    const layout=paddleItemsToLayoutText(result?.items||[]);
    if(!layout.text) throw new Error(`PaddleOCR non ha riconosciuto testo in ${label}.`);
    const elapsed=Number(result?.metrics?.totalMs)||performance.now()-started;
    progressCallback?.({
      phase:"paddle_ocr_done",label,lines:layout.lines,
      averageScore:layout.averageScore,elapsedMs:elapsed,
      model:"PP-OCRv6 tiny · browser"
    });
    return layout.text;
  }

  async function qwenVisionOcrImageBase64(imageBase64,label,progressCallback=null){
    const prompt=`Trascrivi fedelmente questa pagina di un referto di laboratorio italiano.\n\nREGOLE:\n- fai SOLO OCR, non interpretare e non fare diagnosi;\n- conserva nomi degli esami, valori, unità, intervalli di riferimento e date;\n- se la pagina contiene una tabella, restituisci UNA RIGA per riga visiva e separa le colonne con TAB;\n- usa la posizione visiva per associare correttamente Esame | Risultato | U.M. | Range;\n- non correggere valori plausibili e non inventare testo illeggibile;\n- nessun markdown.\n\nRestituisci JSON con un solo campo text.`;
    progressCallback?.({phase:"qwen_ocr_start",label});
    const content=await ollamaChat(
      [{role:"user",content:prompt,images:[imageBase64]}],
      info=>progressCallback?.({phase:"qwen_ocr_stream",label,chars:info?.chars||0}),
      3600,
      OCR_SCHEMA
    );
    const parsed=extractJSONObject(content);
    const text=String(parsed?.text||"").trim();
    if(!text) throw new Error(`IA Vision non ha restituito testo per ${label}.`);
    progressCallback?.({phase:"qwen_ocr_done",label,chars:text.length});
    return text;
  }

  async function extractTextFromPdfFile(file, progressCallback=null, options={}) {
    const mode=options.mode||"auto"; // auto | paddle | qwen
    const pdfjs=await getPdfJs();
    const bytes=new Uint8Array(await file.arrayBuffer());
    const pdf=await pdfjs.getDocument({data:bytes}).promise;
    const pageTexts=[];
    let pagesNeedingOcr=0;
    const pages=[];

    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
      progressCallback?.({phase:"pdf_text",current:pageNumber,total:pdf.numPages});
      const page=await pdf.getPage(pageNumber);
      const textContent=await page.getTextContent();
      const pageText=textContentToLines(textContent).trim();
      const usefulChars=pageText.replace(/\s/g,"").length;
      const needsOcr=mode!=="auto" || usefulChars<CONFIG.pdfTextPageMinChars;
      if(needsOcr) pagesNeedingOcr++;
      pages.push({pageNumber,page,pageText,needsOcr});
    }

    progressCallback?.({phase:"pdf_scan_detected",visionPages:pagesNeedingOcr,total:pdf.numPages,mode});
    if(pagesNeedingOcr>CONFIG.pdfVisionMaxPages) throw new Error(`Il PDF richiede OCR su ${pagesNeedingOcr} pagine; limite ${CONFIG.pdfVisionMaxPages}.`);

    const failures=[];
    for(const info of pages){
      if(!info.needsOcr){
        pageTexts.push(`=== PAGINA ${info.pageNumber} - TESTO PDF ===\n${info.pageText}`);
        continue;
      }
      const engine=mode==="qwen"?"qwen":"paddle";
      progressCallback?.({phase:"pdf_ocr",engine,current:info.pageNumber,total:pdf.numPages});
      const imageBase64=await renderPdfPageToBase64(info.page);
      try{
        const text=engine==="qwen"
          ? await qwenVisionOcrImageBase64(imageBase64,`pagina ${info.pageNumber}/${pdf.numPages}`,progressCallback)
          : await paddleOcrImageBase64(imageBase64,`pagina ${info.pageNumber}/${pdf.numPages}`,progressCallback);
        pageTexts.push(`=== PAGINA ${info.pageNumber} - OCR ${engine==="qwen"?"IA":"LETTURA RAPIDA"} ===\n${text}`);
      }catch(error){
        failures.push({page:info.pageNumber,error:error?.message||String(error)});
        if(mode!=="qwen") throw error;
        pageTexts.push(`=== PAGINA ${info.pageNumber} - OCR IA NON COMPLETATO ===`);
      }
    }
    if(mode==="qwen" && failures.length===pdf.numPages) throw new Error("Lettura con IA fallito su tutte le pagine. "+failures.map(x=>`P${x.page}: ${x.error}`).join(" | "));
    progressCallback?.({phase:"ocr_complete",mode,pages:pdf.numPages,failures});
    return pageTexts.join("\n\n").trim();
  }

  async function extractTextFromImageFile(file, progressCallback=null, options={}) {
    const mode=options.mode||"paddle";
    const imageBase64=await imageFileToBase64(file);
    if(mode==="qwen") return qwenVisionOcrImageBase64(imageBase64,file.name||"immagine",progressCallback);
    return paddleOcrImageBase64(imageBase64,file.name||"immagine",progressCallback);
  }



  // ============================================================
  // v0.15.13 - alias LAD/FLC e nuovi complessi monoclonali/Bence-Jones
  // v0.15.12 - preferenze cliniche: <x come x, TSH reflex contestuale, sierologie IgG/IgM
  // v0.15.11 - audit hardening: comparatori, catalogo, sierologie, retry e guardie writer
  // v0.15.0 - WORKFLOW REFERTO NON PRESCRITTO
  // ============================================================

  const WORKFLOW_MODE = {
    PRESCRIBED: "prescribed",
    UNPRESCRIBED: "unprescribed",
    PRESCRIPTION_LIST: "prescription_list"
  };

  function renderPrescribedTransferBlock(transferText) {
    if (!transferText) return "";
    return `<div class="row warning"><b>Da inserire senza prescrizioni</b>
      <span class="small">Copia questo blocco. Apri Registrazione esiti → Inserimento senza prescrizioni, scegli Referto non prescritto e incollalo nel campo del referto. Controlla l'anteprima prima di inserire.</span>
      <textarea data-transfer-text readonly aria-label="Blocco da copiare per inserimento senza prescrizioni" style="width:100%;box-sizing:border-box;height:150px;margin-top:8px">${escapeHtml(transferText)}</textarea>
      <button type="button" data-transfer-copy>Copia blocco</button><span class="small" data-transfer-status role="status"></span></div>`;
  }

  async function copyPrescribedTransferBlock(field) {
    const text=String(field?.value || "");
    if (!text) return false;
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    try { field.focus();field.select();return document.execCommand("copy"); } catch {return false;}
  }

  // ------------------------------------------------------------
  // Writer della schermata "Inserimento senza prescrizioni"
  // ------------------------------------------------------------

  function visibleElements(selector, root = document) {
    return [...root.querySelectorAll(selector)].filter(isVisibleElement);
  }

  function findCaptionTextElement(label) {
    const target = normalizeExamName(label);
    const candidates = visibleElements(
      ".v-captiontext, .v-caption, label, span"
    );

    return candidates.find(el => {
      const text = normalizeExamName(el.textContent || "");
      return text === target || text === `${target} *`;
    }) || null;
  }

  function nearestControlFromCaption(label, selector) {
    const caption = findCaptionTextElement(label);
    if (!caption) return null;

    // v0.15.7: nella schermata "Inserimento senza prescrizioni" i caption
    // Vaadin condividono rapidamente un contenitore comune. Risalire il DOM e
    // prendere il primo <input> del contenitore puo' quindi restituire di nuovo
    // Accertamento anche quando stiamo cercando Data/Valore/Minimo/Massimo.
    // Associazione quindi per geometria: il controllo deve essere quello
    // immediatamente sotto (o sulla stessa riga) del proprio caption.
    const cr = caption.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const controls = visibleElements(selector).filter(el => !el.disabled && !el.readOnly);

    let best = null;
    let bestScore = Infinity;

    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;

      const ex = r.left + r.width / 2;
      const horizontalOverlap = Math.max(0, Math.min(cr.right, r.right) - Math.max(cr.left, r.left));
      const dxCenter = Math.abs(ex - cx);

      // Caption sopra al controllo: distanza verticale dal bordo inferiore del
      // caption al bordo superiore del widget. Accettiamo anche piccoli overlap
      // dovuti alla struttura Vaadin.
      let dy;
      if (r.top >= cr.bottom - 8) dy = Math.max(0, r.top - cr.bottom);
      else if (r.bottom >= cr.top - 8) dy = 12; // stessa fascia verticale
      else dy = cr.top - r.bottom + 220;        // controllo sopra: forte penalita'

      // Evita di saltare ad altri campi della riga: la distanza orizzontale pesa
      // molto piu' della larghezza del controllo (Accertamento e Referto sono larghi).
      let score = dy * 5 + dxCenter * 1.8;
      if (horizontalOverlap > 0) score -= Math.min(horizontalOverlap, 90) * 1.2;
      if (r.top > cr.bottom + 140) score += 1000;

      if (score < bestScore) {
        best = el;
        bestScore = score;
      }
    }

    return best;
  }

  function nonPrescribedConfirmTextLooksSafe(button) {
    if (!button) return false;
    const text = normalizeExamName(
      button.textContent || button.getAttribute('title') || button.getAttribute('aria-label') || ''
    );
    if (/\bSALVA(?:TAGGIO|RE)?\b|\bSAVE\b/.test(text)) return false;
    if (text.includes('DETTAGLI') || text.includes('ALLEGATI')) return false;
    const cls = String(button.className || '');
    if (/filterselect|combobox|datefield|calendar|popup|menu|tab/i.test(cls)) return false;
    return true;
  }

  function visibleInsertOutcomeTooltip() {
    const needle = normalizeExamName("Inserisci l'esito");
    const nodes = [...document.querySelectorAll(
      '.v-tooltip, .v-tooltip-text, [role="tooltip"], [class*="tooltip"], [class*="Tooltip"]'
    )];
    return nodes.some(el => {
      if (!isVisibleElement(el)) return false;
      const text = normalizeExamName(el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '');
      return text === needle || text.includes(needle);
    });
  }

  async function hoverForInsertOutcomeTooltip(button, timeoutMs = 700) {
    if (!button || !isVisibleElement(button)) return false;
    const r = button.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const target = document.elementFromPoint(x, y) || button;
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 0
    };

    try {
      target.dispatchEvent(new MouseEvent('mouseover', base));
      target.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
      target.dispatchEvent(new MouseEvent('mousemove', base));
    } catch {}

    const loops = Math.max(1, Math.ceil(timeoutMs / 70));
    for (let i = 0; i < loops; i++) {
      if (visibleInsertOutcomeTooltip()) return true;
      await sleep(70);
    }
    return false;
  }

  let lastNonPrescribedConfirmDiagnostic = "";

  function describeConfirmCandidate(el) {
    if (!el) return "";
    const r = el.getBoundingClientRect();
    const text = String(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 45);
    const title = String(
      el.getAttribute("title") ||
      el.getAttribute("aria-label") ||
      el.getAttribute("data-tooltip") ||
      el.getAttribute("data-original-title") ||
      ""
    ).replace(/\s+/g, " ").trim().slice(0, 60);
    const cls = String(el.className || "").replace(/\s+/g, ".").slice(0, 70);
    return `${el.tagName}.${cls} text="${text}" title="${title}" @${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  }

  function nearestCommonAncestor(a, b) {
    if (!a || !b) return null;
    let node = a;
    while (node && node !== document.body) {
      if (node.contains(b)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function findNonPrescribedActionColumnConfirm() {
    const clickableSelector = '.v-button, .v-nativebutton, button, [role="button"]';
    const buttons = visibleElements(clickableSelector)
      .filter(nonPrescribedConfirmTextLooksSafe);

    const details = buttons.find(el => normalizeExamName(el.textContent || "").includes("DETTAGLI"));
    const attachments = buttons.find(el => normalizeExamName(el.textContent || "").includes("ALLEGATI"));
    if (!details || !attachments) return null;

    // In Eumed il ✓ appartiene alla stessa colonna verticale di Dettagli e
    // Allegati. Cerchiamo prima il contenitore comune più piccolo; è molto più
    // stabile di colore/coordinate globali e non può raggiungere la sidebar.
    let column = nearestCommonAncestor(details, attachments);
    while (column && column !== document.body) {
      const r = column.getBoundingClientRect();
      if (r.width > 0 && r.width <= 360 && r.height > 0) break;
      column = column.parentElement;
    }
    if (!column || column === document.body) return null;

    const dr = details.getBoundingClientRect();
    const ar = attachments.getBoundingClientRect();
    const candidates = visibleElements(clickableSelector, column)
      .filter(el => el !== details && el !== attachments)
      .filter(nonPrescribedConfirmTextLooksSafe)
      .filter(el => {
        const r = el.getBoundingClientRect();
        const text = normalizeExamName(el.textContent || "");
        if (text.includes("DETTAGLI") || text.includes("ALLEGATI")) return false;
        if (r.width < 60 || r.width > 220 || r.height < 18 || r.height > 80) return false;
        // Stessa colonna orizzontale dei due pulsanti etichettati.
        const refLeft = (dr.left + ar.left) / 2;
        if (Math.abs(r.left - refLeft) > 55) return false;
        // Il ✓ è sotto Allegati (dopo la riga delle tre piccole icone).
        if (r.top < ar.bottom - 2) return false;
        return true;
      })
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

    if (!candidates.length) return null;

    // Il pulsante di conferma è il controllo largo più in basso della colonna.
    // Le tre icone sopra sono strette e vengono già escluse dalla larghezza.
    return candidates[0];
  }


  function clickableAncestorFromHit(el) {
    if (!el) return null;
    const selector = '.v-button, .v-nativebutton, button, [role="button"]';
    if (el.matches?.(selector)) return el;
    return el.closest?.(selector) || null;
  }

  function findNonPrescribedConfirmByHitTest(report) {
    if (!report || !isVisibleElement(report) || typeof document.elementsFromPoint !== 'function') return null;
    const rr = report.getBoundingClientRect();

    // Il ✓ è fisicamente nella piccola colonna immediatamente a destra del Referto,
    // nella sua metà inferiore. Usiamo hit-test reale del browser invece di dedurre
    // il tipo di widget Vaadin da classi/role, che possono cambiare tra render.
    const xs = [rr.right + 18, rr.right + 45, rr.right + 75, rr.right + 105, rr.right + 140];
    const ys = [
      rr.top + rr.height * 0.58,
      rr.top + rr.height * 0.72,
      rr.top + rr.height * 0.86,
      rr.bottom - 8
    ];

    const score = new Map();
    const seenNodes = [];

    for (const x of xs) {
      for (const y of ys) {
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
        const stack = document.elementsFromPoint(x, y) || [];
        for (const raw of stack) {
          if (seenNodes.length < 30) seenNodes.push(raw);
          const button = clickableAncestorFromHit(raw);
          if (!button || !isVisibleElement(button) || !nonPrescribedConfirmTextLooksSafe(button)) continue;
          const r = button.getBoundingClientRect();
          const cy = r.top + r.height / 2;
          // Guardia geometrica forte: deve essere a destra del Referto e
          // verticalmente allineato alla sua metà inferiore.
          if (r.right < rr.right - 8) continue;
          if (r.left > rr.right + 260) continue;
          if (cy < rr.top + rr.height * 0.45 || cy > rr.bottom + 22) continue;
          if (r.width < 28 || r.width > 260 || r.height < 14 || r.height > 100) continue;
          score.set(button, (score.get(button) || 0) + 1);
        }
      }
    }

    const ranked = [...score.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const ar = a[0].getBoundingClientRect();
      const br = b[0].getBoundingClientRect();
      const ax = Math.abs((ar.left + ar.width / 2) - (rr.right + 70));
      const bx = Math.abs((br.left + br.width / 2) - (rr.right + 70));
      const ay = Math.abs((ar.top + ar.height / 2) - (rr.bottom - 12));
      const by = Math.abs((br.top + br.height / 2) - (rr.bottom - 12));
      return (ax + 2 * ay) - (bx + 2 * by);
    });

    if (ranked.length === 1) return ranked[0][0];
    if (ranked.length > 1 && ranked[0][1] >= ranked[1][1] + 2) return ranked[0][0];

    // Memorizza una diagnostica utile senza cliccare nulla.
    const unique = [];
    for (const raw of seenNodes) {
      const btn = clickableAncestorFromHit(raw);
      if (btn && !unique.includes(btn)) unique.push(btn);
      if (unique.length >= 8) break;
    }
    if (unique.length) {
      lastNonPrescribedConfirmDiagnostic = `Hit-test: ${unique.map(describeConfirmCandidate).join(' | ')}`;
    }
    return null;
  }
  function findExactNonPrescribedLocalSave(report) {
    if (!report || !isVisibleElement(report)) return null;

    // Struttura verificata sul DOM reale Eumed (Vaadin 8.13): il campo
    // Referto e il Salva della singola riga appartengono allo stesso
    // v-gridlayout della scheda "Inserimento senza prescrizioni". Il pulsante
    // locale ha classi primary + icon-only e caption "Salva". Il Salva
    // generale non appartiene a questo gridlayout e quindi non puo' essere
    // selezionato da questa funzione.
    const grid = report.closest('.v-gridlayout');
    if (!grid) return null;

    const captions = [...grid.querySelectorAll('.v-captiontext')]
      .map(el => normalizeExamName(el.textContent || ''));
    if (!captions.includes('ACCERTAMENTO') || !captions.includes('DATA') || !captions.includes('REFERTO')) {
      return null;
    }

    const candidates = [...grid.querySelectorAll(
      '.v-button.v-button-primary.v-button-icon-only, .v-button.primary.icon-only'
    )]
      .filter(isVisibleElement)
      .filter(button => {
        const caption = button.querySelector('.v-button-caption');
        const text = normalizeExamName(caption?.textContent || button.textContent || '');
        return text === 'SALVA';
      });

    if (candidates.length === 1) return candidates[0];

    // Se in una futura build Eumed comparissero piu' primary/icon-only nello
    // stesso gridlayout, scegli solo quello nella colonna a destra del Referto
    // e sotto il textarea. In caso non univoco non cliccare nulla.
    const rr = report.getBoundingClientRect();
    const local = candidates.filter(button => {
      const r = button.getBoundingClientRect();
      return (
        r.left >= rr.right - 20 &&
        r.left <= rr.right + 260 &&
        r.top >= rr.top + rr.height * 0.45 &&
        r.top <= rr.bottom + 80
      );
    });
    return local.length === 1 ? local[0] : null;
  }

  async function findNonPrescribedConfirmButton(reportTextarea = null) {
    lastNonPrescribedConfirmDiagnostic = "";
    const report = reportTextarea || nearestControlFromCaption('Referto', 'textarea.v-textarea, textarea');

    // v0.15.26: selettore deterministico basato sulla struttura DOM reale di
    // Eumed. Non cerchiamo piu' globalmente pulsanti blu/Salva e non facciamo
    // hit-test su controlli della sidebar.
    const localSave = findExactNonPrescribedLocalSave(report);
    if (localSave) return localSave;

    if (!report || !isVisibleElement(report)) {
      lastNonPrescribedConfirmDiagnostic = 'Referto non individuato';
      return null;
    }

    const rr = report.getBoundingClientRect();
    const grid = report.closest('.v-gridlayout');
    const localButtons = grid
      ? [...grid.querySelectorAll('.v-button, .v-nativebutton, button, [role="button"]')]
          .filter(isVisibleElement)
          .map(describeConfirmCandidate)
          .slice(0, 12)
      : [];

    lastNonPrescribedConfirmDiagnostic =
      `Referto @${Math.round(rr.left)},${Math.round(rr.top)} ${Math.round(rr.width)}x${Math.round(rr.height)}; ` +
      (localButtons.length ? `controlli form: ${localButtons.join(' | ')}` : 'nessun controllo nel gridlayout');
    return null;
  }

  function getNonPrescribedForm() {
    const accertamento = nearestControlFromCaption("Accertamento", ".v-filterselect-input");
    const date =
      nearestControlFromCaption("Data", ".v-datefield input") ||
      nearestControlFromCaption("Data", "input");
    const value = nearestControlFromCaption("Valore", ".numeric-field input, input.v-textfield, input");
    const min = nearestControlFromCaption("Minimo", ".numeric-field input, input.v-textfield, input") ||
      nearestControlFromCaption("Min", ".numeric-field input, input.v-textfield, input");
    const max = nearestControlFromCaption("Massimo", ".numeric-field input, input.v-textfield, input") ||
      nearestControlFromCaption("Max", ".numeric-field input, input.v-textfield, input");
    const result = nearestControlFromCaption("Risultato", ".v-filterselect-input, input");
    const report = nearestControlFromCaption("Referto", "textarea.v-textarea, textarea");

    return { accertamento, date, value, min, max, result, report };
  }

  function getNonPrescribedGrid() {
    const grids = visibleElements(".v-grid");

    for (const grid of grids) {
      const header = normalizeExamName(
        grid.querySelector(".v-grid-header")?.textContent || ""
      );

      if (
        header.includes("ACCERTAMENTO") &&
        header.includes("DATA ESITO") &&
        !header.includes("DATA PRESCRIZ")
      ) {
        return grid;
      }
    }

    return null;
  }

  function getNonPrescribedRows() {
    const grid = getNonPrescribedGrid();
    return grid
      ? [...grid.querySelectorAll(".v-grid-body tr.v-grid-row.v-grid-row-has-data")]
      : [];
  }

  async function replaceFormInput(input, value, numeric = false) {
    if (!input) return false;
    const target = String(value ?? "").trim();

    vaadinClick(input);
    await sleep(25);
    selectWholeVaadinInput(input);

    try { document.execCommand("insertText", false, target); } catch {}
    await sleep(25);

    if (numeric ? sameNumericValue(input.value, target) : String(input.value || "").trim() === target) {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    selectWholeVaadinInput(input);
    setNativeInputValue(input, target);
    await sleep(35);

    const ok = numeric
      ? sameNumericValue(input.value, target)
      : String(input.value || "").trim() === target;

    if (ok) input.dispatchEvent(new Event("change", { bubbles: true }));
    return ok;
  }

  async function clearFormInput(input) {
    if (!input) return true;
    if (!String(input.value || "").trim()) return true;
    return replaceFormInput(input, "", false);
  }

  function legacyFilterKeyFromText(text) {
    // Vaadin 8/GWT usa spesso keyCode/which nel KeyUpHandler del FilterSelect.
    // Scegliamo l'ultimo carattere alfanumerico del testo come evento-segnale:
    // il valore completo e' gia' nell'input, il keyup serve a far partire la query.
    const chars = [...String(text || "")];
    let ch = [...chars].reverse().find(c => /[A-Za-z0-9]/.test(c)) || "A";

    if (/^[0-9]$/.test(ch)) {
      return {
        key: ch,
        code: `Digit${ch}`,
        keyCode: 48 + Number(ch)
      };
    }

    ch = ch.toUpperCase();
    return {
      key: ch,
      code: `Key${ch}`,
      keyCode: ch.charCodeAt(0)
    };
  }

  async function triggerNonPrescribedCatalogFilter(input, targetText) {
    if (!input) return false;

    const target = String(targetText || "").trim();
    if (!target) return false;

    vaadinClick(input);
    try { input.focus(); } catch {}
    await sleep(60);
    selectWholeVaadinInput(input);

    // Prima proviamo il percorso piu' simile ad un incolla reale: setter nativo
    // + InputEvent insertFromPaste. Il testo deve comparire senza pero' essere
    // scambiato per una selezione valida del ComboBox.
    setNativeInputValue(input, target);
    try {
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType: "insertFromPaste",
        data: target
      }));
    } catch {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // Il passaggio decisivo per Vaadin 8/GWT: un vero keyup legacy con
    // keyCode/which valorizzati. La 0.15.0 mostrava il testo ma non scatenava
    // la richiesta delle proposte al server.
    const k = legacyFilterKeyFromText(target);
    dispatchLegacyKey(input, "keydown", k.key, k.code, k.keyCode);
    dispatchLegacyKey(input, "keypress", k.key, k.code, k.keyCode);
    dispatchLegacyKey(input, "keyup", k.key, k.code, k.keyCode);

    // v0.15.9: Eumed/Vaadin impiega un tempo percepibile per interrogare il
    // catalogo e costruire la tendina. Non consideriamo il solo testo digitato
    // una selezione valida: lasciamo almeno ~0,5 s al componente prima di
    // cercare la proposta reale.
    await sleep(550);
    return String(input.value || "").trim() === target;
  }

  function getFilterSelectPopup(option) {
    return option?.closest?.(
      ".v-filterselect-suggestpopup, .gwt-SuggestBoxPopup, .v-filterselect-suggestmenu"
    ) || null;
  }

  function deepestVisiblePointTarget(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const points = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + Math.min(Math.max(r.width * 0.25, 6), Math.max(r.width - 6, 6)), r.top + r.height / 2],
      [r.right - Math.min(Math.max(r.width * 0.15, 6), Math.max(r.width - 6, 6)), r.top + r.height / 2]
    ];

    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) return hit;
    }

    return el.querySelector?.(".gwt-MenuItem, [role='menuitem'], [role='option'], td, div, span") || el;
  }

  function dispatchVaadinMouseSequence(target) {
    if (!target) return;
    const r = target.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: Math.round(window.screenX + x),
      screenY: Math.round(window.screenY + y),
      button: 0
    };

    for (const [type, buttons] of [
      ["mouseover", 0],
      ["mousemove", 0],
      ["mousedown", 1],
      ["mouseup", 0],
      ["click", 0]
    ]) {
      try {
        target.dispatchEvent(new MouseEvent(type, { ...base, buttons }));
      } catch {}
    }
  }

  function isActuallyVisibleInViewport(el) {
    if (!el || !document.documentElement.contains(el)) return false;

    let node = el;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) === 0
      ) {
        return false;
      }
      node = node.parentElement;
    }

    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;

    // Vaadin/GWT spesso NON rimuove il suggest popup dopo la selezione:
    // lo lascia montato ma lo sposta fuori viewport. In quel caso offsetWidth/
    // offsetHeight restano > 0 e la vecchia isVisibleElement() dava un falso
    // positivo. Per il commit ci interessa la visibilita' reale sullo schermo.
    return (
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < window.innerHeight &&
      r.left < window.innerWidth
    );
  }

  async function waitFilterPopupClosed(popup, targetText, timeoutMs = 900) {
    const loops = Math.ceil(timeoutMs / 50);
    for (let i = 0; i < loops; i++) {
      if (!popup || !isActuallyVisibleInViewport(popup)) return true;
      await sleep(50);
    }
    return false;
  }

  async function focusNonPrescribedDateAfterAccertamento(input) {
    // Il gesto manuale dell'utente e' equivalente a: selezione proposta -> TAB.
    // Dopo che Vaadin ha ricevuto il click sulla proposta, usiamo il focus nativo
    // del browser sul vero campo Data. Questo genera realmente blur/focus nella
    // pagina e non dipende da KeyboardEvent sintetici (che GWT puo' ignorare).
    const form = getNonPrescribedForm();
    const dateInput =
      form?.date ||
      nearestControlFromCaption("Data", ".v-datefield input, input");

    if (!dateInput) {
      try { input?.blur(); } catch {}
      await sleep(80);
      return document.activeElement !== input;
    }

    try {
      dateInput.focus({ preventScroll: true });
    } catch {
      try { dateInput.focus(); } catch {}
    }
    await sleep(100);

    if (document.activeElement === dateInput) return true;

    // Secondo passaggio: forza esplicitamente l'uscita dal FilterSelect e poi
    // porta il focus sulla data. Non riscrive ne' riclicca l'Accertamento.
    try { input?.blur(); } catch {}
    await sleep(30);
    try { dateInput.focus(); } catch {}
    await sleep(100);

    return document.activeElement === dateInput || document.activeElement !== input;
  }

  async function commitFilterSelectOptionWithTab(input, option, targetText) {
    if (!input || !option) return false;

    // v0.15.7: il primo click sulla proposta esatta viene considerato il commit.
    // Nei test reali Eumed la voce viene selezionata correttamente al primo click,
    // mentre popup/focus/DOM non espongono uno stato affidabile da verificare.
    // Non eseguiamo quindi piu' alcun secondo click, retry o controllo intermedio:
    // la verifica forte resta il pulsante blu + comparsa della nuova riga in Grid.
    const realTarget = deepestVisiblePointTarget(option) || option;

    try { input.focus(); } catch {}
    try {
      realTarget.dispatchEvent(new MouseEvent("mouseover", {
        bubbles: true, cancelable: true, composed: true, view: window
      }));
    } catch {}
    await sleep(35);

    dispatchVaadinMouseSequence(realTarget);

    // v0.15.9: dopo il click lasciamo a Vaadin almeno mezzo secondo per
    // registrare davvero la selezione prima di toccare Data/Valore/Min/Max.
    await sleep(550);

    // NON tentiamo qui di spostare il focus. Il click sulla proposta
    // esatta e' il commit; il passo successivo (setNonPrescribedDate) clicchera'
    // direttamente il vero campo Data, individuato ora per geometria. In questo
    // modo evitiamo che una ricerca DOM ambigua rimetta il focus su Accertamento.
    return true;
  }

  async function chooseFilterSelectOptionFilteredFirst(input, targetText, options = {}) {
    const requireRealOption = Boolean(options?.requireRealOption);
    // v0.15.10: manteniamo le attese richieste da Eumed, ma NON torniamo alla
    // regressione della 0.15.9. Dopo almeno 550 ms il campo puo' essere gia'
    // stato acquisito da Vaadin e il popup puo' essere stato chiuso/rimontato.
    // In quel caso il nome catalogo esatto rimasto nel FilterSelect e' sufficiente
    // per proseguire: la validazione forte resta sempre il ✓ + nuova riga in Grid.
    if (!(await triggerNonPrescribedCatalogFilter(input, targetText))) {
      return { success: false, exactOptionFound: false };
    }

    const normalizedTarget = normalizeExamName(targetText);
    let option = await waitForFilterSelectOption(targetText, 1500);

    // Se la proposta reale e' ancora visibile, la clicchiamo e aspettiamo altri
    // 550 ms prima di toccare Data/Valore/Min/Max.
    if (option) {
      const committed = await commitFilterSelectOptionWithTab(input, option, targetText);
      return { success: committed, exactOptionFound: true, acceptedFromField: false };
    }

    // La proposta puo' essere stata gia' acquisita/chiusa da Vaadin mentre
    // aspettavamo. A differenza della 0.15.8, questo controllo avviene SOLO dopo
    // l'attesa minima di caricamento. Se il testo e' ancora esattamente quello
    // del catalogo, aspettiamo anche il mezzo secondo di stabilizzazione e poi
    // passiamo alla Data senza riscrivere o tentare alias.
    let refreshedInput =
      nearestControlFromCaption("Accertamento", ".v-filterselect-input, input") || input;
    if (!requireRealOption && normalizeExamName(refreshedInput.value || "") === normalizedTarget) {
      await sleep(550);
      return { success: true, exactOptionFound: true, acceptedFromField: true };
    }

    // Alcune build non rendono il popup finche' non si clicca la freccia.
    const wrapper = refreshedInput.closest(".v-filterselect");
    const dropButton = wrapper?.querySelector(".v-filterselect-button");
    if (dropButton) {
      vaadinClick(dropButton);
      await sleep(550);
      option = await waitForFilterSelectOption(targetText, 1000);
      if (option) {
        const committed = await commitFilterSelectOptionWithTab(refreshedInput, option, targetText);
        return { success: committed, exactOptionFound: true, acceptedFromField: false };
      }
    }

    refreshedInput =
      nearestControlFromCaption("Accertamento", ".v-filterselect-input, input") || refreshedInput;
    if (!requireRealOption && normalizeExamName(refreshedInput.value || "") === normalizedTarget) {
      await sleep(550);
      return { success: true, exactOptionFound: true, acceptedFromField: true };
    }

    return { success: false, exactOptionFound: false };
  }

  async function chooseNonPrescribedAccertamento(input, item) {
    if (!input || !item?.catalogEntry) return false;

    const code = String(item.catalogEntry.code || "").trim();
    const name = String(item.catalogEntry.name || "").trim();
    const aliases = Array.isArray(item.catalogEntry.aliases)
      ? item.catalogEntry.aliases.filter(Boolean)
      : [];

    // v0.15.32: il codice CVP/Eumed è il filtro più stabile e discriminante.
    // Prima di usare denominazioni lunghe/alias proviamo SEMPRE il codice puro
    // (es. 90.38.4_0 per il protidogramma) e richiediamo che compaia una vera
    // proposta Vaadin da cliccare. Il semplice testo digitato non basta.
    if (code) {
      const currentInput =
        nearestControlFromCaption("Accertamento", ".v-filterselect-input, input") || input;

      const codeAttempt = await chooseFilterSelectOptionFilteredFirst(
        currentInput,
        code,
        { requireRealOption: true }
      );

      if (codeAttempt.success) return true;

      // Se il codice ha prodotto una proposta reale ma il commit non è riuscito,
      // non cambiamo esame tentando nomi/alias: il mapping catalogo è già certo.
      if (codeAttempt.exactOptionFound) return false;
    }

    // Anche i fallback per nome/alias richiedono una vera proposta Vaadin.
    const strictSelectionTargets = {
      "90.28.1_0": [
        "90.28.1_0 -- Hb - EMOGLOBINA GLICATA",
        "Hb - EMOGLOBINA GLICATA"
      ],
      "90.56.3_2": [
        "90.56.3_2 -- ANTIGENE CARCINOEMBRIONARIO (CEA)",
        "ANTIGENE CARCINO EMBRIONARIO (CEA)",
        "ANTIGENE CARCINOEMBRIONARIO (CEA)"
      ]
    };
    const requireRealOption = true;
    const targets = [
      ...(strictSelectionTargets[code] || []),
      name,
      ...aliases
    ].filter(Boolean);

    for (const target of [...new Set(targets)].slice(0, 6)) {
      const currentInput =
        nearestControlFromCaption("Accertamento", ".v-filterselect-input, input") || input;

      const attempt = await chooseFilterSelectOptionFilteredFirst(
        currentInput,
        target,
        { requireRealOption }
      );

      if (attempt.success) return true;
      if (attempt.exactOptionFound) return false;
    }

    return false;
  }

  async function chooseNonPrescribedResult(input, targetText) {
    if (!input) return false;
    await chooseFilterSelectOption(input, targetText);
    await sleep(160);

    const fresh = nearestControlFromCaption("Risultato", ".v-filterselect-input, input");
    const value = normalizeExamName(fresh?.value || input.value || "");
    return value === normalizeExamName(targetText);
  }

  function getNonPrescribedTotalRowCount() {
    const grid = getNonPrescribedGrid();
    if (!grid) return 0;

    // Vaadin Grid virtualizza le righe: il numero di <tr> nel DOM rappresenta
    // solo la finestra renderizzata, non il totale. aria-rowcount invece resta
    // legato al dataset completo (include la riga header, quindi -1).
    const table = grid.querySelector('table[role="grid"][aria-rowcount]');
    const ariaCount = Number.parseInt(table?.getAttribute("aria-rowcount") || "", 10);
    if (Number.isFinite(ariaCount) && ariaCount >= 1) {
      return Math.max(0, ariaCount - 1);
    }

    // Fallback per eventuali versioni/theme che non espongono aria-rowcount.
    return getNonPrescribedRows().length;
  }

  function nonPrescribedRowMatchesItem(row, item) {
    if (!row) return false;
    const text = normalizeExamName(row.textContent || "");
    const target = normalizeExamName(item.exam || "");
    const tokens = significantTokens(target);
    const examOk = text.includes(target) ||
      (tokens.length >= 2 && tokens.slice(0, 4).every(token => text.includes(token)));
    if (!examOk) return false;

    // Quando disponibili, data e valore rendono il match ancora piu' specifico.
    const dateText = item.reportDate ? normalizeExamName(formatDateForGrid(item.reportDate)) : "";
    if (dateText && !text.includes(dateText)) return false;

    if (!item.complexKind && String(item.value || "").trim()) {
      const valueText = normalizeExamName(String(item.value || "").replace(",", "."));
      const rowTextDot = normalizeExamName(String(row.textContent || "").replace(/,/g, "."));
      if (valueText && !rowTextDot.includes(valueText)) return false;
    }

    return true;
  }

  function findNonPrescribedMatchingRowAfter(beforeTotalCount, item) {
    const totalNow = getNonPrescribedTotalRowCount();

    // Il segnale primario e' l'aumento del totale dati, non il numero di righe
    // DOM visibili. Questo evita falsi negativi quando Vaadin ricicla le righe
    // fuori viewport e impedisce retry che creerebbero duplicati.
    if (totalNow <= beforeTotalCount) return null;

    const rows = getNonPrescribedRows();
    const visibleMatch = rows.find(row => nonPrescribedRowMatchesItem(row, item));
    if (visibleMatch) return visibleMatch;

    // Se la riga appena aggiunta e' gia' fuori dalla finestra virtualizzata,
    // l'aumento di aria-rowcount e' comunque prova che il Salva locale ha creato
    // una nuova riga. In questa pipeline non avvengono altre scritture concorrenti.
    return {
      confirmedByTotalCount: true,
      beforeTotalCount,
      totalNow
    };
  }

  async function waitForNonPrescribedRowAdded(beforeTotalCount, item, timeoutMs = 4200) {
    return await pollUntil(
      () => findNonPrescribedMatchingRowAfter(beforeTotalCount, item),
      timeoutMs,
      70
    );
  }

  async function setNonPrescribedDate(input, reportDate) {
    if (!reportDate) return false;
    const target = formatDateForGrid(reportDate);
    const ok = await replaceVaadinDateInputFast(input, target, reportDate);
    if (!ok) return false;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    input.blur();
    await sleep(50);
    return sameDateValue(input.value, reportDate);
  }

  async function writeNonPrescribedItemAttempt(item, beforeCount, attemptIndex = 0) {
    let form = getNonPrescribedForm();

    if (!form.accertamento || !form.date) {
      throw new Error(
        "Schermata 'Inserimento senza prescrizioni' non riconosciuta. " +
        "Apri quella sezione di Eumed prima di avviare l'inserimento."
      );
    }

    if (form.accertamento === form.date) {
      return { success: false, item, field: "Data: campo non distinto da Accertamento" };
    }

    const catalogSelectionStarted = Date.now();
    const catalogSelected = await chooseNonPrescribedAccertamento(form.accertamento, item);
    item._catalogSelectionMs = (item._catalogSelectionMs || 0) + Date.now() - catalogSelectionStarted;
    if (!catalogSelected) {
      return { success: false, item, field: "Accertamento" };
    }

    // v0.15.27: replica il gesto manuale che su Eumed risulta piu' affidabile:
    // scelta reale dalla tendina -> uscita dal FilterSelect verso Data (equivale
    // al TAB manuale). Nei retry concediamo progressivamente piu' tempo a Vaadin
    // per registrare il valore server-side prima di compilare gli altri campi.
    await focusNonPrescribedDateAfterAccertamento(form.accertamento);
    await sleep([180, 450, 750, 1100][Math.min(attemptIndex, 3)]);

    form = getNonPrescribedForm();
    if (!(await setNonPrescribedDate(form.date, item.reportDate))) {
      return { success: false, item, field: "Data" };
    }

    form = getNonPrescribedForm();

    if (item.complexKind) {
      await clearFormInput(form.value);
      await clearFormInput(form.min);
      await clearFormInput(form.max);

      if (!(await chooseNonPrescribedResult(form.result, "Vedi referto"))) {
        return { success: false, item, field: "Risultato=Vedi referto" };
      }

      form = getNonPrescribedForm();
      if (!form.report || !(await replaceFormInput(form.report, item.text || "", false))) {
        return { success: false, item, field: "Referto" };
      }
    } else {
      if (!(await replaceFormInput(form.value, item.value, true))) {
        return { success: false, item, field: "Valore" };
      }

      if (item.refMin) {
        form = getNonPrescribedForm();
        if (!(await replaceFormInput(form.min, item.refMin, true))) {
          return { success: false, item, field: "Minimo" };
        }
      } else {
        await clearFormInput(form.min);
      }

      if (item.refMax) {
        form = getNonPrescribedForm();
        if (!(await replaceFormInput(form.max, item.refMax, true))) {
          return { success: false, item, field: "Massimo" };
        }
      } else {
        await clearFormInput(form.max);
      }

      form = getNonPrescribedForm();
      if (form.report) await clearFormInput(form.report);
    }

    form = getNonPrescribedForm();
    const confirmButton = await findNonPrescribedConfirmButton(form.report);
    if (!confirmButton) {
      const live = getNonPrescribedForm();
      const expected = `attesi Valore=${item.value || ""}, Min=${item.refMin || "∅"}, Max=${item.refMax || "∅"}`;
      const actual = `campi Valore=${live.value?.value || "∅"}, Min=${live.min?.value || "∅"}, Max=${live.max?.value || "∅"}`;
      const detail = lastNonPrescribedConfirmDiagnostic
        ? `Conferma parziale — ${lastNonPrescribedConfirmDiagnostic}; ${expected}; ${actual}`
        : `Conferma parziale — ${expected}; ${actual}`;
      return { success: false, item, field: detail };
    }

    vaadinClick(confirmButton);

    // Un retry successivo non deve partire troppo presto: il timeout cresce
    // leggermente ad ogni tentativo per tollerare risposte Vaadin piu' lente.
    const row = await waitForNonPrescribedRowAdded(
      beforeCount,
      item,
      [4600, 5200, 6000, 6800][Math.min(attemptIndex, 3)]
    );
    if (!row) {
      return { success: false, item, field: "Riga non comparsa nella tabella" };
    }

    await sleep(80);
    return { success: true, item, row };
  }

  async function writeNonPrescribedItem(item) {
    const beforeCount = getNonPrescribedTotalRowCount();
    const maxAttempts = 4; // primo tentativo + 3 retry
    let lastResult = null;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
      // Prima di ogni retry controlliamo se la conferma precedente e' arrivata
      // in ritardo. In tal caso la consideriamo riuscita e NON ricreiamo la riga.
      if (attemptIndex > 0) {
        await sleep([0, 650, 900, 1200][attemptIndex]);
        const lateRow = findNonPrescribedMatchingRowAfter(beforeCount, item);
        if (lateRow) {
          return { success: true, item, row: lateRow, retries: attemptIndex };
        }
      }

      lastResult = await writeNonPrescribedItemAttempt(item, beforeCount, attemptIndex);
      if (lastResult.success) {
        return { ...lastResult, retries: attemptIndex };
      }

      // I retry automatici servono solo per il caso intermittente osservato:
      // Accertamento apparentemente scritto ma non realmente acquisito da Vaadin,
      // per cui il Salva locale non produce alcuna riga. Per qualsiasi altro
      // errore ci fermiamo subito senza rischiare interazioni aggiuntive.
      if (lastResult.field !== "Riga non comparsa nella tabella") {
        return lastResult;
      }
    }

    return {
      ...(lastResult || { success: false, item }),
      success: false,
      item,
      field: `Riga non comparsa nella tabella dopo ${maxAttempts} tentativi`
    };
  }

  async function writeNonPrescribedItems(items, progressCallback = null) {
    const completed = [];
    const warnings = [];
    const stats = { retries: 0, retriedRows: 0, catalogSelectionMs: 0 };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      item._catalogSelectionMs = 0;
      progressCallback?.(i + 1, items.length, item);
      const result = await writeNonPrescribedItem(item);
      stats.retries += Number(result.retries || 0);
      if (result.retries) stats.retriedRows++;
      stats.catalogSelectionMs += item._catalogSelectionMs || 0;

      if (!result.success) {
        warnings.push({
          exam: item.exam,
          field: result.field || "controllare"
        });

        // Stop duro: se una riga non è stata confermata non proseguire,
        // altrimenti rischieremmo di scrivere il dato successivo sul form
        // rimasto nello stato precedente.
        return { success: false, completed, warnings, failed: item, stats };
      }

      completed.push(item);
    }

    return { success: true, completed, warnings, stats };
  }


  // ============================================================
  // v0.15.35 - PRESCRIZIONE ESAMI DA LISTA
  // Terza pipeline indipendente dagli esiti.
  // - testo incollato: Qwen estrae gli esami richiesti;
  // - PDF/JPEG/PNG: Qwen Vision lavora direttamente sull'immagine e riconosce
  //   le X/spunte, senza passare da PaddleOCR o dal text layer del PDF;
  // - il catalogo locale resta il vincolo finale;
  // - la scrittura usa solo il form Accertamenti e non preme mai Ricette.
  // ============================================================

  const PRESCRIPTION_LIST_SCHEMA = {
    type: "object",
    properties: {
      i: {
        type: "array",
        items: {
          type: "array",
          prefixItems: [
            { type: "string" },
            { type: "string" }
          ],
          minItems: 2,
          maxItems: 2
        }
      },
      u: {
        type: "array",
        items: {
          type: "array",
          prefixItems: [
            { type: "string" },
            { type: "string" }
          ],
          minItems: 2,
          maxItems: 2
        }
      }
    },
    required: ["i", "u"]
  };

  function expandPrescriptionListPayload(parsed) {
    const p = parsed && typeof parsed === "object" ? parsed : {};
    return {
      items: Array.isArray(p.i)
        ? p.i.map(row => ({
            raw_label: String(row?.[0] || "").trim(),
            evidence: String(row?.[1] || "").trim()
          })).filter(x => x.raw_label)
        : [],
      uncertain: Array.isArray(p.u)
        ? p.u.map(row => ({
            text: String(row?.[0] || "").trim(),
            reason: String(row?.[1] || "").trim()
          })).filter(x => x.text || x.reason)
        : []
    };
  }

  function mergePrescriptionListPayloads(payloads) {
    const items = [];
    const uncertain = [];
    const seen = new Set();

    for (const payload of payloads || []) {
      for (const item of payload?.items || []) {
        const key = normalizeExamName(item?.raw_label || "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push({ ...item });
      }
      uncertain.push(...(payload?.uncertain || []));
    }

    return { items, uncertain };
  }

  function prescriptionSelectionSupported(label, sourceText, selective) {
    const wanted = normalizeExamName(label);
    if (!wanted) return false;
    const segments = String(sourceText || '').split(/\r?\n|;|\t+/).flatMap(line => line.split(/(?=\[[ xX]\]|[☐☑☒□✓✔])/));
    return segments.some(segment => {
      const marked = /^\s*(?:\[[xX]\]|[☑☒✓✔]|[xX]\s)/.test(segment);
      if (selective && !marked) return false;
      const normalized = normalizeExamName(segment.replace(/^\s*(?:\[[ xX]\]|[☐☑☒□✓✔]|[xX]\s)/, ''));
      return (` ${normalized} `).includes(` ${wanted} `);
    });
  }

  function prescriptionLabelSupportedByText(label, sourceText) {
    const source = normalizeExamName(sourceText || "");
    const wanted = normalizeExamName(label || "");
    if (!source || !wanted) return false;
    if (source.includes(wanted)) return true;

    const tokens = significantTokens(wanted).filter(t => t.length >= 2);
    if (!tokens.length) return false;
    const matched = tokens.filter(t => source.includes(t)).length;
    return matched >= Math.min(2, tokens.length) && matched / tokens.length >= 0.6;
  }

  function splitPrescriptionAnalysisText(sourceText, maxChars = 900) {
    const text=String(sourceText || '').trim(), parts=[];
    let current='', depth=0;
    for(let index=0;index<text.length;index++) {
      const char=text[index];
      if('(['.includes(char)) depth++;
      if(')]'.includes(char)) depth=Math.max(0,depth-1);
      if(!depth && /[\n;,]/.test(char) && !(char===',' && /\d/.test(text[index-1]||'') && /\d/.test(text[index+1]||''))) {if(current.trim()) parts.push(current.trim());current='';}
      else current+=char;
    }
    if(current.trim()) parts.push(current.trim());
    const chunks=[];current='';let count=0;
    for(const part of parts) {
      if(current && (current.length+part.length+1>maxChars || count>=12)) {chunks.push(current);current='';count=0;}
      current+=(current?'\n':'')+part;count++;
    }
    if(current) chunks.push(current);
    return chunks;
  }

  async function extractPrescriptionListWithQwenText(sourceText, progressCallback = null) {
    const text=String(sourceText || '').trim();
    if(!text) return {items:[],uncertain:[]};
    const selective=/[\u2610\u2611\u2612\u25a1\u2713\u2714\u2717\u2718]|\[[ xX]\]|^\s*[xX]\s+/m.test(text);
    const chunks=splitPrescriptionAnalysisText(text), items=[], uncertain=[];
    let activeBatch=0;
    const read=async(chunk,depth=0)=>{
      try {
        return await extractPrescriptionListTextBatch(chunk,info=>progressCallback?.({...info,current:activeBatch+1,total:chunks.length}),selective);
      } catch(error) {
        if(depth>=3 || !/JSON|tronc|incomplet/i.test(String(error?.message || error))) throw error;
        const smaller=splitPrescriptionAnalysisText(chunk,Math.max(1,Math.floor(chunk.length/2)));
        if(smaller.length<2) throw error;
        const combined={items:[],uncertain:[]};
        for(const part of smaller){const result=await read(part,depth+1);combined.items.push(...result.items);combined.uncertain.push(...result.uncertain);}
        return combined;
      }
    };
    for(let i=0;i<chunks.length;i++) {
      activeBatch=i;
      progressCallback?.({phase:'prescription_qwen_start',source:'text',current:i+1,total:chunks.length});
      let result;
      try {result=await read(chunks[i]);}
      catch(error){throw new Error(`Analisi lista interrotta al blocco ${i+1}/${chunks.length}: ${error?.message || error}. La lista non e stata completata: nessun inserimento avviato.`);}
      items.push(...result.items);uncertain.push(...result.uncertain);
    }
    progressCallback?.({phase:'prescription_qwen_done',count:items.length});
    return {items,uncertain};
  }

  async function extractPrescriptionListTextBatch(sourceText, progressCallback = null, selective = false) {
    const text = String(sourceText || "").trim();
    if (!text) return { items: [], uncertain: [] };

    const system = `
Sei un assistente locale che deve leggere una LISTA DI ESAMI da prescrivere.
NON fare diagnosi e NON aggiungere esami non presenti.

REGOLE:
- restituisci una voce per ogni esame realmente richiesto;
- raw_label deve essere il nome/abbreviazione COME compare nel testo, non una tua traduzione;
- se il testo e' una semplice lista senza caselle/spunte, considera richieste tutte le voci della lista;
- se invece compaiono checkbox, X, croci, spunte o indicatori selettivi, includi SOLO le voci chiaramente selezionate;
- separa esami diversi anche se sono sulla stessa riga;
- NON espandere profili o pannelli in esami che non sono esplicitamente scritti;
- non trasformare CMV, HIV, HBV, HCV, Toxoplasma ecc. in nomi diversi: conserva la dicitura originale;
- titoli, note cliniche, date, firme e istruzioni non sono esami;
- se non sei certo che una voce sia richiesta, mettila in u e NON in i.

Output compatto:
- i = [[raw_label,evidence], ...]
- u = [[testo,motivo], ...]
`;

    progressCallback?.({ phase: "prescription_qwen_start", source: "text" });
    const content = await ollamaChat(
      [
        { role: "system", content: system + (selective ? "\nLa lista completa contiene marcature selettive: anche in questo frammento includi SOLO voci esplicitamente selezionate." : "") },
        { role: "user", content: text }
      ],
      info => progressCallback?.({ phase: "prescription_qwen_stream", chars: info?.chars || 0 }),
      1800,
      PRESCRIPTION_LIST_SCHEMA
    );

    const payload = expandPrescriptionListPayload(extractJSONObject(content));
    const filtered = [];
    const uncertain = [...payload.uncertain];

    for (const item of payload.items) {
      if (prescriptionSelectionSupported(item.raw_label, text, selective || /\[[ xX]\]|[☐☑☒□✓✔]/.test(text))) {
        filtered.push(item);
      } else {
        uncertain.push({
          text: item.raw_label,
          reason: "Nome o marcatura di selezione non confermati sulla stessa voce del testo"
        });
      }
    }

    progressCallback?.({ phase: "prescription_qwen_done", count: filtered.length });
    return { items: filtered, uncertain };
  }

  async function extractPrescriptionListWithQwenVision(imageBase64, label, progressCallback = null) {
    const prompt = `
Analizza VISIVAMENTE questa pagina che contiene una lista/richiesta di esami medici.
Devi identificare SOLO gli esami effettivamente richiesti.

REGOLA FONDAMENTALE PER LE LISTE CON CASELLE:
- osserva anche segni grafici/manoscritti: X, croci, spunte, cerchi, barrature o marcature vicino alla voce;
- se la pagina contiene molte voci e solo alcune sono marcate, restituisci SOLO quelle chiaramente marcate;
- una casella vuota o una voce non marcata NON deve essere inclusa;
- se un segno e' ambiguo, metti la voce in u, non in i.

SE INVECE la pagina e' una semplice richiesta breve senza checkbox/segni selettivi, considera richieste le voci esplicitamente elencate.

ALTRE REGOLE:
- raw_label deve riprodurre il nome/abbreviazione visibile della voce, senza reinterpretarlo;
- NON inventare esami e NON espandere profili in componenti non visibili;
- ignora intestazioni, dati anagrafici, note, firme, codici amministrativi non associati a un esame;
- separa esami distinti;
- evidence deve descrivere brevemente perche' la voce e' stata considerata selezionata (es. "X a sinistra della riga").

Output JSON compatto:
- i = [[raw_label,evidence], ...]
- u = [[testo,motivo], ...]
`;

    progressCallback?.({ phase: "prescription_vision_start", label });
    const content = await ollamaChat(
      [{ role: "user", content: prompt, images: [imageBase64] }],
      info => progressCallback?.({
        phase: "prescription_vision_stream",
        label,
        chars: info?.chars || 0
      }),
      1800,
      PRESCRIPTION_LIST_SCHEMA
    );

    const payload = expandPrescriptionListPayload(extractJSONObject(content));
    // Independent visual verification of each proposed row; unknown/empty never passes.
    if (payload.items.length) {
      const schema = {type:'object',properties:{rows:{type:'array',items:{type:'object',properties:{index:{type:'integer',enum:payload.items.map((_,index)=>index)},label:{type:'string'},marker:{type:'string',enum:['checked','plain','empty','uncertain']}},required:['index','label','marker'],additionalProperties:false}}},required:['rows'],additionalProperties:false};
      const verification = extractJSONObject(await ollamaChat([{role:'user',images:[imageBase64],content:
        'Verifica sulla immagine originale ogni voce candidata. Non fidarti della prima lettura. Restituisci una riga per ogni candidato, con index UGUALE all indice del candidato fornito (non la posizione nella pagina), label originale e marker. Se ci sono caselle: marker="checked" SOLO con spunta o X sulla stessa voce. Casella vuota: marker="empty". Segno ambiguo o voce assente: marker="uncertain". Solo se tutta la pagina e una lista senza caselle usa marker="plain". Candidati:\n' + payload.items.map((item,index)=>`${index}: ${item.raw_label}`).join('\n')}],null,1800,schema));
      payload.items = payload.items.filter((item,index) => {
        const matches = (verification.rows || []).filter(row=>row.index === index);
        const row = matches.length === 1 ? matches[0] : null;
        const accepted = row && ['checked','plain'].includes(row.marker) && normalizeExamName(row.label) === normalizeExamName(item.raw_label);
        if (!accepted) payload.uncertain.push({text:item.raw_label,reason:'Selezione visiva non confermata nella seconda verifica della riga.'});
        return accepted;
      });
    }
    progressCallback?.({ phase: "prescription_vision_done", label, count: payload.items.length });
    return payload;
  }

  async function extractPrescriptionListFromFile(file, progressCallback = null) {
    if (!file) throw new Error("Carica prima un PDF/JPEG/PNG.");
    const lower = String(file.name || "").toLowerCase();
    const isPdf = file.type === "application/pdf" || lower.endsWith(".pdf");
    const isImage = /image\/(jpeg|png)/.test(file.type) || /\.(jpe?g|png)$/.test(lower);
    if (!isPdf && !isImage) throw new Error("Formato non supportato. Usa PDF, JPEG o PNG.");

    if (isImage) {
      const base64 = await imageFileToBase64(file);
      return await extractPrescriptionListWithQwenVision(
        base64,
        file.name || "immagine",
        progressCallback
      );
    }

    const pdfjs = await getPdfJs();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    if (pdf.numPages > CONFIG.pdfVisionMaxPages) {
      throw new Error(`PDF di ${pdf.numPages} pagine; limite IA Vision ${CONFIG.pdfVisionMaxPages}.`);
    }

    const payloads = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      progressCallback?.({ phase: "prescription_pdf_page", current: pageNumber, total: pdf.numPages });
      const page = await pdf.getPage(pageNumber);
      const imageBase64 = await renderPdfPageToBase64(page);
      payloads.push(
        await extractPrescriptionListWithQwenVision(
          imageBase64,
          `pagina ${pageNumber}/${pdf.numPages}`,
          progressCallback
        )
      );
    }

    return mergePrescriptionListPayloads(payloads);
  }

  function buildPrescriptionDecisionContext(rawItems) {
    const labels = (rawItems || []).map(x => sanitizeCreationCatalogAlias(x?.raw_label || "")).filter(Boolean);
    const joined = labels.join("\n");
    const n = normalizeExamName(joined);

    const hasHbsAg = labels.some(label => {
      const marker = normalizeExamName(label);
      return !/ANTI\s*HBS|HBSAB|ANTICORPI\s+HBS/.test(marker) &&
        (/\bHBSAG\b/.test(marker) || /(?:^|\s)HBS(?:\s|$)/.test(marker) || marker.includes("ANTIGENE HBS"));
    });
    const hasAntiHbs = /ANTI\s*HBS|HBSAB|ANTICORPI\s+HBS/.test(n);
    const hasAntiHbc = /ANTI\s*HBC|HBC\s*AB|ANTICORPI\s+HBC/.test(n) ||
      (/ANTI CORE/.test(n) && /\bHBV\b|EPAT(?:ITE)? B/.test(n));
    const markerCount = [hasHbsAg, hasAntiHbs, hasAntiHbc].filter(Boolean).length;
    const hbvProfile =
      /HBV.*(?:REFLEX|PROFIL|COMPLET)|EPATITE B.*(?:REFLEX|PROFIL|COMPLET)/.test(n) ||
      markerCount >= 2 || hasAntiHbc;

    return {
      ...buildUnprescribedDecisionContext(joined, []),
      hbvProfile,
      hbv: { hasHbsAg, hasAntiHbs, hasAntiHbc }
    };
  }

  function resolvePrescriptionListItems(rawItems) {
    const context = buildPrescriptionDecisionContext(rawItems);
    const resolved = [];
    const uncertain = [];
    const seenCodes = new Set();

    for (const rawItem of rawItems || []) {
      const label = String(rawItem?.raw_label || "").trim();
      if (!label) continue;

      const n = normalizeExamName(label);
      if (/^(?:ESAMI|ANALISI|LABORATORIO|BIOCHIMICA|SIEROLOGIA|EMATOLOGIA)$/.test(n)) continue;

      if (/^CALCIURIA(?: (?:SPOT|ESTEMPORANEA|SEMPLICE|NORMALE))?$/.test(n)) {
        uncertain.push({ text: label, reason: "Nel catalogo manca una voce generica CALCIO [U]: specificare I/II minzione oppure rapporto calcio/creatinina. Nessuna conversione automatica in raccolta 24 ore." });
        continue;
      }

      if (/BILIRUBINA/.test(n) && /\bDIRETTA\b|\bINDIRETTA\b/.test(n) && !/REFLEX/.test(n)) {
        uncertain.push({text:label,reason:"Saltata: bilirubina diretta/indiretta non prescritta autonomamente. La voce prevista e BILIRUBINA reflex 90.10.5_3."});
        continue;
      }
      const preferred = preferredPrescriptionCatalogEntry(label, context);
      let match = preferred
        ? { entry: preferred, score: 4000, preferred: true }
        : matchCatalogForCreation(label, context);

      if (match?.blocked) {
        uncertain.push({ text: label, reason: match.reason || "Voce catalogo non univoca" });
        continue;
      }

      if (!match?.entry) {
        uncertain.push({
          text: label,
          reason: match?.ambiguous
            ? `Più voci del catalogo risultano equivalenti${match.candidates?.length ? `: ${match.candidates.slice(0, 3).map(x => `${x.entry?.code || ""} ${x.entry?.name || ""}`.trim()).join(" · ")}` : ""}`
            : "Nessuna voce certa nel catalogo prescrivibile"
        });
        continue;
      }

      const code = String(match.entry.code || "").trim();
      if (!code) continue;
      if (seenCodes.has(code)) {
        const existing=resolved.find(item=>item.catalogCode===code);
        if (existing && !existing.requestedLabels.includes(label)) existing.requestedLabels.push(label);
        if (existing && code==="91.18.6_0" && /IGM/.test(n)) existing.mappingNote="Voce unica HBV reflex: il catalogo include anti-HBc IgM se HBsAg e anti-HBc sono positivi. Non e un dosaggio IgM autonomo.";
        continue;
      }
      seenCodes.add(code);

      resolved.push({
        raw_label: label,
        requestedLabels: [label],
        mappingNote: code==="90.56.9_0" ? "PSA totale e libero confluiscono nella stessa voce PSA reflex." : code==="90.66.7_2" ? "Frazioni HbA2, HbF e varianti confluiscono nel dosaggio delle frazioni emoglobiniche." : code==="91.21.6_0" ? "Marcatori EBV accorpati: EBNA, VCA IgG e VCA IgM." : code==="91.18.6_0" ? (/IGM/.test(n)
          ? "Voce unica HBV reflex: il catalogo include anti-HBc IgM se HBsAg e anti-HBc sono positivi. Non e un dosaggio IgM autonomo."
          : "I marcatori HBV richiesti confluiscono nella stessa voce reflex del catalogo.") : "",
        evidence: String(rawItem?.evidence || "").trim(),
        exam: String(match.entry.name || label),
        catalogCode: code,
        catalogEntry: match.entry,
        source: match.preferred || preferred ? "mapping-deterministico" : "catalogo"
      });
    }

    return { resolved, uncertain };
  }

  function getPrescriptionListForm() {
    const exemptionSlot = [...document.querySelectorAll(".v-slot-esenzione-prescrizione")]
      .find(isVisibleElement);
    if (!exemptionSlot) return null;

    const row = exemptionSlot.closest(".v-horizontallayout.v-layout.v-horizontal");
    if (!row || !isVisibleElement(row)) return null;

    const filterInputs = [...row.querySelectorAll("input.v-filterselect-input")].filter(isVisibleElement);
    const priority = filterInputs.find(input => String(input.placeholder || "").toLowerCase().includes("priorit")) || null;
    const exemption = exemptionSlot.querySelector("input.v-filterselect-input") || null;
    const accertamento = filterInputs.find(input =>
      input !== priority &&
      input !== exemption &&
      !input.readOnly &&
      !input.classList.contains("v-filterselect-input-readonly")
    ) || null;

    const confirm = row.querySelector(
      ".v-slot-friendly .v-button-friendly.icon-only[role='button'], " +
      ".v-slot-friendly [role='button'].v-button-friendly"
    );

    return { row, accertamento, exemption, priority, confirm };
  }

  function getPrescriptionListGrid() {
    return [...document.querySelectorAll(".v-treegrid.prescrizione")].find(isVisibleElement) || null;
  }

  async function waitForPrescriptionListForm(fields, timeoutMs = 2200) {
    for (let elapsed = 0; elapsed <= timeoutMs; elapsed += 80) {
      const form = getPrescriptionListForm();
      if (form && fields.every(field => form[field])) return form;
      if (elapsed < timeoutMs) await sleep(80);
    }
    return null;
  }

  function prescriptionPageIsReady() {
    const form = getPrescriptionListForm();
    return Boolean(
      form?.accertamento &&
      form?.exemption &&
      form?.priority &&
      form?.confirm &&
      getPrescriptionListGrid()
    );
  }

  function getPrescriptionListRowCount() {
    const grid = getPrescriptionListGrid();
    const table = grid?.querySelector("table[role='treegrid'][aria-rowcount]");
    const count = Number.parseInt(table?.getAttribute("aria-rowcount") || "", 10);
    // Non usare le righe DOM come totale: la TreeGrid e' virtualizzata.
    return Number.isFinite(count) && count >= 0 ? count : null;
  }

  function prescriptionRowText(row) {
    const cells = row?.querySelectorAll?.("td[role='gridcell'], td.v-treegrid-cell, [role='gridcell']");
    // textContent della riga concatena celle adiacenti senza separatori.
    return cells?.length ? [...cells].map(cell => cell.textContent || "").join(" ") : row?.textContent || "";
  }

  function normalizePrescriptionRowText(text) {
    return normalizeExamName(text).replace(/[°ºª]/g, "").replace(/\s+/g, " ").trim();
  }

  function prescriptionRowMatchesItem(row, item) {
    const text = normalizePrescriptionRowText(sanitizeCreationCatalogAlias(prescriptionRowText(row)));
    if (!text) return false;

    const code = normalizePrescriptionRowText(item?.catalogCode || "");
    const containsWhole = value => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(text);
    };
    if (code && containsWhole(code)) return true;
    const names = [item?.catalogEntry?.name, item?.exam, ...(item?.catalogEntry?.aliases || [])]
      .filter(Boolean).map(sanitizeCreationCatalogAlias).map(normalizePrescriptionRowText);
    return names.some(name => name.length >= 4 && containsWhole(name));
  }

  function findPrescriptionMatchingRow(item) {
    const grid = getPrescriptionListGrid();
    if (!grid) return null;
    return [...grid.querySelectorAll("tbody.v-treegrid-body > tr, [role='rowgroup'] > [role='row']")]
      .find(row => prescriptionRowMatchesItem(row, item)) || null;
  }

  function getPrescriptionRowEvidence(item) {
    const grid = getPrescriptionListGrid();
    const rows = grid ? [...grid.querySelectorAll("tbody.v-treegrid-body > tr, [role='rowgroup'] > [role='row']")] : [];
    return rows.filter(row => prescriptionRowMatchesItem(row, item)).map(row => ({
      row,
      prescriptionDate: prescriptionListRowDate(row, grid),
      key: `${row.getAttribute("aria-rowindex") || ""}|${normalizePrescriptionRowText(prescriptionRowText(row))}`
    }));
  }

  function getPrescriptionWriteSnapshot(item) {
    const evidence = getPrescriptionRowEvidence(item);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return {
      total: getPrescriptionListRowCount(),
      matches: evidence.map(entry => entry.key),
      todayMatches: evidence.filter(entry => entry.prescriptionDate === today).length,
      unknownDateMatches: evidence.filter(entry => !entry.prescriptionDate).length,
      today
    };
  }

  function prescriptionListRowDate(row, grid) {
    const headers = [...grid.querySelectorAll("thead th, [role='columnheader']")];
    const dateHeaders = headers.filter(header => /^DATA PRESC(?:RIZ(?:IONE)?)?$/.test(normalizeExamName(header.textContent || "")));
    if (dateHeaders.length !== 1) return "";
    const header = dateHeaders[0];
    const ariaIndex = Number.parseInt(header.getAttribute("aria-colindex") || "", 10);
    const cells = [...row.querySelectorAll("td[role='gridcell'], td.v-treegrid-cell, [role='gridcell']")];
    let cell = Number.isFinite(ariaIndex)
      ? cells.find(candidate => Number.parseInt(candidate.getAttribute("aria-colindex") || "", 10) === ariaIndex)
      : cells[Number.isInteger(header.cellIndex) ? header.cellIndex : headers.indexOf(header)];
    if (!cell && !cells.some(candidate => candidate.getAttribute("aria-colindex"))) {
      cell = cells[Number.isInteger(header.cellIndex) ? header.cellIndex : ariaIndex - 1];
    }
    // Never infer the prescription date from another date elsewhere in the row.
    return normalizeDateValue(cell?.textContent || "");
  }

  function findNewPrescriptionRow(before, item) {
    const total = getPrescriptionListRowCount();
    if (!Number.isFinite(before?.total) || !Number.isFinite(total) || total <= before.total) return null;
    // Servono entrambi: crescita del totale e una nuova riga corrispondente.
    // Confrontiamo evidenze, non nodi DOM: Vaadin puo' riciclare gli stessi nodi.
    const remaining = [...before.matches];
    for (const evidence of getPrescriptionRowEvidence(item)) {
      if (evidence.prescriptionDate !== before.today) continue;
      const index = remaining.indexOf(evidence.key);
      if (index < 0) return evidence.row;
      remaining.splice(index, 1);
    }
    return null;
  }

  async function waitForPrescriptionRowAdded(before, item, timeoutMs = 5000) {
    const loops = Math.ceil(timeoutMs / 100);
    for (let i = 0; i < loops; i++) {
      const row = findNewPrescriptionRow(before, item);
      if (row) return row;
      await sleep(100);
    }
    return null;
  }

  async function choosePrescriptionCatalogEntry(input, item) {
    if (!input || !item?.catalogEntry) return false;
    const code = String(item.catalogEntry.code || "").trim();
    const name = String(item.catalogEntry.name || "").trim();
    const aliases = Array.isArray(item.catalogEntry.aliases)
      ? item.catalogEntry.aliases.filter(Boolean)
      : [];

    const targets = [code, name, ...aliases].filter(Boolean);
    for (const target of [...new Set(targets)].slice(0, 7)) {
      const currentInput = getPrescriptionListForm()?.accertamento || input;
      const attempt = await choosePrescriptionCatalogTarget(currentInput, target, item);
      if (attempt.success) return true;
      if (attempt.exactOptionFound) return false;
    }
    return false;
  }

  function getPrescriptionCatalogOptions() {
    // Non usare i popup montati ma fuori schermo, ne' i figli grafici della
    // proposta: il destinatario degli eventi Vaadin e' la vera voce di menu.
    return [...new Set([...document.querySelectorAll(
      ".v-filterselect-suggestpopup .gwt-MenuItem, .gwt-SuggestBoxPopup .gwt-MenuItem, " +
      ".v-filterselect-suggestmenu .gwt-MenuItem, [role='option']"
    )].map(node => node.closest?.(".gwt-MenuItem") || node))].filter(isActuallyVisibleInViewport);
  }

  function prescriptionCatalogOptionEvidence(option, item) {
    const originalText = String(option?.textContent || "").trim();
    const text = sanitizeCreationCatalogAlias(originalText);
    const codes = text.toUpperCase().match(/\b(?:\d{2}\.\d{2}\.[A-Z0-9]+|G\d\.\d+)(?:_[A-Z0-9]+)?\b/g) || [];
    const codeExact = codes.includes(String(item.catalogCode || item.catalogEntry?.code || "").toUpperCase());
    const codeConflict = codes.length > 0 && !codeExact;
    const caption = normalizePrescriptionRowText(text.replace(/\b(?:\d{2}\.\d{2}\.[A-Z0-9]+|G\d\.\d+)(?:_[A-Z0-9]+)?\b/gi, ""));
    const names = [item.catalogEntry?.name, item.exam, ...(item.catalogEntry?.aliases || [])]
      .filter(Boolean).map(sanitizeCreationCatalogAlias).filter(Boolean);
    const exactCaption = names.some(name => normalizePrescriptionRowText(name) === caption);
    const captionMatched = exactCaption || prescriptionRowMatchesItem(option, { ...item, catalogCode: "" });
    const nameScore = captionMatched ? Math.max(0, ...names.map(name => filterSelectCandidateScore(text, name))) : 0;
    const score = codeConflict ? 0 : codeExact ? 12000 : exactCaption ? 11000 : nameScore;
    const referenceCodes = originalText.slice(text.length).toUpperCase().match(/\b(?:\d{2}\.\d{2}\.[A-Z0-9]+|G\d\.\d+)(?:_[A-Z0-9]+)?\b/g) || [];
    return { score, codeExact, codeConflict, codeAbsent: codes.length === 0, captionMatched, exactCaption, ignoredReferenceCodesCount: referenceCodes.length };
  }

  function readPrescriptionCatalogSelection(item, popup) {
    const field = getPrescriptionListForm()?.accertamento;
    const value = String(field?.value || "").trim();
    const fieldIsCode = !!value && value.toUpperCase() === String(item?.catalogCode || "").toUpperCase();
    const fieldMatched = Boolean(value && !fieldIsCode && (
      prescriptionRowMatchesItem({ textContent: value }, item) ||
      (item._prescriptionSelectedCaption && normalizePrescriptionRowText(value) === item._prescriptionSelectedCaption)
    ));
    const popupVisible = !!popup && isActuallyVisibleInViewport(popup);
    return { fieldPresent: !!field, fieldIsCode, fieldMatched, popupVisible,
      success: fieldMatched && !popupVisible };
  }

  async function waitPrescriptionCatalogSelection(item, popup, timeoutMs = 1400) {
    let stable = 0;
    for (let elapsed = 0; elapsed <= timeoutMs; elapsed += 80) {
      const state = readPrescriptionCatalogSelection(item, popup);
      stable = state.success ? stable + 1 : 0;
      if (stable >= 2) return state;
      await sleep(80);
    }
    return { ...readPrescriptionCatalogSelection(item, popup), success: false };
  }

  async function choosePrescriptionCatalogTarget(input, target, item) {
    delete item._prescriptionSelectedCaption;
    const started = Date.now();
    const queryIndex = item._diagnosticQuery = (item._diagnosticQuery || 0) + 1;
    const trace = (step, state = {}) => {
      if (typeof recordDiagnosticEvent === "function") recordDiagnosticEvent("catalogo_selezione", {
        rowIndex: item?._diagnosticRow || 0, attempt: item?._diagnosticAttempt || 1,
        queryIndex, targetIsCode: String(target).toUpperCase() === String(item.catalogCode).toUpperCase(),
        pageHidden: typeof document !== "undefined" && Boolean(document.hidden),
        step, durationMs: Date.now() - started, ...state
      });
    };
    if (!(await triggerNonPrescribedCatalogFilter(input, target))) {
      trace(1, { success: false });
      return { success: false, exactOptionFound: false };
    }
    const findOption = () => {
      const visible = getPrescriptionCatalogOptions();
      const evidence = visible.map(candidate => ({ candidate, ...prescriptionCatalogOptionEvidence(candidate, item) }));
      const bestScore = Math.max(0, ...evidence.map(entry => entry.score));
      const ranked = bestScore >= 7000 ? evidence.filter(entry => entry.score === bestScore).map(entry => entry.candidate) : [];
      return { visible, ranked, bestScore,
        codeMatchesCount: evidence.filter(entry => entry.codeExact).length,
        captionMatchesCount: evidence.filter(entry => entry.captionMatched).length,
        ignoredReferenceCodesCount: evidence.reduce((sum,entry)=>sum+entry.ignoredReferenceCodesCount,0),
        codeAbsentCount: evidence.filter(entry => entry.codeAbsent).length,
        codeConflictCount: evidence.filter(entry => entry.codeConflict).length };
    };
    let found = { visible: [], ranked: [] };
    for (let elapsed = 0; elapsed < 2000; elapsed += 80) {
      found = findOption();
      if (found.ranked.length) {
        // Use the fresh menu item after Vaadin has had time to finish rendering.
        await sleep(100);
        found = findOption();
        if (found.ranked.length) break;
      }
      await sleep(80);
    }
    trace(2, { optionsCount: found.visible.length, matchingOptions: found.ranked.length,
      bestScore: found.bestScore, codeMatchesCount: found.codeMatchesCount,
      captionMatchesCount: found.captionMatchesCount, codeAbsentCount: found.codeAbsentCount,
      ignoredReferenceCodesCount: found.ignoredReferenceCodesCount,
      codeConflictCount: found.codeConflictCount });
    if (found.ranked.length !== 1) return { success: false, exactOptionFound: found.ranked.length > 0 };
    let option = found.ranked[0];
    item._prescriptionSelectedCaption = normalizePrescriptionRowText(String(option.textContent || "")
      .replace(/\b(?:\d{2}\.\d{2}\.[A-Z0-9]+|G\d\.\d+)(?:_[A-Z0-9]+)?\b/gi, ""));
    let popup = getFilterSelectPopup(option);
    // Click before blur: a synthetic Tab alone can dismiss the menu without
    // committing its highlighted item, leaving no visible item for a fallback.
    dispatchVaadinMouseSequence(option);
    let selected = await waitPrescriptionCatalogSelection(item, popup);
    trace(3, selected);
    if (selected.success) return { success: true, exactOptionFound: true };

    // Same search, no rewriting: send Tab only after the exact-item click.
    const form = getPrescriptionListForm();
    const current = form?.accertamento;
    if (!current) return { success: false, exactOptionFound: true };
    dispatchLegacyKey(current, "keydown", "Tab", "Tab", 9);
    dispatchLegacyKey(current, "keyup", "Tab", "Tab", 9);
    try { form.exemption?.focus({ preventScroll: true }); } catch {}
    selected = await waitPrescriptionCatalogSelection(item, popup, 1800);
    trace(4, selected);
    if (selected.success) return { success: true, exactOptionFound: true };

    // A menu rebuilt during the click needs its new node, not a new query.
    found = findOption();
    if (found.ranked.length === 1 && found.ranked[0] !== option) {
      option = found.ranked[0]; popup = getFilterSelectPopup(option);
      dispatchVaadinMouseSequence(option);
      selected = await waitPrescriptionCatalogSelection(item, popup);
      trace(5, selected);
    }
    return { success: selected.success, exactOptionFound: true };
  }

  async function prescriptionTabTo(from, to, waitMs = 180) {
    if (!from || !to) return false;
    try { from.focus({ preventScroll: true }); } catch { try { from.focus(); } catch {} }
    dispatchLegacyKey(from, "keydown", "Tab", "Tab", 9);
    dispatchLegacyKey(from, "keyup", "Tab", "Tab", 9);
    try { from.blur(); } catch {}
    await sleep(35);
    try { to.focus({ preventScroll: true }); } catch { try { to.focus(); } catch {} }
    await sleep(waitMs);
    return document.activeElement === to || document.activeElement !== from;
  }

  async function writePrescriptionListItemAttempt(item, before, attemptIndex = 0) {
    item._diagnosticAttempt = attemptIndex + 1;
    item._diagnosticQuery = 0;
    if (typeof recordDiagnosticEvent === "function") recordDiagnosticEvent("prescrizione_tentativo", { rowIndex: item._diagnosticRow || 0, attempt: attemptIndex + 1, pageHidden: Boolean(document.hidden) });
    let form = await waitForPrescriptionListForm(["accertamento", "confirm"]);
    if (!form?.accertamento || !form?.confirm) {
      return { success: false, item, field: "Pagina Accertamenti non riconosciuta" };
    }

    if (!(await choosePrescriptionCatalogEntry(form.accertamento, item))) {
      return { success: false, item, field: "Accertamento non selezionato dalla tendina" };
    }

    // Dopo la selezione riproduciamo il flusso manuale Eumed:
    // TAB -> esenzione automatica, TAB -> priorita' (lasciata vuota),
    // TAB -> pulsante di conferma. Il click finale e' esplicito e locale.
    await sleep([550, 700, 900, 1100][Math.min(attemptIndex, 3)]);

    form = await waitForPrescriptionListForm(["accertamento", "exemption", "priority", "confirm"]);
    if (!form?.exemption || !form?.priority || !form?.confirm) {
      return { success: false, item, field: "Campi esenzione/priorità non disponibili" };
    }

    await prescriptionTabTo(form.accertamento, form.exemption, 300);

    form = await waitForPrescriptionListForm(["exemption", "priority"]);
    if (!form) return { success: false, item, field: "Campi esenzione/priorità non disponibili dopo aggiornamento Eumed" };
    await prescriptionTabTo(form.exemption, form.priority, 180);

    form = await waitForPrescriptionListForm(["priority", "confirm"]);
    if (!form) return { success: false, item, field: "Priorità/conferma locale non disponibili dopo aggiornamento Eumed" };
    // Nessuna priorita': non selezioniamo alcuna voce.
    if (String(form.priority?.value || "").trim()) {
      try {
        form.priority.focus();
        form.priority.select?.();
        document.execCommand("delete", false);
        form.priority.dispatchEvent(new Event("input", { bubbles: true }));
        form.priority.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    }

    await prescriptionTabTo(form.priority, form.confirm, 160);
    form = await waitForPrescriptionListForm(["confirm"]);
    if (!form?.confirm) return { success: false, item, field: "Conferma locale non trovata" };

    item.prescriptionPendingSnapshot = before;
    vaadinClick(form.confirm);
    if (typeof recordDiagnosticEvent === "function") recordDiagnosticEvent("prescrizione_conferma", { rowIndex: item._diagnosticRow || 0, attempt: attemptIndex + 1, confirmationSent: true });

    const row = await waitForPrescriptionRowAdded(
      before,
      item,
      [4600, 5400, 6200, 7000][Math.min(attemptIndex, 3)]
    );
    if (typeof recordDiagnosticEvent === "function") recordDiagnosticEvent("prescrizione_riga", { rowIndex: item._diagnosticRow || 0, attempt: attemptIndex + 1, success: Boolean(row) });
    if (!row) return {
      success: false, item,
      field: `Conferma inviata, ma nuova riga non verificata (totale TreeGrid: ${before.total} → ${getPrescriptionListRowCount() ?? "non disponibile"}; righe corrispondenti visibili: ${getPrescriptionRowEvidence(item).length}). Controlla la tabella Eumed prima di riprovare: nessun reinvio automatico.`,
      confirmationSent: true
    };

    await sleep(120);
    delete item.prescriptionPendingSnapshot;
    return { success: true, item, row };
  }

  async function writePrescriptionListItem(item) {
    if (item.prescriptionPendingSnapshot) {
      const row = findNewPrescriptionRow(item.prescriptionPendingSnapshot, item);
      if (row) {
        delete item.prescriptionPendingSnapshot;
        return { success: true, item, row };
      }
      return { success: false, item, field: "Conferma precedente ancora da verificare: nessun reinvio. Controlla la tabella Eumed.", confirmationSent: true };
    }
    const before = getPrescriptionWriteSnapshot(item);
    if (typeof recordDiagnosticEvent === "function") recordDiagnosticEvent("prescrizione_duplicati", {
      rowIndex: item._diagnosticRow || 0, matchingRows: before.matches.length,
      todayMatches: before.todayMatches, unknownDateMatches: before.unknownDateMatches
    });
    if (!Number.isFinite(before.total)) {
      return { success: false, item, field: "Totale TreeGrid non disponibile: inserimento sospeso per evitare duplicati" };
    }
    if (before.todayMatches) {
      return { success: false, item, field: "Esame gia visibile nella tabella con Data presc. odierna: verifica la riga esistente prima di inserire nuovamente" };
    }
    if (before.unknownDateMatches) {
      return { success: false, item, field: "Data presc. non leggibile per una riga corrispondente: verifica la colonna prima di procedere. La riga non e stata considerata una prescrizione odierna." };
    }
    const maxAttempts = 4;
    let last = null;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
      if (attemptIndex > 0) {
        await sleep([0, 650, 900, 1200][attemptIndex]);
      }

      last = await writePrescriptionListItemAttempt(item, before, attemptIndex);
      if (last.success) return { ...last, retries: attemptIndex };
      if (last.confirmationSent || last.field !== "Accertamento non selezionato dalla tendina") {
        return last;
      }
    }

    return {
      ...(last || { success: false, item }),
      success: false,
      item,
      field: `${last?.field || "Inserimento non riuscito"} dopo ${maxAttempts} tentativi`
    };
  }

  async function writePrescriptionListItems(items, completedCodes, progressCallback = null) {
    const completed = [];
    const pending = (items || []).filter(item => !completedCodes.has(item.catalogCode));

    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      progressCallback?.(i + 1, pending.length, item);
      item._diagnosticRow = i + 1;
      const result = await writePrescriptionListItem(item);
      if (!result.success) {
        return { success: false, completed, failed: item, field: result.field || "controllare" };
      }
      completedCodes.add(item.catalogCode);
      completed.push(item);
    }

    return { success: true, completed };
  }

  // ============================================================
  // UI
  // ============================================================

  const host = document.createElement("div");
  host.id = "segretario-mmg-host";

  Object.assign(host.style, {
    position: "fixed",
    top: "70px",
    right: "18px",
    zIndex: "2147483647"
  });

  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
<style>
* {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
}

.panel {
  display: none;
  width: 470px;
  max-height: calc(100vh - 90px);
  background: white;
  border: 1px solid #999;
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,.28);
  color: #222;
  overflow: hidden;
}

.header {
  background: #30343b;
  color: white;
  padding: 10px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: move;
}

.title {
  font-size: 15px;
  font-weight: 700;
}

.subtitle {
  font-size: 10px;
  opacity: .78;
  margin-top: 2px;
}

.close {
  background: transparent;
  color: white;
  border: 0;
  font-size: 20px;
  cursor: pointer;
}

.content {
  padding: 12px;
  max-height: calc(100vh - 145px);
  overflow-y: auto;
}

textarea {
  width: 100%;
  height: 210px;
  resize: vertical;
  border: 1px solid #aaa;
  border-radius: 6px;
  padding: 9px;
  font-family: Consolas, monospace;
  font-size: 12px;
}

.hint {
  font-size: 10px;
  color: #666;
  line-height: 1.45;
  margin-top: 6px;
}

.mode-chooser {
  padding: 4px 0 2px;
}

.mode-title {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 8px;
}

.mode-subtitle {
  font-size: 10px;
  color: #666;
  line-height: 1.4;
  margin-bottom: 10px;
}

.mode-buttons {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.mode-choice {
  border: 1px solid #aeb4ba;
  border-radius: 7px;
  background: #f5f6f7;
  padding: 12px 10px;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  font-weight: 700;
}

.mode-choice small {
  display: block;
  font-size: 10px;
  font-weight: 400;
  color: #666;
  margin-top: 3px;
}

.mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: #eef1f3;
  font-size: 10px;
}

#changeMode {
  border: 0;
  background: transparent;
  text-decoration: underline;
  cursor: pointer;
  font-size: 10px;
}

.buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  margin-top: 10px;
}

.action {
  border: 0;
  border-radius: 6px;
  padding: 9px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
}

#auto {
  grid-column: span 2;
  background: #16813d;
  color: white;
  font-size: 14px;
  padding: 13px 9px;
}

#ocrFast, #ocrSlow, #extract, #compile {
  background: #e2e4e7;
  color: #202326;
}

#compile {
  background: #dcefe3;
  color: #14572f;
}

button:disabled {
  opacity: .35;
  cursor: not-allowed;
}

.file-row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
  margin-top: 8px;
}

#fileButton {
  background: #f4f5f6;
  border: 1px solid #bbb;
  border-radius: 6px;
  padding: 8px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
}

#fileStatus {
  min-height: 14px;
  font-size: 10px;
  color: #666;
  line-height: 1.35;
}

#clear {
  width: 100%;
  margin-top: 7px;
  padding: 6px;
  background: white;
  border: 1px solid #ccc;
  border-radius: 6px;
  cursor: pointer;
}

.status {
  border-top: 1px solid #ddd;
  margin-top: 12px;
  padding-top: 10px;
}

.status-title {
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 7px;
}

.row {
  padding: 8px;
  margin-bottom: 7px;
  border-radius: 5px;
  background: #f3f4f5;
  font-size: 11px;
  line-height: 1.45;
}

.ok { border-left: 4px solid #39875b; }
.warning { border-left: 4px solid #d49a22; }
.error { border-left: 4px solid #b94040; }

.main-value {
  margin-top: 3px;
  font-size: 12px;
}

.range {
  display: block;
  margin-top: 5px;
}

.small {
  display: block;
  color: #666;
  font-size: 10px;
  margin-top: 4px;
}

.convert {
  display: block;
  margin-top: 5px;
  font-weight: 600;
}

.evidence {
  display: block;
  color: #666;
  font-size: 10px;
  font-style: italic;
  margin-top: 4px;
}

.summary {
  background: #eceff1;
  border-radius: 5px;
  padding: 8px;
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.45;
}

.busy {
  opacity: .68;
}

#launcher {
  display: block;
  border: 0;
  border-radius: 20px;
  padding: 9px 14px;
  background: #30343b;
  color: white;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 5px 18px rgba(0,0,0,.28);
}
</style>

<button id="launcher">MMG</button>

<div class="panel" id="panel">
  <div class="header" id="header">
    <div>
      <div class="title">SEGRETARIO MMG</div>
      <div class="subtitle">
        Referti e liste di esami · elaborazione sul computer
      </div>
    </div>
    <button class="close" id="close">×</button>
  </div>

  <div class="content" id="content">
    <div class="mode-chooser" id="modeChooser">
      <div style="margin-bottom:12px;padding:10px;background:#edf4fa;border-radius:6px">
        <b id="extensionVersion"></b>
        <div id="extensionUpdateStatus" class="small" role="status" aria-live="polite">Verifica aggiornamenti GitHub...</div>
        <button id="extensionUpdateCheck" type="button" style="margin-top:6px">Verifica aggiornamenti</button>
        <a id="extensionUpdateDownload" target="_blank" rel="noopener noreferrer" style="display:none;margin:8px 0;font-weight:bold">Scarica aggiornamento</a>
        <div id="extensionUpdateHelp" class="small" hidden>Avvia il setup scaricato e salva prima i lavori in Chrome: dopo il tuo OK il setup chiudera Chrome. Gli aggiornamenti automatici richiedono Chrome completamente chiuso.</div>
      </div>
      <div class="mode-title">Cosa vuoi fare?</div>
      <div class="mode-subtitle">
        Apri in Eumed la sezione in cui vuoi lavorare, poi scegli un'attività.
      </div>
      <div style="margin:12px 0;padding:10px;background:#f3f4f5;border-radius:6px">
        <label for="aiModelSelect"><b>Modello IA</b></label>
        <div style="display:flex;gap:6px;margin-top:6px">
          <select id="aiModelSelect" disabled style="flex:1;min-width:0;padding:7px" aria-describedby="aiModelStatus">
            <option>Caricamento modelli…</option>
          </select>
          <button id="aiModelRefresh" type="button">Aggiorna elenco</button>
        </div>
        <div id="aiModelStatus" class="small" role="status" aria-live="polite">Ricerca dei modelli installati in Ollama…</div>
        <div class="small">La scelta vale per tutte le modalità e viene ricordata in questo profilo Chrome.</div>
      </div>
      <div class="mode-buttons">
        <button class="mode-choice" id="modePrescribed" type="button">
          REFERTO GIÀ PRESCRITTO
          <small>Apri Registrazione esiti → Inserimento da prescrizioni.</small>
        </button>
        <button class="mode-choice" id="modeUnprescribed" type="button">
          REFERTO NON PRESCRITTO
          <small>Apri Registrazione esiti → Inserimento senza prescrizioni.</small>
        </button>
        <button class="mode-choice" id="modePrescriptionList" type="button">
          PRESCRIVI ESAMI DA LISTA
          <small>Apri Accertamenti, non Dashboard. Puoi incollare una lista o caricare un file.</small>
        </button>
      </div>
    </div>

    <div id="workflowMain" style="display:none">
      <div class="mode-bar">
        <span id="modeLabel"></span>
        <button id="changeMode" type="button">Cambia modalità</button>
      </div>

    <textarea
      id="input"
      placeholder="Incolla qui il testo copiato dal referto..."
    ></textarea>

    <div class="file-row">
      <button id="fileButton" type="button">
        CARICA PDF / JPEG / PNG
      </button>
      <input
        id="fileInput"
        type="file"
        accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
        hidden
      >
      <div id="fileStatus"></div>
    </div>

    <div class="hint">
      Preferenze: creatinina → mg/dL · FT3/FT4 → pmol/L ·
      HbA1c → mmol/mol · calcio/lipidi → mg/dL.
      <br>
      I limiti di riferimento vengono compilati quando entrambi sono chiaramente indicati.
      
    </div>

    <div class="buttons">
      <button class="action" id="auto">INSERISCI VALORI IN AUTOMATICO</button>
      <button class="action" id="ocrFast">LETTURA RAPIDA</button>
      <button class="action" id="ocrSlow">LETTURA CON IA</button>
      <button class="action" id="extract">TROVA CORRISPONDENZE</button>
      <button class="action" id="compile" disabled>INSERISCI VALORI</button>
    </div>

    <button id="clear">Pulisci</button>

    <div class="status">
      <div class="status-title">Stato</div>
      <div id="results">Incolla un referto.</div>
      <button id="downloadDiagnostics" type="button" style="width:100%;margin-top:10px;padding:8px">Scarica report diagnostico (.txt)</button>
      <div class="small">Da allegare alle segnalazioni insieme ai valori del referto anonimizzati. Il report contiene tempi e conteggi, non il testo del referto.</div>
    </div>
    </div>
  </div>
</div>
`;

  const panel = shadow.getElementById("panel");
  const launcher = shadow.getElementById("launcher");
  const textarea = shadow.getElementById("input");
  const extractButton = shadow.getElementById("extract");
  const ocrFastButton = shadow.getElementById("ocrFast");
  const ocrSlowButton = shadow.getElementById("ocrSlow");
  const compileButton = shadow.getElementById("compile");
  const autoButton = shadow.getElementById("auto");
  const clearButton = shadow.getElementById("clear");
  const fileButton = shadow.getElementById("fileButton");
  const fileInput = shadow.getElementById("fileInput");
  const fileStatus = shadow.getElementById("fileStatus");
  const resultsBox = shadow.getElementById("results");
  resultsBox.addEventListener("click",async event=>{
    const button=event.target.closest?.("[data-transfer-copy]");
    if (!button || !resultsBox.contains(button) || isBusy) return;
    const block=button.closest(".row");
    const field=block.querySelector("[data-transfer-text]");
    const status=block.querySelector("[data-transfer-status]");
    button.disabled=true;
    try { status.textContent=await copyPrescribedTransferBlock(field)
      ? "Blocco copiato. Incollalo nella modalita Referto non prescritto."
      : "Copia non riuscita: seleziona il blocco e premi Ctrl+C."; }
    finally {button.disabled=false;}
  });
  const contentBox = shadow.getElementById("content");
  const modeChooser = shadow.getElementById("modeChooser");
  const workflowMain = shadow.getElementById("workflowMain");
  const modeLabel = shadow.getElementById("modeLabel");
  const modePrescribedButton = shadow.getElementById("modePrescribed");
  const modeUnprescribedButton = shadow.getElementById("modeUnprescribed");
  const modePrescriptionListButton = shadow.getElementById("modePrescriptionList");
  const changeModeButton = shadow.getElementById("changeMode");

  let activeWorkflowMode = null;
  let unprescribedNumeric = [];
  let unprescribedComplex = [];
  let unprescribedUncertain = [];
  let prescriptionListItems = [];
  let prescriptionListUncertain = [];
  const prescriptionCompletedCodes = new Set();

  let validated = [];
  let validatedLongReports = [];
  let isBusy = false;
  let diagnosticEvents = [];
  let diagnosticOperationStarted = null;
  const diagnosticSessionStarted = Date.now();

  function recordDiagnosticEvent(kind, data = {}) {
    const allowedKinds = ["operazione_avviata", "operazione_terminata", "ia_completata", "ia_errore", "catalogo_selezione", "prescrizione_tentativo", "prescrizione_conferma", "prescrizione_riga", "prescrizione_duplicati", "ia_validazione", "parser_referto"];
    if (!allowedKinds.includes(kind)) return;
    const allowedKeys = ["durationMs", "inputCharacters", "outputCharacters", "images", "numeric", "complex", "uncertain", "requested", "completed", "retries", "retriedRows", "catalogSelectionMs", "interrupted", "error", "rowIndex", "attempt", "queryIndex", "targetIsCode", "step", "optionsCount", "matchingOptions", "bestScore", "codeMatchesCount", "captionMatchesCount", "codeAbsentCount", "codeConflictCount", "ignoredReferenceCodesCount", "matchingRows", "todayMatches", "unknownDateMatches", "acceptedNumeric", "acceptedComplex", "rejectedNumeric", "rejectedComplex", "rejectedUncertain", "knownLayout", "rawResults", "qwenUsed", "qwenResidualEvidence", "fieldPresent", "fieldIsCode", "fieldMatched", "popupVisible", "success", "confirmationSent", "pageHidden"];
    const safe = {};
    for (const key of allowedKeys) {
      const value = data[key];
      if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") safe[key] = value;
    }
    const mode = ["prescribed", "unprescribed", "prescription_list"].includes(activeWorkflowMode) ? activeWorkflowMode : "non_selezionata";
    diagnosticEvents.push({ elapsedMs: Date.now() - diagnosticSessionStarted, mode, kind, ...safe });
    if (diagnosticEvents.length > 300) diagnosticEvents.shift();
  }

  function diagnosticSummaryFromText(text) {
    const result = {};
    const counts = text.match(/Righe create e confermate:\s*(\d+)\s*\/\s*(\d+)/i);
    if (counts) { result.completed = Number(counts[1]); result.requested = Number(counts[2]); }
    const numeric = text.match(/Risultati numerici:\s*(\d+)/i);
    const complex = text.match(/Referti complessi:\s*(\d+)/i);
    const uncertain = text.match(/(\d+)\s+esami\/dati non inseriti automaticamente/i);
    if (numeric) result.numeric = Number(numeric[1]);
    if (complex) result.complex = Number(complex[1]);
    if (uncertain) result.uncertain = Number(uncertain[1]);
    const retries = text.match(/Retry automatici:\s*(\d+)\s*su\s*(\d+)/i);
    if (retries) { result.retries = Number(retries[1]); result.retriedRows = Number(retries[2]); }
    const selection = text.match(/Tempo selezione catalogo:\s*(\d+(?:[.,]\d+)?)\s*s/i);
    if (selection) result.catalogSelectionMs = Math.round(Number(selection[1].replace(",", ".")) * 1000);
    result.interrupted = /interrott[oa]|Stop su|Conferma inviata, ma/i.test(text);
    result.error = /Errore durante|non completat[oa]/i.test(text);
    return result;
  }

  function createDiagnosticReport(version, mode, model, events) {
    return ["SEGRETARIO MMG - REPORT DIAGNOSTICO", `Versione: ${version}`, `Modalita: ${mode || "non selezionata"}`,
      `Modello IA: ${model}`, "Ragionamento esteso nelle richieste: disattivato",
      "Contenuto: tempi relativi, conteggi e stato delle operazioni. Nessun testo o valore del referto, nome file, URL o dato del paziente.",
      "Gli eventi descrivono questa pagina dall'apertura; massimo 300 eventi. Il report non sostituisce la verifica dei risultati.",
      "Diagnostica prescrizione: rowIndex = numero progressivo anonimo; attempt = tentativo; queryIndex = ricerca nello stesso tentativo; targetIsCode = ricerca per codice; pageHidden = scheda in background.",
      "catalogo_selezione step: 1 filtro non avviato; 2 proposte disponibili; 3 verifica dopo click; 4 verifica dopo Tab; 5 verifica dopo ricostruzione menu. fieldMatched = testo del campo corrispondente; fieldIsCode = solo codice digitato; popupVisible = menu ancora visibile. Questi stati non provano la creazione della riga.",
      "prescrizione_conferma = conferma locale inviata; prescrizione_riga success = nuova riga verificata. Nomi esami, codici e contenuto dei campi non sono inclusi.",
      "Selezione: codeMatchesCount = codici coincidenti; codeAbsentCount = proposte senza codice visibile; codeConflictCount = codici diversi; captionMatchesCount = nomi compatibili; bestScore = punteggio migliore. matchingOptions conta le sole proposte a pari punteggio migliore.",
      "ignoredReferenceCodesCount = codici citati nelle note amministrative (Incluso / Non associabile), esclusi dal riconoscimento della proposta.",
      "prescrizione_duplicati: matchingRows = righe corrispondenti; todayMatches = Data presc. odierna; unknownDateMatches = Data presc. non leggibile. Le date effettive non sono incluse.",
      "parser_referto: formato riconosciuto, conteggi e uso IA. ia_validazione: proposte accettate/scartate dopo controllo sul testo sorgente; nessuna risposta IA o contenuto sorgente viene incluso.",
      "Per assistenza: incollare separatamente nomi esami, valori, unita e intervalli, dopo anonimizzazione. Non allegare documenti identificabili.",
      "", JSON.stringify(events, null, 2)].join("\n");
  }

  shadow.getElementById("downloadDiagnostics").addEventListener("click", () => {
    const report = createDiagnosticReport(chrome.runtime.getManifest().version, activeWorkflowMode, CONFIG.aiModel, diagnosticEvents);
    const url = URL.createObjectURL(new Blob([report], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `SegretarioMMG-diagnostica-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const aiModelSelect = shadow.getElementById("aiModelSelect");
  const extensionVersion = shadow.getElementById("extensionVersion");
  const extensionUpdateStatus = shadow.getElementById("extensionUpdateStatus");
  const extensionUpdateCheck = shadow.getElementById("extensionUpdateCheck");
  const extensionUpdateDownload = shadow.getElementById("extensionUpdateDownload");
  const extensionUpdateHelp = shadow.getElementById("extensionUpdateHelp");
  let extensionUpdateChecking = false;
  extensionVersion.textContent = `Segretario MMG - versione ${chrome.runtime.getManifest().version}`;

  async function refreshExtensionUpdate(force = false) {
    if (isBusy || extensionUpdateChecking) return;
    extensionUpdateChecking = true;
    extensionUpdateCheck.disabled = true;
    extensionUpdateDownload.style.display = "none";
    extensionUpdateDownload.removeAttribute("href");
    extensionUpdateHelp.hidden = true;
    extensionUpdateStatus.textContent = "Verifica aggiornamenti GitHub...";
    try {
      const response = await requestOllamaMetadata({ type: "SEGRETARIO_CHECK_UPDATE", force });
      const info = response.update;
      const messages = {
        current: "Sei aggiornato all'ultima versione disponibile su GitHub.",
        available: `Disponibile la versione ${info.latest}.`,
        pending: `Versione ${info.latest} in pubblicazione: il setup non e ancora disponibile.`,
        ahead: "La versione installata e piu recente della release GitHub rilevata."
      };
      extensionUpdateStatus.textContent = (messages[info.state] || "Stato aggiornamento non disponibile.") +
        ` Ultima verifica: ${new Date(info.checkedAt).toLocaleString("it-IT")}.`;
      if (info.state === "available" && info.downloadUrl) {
        extensionUpdateDownload.href = info.downloadUrl;
        extensionUpdateDownload.style.display = "block";
        extensionUpdateHelp.hidden = false;
      }
    } catch {
      extensionUpdateStatus.textContent = "Impossibile verificare gli aggiornamenti su GitHub. Controlla la connessione e riprova.";
    } finally {
      extensionUpdateChecking = false;
      extensionUpdateCheck.disabled = isBusy;
    }
  }
  const aiModelRefresh = shadow.getElementById("aiModelRefresh");
  const aiModelStatus = shadow.getElementById("aiModelStatus");
  let selectedAiModelInfo = null;
  let aiModelsLoading = false;
  let aiModelSelecting = false;
  let aiModelSelectionTask = Promise.resolve();
  let aiModelInitialization = null;
  const AI_MODEL_STORAGE_KEY = "segretarioMmgAiModel";

  function requestOllamaMetadata(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        const error = chrome.runtime.lastError;
        if (error) return reject(new Error(error.message));
        if (!response?.ok) return reject(new Error(response?.error || "Ollama non risponde."));
        resolve(response);
      });
    });
  }

  function chooseAvailableAiModel(models, saved, fallback) {
    const names = models.map(model => model.name);
    return names.includes(saved) ? saved : names.includes(fallback) ? fallback : names[0] || "";
  }

  async function applyAiModelSelection(name) {
    aiModelSelecting = true;
    selectedAiModelInfo = null;
    aiModelSelect.disabled = true;
    aiModelRefresh.disabled = true;
    aiModelStatus.textContent = "Verifica del modello…";
    try {
      const { info } = await requestOllamaMetadata({ type: "OLLAMA_MODEL_INFO", model: name });
      if (info.completion === false) throw new Error("Questo modello non supporta l’analisi del testo. Scegli un modello di conversazione.");
      if (info.thinkingOnly) throw new Error("Modello Thinking non compatibile: scegli una variante Instruct per usare IA senza ragionamento esteso.");
      CONFIG.aiModel = name;
      selectedAiModelInfo = info;
      invalidate();
      const description = info.vision === true ? "Legge testo e immagini."
        : info.vision === false ? "Legge soltanto testo. Per foto e liste con spunte scegli un modello che legga immagini."
        : "Supporto immagini non dichiarato da questa versione di Ollama.";
      try {
        await chrome.storage.local.set({ [AI_MODEL_STORAGE_KEY]: name });
        aiModelStatus.textContent = `${info.variant || ""} · ${description}`;
      } catch {
        aiModelStatus.textContent = `${description} Scelta valida per questa pagina; non è stato possibile salvarla.`;
      }
      if (activeWorkflowMode) renderWorkflowMode();
    } catch (error) {
      aiModelStatus.textContent = error?.message || "Impossibile usare il modello selezionato.";
    } finally {
      aiModelSelecting = false;
      aiModelSelect.disabled = isBusy || !aiModelSelect.options.length;
      aiModelRefresh.disabled = isBusy;
    }
  }

  async function refreshAiModels() {
    if (isBusy || aiModelsLoading || aiModelSelecting) return;
    aiModelsLoading = true;
    selectedAiModelInfo = null;
    aiModelSelect.disabled = true;
    aiModelRefresh.disabled = true;
    aiModelStatus.textContent = "Ricerca dei modelli installati in Ollama…";
    try {
      const saved = await chrome.storage.local.get(AI_MODEL_STORAGE_KEY).catch(() => ({}));
      const installedDefaults = await fetch(extensionUrl("installation-defaults.json", "modello iniziale"))
        .then(response => response.ok ? response.json() : {}).catch(() => ({}));
      const { models } = await requestOllamaMetadata({ type: "OLLAMA_LIST_MODELS" });
      aiModelSelect.replaceChildren();
      for (const model of models) {
        const option = document.createElement("option");
        option.value = model.name;
        option.textContent = model.name;
        aiModelSelect.appendChild(option);
      }
      const chosen = chooseAvailableAiModel(models, saved[AI_MODEL_STORAGE_KEY], installedDefaults.model || CONFIG.aiModel);
      if (!chosen) {
        aiModelStatus.textContent = "Nessun modello locale installato. Installa un modello in Ollama, poi premi Aggiorna elenco.";
        return;
      }
      aiModelSelect.value = chosen;
      aiModelSelectionTask = applyAiModelSelection(chosen);
      await aiModelSelectionTask;
      if (saved[AI_MODEL_STORAGE_KEY] && saved[AI_MODEL_STORAGE_KEY] !== chosen && selectedAiModelInfo) {
        aiModelStatus.textContent = `Il modello precedente non è disponibile: selezionato ${chosen}. ${aiModelStatus.textContent}`;
      }
    } catch (error) {
      aiModelSelect.replaceChildren();
      aiModelStatus.textContent = error?.message || "Impossibile leggere i modelli. Avvia Ollama e riprova.";
    } finally {
      aiModelsLoading = false;
      aiModelSelect.disabled = isBusy || !aiModelSelect.options.length;
      aiModelRefresh.disabled = isBusy;
    }
  }
  let lastAnalyzedText = "";
  let currentUploadedFile = null;
  let activeTextSource = "manuale";

  function invalidate() {
    validated = [];
    validatedLongReports = [];
    unprescribedNumeric = [];
    unprescribedComplex = [];
    unprescribedUncertain = [];
    prescriptionListItems = [];
    prescriptionListUncertain = [];
    prescriptionCompletedCodes.clear();
    compileButton.disabled = true;
    lastAnalyzedText = "";
  }

  function hasCompilableItems() {
    if (activeWorkflowMode === WORKFLOW_MODE.UNPRESCRIBED) {
      return unprescribedNumeric.length > 0 || unprescribedComplex.length > 0;
    }
    if (activeWorkflowMode === WORKFLOW_MODE.PRESCRIPTION_LIST) {
      return prescriptionListItems.length > 0;
    }
    return validated.length > 0 || validatedLongReports.length > 0;
  }

  function renderWorkflowMode() {
    const selected = !!activeWorkflowMode;
    modeChooser.style.display = selected ? "none" : "block";
    workflowMain.style.display = selected ? "block" : "none";

    if (!selected) return;

    const unprescribed = activeWorkflowMode === WORKFLOW_MODE.UNPRESCRIBED;
    const prescriptionList = activeWorkflowMode === WORKFLOW_MODE.PRESCRIPTION_LIST;

    modeLabel.innerHTML = prescriptionList
      ? "Modalità: <b>prescrizione esami da lista</b>"
      : unprescribed
        ? "Modalità: <b>referto non prescritto</b>"
        : "Modalità: <b>referto già prescritto</b>";
    modeLabel.innerHTML += `<span class="small">IA: ${selectedAiModelInfo ? escapeHtml(CONFIG.aiModel) : "modello non disponibile"}</span>`;
    modeLabel.innerHTML += `<span class="small">Apri: ${prescriptionList ? "Accertamenti (non Dashboard)" : unprescribed ? "Registrazione esiti → Inserimento senza prescrizioni" : "Registrazione esiti → Inserimento da prescrizioni"}</span>`;

    autoButton.textContent = prescriptionList
      ? "PRESCRIVI ESAMI DALLA LISTA"
      : unprescribed
        ? "INSERISCI REFERTO NON PRESCRITTO"
        : "INSERISCI VALORI IN AUTOMATICO";

    extractButton.textContent = prescriptionList
      ? "ANALIZZA LISTA"
      : unprescribed
        ? "ANALIZZA REFERTO"
        : "TROVA CORRISPONDENZE";

    compileButton.textContent = prescriptionList
      ? "PRESCRIVI ESAMI"
      : unprescribed
        ? "INSERISCI ESAMI"
        : "INSERISCI VALORI";

    textarea.placeholder = prescriptionList
      ? "Incolla qui la lista degli esami da prescrivere..."
      : "Incolla qui il testo copiato dal referto...";

    // Nella modalità lista i file vengono analizzati direttamente da IA per immagini:
    // PaddleOCR resta nascosto per non perdere X/spunte manoscritte.
    ocrFastButton.style.display = prescriptionList ? "none" : "";
    ocrSlowButton.style.display = "";
    ocrSlowButton.textContent = prescriptionList ? "LEGGI LISTA CON IA" : "LETTURA CON IA";

    resultsBox.innerHTML = prescriptionList
      ? '<div class="summary">Incolla una lista oppure carica un PDF o una foto. L’IA riconosce le X e le spunte e propone gli esami selezionati. Ogni esame viene verificato nel catalogo Eumed.</div>'
      : unprescribed
        ? '<div class="summary">Carica o incolla il referto. Gli esami verranno associati al catalogo prescrivibile e poi creati uno alla volta nella tabella Eumed.</div>'
        : '<div class="summary">Carica o incolla il referto. Verranno compilate soltanto le righe già prescritte presenti in Eumed.</div>';
  }

  function selectWorkflowMode(mode) {
    activeWorkflowMode = mode;
    invalidate();
    renderWorkflowMode();
    textarea.focus();
  }

  function clearWorkflowMode() {
    if (isBusy) return;
    activeWorkflowMode = null;
    invalidate();
    renderWorkflowMode();
  }

  function setBusy(value) {
    if (value && !isBusy) {
      diagnosticOperationStarted = Date.now();
      recordDiagnosticEvent("operazione_avviata");
    } else if (!value && isBusy && diagnosticOperationStarted !== null) {
      recordDiagnosticEvent("operazione_terminata", {
        durationMs: Date.now() - diagnosticOperationStarted,
        numeric: activeWorkflowMode === WORKFLOW_MODE.UNPRESCRIBED ? unprescribedNumeric.length : validated.length,
        complex: activeWorkflowMode === WORKFLOW_MODE.UNPRESCRIBED ? unprescribedComplex.length : validatedLongReports.length,
        uncertain: activeWorkflowMode === WORKFLOW_MODE.PRESCRIPTION_LIST ? prescriptionListUncertain.length : unprescribedUncertain.length,
        ...diagnosticSummaryFromText(resultsBox.textContent || "")
      });
      diagnosticOperationStarted = null;
    }
    isBusy = value;
    extensionUpdateCheck.disabled = value || extensionUpdateChecking;
    aiModelSelect.disabled = value || aiModelsLoading || aiModelSelecting || !aiModelSelect.options.length;
    aiModelRefresh.disabled = value || aiModelsLoading || aiModelSelecting;
    extractButton.disabled = value;
    ocrFastButton.disabled = value;
    ocrSlowButton.disabled = value;
    fileButton.disabled = value;
    compileButton.disabled = value || !hasCompilableItems();
    autoButton.disabled = value;
    clearButton.disabled = value;
    textarea.disabled = value;
    shadow.getElementById("downloadDiagnostics").disabled = value;

    if (value) contentBox.classList.add("busy");
    else contentBox.classList.remove("busy");
  }

  function showPanel() {
    launcher.style.display = "none";
    panel.style.display = "block";
  }

  function hidePanel() {
    panel.style.display = "none";
    launcher.style.display = "block";
  }

  function togglePanel() {
    if (panel.style.display === "block") hidePanel();
    else showPanel();
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "SEGRETARIO_MMG_TOGGLE") {
      togglePanel();
    }
  });

  textarea.addEventListener("input", () => {
    // Se l'utente passa da un file a una lista incollata, la lista manuale
    // deve avere la precedenza sul vecchio allegato.
    if (activeWorkflowMode === WORKFLOW_MODE.PRESCRIPTION_LIST) {
      currentUploadedFile = null;
      activeTextSource = "manuale";
      fileStatus.textContent = "";
      fileInput.value = "";
    }

    invalidate();

    resultsBox.innerHTML = `
      <div class="summary">
        Testo modificato: esegui nuovamente l'analisi prima di compilare.
      </div>
    `;
  });

  function analyzeDirect() {
    if (isBusy) return;

    invalidate();

    const parsed = parseDirectText(textarea.value);
    const html = [];
    const seen = new Set();
    let error = false;

    for (const item of parsed) {
      if (!item.success) {
        error = true;

        html.push(`
          <div class="row error">
            ✗ ${escapeHtml(item.original)}
          </div>
        `);
        continue;
      }

      const resolution = resolveExamName(item.exam);

      if (!resolution.success) {
        error = true;

        html.push(`
          <div class="row error">
            ✗ ${escapeHtml(item.exam)}
            <span class="small">
              ${
                resolution.reason === "ambiguous"
                  ? "Esame ambiguo"
                  : "Esame non trovato"
              }
            </span>
          </div>
        `);
        continue;
      }

      if (seen.has(resolution.exam)) {
        error = true;

        html.push(`
          <div class="row error">
            ✗ Esame duplicato: ${escapeHtml(resolution.exam)}
          </div>
        `);
        continue;
      }

      seen.add(resolution.exam);

      validated.push({
        exam: resolution.exam,
        value: item.value,
        refMin: "",
        refMax: "",
        unit: "",
        converted: false,
        rangeAvailable: false
      });

      html.push(`
        <div class="row ok">
          <b>${escapeHtml(resolution.exam)}</b>
          <div class="main-value">
            Valore → <b>${escapeHtml(item.value)}</b>
          </div>
        </div>
      `);
    }

    if (error || !validated.length) {
      invalidate();
    } else {
      compileButton.disabled = false;

      html.push(`
        <div class="summary">
          ✓ ${validated.length} valori validati.
        </div>
      `);
    }

    resultsBox.innerHTML = html.join("");
  }


  function renderPrescriptionListAnalysis(rawPayload, sourceLabel = "lista") {
    const resolvedInfo = resolvePrescriptionListItems(rawPayload?.items || []);
    prescriptionListItems = resolvedInfo.resolved;
    prescriptionListUncertain = [
      ...(rawPayload?.uncertain || []),
      ...(resolvedInfo.uncertain || [])
    ];
    prescriptionCompletedCodes.clear();

    const html = [];
    for (const item of prescriptionListItems) {
      html.push(`
        <div class="row ok">
          <b>${escapeHtml((item.requestedLabels || [item.raw_label]).join(" · "))}</b>
          <div class="main-value">
            → <b>${escapeHtml(item.catalogCode)}</b> · ${escapeHtml(item.exam)}
          </div>
          ${item.evidence ? `<span class="evidence">${escapeHtml(item.evidence)}</span>` : ""}
          ${item.mappingNote ? `<span class="small">${escapeHtml(item.mappingNote)}</span>` : ""}
        </div>
      `);
    }

    for (const item of prescriptionListUncertain) {
      html.push(`
        <div class="row warning">
          ? ${escapeHtml(item.text || "Voce incerta")}
          <span class="small">${escapeHtml(item.reason || "Da verificare")}</span>
        </div>
      `);
    }

    html.push(`
      <div class="summary">
        Sorgente: <b>${escapeHtml(sourceLabel)}</b><br>
        <b>${prescriptionListItems.length} esami pronti per la prescrizione.</b>
        ${prescriptionListUncertain.length ? `<br>⚠ ${prescriptionListUncertain.length} voci da verificare/non associate.` : ""}
        <br><br>
        La priorità verrà lasciata vuota. L'esenzione resta affidata alla logica automatica di Eumed.
        <br>Nessun pulsante <b>Ricette</b> viene premuto automaticamente.
      </div>
    `);

    compileButton.disabled = prescriptionListItems.length === 0;
    resultsBox.innerHTML = html.join("");
  }

  function renderPrescriptionQwenProgress(info) {
    if (info?.phase === "prescription_pdf_page") {
      resultsBox.innerHTML = `<div class="summary">IA per immagini · pagina ${info.current}/${info.total}…<br>Ricerca X/spunte e voci selezionate.</div>`;
    } else if (info?.phase === "prescription_vision_start") {
      resultsBox.innerHTML = `<div class="summary">IA per immagini · ${escapeHtml(info.label || "immagine")}…<br>Analisi visiva delle marcature.</div>`;
    } else if (info?.phase === "prescription_vision_stream") {
      resultsBox.innerHTML = `<div class="summary">IA per immagini · ${escapeHtml(info.label || "")} · ${info.chars || 0} caratteri…</div>`;
    } else if (info?.phase === "prescription_qwen_start") {
      resultsBox.innerHTML = `<div class="summary">IA · interpretazione della lista incollata${info.total > 1 ? ` · blocco ${info.current}/${info.total}` : ""}…</div>`;
    } else if (info?.phase === "prescription_qwen_stream") {
      resultsBox.innerHTML = `<div class="summary">IA · lista incollata${info.total > 1 ? ` · blocco ${info.current}/${info.total}` : ""} · ${info.chars || 0} caratteri…</div>`;
    }
  }

  async function analyzePrescriptionList() {
    if (isBusy) return;
    const text = textarea.value.trim();
    if (!text) {
      resultsBox.innerHTML = '<div class="row warning">Incolla prima una lista oppure carica un PDF/JPEG/PNG.</div>';
      return;
    }

    setBusy(true);
    prescriptionListItems = [];
    prescriptionListUncertain = [];
    prescriptionCompletedCodes.clear();
    try {
      const payload = await extractPrescriptionListWithQwenText(text, renderPrescriptionQwenProgress);
      renderPrescriptionListAnalysis(payload, activeTextSource || "testo incollato");
    } catch (error) {
      prescriptionListItems = [];
      prescriptionListUncertain = [];
      resultsBox.innerHTML = `<div class="row error">Analisi della lista non completata.<span class="small">${escapeHtml(error?.message || String(error))}</span></div>`;
    } finally {
      setBusy(false);
    }
  }

  async function analyzePrescriptionUploadedFile(file) {
    if (isBusy || !file) return;
    currentUploadedFile = file;
    invalidate();
    setBusy(true);
    fileStatus.textContent = `File: ${file.name}`;
    resultsBox.innerHTML = '<div class="summary">IA per immagini · preparazione del file…</div>';

    try {
      const payload = await extractPrescriptionListFromFile(file, renderPrescriptionQwenProgress);
      const selectedText = (payload.items || []).map(x => x.raw_label).join("\n");
      textarea.value = selectedText;
      activeTextSource = "IA per immagini · lista selezionata";
      fileStatus.textContent = `${file.name} · IA per immagini · ${(payload.items || []).length} voci selezionate`;
      renderPrescriptionListAnalysis(payload, activeTextSource);
    } catch (error) {
      resultsBox.innerHTML = `<div class="row error">Analisi IA per immagini non completata.<span class="small">${escapeHtml(error?.message || String(error))}</span></div>`;
      fileStatus.textContent = file.name || "";
    } finally {
      setBusy(false);
      fileInput.value = "";
    }
  }

  async function compilePrescriptionList() {
    if (isBusy || !prescriptionListItems.length) return;

    if (!prescriptionPageIsReady()) {
      resultsBox.innerHTML = `
        <div class="row error">
          Pagina Accertamenti non riconosciuta.
          <span class="small">Apri la sezione <b>Accertamenti</b> del paziente prima di prescrivere la lista.</span>
        </div>
      `;
      return;
    }

    setBusy(true);
    const started = performance.now();
    try {
      const total = prescriptionListItems.length;
      const result = await writePrescriptionListItems(
        prescriptionListItems,
        prescriptionCompletedCodes,
        (current, pendingTotal, item) => {
          resultsBox.innerHTML = `
            <div class="summary">
              Prescrizione ${current}/${pendingTotal}<br>
              <b>${escapeHtml(item.catalogCode)}</b> · ${escapeHtml(item.exam)}
              <br><br>Selezione catalogo → esenzione automatica → priorità vuota → conferma riga.
            </div>
          `;
        }
      );

      const elapsed = ((performance.now() - started) / 1000).toFixed(1);
      const done = prescriptionCompletedCodes.size;
      const uncertainHtml = prescriptionListUncertain.length
        ? `<br><br><b>⚠ ${prescriptionListUncertain.length} voci non prescritte automaticamente:</b><br>${prescriptionListUncertain.map(x => `• ${escapeHtml(x.text || "")} — ${escapeHtml(x.reason || "Da verificare")}`).join("<br>")}`
        : "";

      if (!result.success) {
        resultsBox.innerHTML = `
          <div class="summary">
            <b>PRESCRIZIONE ESAMI DA LISTA interrotta</b><br>
            Righe create e confermate: ${done}/${total}<br>
            Tempo scrittura: ${elapsed} s<br><br>
            ⚠ Stop su <b>${escapeHtml(result.failed?.exam || result.failed?.raw_label || "accertamento")}</b><br>
            ${escapeHtml(result.field || "Verifica la riga prima di riprovare.")}
            ${uncertainHtml}
            <br><br><b>Prima di riprovare verifica la tabella Eumed, soprattutto se la conferma è stata inviata. Le righe già verificate in questa sessione non verranno reinserite.</b>
            <br><br>Nessuna priorità è stata selezionata e nessun pulsante <b>Ricette</b> è stato premuto.
          </div>
        `;
        return;
      }

      resultsBox.innerHTML = `
        <div class="summary">
          <b>PRESCRIZIONE ESAMI DA LISTA completata</b><br>
          Righe create e confermate: ${done}/${total}<br>
          Tempo scrittura: ${elapsed} s
          ${uncertainHtml}
          <br><br>Esenzione lasciata alla logica Eumed · priorità non impostata.
          <br><b>Nessun pulsante Ricette è stato premuto automaticamente.</b>
        </div>
      `;
    } catch (error) {
      resultsBox.innerHTML = `<div class="row error">Errore durante la prescrizione della lista.<span class="small">${escapeHtml(error?.message || String(error))}</span><span class="small">Nessun pulsante Ricette è stato premuto.</span></div>`;
    } finally {
      setBusy(false);
    }
  }

  async function analyzeReport() {
    if (activeWorkflowMode === WORKFLOW_MODE.PRESCRIPTION_LIST) {
      await analyzePrescriptionList();
      return;
    }
    if (activeWorkflowMode === WORKFLOW_MODE.UNPRESCRIBED) {
      await analyzeUnprescribedReport();
      return;
    }

    if (isBusy) return;

    invalidate();

    const text = textarea.value.trim();

    if (!text) {
      resultsBox.innerHTML = `
        <div class="row warning">
          Incolla prima il referto.
        </div>
      `;
      return;
    }

    setBusy(true);

    try {
      resultsBox.innerHTML =
        '<div class="summary">Indicizzazione completa di Eumed…</div>';

      await scanAllEumedRows(info => {
        resultsBox.innerHTML =
          `<div class="summary">
            Indicizzazione completa di Eumed…<br>
            ${info.count} accertamenti individuati
          </div>`;
      });

      const targetExams =
        getEmptyEumedExams();

      const analysis =
        await runResidualQwenAnalysis(
          text,
          targetExams,
          info => {
            if (
              info.phase === "grid_first_parse" &&
              info.analysisStage === "parser"
            ) {
              resultsBox.innerHTML =
                `<div class="summary">
                  Lettura automatica del referto${
                    info.layout
                      ? ` · ${escapeHtml(
                          getKnownLayoutDisplayName(info.layout)
                        )}`
                      : ""
                  }…
                </div>`;
            } else if (info.phase === "residual_plan") {
              resultsBox.innerHTML =
                `<div class="summary">
                  Esami riconosciuti automaticamente: <b>${info.strongResolved}/${info.totalTargets}</b>.<br>
                  Esami da verificare con l’IA: <b>${info.residualCount}</b>.
                  ${
                    info.residualCount
                      ? `<br>Testo IA: ${info.aiChars} caratteri su ${info.originalChars}.`
                      : `<br><b>IA non necessario.</b>`
                  }
                </div>`;
            } else if (info.phase === "target_ai_start") {
              resultsBox.innerHTML =
                `<div class="summary">
                  Analisi con IA · gruppo ${info.current}/${info.total}<br>
                  ${escapeHtml((info.targets || []).join(" · "))}
                </div>`;
            } else if (info.phase === "target_ai_stream") {
              resultsBox.innerHTML =
                `<div class="summary">
                  IA locale: analisi dei dati rimanenti…
                </div>`;
            } else if (info.phase === "adaptive_split") {
              resultsBox.innerHTML =
                `<div class="summary">
                  IA locale: molti dati da analizzare.
                  <br>Suddivisione automatica (livello ${info.depth})…
                </div>`;
            }
          }
        );

      const extraction = analysis.merged;

      validated = extraction.results || [];
      validatedLongReports = extraction.longReports || [];

      const html = [];

      for (const item of validated) {
        let conversionHtml = "";

        if (item.converted) {
          conversionHtml = `
            <span class="convert">
              Valore convertito:
              ${escapeHtml(item.originalValue)}
              ${escapeHtml(item.originalUnit)}
              →
              ${escapeHtml(item.value)}
              ${escapeHtml(item.unit)}
            </span>
          `;
        } else if (item.unit) {
          conversionHtml = `
            <span class="small">
              Unità: ${escapeHtml(item.unit)}
            </span>
          `;
        }

        let rangeHtml = "";

        if (item.rangeAvailable) {
          let originalRange = "";

          if (item.rangeConverted) {
            originalRange = `
              <span class="small">
                Intervallo originale:
                ${escapeHtml(item.originalRefMin)}
                –
                ${escapeHtml(item.originalRefMax)}
                ${escapeHtml(item.originalRefUnit)}
              </span>
            `;
          }

          rangeHtml = `
            <span class="range">
              Min → <b>${escapeHtml(item.refMin)}</b>
              &nbsp;&nbsp;
              Max → <b>${escapeHtml(item.refMax)}</b>
              ${
                item.refUnit
                  ? ` ${escapeHtml(item.refUnit)}`
                  : ""
              }
            </span>
            ${originalRange}
          `;
        } else if (item.referenceText) {
          rangeHtml = `
            <span class="small">
              Range non compilato automaticamente:
              ${escapeHtml(item.referenceText)}
            </span>
          `;
        }

        html.push(`
          <div class="row ok">
            <b>${escapeHtml(item.exam)}</b>

            <div class="main-value">
              Valore → <b>${escapeHtml(item.value)}</b>
            </div>

            ${conversionHtml}
            ${rangeHtml}

            ${
              item.comparatorOriginalWithUnit
                ? `
                  <span class="small">
                    Referto originale:
                    <b>${escapeHtml(item.comparatorOriginalWithUnit)}</b>
                    · in Valore verrà scritto ${escapeHtml(item.value)}
                  </span>
                `
                : ""
            }

            ${
              item.raw_label
                ? `
                  <span class="small">
                    Referto: ${escapeHtml(item.raw_label)}
                  </span>
                `
                : ""
            }

            ${
              item.evidence
                ? `
                  <span class="evidence">
                    “${escapeHtml(item.evidence)}”
                  </span>
                `
                : ""
            }
          </div>
        `);
      }

      for (const item of validatedLongReports) {
        const previewLines =
          String(item.text || "")
            .split(/\r?\n/)
            .filter(Boolean);

        const preview =
          previewLines.slice(0, 8).join("\n");

        html.push(`
          <div class="row ok">
            <b>${escapeHtml(item.exam)}</b>

            <div class="main-value">
              Referto lungo → <b>Vedi referto</b>
            </div>

            <span class="small">
              ${escapeHtml(longReportKindLabel(item.kind))}
              · ${previewLines.length} righe
            </span>

            <span class="evidence" style="white-space:pre-wrap">
              ${escapeHtml(preview)}
              ${
                previewLines.length > 8
                  ? "\n…"
                  : ""
              }
            </span>
          </div>
        `);
      }

      for (const item of extraction.recognizedNotInGrid || []) {
        html.push(`
          <div class="row warning">
            ◌ Esame presente nel referto, non presente in Eumed

            <span class="small">
              ${escapeHtml(item.raw_label || item.exam || "")}
              ${
                item.value
                  ? ` → ${escapeHtml(item.value)} ${escapeHtml(item.unit || "")}`
                  : ""
              }
            </span>

            <span class="small">
              Catalogo:
              ${escapeHtml(item.catalogName || "")}
              ${
                item.catalogCode
                  ? ` [${escapeHtml(item.catalogCode)}]`
                  : ""
              }
            </span>
          </div>
        `);
      }

      for (const item of extraction.uncertain || []) {
        html.push(`
          <div class="row warning">
            ? Dato non compilato
            <span class="small">
              ${escapeHtml(item.text || "")}
            </span>
            <span class="small">
              ${escapeHtml(item.reason || "")}
            </span>
          </div>
        `);
      }

      for (const item of extraction.rejected || []) {
        html.push(`
          <div class="row error">
            ✗ Dato rifiutato
            <span class="small">
              ${escapeHtml(item.raw_label || item.exam || "")}
              ${escapeHtml(item.value || "")}
              ${escapeHtml(item.unit || "")}
            </span>
            <span class="small">
              ${escapeHtml(item.reason || "")}
            </span>
            ${
              item.candidates?.length
                ? `
                  <span class="small">
                    Candidati:
                    <br>
                    ${item.candidates.map(escapeHtml).join("<br>")}
                  </span>
                `
                : ""
            }
          </div>
        `);
      }

      const reportDateHtml = extraction.reportDate
        ? `Data referto → <b>${escapeHtml(formatDateForGrid(extraction.reportDate))}</b>`
        : `<span style="color:#8a5b00">Data referto non trovata con certezza: Data esito non verrà modificata.</span>`;

      const rangesCount =
        validated.filter(x => x.rangeAvailable).length;

      if (hasCompilableItems()) {
        html.push(`
          <div class="summary">
            ${reportDateHtml}
            ${
              extraction.reportDateEvidence
                ? `<br><span class="small">${escapeHtml(extraction.reportDateEvidence)}</span>`
                : ""
            }

            <br><br>

            <b>${validated.length} risultati numerici pronti.</b>
            <br>
            ${rangesCount} con Min/Max pronti.
            <br>
            <b>${validatedLongReports.length} referti lunghi pronti.</b>
            <br>
            ${(extraction.recognizedNotInGrid || []).length}
            esami presenti nel referto ma assenti in Eumed.

            <br><br>

            ${
              `Eumed-first${extraction.labLayoutName ? ` · ${escapeHtml(extraction.labLayoutName)}` : ""}: ${extraction.strongParserResolvedCount || 0} target forti risolti senza IA · ${extraction.residualAiTargetCount || 0} target passati a IA · ${extraction.targetedAiBatches || 0} batch IA.`
            }

            <br><br>

            Per i referti lunghi verranno impostati:
            Data esito → Risultato "Vedi referto" → testo nel popup Referto.

            <br>
            Il salvataggio finale resta manuale.
          </div>
        `);

        compileButton.disabled = false;
      } else {
        html.push(`
          <div class="summary">
            ${reportDateHtml}
            <br><br>
            Nessun dato pronto per la compilazione.
          </div>
        `);
      }

      lastAnalyzedText = text;
      resultsBox.innerHTML = html.join("") + renderPrescribedTransferBlock(buildPrescribedTransferText(extraction,text));

    } catch (error) {
      invalidate();

      resultsBox.innerHTML = `
        <div class="row error">
          Errore durante l'estrazione locale.
          <span class="small">
            ${escapeHtml(error?.message || String(error))}
          </span>
        </div>
      `;

    } finally {
      setBusy(false);
    }
  }

  async function compileValidated() {
    if (activeWorkflowMode === WORKFLOW_MODE.PRESCRIPTION_LIST) {
      await compilePrescriptionList();
      return;
    }
    if (activeWorkflowMode === WORKFLOW_MODE.UNPRESCRIBED) {
      await compileUnprescribedValidated();
      return;
    }

    if (isBusy || !hasCompilableItems()) return;

    const numericSnapshot = validated.map(x => ({ ...x }));
    const longSnapshot = validatedLongReports.map(x => ({ ...x }));

    setBusy(true);

    try {
      let numericResult = {
        success: true,
        completed: []
      };

      if (numericSnapshot.length) {
        numericResult = await setExamRecords(
          numericSnapshot,
          (current, total, item, phase = "values") => {
            resultsBox.innerHTML = `
              <div class="summary">
                ${
                  phase === "dates"
                    ? `Verifica Data esito ${current}/${total}`
                    : `Risultati numerici ${current}/${total}`
                }
                <br>
                ${escapeHtml(item.exam)}
                <br><br>
                ${
                  phase === "dates"
                    ? "Data esito viene impostata per prima sulla riga."
                    : "Dopo la data vengono scritti e riletti Min, Max e Valore."
                }
              </div>
            `;
          }
        );
      }

      let longResult = {
        success: true,
        completed: []
      };

      if (longSnapshot.length) {
        longResult = await setLongReportRecords(
          longSnapshot,
          (current, total, item) => {
            resultsBox.innerHTML = `
              <div class="summary">
                Referti lunghi ${current}/${total}
                <br>
                ${escapeHtml(item.exam)}
                <br><br>
                Data esito → Vedi referto → testo Referto → verifica riapertura.
              </div>
            `;
          }
        );
      }

      if (!longResult.success) {
        resultsBox.innerHTML = `
          <div class="row error">
            Compilazione interrotta durante i referti lunghi.
            <span class="small">
              Referti lunghi completati:
              ${longResult.completed.length}/${longSnapshot.length}
            </span>
            ${
              longResult.failed
                ? `
                  <span class="small">
                    Stop su: ${escapeHtml(longResult.failed.exam)}
                  </span>
                `
                : ""
            }
            <span class="small">
              I risultati numerici precedenti possono essere già stati modificati.
              Nessun Salva generale è stato premuto.
            </span>
          </div>
        `;
        return;
      }

      const successHtml = [];
      const numericDateVerified =
        new Set(numericResult.dateVerified || []);
      const numericDateWarnings =
        numericResult.dateWarnings || [];
      const numericDateWarningMap =
        new Map(
          numericDateWarnings.map(x => [x.exam, x])
        );

      const numericFieldStatusMap =
        new Map(
          (numericResult.fieldStatus || []).map(x => [x.exam, x])
        );

      for (const item of numericSnapshot) {
        const dateWarning =
          numericDateWarningMap.get(item.exam);

        const fieldStatus =
          numericFieldStatusMap.get(item.exam)?.fields || {};

        const valueStatus = fieldStatus.value;
        const minStatus = fieldStatus.min;
        const maxStatus = fieldStatus.max;

        successHtml.push(`
          <div class="row ok">
            <b>${escapeHtml(item.exam)}</b>
            ${
              item.reportDate && numericDateVerified.has(item.exam)
                ? `<span class="small">Data verificata → <b>${escapeHtml(formatDateForGrid(item.reportDate))}</b></span>`
                : item.reportDate && dateWarning
                  ? `
                    <span class="small">
                      ⚠ Data esito da controllare manualmente:
                      attesa <b>${escapeHtml(dateWarning.expected)}</b>
                      ${
                        dateWarning.current
                          ? `· Eumed attuale: <b>${escapeHtml(dateWarning.current)}</b>`
                          : "· Eumed attuale vuoto"
                      }
                    </span>
                  `
                  : ""
            }
            <div class="main-value">
              ${
                valueStatus?.verified
                  ? `Valore verificato → <b>${escapeHtml(item.value)}</b>`
                  : `
                    ⚠ Valore da controllare manualmente:
                    atteso <b>${escapeHtml(item.value)}</b>
                    ${
                      valueStatus?.current
                        ? `· Eumed attuale: <b>${escapeHtml(valueStatus.current)}</b>`
                        : "· Eumed attuale vuoto"
                    }
                  `
              }
            </div>

            ${
              item.refMin
                ? `
                  <span class="small">
                    ${
                      minStatus?.verified
                        ? `Min verificato → <b>${escapeHtml(item.refMin)}</b>`
                        : `
                          ⚠ Min da controllare:
                          atteso <b>${escapeHtml(item.refMin)}</b>
                          ${
                            minStatus?.current
                              ? `· Eumed attuale: <b>${escapeHtml(minStatus.current)}</b>`
                              : "· Eumed attuale vuoto"
                          }
                        `
                    }
                  </span>
                `
                : ""
            }

            ${
              item.refMax
                ? `
                  <span class="small">
                    ${
                      maxStatus?.verified
                        ? `Max verificato → <b>${escapeHtml(item.refMax)}</b>`
                        : `
                          ⚠ Max da controllare:
                          atteso <b>${escapeHtml(item.refMax)}</b>
                          ${
                            maxStatus?.current
                              ? `· Eumed attuale: <b>${escapeHtml(maxStatus.current)}</b>`
                              : "· Eumed attuale vuoto"
                          }
                        `
                    }
                  </span>
                `
                : ""
            }
          </div>
        `);
      }

      for (const item of longSnapshot) {
        successHtml.push(`
          <div class="row ok">
            <b>${escapeHtml(item.exam)}</b>
            ${
              item.reportDate
                ? `<span class="small">Data verificata → <b>${escapeHtml(formatDateForGrid(item.reportDate))}</b></span>`
                : ""
            }
            <div class="main-value">
              Risultato verificato → <b>Vedi referto</b>
            </div>
            <span class="small">
              Referto lungo scritto e verificato riaprendo il popup.
            </span>
          </div>
        `);
      }

      const fieldWarnings =
        numericResult.fieldWarnings || [];
      const dateWarnings =
        numericResult.dateWarnings || [];

      const hasWarnings =
        fieldWarnings.length > 0 ||
        dateWarnings.length > 0;

      const valueWarningCount =
        fieldWarnings.filter(x => x.field === "Valore").length;
      const minWarningCount =
        fieldWarnings.filter(x => x.field === "Min").length;
      const maxWarningCount =
        fieldWarnings.filter(x => x.field === "Max").length;

      resultsBox.innerHTML =
        successHtml.join("") +
        `
          <div class="summary">
            ${
              hasWarnings
                ? "✓ Compilazione completata senza hard-stop. ⚠ Alcuni campi richiedono controllo manuale."
                : "✓ Tutti i campi richiesti sono stati scritti e verificati."
            }
            <br>
            ${numericSnapshot.length} risultati numerici ·
            ${longSnapshot.length} referti lunghi.
            ${
              valueWarningCount
                ? `<br>⚠ ${valueWarningCount} Valore non confermati automaticamente.`
                : ""
            }
            ${
              minWarningCount
                ? `<br>⚠ ${minWarningCount} Min non confermati automaticamente.`
                : ""
            }
            ${
              maxWarningCount
                ? `<br>⚠ ${maxWarningCount} Max non confermati automaticamente.`
                : ""
            }
            ${
              dateWarnings.length
                ? `<br>⚠ ${dateWarnings.length} Data esito non confermate automaticamente.`
                : ""
            }
            <br><br>
            <b>Verifica visivamente i campi segnalati e poi salva tu dal gestionale.</b>
          </div>
        `;

    } catch (error) {
      resultsBox.innerHTML = `
        <div class="row error">
          Errore durante la compilazione.
          <span class="small">
            ${escapeHtml(error?.message || String(error))}
          </span>
        </div>
      `;

    } finally {
      setBusy(false);
    }
  }


  function renderUnprescribedPreview(extraction) {
    const html = [];

    html.push(`
      <div class="summary">
        <b>REFERTO NON PRESCRITTO analizzato</b><br>
        ${extraction.layout ? `Formato riconosciuto: ${escapeHtml(getKnownLayoutDisplayName(extraction.layout))}<br>` : "Formato non riconosciuto: analisi affidata all’IA.<br>"}
        Data referto: <b>${escapeHtml(extraction.reportDate ? formatDateForGrid(extraction.reportDate) : "da controllare")}</b><br>
        ${extraction.numeric.length} risultati numerici · ${extraction.complex.length} referti complessi.
      </div>
    `);

    for (const item of extraction.numeric) {
      html.push(`
        <div class="row ok">
          <b>${escapeHtml(item.exam)}</b>
          <span class="small">Catalogo ${escapeHtml(item.catalogCode || "")}</span>
          <div class="main-value">Valore → <b>${escapeHtml(item.value)}</b>${item.unit ? ` ${escapeHtml(item.unit)}` : ""}</div>
          ${item.comparatorOriginalWithUnit ? `<span class="small">Referto originale: <b>${escapeHtml(item.comparatorOriginalWithUnit)}</b> · in Valore verrà scritto ${escapeHtml(item.value)}</span>` : ""}
          ${item.refMin && item.refMax ? `<span class="small">Range → ${escapeHtml(item.refMin)} - ${escapeHtml(item.refMax)}</span>` : ""}
          ${item.raw_label && normalizeExamName(item.raw_label) !== normalizeExamName(item.exam) ? `<span class="evidence">Referto: ${escapeHtml(item.raw_label)}</span>` : ""}
        </div>
      `);
    }

    for (const item of extraction.complex) {
      html.push(`
        <div class="row ok">
          <b>${escapeHtml(item.exam)}</b>
          <span class="small">Catalogo ${escapeHtml(item.catalogCode || "")} · referto complesso ${escapeHtml(item.complexKind || "")}</span>
          <div class="main-value">Risultato → <b>Vedi referto</b></div>
          <span class="small">${escapeHtml((item.text || "").slice(0, 220))}${(item.text || "").length > 220 ? "…" : ""}</span>
        </div>
      `);
    }

    for (const item of extraction.uncertain || []) {
      html.push(`
        <div class="row warning">
          ⚠ ${escapeHtml(item.text || "Da controllare")}
          <span class="small">${escapeHtml(item.reason || "")}</span>
        </div>
      `);
    }

    if (extraction.numeric.length || extraction.complex.length) {
      html.push(`
        <div class="summary">
          Pronti per la creazione in Eumed: <b>${extraction.numeric.length + extraction.complex.length}</b> righe.<br>
          Controlla l’anteprima prima di inserire i risultati.
        </div>
      `);
    }

    return html.join("");
  }

  async function analyzeUnprescribedReport() {
    if (isBusy) return;
    invalidate();

    const text = textarea.value.trim();
    if (!text) {
      resultsBox.innerHTML = '<div class="row warning">Incolla o carica prima il referto.</div>';
      return;
    }

    setBusy(true);

    try {
      const extraction = await extractUnprescribedFromReport(text, info => {
        if (info.phase === "unprescribed_parser") {
          resultsBox.innerHTML = `<div class="summary">Lettura automatica · ${info.layout ? escapeHtml(getKnownLayoutDisplayName(info.layout)) : "riconoscimento del formato"}…</div>`;
        } else if (info.phase === "unprescribed_qwen_residual") {
          resultsBox.innerHTML = `<div class="summary">IA · verifica dei dati ancora da riconoscere · ${info.evidence || 0} righe da verificare (${info.chars || 0} caratteri)…</div>`;
        } else if (info.phase === "unprescribed_qwen_start") {
          const label = info.mode === "residual" ? "verifica dei dati rimanenti" : "lettura del referto";
          resultsBox.innerHTML = `<div class="summary">IA · ${label} blocco ${info.current}/${info.total}…</div>`;
        } else if (info.phase === "unprescribed_qwen_stream") {
          const label = info.mode === "residual" ? "verifica dei dati rimanenti" : "lettura del referto";
          resultsBox.innerHTML = `<div class="summary">IA · ${label} blocco ${info.current}/${info.total} · ${info.chars || 0} caratteri…</div>`;
        }
      });

      unprescribedNumeric = extraction.numeric;
      unprescribedComplex = extraction.complex;
      unprescribedUncertain = extraction.uncertain;
      lastAnalyzedText = text;
      compileButton.disabled = !hasCompilableItems();
      resultsBox.innerHTML = renderUnprescribedPreview(extraction);
    } catch (error) {
      invalidate();
      resultsBox.innerHTML = `<div class="row error">Errore durante l'analisi del referto non prescritto.<span class="small">${escapeHtml(error?.message || String(error))}</span></div>`;
    } finally {
      setBusy(false);
    }
  }

  function unprescribedItemKey(item) {
    return [
      String(item?.catalogCode || normalizeExamName(item?.exam || "")),
      String(item?.reportDate || ""),
      String(item?.complexKind || "NUM"),
      String(item?.value || ""),
      String(item?.unit || "")
    ].join("|");
  }

  function removeCompletedUnprescribedItems(completed) {
    const done = new Set((completed || []).map(unprescribedItemKey));
    if (!done.size) return;
    unprescribedNumeric = unprescribedNumeric.filter(item => !done.has(unprescribedItemKey(item)));
    unprescribedComplex = unprescribedComplex.filter(item => !done.has(unprescribedItemKey(item)));
  }

  async function compileUnprescribedValidated() {
    if (isBusy || !hasCompilableItems()) return;

    const numeric = unprescribedNumeric.map(x => ({ ...x }));
    const complex = unprescribedComplex.map(x => ({ ...x }));
    const items = [...numeric, ...complex];

    if (items.some(item => !item.reportDate)) {
      resultsBox.innerHTML = `
        <div class="row error">
          Inserimento non avviato: manca la data del referto per almeno un esame.
          <span class="small">Correggi/integra il testo del referto o la data prima di creare le righe Eumed.</span>
        </div>`;
      return;
    }

    setBusy(true);
    const started = Date.now();

    try {
      const result = await writeNonPrescribedItems(items, (current, total, item) => {
        resultsBox.innerHTML = `
          <div class="summary">
            Creazione riga ${current}/${total}<br>
            <b>${escapeHtml(item.exam)}</b><br>
            ${item.complexKind ? "Vedi referto + testo complesso" : `Valore ${escapeHtml(item.value || "")}`}
          </div>`;
      });

      const elapsed = Date.now() - started;

      // Gli elementi già confermati non restano più "pronti": un secondo click
      // non deve duplicarli. Se il workflow si interrompe, il retry riparte dal
      // primo elemento non completato e conserva quelli successivi.
      removeCompletedUnprescribedItems(result.completed);

      const uncertainHtml = unprescribedUncertain.length
        ? `<br><br><b>⚠ ${unprescribedUncertain.length} esami/dati non inseriti automaticamente:</b><br>${unprescribedUncertain.slice(0, 20).map(x => `• ${escapeHtml(x.text || "Dato")} — ${escapeHtml(x.reason || "da controllare")}`).join("<br>")}${unprescribedUncertain.length > 20 ? `<br>… altri ${unprescribedUncertain.length - 20}` : ""}`
        : "";

      resultsBox.innerHTML = `
        <div class="summary">
          <b>INSERIMENTO REFERTO NON PRESCRITTO ${result.success ? "completato" : "interrotto"}</b><br>
          Righe create e confermate: ${result.completed.length}/${items.length}<br>
          Risultati numerici: ${numeric.length}<br>
          Referti complessi: ${complex.length}<br>
          Tempo scrittura: ${formatElapsedMs(elapsed)}<br>
          Retry automatici: ${result.stats?.retries || 0} su ${result.stats?.retriedRows || 0} righe<br>
          Tempo selezione catalogo: ${formatElapsedMs(result.stats?.catalogSelectionMs || 0)}<br>
          ${result.failed ? `<br>⚠ Stop su <b>${escapeHtml(result.failed.exam)}</b>. Verifica il campo indicato prima di riprovare.<br>` : ""}
          ${(result.warnings || []).length ? `<br>⚠ ${(result.warnings || []).map(x => `${escapeHtml(x.exam)} — ${escapeHtml(x.field)}`).join("<br>⚠ ")}<br>` : ""}
          ${uncertainHtml}
          ${!result.success && result.completed.length ? `<br><br><b>Puoi riprovare: le ${result.completed.length} righe già confermate non verranno reinserite.</b>` : ""}
          <br><br><b>Controlla i risultati inseriti in Eumed.</b>
        </div>`;
    } catch (error) {
      resultsBox.innerHTML = `
        <div class="row error">
          Errore durante la creazione delle righe non prescritte.
          <span class="small">${escapeHtml(error?.message || String(error))}</span>
          <span class="small">Nessun Salva generale è stato premuto.</span>
        </div>`;
    } finally {
      setBusy(false);
    }
  }

  async function runUnprescribedAutoWorkflow() {
    if (isBusy) return;
    if (!textarea.value.trim()) {
      resultsBox.innerHTML = '<div class="row warning">Carica o incolla prima il referto.</div>';
      return;
    }

    await analyzeUnprescribedReport();
    if (hasCompilableItems()) await compileUnprescribedValidated();
  }

  async function compileCompositeDetails(
    items,
    label = "Dettagli esami composti",
    onProgress = null
  ) {
    const completed = [];
    const warnings = [];

    for (let i = 0; i < (items || []).length; i++) {
      const item = items[i];

      await ensureExamRowVisible(item.exam);

      if (onProgress) {
        onProgress(
          i + 1,
          items.length,
          item,
          "composite"
        );
      } else {
        resultsBox.innerHTML =
          `<div class="summary">
            ${escapeHtml(label)} ${i + 1}/${items.length}<br>
            ${escapeHtml(item.exam)}
          </div>`;
      }

      // NON impostare "Vedi referto": il valore numerico principale
      // deve restare visibile nella colonna Valore.
      const ok =
        await writeLongReportTextResilient(
          item.exam,
          item.text,
          2
        );

      if (ok) {
        completed.push(item);
      } else {
        warnings.push({
          exam: item.exam,
          field: "Dettaglio esame composto"
        });
      }

      await sleep(150);
    }

    return { completed, warnings };
  }

  async function compileLongReportsNonBlocking(
    items,
    label,
    onProgress = null
  ) {
    const completed = [], warnings = [], statuses = [];

    for (let i = 0; i < (items || []).length; i++) {
      const item = items[i];

      if (onProgress) {
        onProgress(
          i + 1,
          items.length,
          item,
          "long"
        );
      } else {
        resultsBox.innerHTML =
          `<div class="summary">${escapeHtml(label)} · referto lungo ${i + 1}/${items.length}<br>${escapeHtml(item.exam)}</div>`;
      }

      const status = await setLongReportRecordDetailed(item);
      statuses.push(status);

      if (status.resultVerified && status.textVerified) {
        completed.push(item);
      }

      warnings.push(...(status.warnings || []));
      await sleep(180);
    }

    return { completed, warnings, statuses };
  }

  function formatElapsedMs(ms) {
    const n = Number(ms || 0);

    if (!Number.isFinite(n) || n <= 0) {
      return "0,0 s";
    }

    return `${(n / 1000)
      .toFixed(1)
      .replace(".", ",")} s`;
  }

  function mergeCompileWarnings(...numericResults) {
    const fieldWarnings=[], dateWarnings=[];
    for(const r of numericResults){fieldWarnings.push(...(r?.fieldWarnings||[]));dateWarnings.push(...(r?.dateWarnings||[]));}
    return {fieldWarnings,dateWarnings};
  }

  function renderEumedAudit(audit) {
    const blocks = [];
    if (audit.transferText) blocks.push(renderPrescribedTransferBlock(audit.transferText));

    if (audit.presentInReportAbsentEumed.length) {
      blocks.push(`
        <div class="row warning">
          <b>Esami presenti nel referto ma assenti in Eumed</b>
          ${audit.presentInReportAbsentEumed
            .map(x =>
              `<span class="small">• ${escapeHtml(x.name)}${
                x.detail ? ` → ${escapeHtml(x.detail)}` : ""
              }</span>`
            )
            .join("")}
        </div>
      `);
    }

    if (audit.eumedNotFound.length) {
      blocks.push(`
        <div class="row warning">
          <b>Esami presenti in Eumed ma non trovati nel referto</b>
          ${audit.eumedNotFound
            .map(name => `<span class="small">• ${escapeHtml(name)}</span>`)
            .join("")}
        </div>
      `);
    }

    if (audit.ambiguousItems.length) {
      blocks.push(`
        <div class="row warning">
          <b>Esami ambigui o non validabili</b>
          ${audit.ambiguousItems
            .map(x =>
              `<span class="small">• ${escapeHtml(x.name)}${
                x.reason ? ` — ${escapeHtml(x.reason)}` : ""
              }</span>`
            )
            .join("")}
        </div>
      `);
    }

    if (!blocks.length) {
      blocks.push(`
        <div class="row ok">
          <b>Controllo completezza</b>
          <span class="small">
            Nessun esame aggiuntivo o ambiguo rilevato.
          </span>
        </div>
      `);
    }

    return blocks.join("");
  }

  async function runAutoWorkflow() {
    if (isBusy) return;

    const text = textarea.value.trim();

    if (!text) {
      resultsBox.innerHTML =
        '<div class="row warning">Carica o incolla prima un referto.</div>';
      return;
    }

    invalidate();
    setBusy(true);
    examRowSelectionCache.clear();

    const workflowStartedAt =
      Date.now();

    try {
      await ensureLabCatalog();

      resultsBox.innerHTML =
        '<div class="summary">INSERIMENTO AUTOMATICO · indicizzazione completa di Eumed…</div>';

      const gridScan =
        await scanAllEumedRows(info => {
          resultsBox.innerHTML =
            `<div class="summary">
              INSERIMENTO AUTOMATICO · indicizzazione completa di Eumed…<br>
              ${info.count} accertamenti individuati
            </div>`;
        });

      const targetExams =
        getEmptyEumedExams();

      if (!targetExams.length) {
        // Read-only analysis: offer a handoff even when there are no empty
        // prescription rows. This path never invokes a writer.
        resultsBox.innerHTML='<div class="summary">Nessuna riga vuota in Eumed. Analisi del referto per preparare il blocco da copiare...</div>';
        const analysis=await extractUnprescribedFromReport(text);
        const transferText=buildPrescribedTransferText({reportDate:analysis.reportDate,
          recognizedNotInGrid:analysis.numeric.map(item=>({...item,value:item.originalValue || item.value,unit:item.originalUnit || item.unit}))},text);
        resultsBox.innerHTML =
          `<div class="summary">
            <b>INSERIMENTO AUTOMATICO</b><br>
            Nessun accertamento vuoto da compilare in Eumed.
            <br><br>
            <b>Nessun Salva generale è stato premuto.</b>
          </div>` + renderPrescribedTransferBlock(transferText);
        return;
      }

      const parallelState = {
        parser: "in avvio",
        ai: "in attesa del parser",
        writer: "in attesa del parser"
      };

      const renderParallelState = () => {
        resultsBox.innerHTML =
          `<div class="summary">
            <b>INSERIMENTO AUTOMATICO · pipeline parallela</b><br>
            Lettura automatica: ${escapeHtml(parallelState.parser)}<br>
            IA: ${escapeHtml(parallelState.ai)}<br>
            Eumed: ${escapeHtml(parallelState.writer)}<br>
            <br>
            L’analisi IA e l’inserimento dei risultati già verificati procedono insieme.
          </div>`;
      };

      renderParallelState();

      // FASE 1: parser deterministico + piano residuo.
      const plan =
        await prepareResidualQwenPlan(
          text,
          targetExams,
          info => {
            if (
              info.phase === "grid_first_parse" &&
              info.analysisStage === "parser"
            ) {
              parallelState.parser =
                info.layout
                  ? `${getKnownLayoutDisplayName(info.layout)}`
                  : "parser generico";
              renderParallelState();
            } else if (
              info.phase === "residual_plan"
            ) {
              parallelState.parser =
                `${info.strongResolved}/${info.totalTargets} target forti · ${formatElapsedMs(info.parserMs)}`;
              parallelState.ai =
                info.residualCount
                  ? `${info.residualCount} target · ${info.aiChars}/${info.originalChars} caratteri${
                      info.skippedNoEvidenceCount
                        ? ` · ${info.skippedNoEvidenceCount} esclusi senza indizi`
                        : ""
                    }`
                  : info.skippedNoEvidenceCount
                    ? `non necessario · ${info.skippedNoEvidenceCount} residui senza indizi nel referto`
                    : "non necessario";
              parallelState.writer =
                info.strongResolved
                  ? `${info.strongResolved} target forti pronti`
                  : "nessun match forte";
              renderParallelState();
            }
          }
        );

      const strongWriteSet =
        buildStrongParserWriteSet(
          plan
        );

      // FASE 2A: IA parte SUBITO sui soli residui.
      const qwenPromise =
        runResidualQwenFromPlan(
          plan,
          info => {
            if (
              info.phase === "target_ai_start"
            ) {
              parallelState.ai =
                `batch ${info.current || "?"}/${info.total || "?"}: ` +
                (info.targets || [])
                  .slice(0, 3)
                  .join(" · ");
            } else if (
              info.phase === "target_ai_stream"
            ) {
              parallelState.ai =
                `elaborazione residuo · ${info.chars || 0} caratteri ricevuti`;
            } else if (
              info.phase === "adaptive_split"
            ) {
              parallelState.ai =
                `residuo denso · suddivisione livello ${info.depth || "?"}`;
            } else if (
              info.phase === "long_report_ai_fallback"
            ) {
              parallelState.ai =
                `recupero ${longReportKindLabel(info.kind)}`;
            }

            renderParallelState();
          }
        );

      // FASE 2B: contemporaneamente scrivi tutti i match forti.
      const strongWriterStartedAt =
        Date.now();

      const strongWriterPromise =
        (async () => {
          let numeric = {
            fieldWarnings: [],
            dateWarnings: [],
            completed: []
          };

          if (strongWriteSet.results.length) {
            numeric =
              await setExamRecords(
                strongWriteSet.results,
                (c, t, item, phase) => {
                  parallelState.writer =
                    `${phase === "dates" ? "Data" : "Valori"} parser ${c}/${t} · ${item.exam}`;
                  renderParallelState();
                }
              );
          }

          const composite =
            await compileCompositeDetails(
              strongWriteSet.compositeDetails,
              "Lettura automatica · dettaglio esame composto",
              (c, t, item) => {
                parallelState.writer =
                  `dettaglio composto parser ${c}/${t} · ${item.exam}`;
                renderParallelState();
              }
            );

          const longReports =
            await compileLongReportsNonBlocking(
              strongWriteSet.longReports,
              "Lettura automatica",
              (c, t, item) => {
                parallelState.writer =
                  `referto lungo parser ${c}/${t} · ${item.exam}`;
                renderParallelState();
              }
            );

          parallelState.writer =
            "match forti completati";
          renderParallelState();

          return {
            numeric,
            composite,
            longReports,
            elapsedMs:
              Date.now() -
              strongWriterStartedAt
          };
        })();

      // Le due attività procedono realmente insieme.
      const [
        analysis,
        strongWriter
      ] =
        await Promise.all([
          qwenPromise,
          strongWriterPromise
        ]);

      const parserExtraction =
        analysis.parserExtraction;
      const hybridExtraction =
        analysis.hybridExtraction;
      const merged =
        analysis.merged;

      parallelState.parser =
        `${merged.strongParserResolvedCount || 0}/${targetExams.length} target forti · ${formatElapsedMs(analysis.parserMs)}`;

      parallelState.ai =
        merged.residualAiTargetCount
          ? `${hybridExtraction.targetedAiBatches || 0} batch completati · ${formatElapsedMs(analysis.qwenMs)}`
          : "non necessario";

      parallelState.writer =
        `match forti completati · ${formatElapsedMs(strongWriter.elapsedMs)}`;

      renderParallelState();

      // FASE 3: dopo IA scrivi SOLO ciò che non era già stato scritto
      // dal parser forte.
      const postQwenWriteSet =
        filterPostQwenWriteSet(
          merged,
          plan.strongResolved,
          strongWriter.composite.completed
        );

      const qwenWriterStartedAt =
        Date.now();

      let qwenNumeric = {
        fieldWarnings: [],
        dateWarnings: [],
        completed: []
      };

      if (postQwenWriteSet.results.length) {
        qwenNumeric =
          await setExamRecords(
            postQwenWriteSet.results,
            (c, t, item, phase) => {
              parallelState.writer =
                `${phase === "dates" ? "Data" : "Valori"} IA ${c}/${t} · ${item.exam}`;
              renderParallelState();
            }
          );
      }

      const finalCompositeDetails =
        buildCompositeExamDetails(
          text,
          merged
        );

      const additionalCompositeDetails =
        finalCompositeDetails.filter(item => {
          const key =
            normalizeExamName(
              `${item?.exam || ""}|${item?.text || ""}`
            );

          return !postQwenWriteSet
            .completedCompositeKeys
            .has(key);
        });

      const qwenComposite =
        await compileCompositeDetails(
          additionalCompositeDetails,
          "IA · dettaglio esame composto",
          (c, t, item) => {
            parallelState.writer =
              `dettaglio composto finale ${c}/${t} · ${item.exam}`;
            renderParallelState();
          }
        );

      const qwenLong =
        await compileLongReportsNonBlocking(
          postQwenWriteSet.longReports,
          "IA",
          (c, t, item) => {
            parallelState.writer =
              `referto lungo IA ${c}/${t} · ${item.exam}`;
            renderParallelState();
          }
        );

      const qwenWriterMs =
        Date.now() -
        qwenWriterStartedAt;

      validated = merged.results;
      validatedLongReports =
        merged.longReports;
      lastAnalyzedText = text;

      const audit =
        buildEumedAudit(merged, text);

      const stats =
        merged.workflowStats || {
          parserOnly: 0,
          aiOnly: 0,
          concordant: 0,
          conflicts: 0,
          qwenNoiseIgnored: 0
        };

      const compileWarnings =
        mergeCompileWarnings(
          strongWriter.numeric,
          qwenNumeric
        );

      const valueWarnings =
        (compileWarnings.fieldWarnings || [])
          .filter(x => x.field === "Valore")
          .length;

      const minWarnings =
        (compileWarnings.fieldWarnings || [])
          .filter(x => x.field === "Min")
          .length;

      const maxWarnings =
        (compileWarnings.fieldWarnings || [])
          .filter(x => x.field === "Max")
          .length;

      const dateWarnings =
        compileWarnings.dateWarnings || [];

      const longWarnings = [
        ...(strongWriter.longReports.warnings || []),
        ...(qwenLong.warnings || [])
      ];

      const compositeWarnings = [
        ...(strongWriter.composite.warnings || []),
        ...(qwenComposite.warnings || [])
      ];

      const totalMs =
        Date.now() -
        workflowStartedAt;

      const parserMs =
        analysis.parserMs || 0;

      const qwenMs =
        analysis.qwenMs || 0;

      const strongWriterMs =
        strongWriter.elapsedMs || 0;

      const writtenStrongCount =
        (strongWriter.numeric.completed || []).length +
        (strongWriter.longReports.completed || []).length;

      const writtenQwenCount =
        (qwenNumeric.completed || []).length +
        (qwenLong.completed || []).length;

      resultsBox.innerHTML =
        `<div class="summary">
          <b>INSERIMENTO AUTOMATICO completato</b><br>
          Accertamenti indicizzati in Eumed: ${gridScan.count}<br>
          Esami da compilare in Eumed: ${targetExams.length}<br>
          <details><summary>Dettagli dell’analisi</summary>
          Lettura automatica: ${merged.strongParserResolvedCount || 0}/${targetExams.length} target risolti senza IA<br>
          IA: ${
            merged.residualAiTargetCount
              ? `${hybridExtraction.targetedAiBatches || 0} batch · ${merged.residualAiTargetCount} target residui`
              : "non necessario"
          }<br>
          ${
            merged.aiSkippedNoEvidenceCount
              ? `Target residui esclusi da IA perché senza indizi nel referto: ${merged.aiSkippedNoEvidenceCount}<br>`
              : ""
          }
          ${
            merged.aiSemanticRescueCount
              ? `Recupero semantico IA (target senza alias noto): ${merged.aiSemanticRescueCount} · righe residue non spiegate dal parser: ${merged.aiUnclaimedEvidenceCount || 0}<br>`
              : ""
          }
          Testo inviato a IA: ${
            merged.residualAiTargetCount
              ? `${merged.aiInputChars || 0} / ${merged.originalInputChars || 0} caratteri (−${merged.aiInputReductionPercent || 0}%)`
              : "0 caratteri"
          }<br>
          <br>
          </details><b>Tempi</b><br>
          Lettura automatica: ${formatElapsedMs(parserMs)}<br>
          IA: ${formatElapsedMs(qwenMs)}<br>
          Inserimento dei risultati riconosciuti: ${formatElapsedMs(strongWriterMs)} <span class="small">(durante l’analisi IA, quando necessaria)</span><br>
          Scrittura dopo IA: ${formatElapsedMs(qwenWriterMs)}<br>
          Tempo totale: ${formatElapsedMs(totalMs)}<br>
          <br>
          ✓ ${stats.parserOnly + stats.concordant} risultati riconosciuti automaticamente<br>
          ✓ ${stats.aiOnly} risultati riconosciuti con l’IA e verificati<br>
          ✓ ${writtenStrongCount} elementi compilati in Eumed dopo la lettura automatica<br>
          ${
            writtenQwenCount
              ? `✓ ${writtenQwenCount} elementi Eumed scritti dopo IA<br>`
              : ""
          }
          ${
            stats.conflicts
              ? `⚠ ${stats.conflicts} risultati discordanti lasciati da verificare<br>`
              : ""
          }
          ${
            stats.qwenNoiseIgnored
              ? `ℹ ${stats.qwenNoiseIgnored} letture IA discordanti ignorate perché il parser deterministico era affidabile<br>`
              : ""
          }
          ✓ ${merged.longReports.length} referti lunghi preparati<br>
          ${
            strongWriter.composite.completed.length +
              qwenComposite.completed.length
              ? `✓ ${
                  strongWriter.composite.completed.length +
                  qwenComposite.completed.length
                } esami composti con dettaglio salvato<br>`
              : ""
          }
          ${
            valueWarnings
              ? `⚠ ${valueWarnings} Valori da controllare<br>`
              : ""
          }
          ${
            minWarnings
              ? `⚠ ${minWarnings} Min da controllare<br>`
              : ""
          }
          ${
            maxWarnings
              ? `⚠ ${maxWarnings} Max da controllare<br>`
              : ""
          }
          ${
            dateWarnings.length
              ? `⚠ ${dateWarnings.length} date da controllare:<br>${
                  dateWarnings
                    .map(
                      x =>
                        `&nbsp;&nbsp;• ${escapeHtml(x.exam)} — atteso ${escapeHtml(x.expected || "")}, Grid ${escapeHtml(x.current || "vuota")}`
                    )
                    .join("<br>")
                }<br>`
              : ""
          }
          ${
            compositeWarnings.length
              ? `⚠ ${compositeWarnings.length} dettagli di esami composti da controllare<br>`
              : ""
          }
          ${
            longWarnings.length
              ? `⚠ ${longWarnings.length} controlli sui referti lunghi:<br>${
                  longWarnings
                    .map(
                      x =>
                        `&nbsp;&nbsp;• ${escapeHtml(x.exam)} — ${
                          escapeHtml(
                            x.field || "controllare"
                          )
                        }`
                    )
                    .join("<br>")
                }<br>`
              : ""
          }
          <br>
          <b>Nessun Salva generale è stato premuto. Verifica e salva tu dal gestionale.</b>
        </div>` +
        renderEumedAudit(audit);

    } catch (error) {
      resultsBox.innerHTML =
        `<div class="row error">
          Errore nel workflow INSERIMENTO AUTOMATICO.
          <span class="small">${
            escapeHtml(
              error?.message || String(error)
            )
          }</span>
          <span class="small">
            Nessun Salva generale è stato premuto.
          </span>
        </div>`;
    } finally {
      setBusy(false);
    }
  }

  function renderOcrProgress(info, engineLabel) {
    if (info?.phase === "pdf_text") {
      resultsBox.innerHTML=`<div class="summary">Lettura PDF · pagina ${info.current}/${info.total}…</div>`;
    } else if (info?.phase === "pdf_ocr") {
      resultsBox.innerHTML=`<div class="summary">${info.engine==="qwen"?"Lettura con IA":"Lettura rapida"} · pagina ${info.current}/${info.total}…</div>`;
    } else if (info?.phase === "paddle_ocr_done") {
      resultsBox.innerHTML=`<div class="summary">Lettura rapida completata · ${info.lines||0} righe riconosciute</div>`;
    } else if (info?.phase === "qwen_ocr_start") {
      resultsBox.innerHTML=`<div class="summary">Lettura con IA · ${escapeHtml(info.label||"")}<br>Tempo massimo di attesa: 6 minuti per pagina.</div>`;
    } else if (info?.phase === "qwen_ocr_stream") {
      resultsBox.innerHTML=`<div class="summary">Lettura con IA · ${escapeHtml(info.label||"")} · ${info.chars||0} caratteri…</div>`;
    }
  }

  async function extractCurrentFile(mode="auto") {
    if (activeWorkflowMode === WORKFLOW_MODE.PRESCRIPTION_LIST) {
      throw new Error("In modalità lista i file vengono analizzati direttamente da IA per immagini, senza OCR leggero.");
    }
    if(!currentUploadedFile) throw new Error("Carica prima un PDF/JPEG/PNG.");
    const file=currentUploadedFile;
    const lower=String(file.name||"").toLowerCase();
    const isPdf=file.type==="application/pdf"||lower.endsWith(".pdf");
    const isImage=/image\/(jpeg|png)/.test(file.type)||/\.(jpe?g|png)$/.test(lower);
    if(!isPdf&&!isImage) throw new Error("Formato non supportato. Usa PDF, JPEG o PNG.");
    const effectiveMode=mode==="auto"?"auto":mode;
    const text=isPdf
      ? await extractTextFromPdfFile(file,info=>renderOcrProgress(info,effectiveMode),{mode:effectiveMode})
      : await extractTextFromImageFile(file,info=>renderOcrProgress(info,effectiveMode),{mode:effectiveMode==="auto"?"paddle":effectiveMode});
    if(text.trim().length<20) throw new Error("Il file non ha prodotto testo sufficiente.");
    textarea.value=text;
    activeTextSource=effectiveMode==="qwen"?"lettura con IA":effectiveMode==="paddle"?"lettura rapida":isPdf?"lettura PDF e immagini":"lettura rapida";
    invalidate();
    fileStatus.textContent=`${file.name} · sorgente: ${activeTextSource} · ${text.length} caratteri`;
    resultsBox.innerHTML = activeWorkflowMode === WORKFLOW_MODE.UNPRESCRIBED
      ? `<div class="summary">Testo pronto · sorgente <b>${escapeHtml(activeTextSource)}</b>.<br>Puoi usare <b>ANALIZZA REFERTO</b> oppure <b>INSERISCI REFERTO NON PRESCRITTO</b>.</div>`
      : `<div class="summary">Testo pronto · sorgente <b>${escapeHtml(activeTextSource)}</b>.<br>Puoi usare <b>TROVA CORRISPONDENZE</b> oppure <b>INSERISCI VALORI IN AUTOMATICO</b>.</div>`;
    return text;
  }

  async function analyzeUploadedFile(file) {
    if (activeWorkflowMode === WORKFLOW_MODE.PRESCRIPTION_LIST) {
      await analyzePrescriptionUploadedFile(file);
      return;
    }
    if(isBusy||!file)return;
    currentUploadedFile=file;
    invalidate(); setBusy(true);
    fileStatus.textContent=`File: ${file.name}`;
    resultsBox.innerHTML='<div class="summary">Lettura locale del file…</div>';
    try { await extractCurrentFile("auto"); }
    catch(error){
      resultsBox.innerHTML=`<div class="row error">Errore durante la lettura locale del file.<span class="small">${escapeHtml(error?.message||String(error))}</span></div>`;
      fileStatus.textContent=file.name||"";
    } finally { setBusy(false); fileInput.value=""; }
  }

  async function forceOcr(mode){
    if(isBusy)return;
    if (activeWorkflowMode === WORKFLOW_MODE.PRESCRIPTION_LIST) {
      if (!currentUploadedFile) {
        resultsBox.innerHTML='<div class="row warning">Carica prima un PDF/JPEG/PNG.</div>';
        return;
      }
      if (mode !== "qwen") {
        resultsBox.innerHTML='<div class="row warning">Per le liste con X/spunte viene usato solo IA per immagini.</div>';
        return;
      }
      await analyzePrescriptionUploadedFile(currentUploadedFile);
      return;
    }
    if(!currentUploadedFile){
      resultsBox.innerHTML='<div class="row warning">Carica prima un PDF/JPEG/PNG.</div>'; return;
    }
    setBusy(true); invalidate();
    try { await extractCurrentFile(mode); }
    catch(error){ resultsBox.innerHTML=`<div class="row error">${mode==="qwen"?"Lettura con IA":"Lettura rapida"} non completato.<span class="small">${escapeHtml(error?.message||String(error))}</span></div>`; }
    finally { setBusy(false); }
  }

  async function automaticFromCurrent(){
    if (activeWorkflowMode === WORKFLOW_MODE.PRESCRIPTION_LIST) {
      if (isBusy) return;
      if (!prescriptionListItems.length) {
        if (currentUploadedFile) {
          await analyzePrescriptionUploadedFile(currentUploadedFile);
        } else {
          await analyzePrescriptionList();
        }
      }
      if (prescriptionListItems.length) await compilePrescriptionList();
      return;
    }

    if (activeWorkflowMode === WORKFLOW_MODE.UNPRESCRIBED) {
      if(isBusy)return;
      if(!textarea.value.trim() && currentUploadedFile){
        setBusy(true);
        try { await extractCurrentFile("auto"); }
        catch(error){ resultsBox.innerHTML=`<div class="row error">Preparazione file fallita.<span class="small">${escapeHtml(error?.message||String(error))}</span></div>`; setBusy(false); return; }
        setBusy(false);
      }
      await runUnprescribedAutoWorkflow();
      return;
    }

    if(isBusy)return;
    if(!textarea.value.trim() && currentUploadedFile){
      setBusy(true);
      try { await extractCurrentFile("auto"); }
      catch(error){ resultsBox.innerHTML=`<div class="row error">Preparazione file fallita.<span class="small">${escapeHtml(error?.message||String(error))}</span></div>`; setBusy(false); return; }
      setBusy(false);
    }
    await runAutoWorkflow();
  }


  modePrescribedButton.addEventListener("click", () => selectWorkflowMode(WORKFLOW_MODE.PRESCRIBED));
  extensionUpdateCheck.addEventListener("click", () => refreshExtensionUpdate(true));
  extensionUpdateDownload.addEventListener("click", event => {
    if (isBusy) event.preventDefault();
  });
  aiModelSelect.addEventListener("change", () => {
    if (isBusy || aiModelsLoading) return;
    aiModelSelectionTask = applyAiModelSelection(aiModelSelect.value);
  });
  aiModelRefresh.addEventListener("click", () => {
    aiModelInitialization = refreshAiModels();
  });
  modeUnprescribedButton.addEventListener("click", () => selectWorkflowMode(WORKFLOW_MODE.UNPRESCRIBED));
  modePrescriptionListButton.addEventListener("click", () => selectWorkflowMode(WORKFLOW_MODE.PRESCRIPTION_LIST));
  changeModeButton.addEventListener("click", clearWorkflowMode);

  extractButton.addEventListener("click", analyzeReport);
  ocrFastButton.addEventListener("click", () => forceOcr("paddle"));
  ocrSlowButton.addEventListener("click", () => forceOcr("qwen"));
  compileButton.addEventListener("click", compileValidated);
  autoButton.addEventListener("click", automaticFromCurrent);

  fileButton.addEventListener("click", () => {
    if (!isBusy) fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) analyzeUploadedFile(file);
  });

  clearButton.addEventListener("click", () => {
    if (isBusy) return;
    textarea.value = "";
    currentUploadedFile = null;
    activeTextSource = "manuale";
    fileStatus.textContent = "";
    invalidate();
    resultsBox.innerHTML = activeWorkflowMode === WORKFLOW_MODE.PRESCRIPTION_LIST
      ? "Incolla una lista di esami oppure carica un file."
      : "Incolla un referto.";
    fileStatus.textContent = "";
    fileInput.value = "";
    textarea.focus();
  });

  shadow.getElementById("close").addEventListener("click", hidePanel);
  // ============================================================
  // DRAG PANNELLO + PULSANTE MMG CHIUSO
  // Posizione ricordata localmente. Nessun dato clinico viene salvato.
  // ============================================================

  const header = shadow.getElementById("header");

  let dragging = false;
  let dragSource = null;
  let offsetX = 0;
  let offsetY = 0;
  let dragStartX = 0;
  let dragStartY = 0;
  let suppressLauncherClick = false;

  function clampHostPosition(left, top) {
    const rect = host.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - Math.max(40, rect.width));
    const maxTop = Math.max(0, window.innerHeight - Math.max(40, rect.height));

    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop)
    };
  }

  function applyHostPosition(left, top) {
    const p = clampHostPosition(left, top);
    host.style.right = "auto";
    host.style.left = `${p.left}px`;
    host.style.top = `${p.top}px`;
  }

  async function saveHostPosition() {
    const rect = host.getBoundingClientRect();
    try {
      await chrome.storage.local.set({
        segretarioMmgPosition: {
          left: Math.round(rect.left),
          top: Math.round(rect.top)
        }
      });
    } catch {}
  }

  async function restoreHostPosition() {
    try {
      const data = await chrome.storage.local.get("segretarioMmgPosition");
      const p = data?.segretarioMmgPosition;

      if (Number.isFinite(p?.left) && Number.isFinite(p?.top)) {
        applyHostPosition(p.left, p.top);
      }
    } catch {}
  }

  function beginDrag(event, source) {
    if (source === "header" && event.target.closest(".close")) return;
    if (event.button !== 0) return;

    dragging = true;
    dragSource = source;

    const rect = host.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    dragStartX = event.clientX;
    dragStartY = event.clientY;

    event.preventDefault();
  }

  header.addEventListener("mousedown", event => beginDrag(event, "header"));
  launcher.addEventListener("mousedown", event => beginDrag(event, "launcher"));

  window.addEventListener("mousemove", event => {
    if (!dragging) return;

    applyHostPosition(
      event.clientX - offsetX,
      event.clientY - offsetY
    );

    if (
      dragSource === "launcher" &&
      Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY) > 4
    ) {
      suppressLauncherClick = true;
    }
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    dragSource = null;
    saveHostPosition();
  });

  // Sostituisce il click semplice precedente: un vero click apre,
  // un trascinamento sposta soltanto il pulsante.
  launcher.addEventListener("click", event => {
    if (suppressLauncherClick) {
      suppressLauncherClick = false;
      event.preventDefault();
      return;
    }

    showPanel();
  });

  window.addEventListener("resize", () => {
    const rect = host.getBoundingClientRect();
    applyHostPosition(rect.left, rect.top);
  });

  renderWorkflowMode();
  restoreHostPosition();

  // API di debug locale (nessun dato inviato fuori dal browser/Ollama).
  window.SegretarioMMG = {
    version: "0.15.31",
    getAvailableExams,
    resolveExamName,
    getExamConcept,
    readExamRow,
    sameNumericValue,
    sameDateValue,
    extractFromReport,
    detectKnownLabLayout,
    extractGridFirstResiduals,
    extractGridFirstResidualsBound,
    buildTargetedReportContext,
    residualResolverTargetRows,
    runAutoWorkflow,
    extractTextFromPdfFile,
    extractTextFromImageFile,
    paddleOcrHealth,
    extensionContextIsValid,
    convertMeasurement,
    setExamDate,
    setExamResultVediReferto,
    openLongReportPopup,
    writeLongReportText,
    setLongReportRecord,
    setLongReportRecords,
    setExamRecord,
    setExamRecords,
    ensureLabCatalog,
    matchCatalogForCreation,
    buildUnprescribedDecisionContext,
    preferredSerologyCatalogEntry,
    prepareUnprescribedNumericCandidate,
    extractUnprescribedFromReport,
    getNonPrescribedForm,
    getNonPrescribedRows,
    writeNonPrescribedItem,
    selectWorkflowMode,
    show: showPanel,
    hide: hidePanel,
    toggle: togglePanel,
    getValidated() {
      return validated.map(x => ({ ...x }));
    },
    destroy() {
      destroyPaddleSandbox();
      host.remove();
      delete window.SegretarioMMG;
    }
  };

  aiModelInitialization = refreshAiModels();
  refreshExtensionUpdate();
  // Precarica il catalogo locale in background; l'analisi lo attende comunque.
  ensureLabCatalog();

  log(
    `Avviato. Esami disponibili: ${getAvailableExams().length}. ` +
    "Salvataggio finale manuale."
  );
})();
