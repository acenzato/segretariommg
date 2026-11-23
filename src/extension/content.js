// Content script Eumed: interfaccia, automazione Vaadin, file locali e collegamento a Ollama.
"use strict";

const {
  CONFIG,
  formatDateForGrid,
  getExamConcept,
  getLongReportKind,
  isExtensionContextInvalidatedError,
  log,
  longReportKindLabel,
  normalizeDateValue,
  normalizeExamName,
  normalizeValueString,
  sameNumericValue,
  sleep,
} = require("../engine/core");
const {
  ensureLabCatalog,
  matchCatalog,
  resolveExamName,
  significantTokens,
} = require("../engine/catalog");
const {
  convertMeasurement,
  normalizeLongReportText,
} = require("../engine/long-report");
const {
  buildTargetedReportContext,
  cleanModelLabLabel,
  detectKnownLabLayout,
  extractFromReport,
  extractGridFirstResiduals,
  extractGridFirstResidualsBound,
  extractJSONObject,
  getKnownLayoutDisplayName,
  ollamaChat,
  residualResolverTargetRows,
} = require("../engine/extraction");
const {
  textContentToLines,
} = require("../engine/pdf-text");
const {
  buildPrescribedTransferText,
  buildUnprescribedDecisionContext,
  extractUnprescribedFromReport,
  matchCatalogForCreation,
  preferredPrescriptionCatalogEntry,
  preferredSerologyCatalogEntry,
  prepareUnprescribedNumericCandidate,
  sanitizeCreationCatalogAlias,
} = require("../engine/unprescribed");
const {
  buildCompositeExamDetails,
  buildEumedAudit,
  buildStrongParserWriteSet,
  filterPostQwenWriteSet,
  prepareResidualQwenPlan,
  runResidualQwenAnalysis,
  runResidualQwenFromPlan,
} = require("../engine/workflow");

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
