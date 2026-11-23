// Referti lunghi (emocromo, urine, protidogramma, ...): riconoscimento e testo.
"use strict";

const {
  CONFIG,
  PREFERRED_UNITS,
  formatNumber,
  normalizeValueString,
  parseItalianNumber,
} = require("./core");

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

module.exports = {
  convertMeasurement,
  convertRange,
  normalizeLongReportText,
  normalizeUnit,
  prepareRangeInput,
  shouldSuppressAutomaticRange,
  splitReportText,
  unitsCompatible,
};
