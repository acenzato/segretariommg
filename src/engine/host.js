// Punti di contatto tra il motore di analisi e l'ambiente che lo ospita.
//
// Nell'estensione Chrome questo file NON viene incluso: le funzioni omonime
// sono definite in src/extension/content.js (Grid Eumed, porta Ollama del
// service worker, diagnostica, catalogo da chrome-extension://).
// In Node l'ambiente le fornisce con configureHost().
"use strict";

const defaults = {
  getAvailableExams: () => [],
  ollamaChatOnce: async () => {
    throw new Error("Nessun client Ollama configurato (configureHost({ ollamaChatOnce })).");
  },
  recordDiagnosticEvent: () => {},
  loadLabCatalogData: async () => {
    throw new Error("Nessun catalogo configurato (configureHost({ loadLabCatalogData })).");
  },
};

let hooks = { ...defaults };

function configureHost(overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in defaults)) throw new Error(`Hook sconosciuto: ${key}`);
  }
  hooks = { ...hooks, ...overrides };
}

function resetHost() {
  hooks = { ...defaults };
}

// Esami (righe Grid Eumed) disponibili come destinazione dei risultati.
function getAvailableExams() {
  return hooks.getAvailableExams();
}

// Una richiesta /api/chat a Ollama: (messages, onProgress, numPredict,
// formatSchema) -> testo completo della risposta.
function ollamaChatOnce(...args) {
  return hooks.ollamaChatOnce(...args);
}

function recordDiagnosticEvent(...args) {
  return hooks.recordDiagnosticEvent(...args);
}

// Contenuto di lab_catalog.json ({ entries: [...] }).
function loadLabCatalogData() {
  return hooks.loadLabCatalogData();
}

module.exports = {
  configureHost,
  resetHost,
  getAvailableExams,
  ollamaChatOnce,
  recordDiagnosticEvent,
  loadLabCatalogData,
};
