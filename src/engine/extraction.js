// Parser deterministici dei referti, prompt/schema IA e validazione dei risultati.
"use strict";

const {
  getAvailableExams,
  ollamaChatOnce,
} = require("./host");
const {
  CONFIG,
  PREFERRED_UNITS,
  formatDateForGrid,
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
} = require("./core");
const {
  detectSpecimen,
  ensureLabCatalog,
  getFrequentExamPriorityHints,
  matchCatalog,
  resolveExamName,
  significantTokens,
} = require("./catalog");
const {
  convertMeasurement,
  convertRange,
  normalizeLongReportText,
  normalizeUnit,
  prepareRangeInput,
  shouldSuppressAutomaticRange,
  unitsCompatible,
} = require("./long-report");

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

module.exports = {
  aiLineHasMeasurement,
  buildPsaReflexLongReport,
  buildPsaReflexLongReportFromRawResults,
  buildReferenceIntervalPrompt,
  buildResidualAiText,
  buildTargetedReportContext,
  cleanModelLabLabel,
  cleanReportLines,
  collectStrongResolvedTargets,
  dedupeRecognizedNotInGrid,
  detectKnownLabLayout,
  extractAcrResult,
  extractAouPadovaResults,
  extractFromReport,
  extractGridFirstResiduals,
  extractGridFirstResidualsBound,
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
  residualResolverTargetRows,
  sourceSupportScoreForResult,
  stripKnownPageChrome,
  targetConceptTerms,
  unitCompatibleWithConcept,
  validateAiMeasurementEvidence,
  validatedAiReportDate,
  valuesClinicallyEquivalent,
};
