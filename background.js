// Segretario MMG - background.js
// Versione 0.16.29
// Parla direttamente con Ollama locale via streaming NDJSON.

const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const REQUEST_TIMEOUT_MS = 6 * 60 * 1000; // 6 minuti per blocco/pagina
const modelInfoCache = new Map();
const modelProbeCache = new Map();

async function verifyLocalModel(name) {
  const info = await getLocalOllamaModelInfo(name);
  if (info.thinkingOnly || info.completion === false) return info;
  const key = JSON.stringify(info);
  if (Date.now() - (modelProbeCache.get(key) || 0) < 30 * 60 * 1000) return info;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('probe_timeout'), 60000);
  let result;
  try {
    await ollamaStreamChat({model:name,messages:[{role:'user',content:'Restituisci esattamente {"ok":true}.'}],num_predict:128,
      format:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}},
      {postMessage:message=>{if(message.type !== 'OLLAMA_PROGRESS') result=message;}},'compatibility',controller);
    if (result?.type !== 'OLLAMA_RESULT') throw new Error(result?.message || 'Verifica del modello non completata.');
    let parsed;
    try { parsed = JSON.parse(result.content); } catch {}
    if (parsed?.ok !== true || Object.keys(parsed).length !== 1) throw new Error('Il modello non supera la verifica JSON senza ragionamento. Scegli un altro modello.');
    modelProbeCache.set(key, Date.now());
    return info;
  } finally { clearTimeout(timer); }
}

function isRemoteOllamaModel(model) {
  return Boolean(model?.remote_host || model?.remote_model || /(?::cloud$|-cloud(?::|$))/i.test(model?.name || ""));
}

async function ollamaMetadata(path, body) {
  const response = await fetch(`http://127.0.0.1:11434/api/${path}`, {
    method: body ? "POST" : "GET",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Ollama: richiesta non riuscita (HTTP ${response.status}).`);
  return response.json();
}

async function listLocalOllamaModels() {
  const data = await ollamaMetadata("tags");
  if (!Array.isArray(data.models)) throw new Error("Elenco modelli non valido ricevuto da Ollama.");
  const unique = new Map();
  for (const model of data.models) {
    if (typeof model?.name !== "string" || !model.name.trim() || isRemoteOllamaModel(model)) continue;
    unique.set(model.name, { name: model.name, size: Number(model.size) || 0 });
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function getLocalOllamaModelInfo(name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("Seleziona un modello IA.");
  const cached = modelInfoCache.get(name);
  if (cached && Date.now() - cached.at < 30000) return cached.info;
  const data = await ollamaMetadata("show", { model: name });
  if (isRemoteOllamaModel({ ...data, name })) throw new Error("Scegli un modello installato sul computer: i modelli cloud non sono utilizzati.");
  const capabilities = Array.isArray(data.capabilities) ? data.capabilities : null;
  const metadata = `${data.template || ''} ${data.model_info?.['general.name'] || ''} ${data.parameters || ''}`;
  const thinkingOnly = /gpt-oss/i.test(`${name} ${metadata}`) ||
    (/qwen3.?vl/i.test(`${name} ${metadata}`) && /thinking/i.test(metadata) && !/instruct/i.test(metadata));
  const info = {
    name,
    signature: JSON.stringify([data.modified_at,data.details,data.model_info,data.template,data.parameters]),
    thinkingOnly,
    variant: thinkingOnly ? 'Thinking (non compatibile)' : /instruct/i.test(`${name} ${metadata}`) ? 'Instruct' : 'Standard',
    completion: capabilities ? capabilities.includes("completion") : null,
    vision: capabilities ? capabilities.includes("vision") : null
  };
  modelInfoCache.set(name, { at: Date.now(), info });
  return info;
}

function compareExtensionVersions(left, right) {
  const parse = value => {
    if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value || "")) throw new Error("Versione non valida.");
    return value.split(".").map(Number);
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 4; i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

async function getExtensionUpdateStatus(force = false) {
  const key = "segretarioMmgLatestRelease";
  const current = chrome.runtime.getManifest().version;
  const now = Date.now();
  let release = null;
  try {
    const saved = (await chrome.storage.local.get(key))[key];
    const age = now - saved?.checkedAt;
    if (!force && saved && typeof saved.setupAvailable === "boolean" && age >= 0 &&
        age < (saved.setupAvailable ? 15 * 60 * 1000 : 30000)) {
      compareExtensionVersions(saved.version, current);
      release = saved;
    }
  } catch {}
  if (!release) {
    // Fixed public endpoint: never send patient data, page URLs or credentials.
    const response = await fetch("https://api.github.com/repos/1702micky/segretariommg/releases/latest", {
      method: "GET", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
      cache: "no-store", headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("Verifica GitHub non disponibile. Riprova piu tardi.");
    const data = await response.json();
    const version = String(data.tag_name || "").replace(/^v/, "");
    compareExtensionVersions(version, current);
    if (data.draft || data.prerelease || data.tag_name !== "v" + version) throw new Error("Release stabile non disponibile.");
    release = { version, checkedAt: now, setupAvailable: Array.isArray(data.assets) && data.assets.some(
      asset => asset.name === `SegretarioMMG-Setup-${version}.exe` && Number(asset.size) > 0) };
    try { await chrome.storage.local.set({ [key]: release }); } catch {}
  }
  const comparison = compareExtensionVersions(current, release.version);
  const state = comparison > 0 ? "ahead" : comparison === 0 ? "current" : release.setupAvailable ? "available" : "pending";
  return { current, latest: release.version, checkedAt: release.checkedAt, state,
    downloadUrl: state === "available"
      ? `https://github.com/1702micky/segretariommg/releases/download/v${release.version}/SegretarioMMG-Setup-${release.version}.exe` : "" };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id === chrome.runtime.id && message?.type === "SEGRETARIO_CHECK_UPDATE") {
    getExtensionUpdateStatus(message.force === true)
      .then(update => respond({ ok: true, update }))
      .catch(() => respond({ ok: false, error: "Impossibile verificare gli aggiornamenti su GitHub. Controlla la connessione e riprova." }));
    return true;
  }
  if (sender.id !== chrome.runtime.id || !["OLLAMA_LIST_MODELS", "OLLAMA_MODEL_INFO"].includes(message?.type)) return;
  const task = message.type === "OLLAMA_LIST_MODELS"
    ? listLocalOllamaModels().then(models => ({ models }))
    : verifyLocalModel(message.model).then(info => ({ info }));
  task.then(result => respond({ ok: true, ...result })).catch(error => respond({
    ok: false,
    error: error?.name === "TypeError" || error?.name === "TimeoutError"
      ? "Ollama non risponde. Avvialo sul computer e premi Aggiorna elenco."
      : error?.message || "Impossibile leggere i modelli IA."
  }));
  return true;
});

// Un click sull'icona dell'estensione apre/chiude il pannello nella pagina.
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;

  chrome.tabs.sendMessage(
    tab.id,
    { type: "SEGRETARIO_MMG_TOGGLE" },
    () => void chrome.runtime.lastError
  );
});

function startKeepAlive() {
  // Chrome MV3 può sospendere i service worker inattivi.
  // Durante una generazione lunga richiamiamo periodicamente
  // una API dell'estensione; inoltre lo stream invia messaggi
  // sul Port mentre Ollama genera.
  return setInterval(() => {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20_000);
}

async function ollamaStreamChat(payload, port, requestId, controller) {
  const keepAliveTimer = startKeepAlive();
  const timeoutTimer = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);

  let response;
  let reader;

  try {
    const modelInfo = await getLocalOllamaModelInfo(payload.model || "qwen3.5:4b");
    if (modelInfo.thinkingOnly) throw new Error('Questo modello richiede ragionamento esteso. Scegli una variante Instruct compatibile con think: false.');
    if (modelInfo.completion === false) throw new Error("Il modello selezionato non supporta l’analisi del testo. Scegli un modello di conversazione.");
    if ((payload.messages || []).some(message => message.images?.length) && modelInfo.vision === false) {
      throw new Error("Il modello selezionato legge soltanto testo. Per foto e PDF analizzati come immagini scegli un modello che supporti le immagini.");
    }
    response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify((() => {
        const body = {
          model: payload.model || "qwen3.5:4b",
          messages: payload.messages || [],
          stream: true,
          think: false,
          keep_alive: payload.keep_alive || "30m",
          options: {
            temperature: 0,
            num_predict: payload.num_predict || 900,
            ...(payload.options || {})
          }
        };

        // Per l'estrazione dei laboratori v0.8.4 usiamo un protocollo
        // tabellare, non JSON. OCR e altre chiamate possono invece
        // continuare a richiedere structured output esplicitamente.
        if (payload.format !== undefined && payload.format !== null) {
          body.format = payload.format;
        }

        return body;
      })())
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Ollama HTTP ${response.status}: ${errorText || response.statusText}`
      );
    }

    if (!response.body) {
      throw new Error("Ollama non ha restituito uno stream leggibile.");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    let content = "";
    let lastProgressAt = 0;
    let chunksSeen = 0;
    let finalStats = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event?.error) {
          throw new Error(`Ollama stream error: ${event.error}`);
        }

        chunksSeen += 1;
        if (event?.message?.thinking?.trim()) throw new Error('Il modello ha attivato il ragionamento nonostante think: false. Analisi interrotta: scegli una variante Instruct compatibile.');

        const piece = event?.message?.content;
        if (typeof piece === "string") {
          content += piece;
        }

        if (event?.done) {
          finalStats = {
            total_duration: event.total_duration ?? null,
            load_duration: event.load_duration ?? null,
            prompt_eval_count: event.prompt_eval_count ?? null,
            eval_count: event.eval_count ?? null
          };
        }

        const now = Date.now();
        if (now - lastProgressAt >= 900) {
          lastProgressAt = now;
          try {
            port.postMessage({
              type: "OLLAMA_PROGRESS",
              requestId,
              chunksSeen,
              chars: content.length
            });
          } catch {}
        }
      }
    }

    // Eventuale ultima riga non terminata da newline.
    const tail = buffer.trim();
    if (tail) {
      let event = null;
      try { event = JSON.parse(tail); } catch {}

      if (event?.error) {
        throw new Error(`Ollama stream error: ${event.error}`);
      }

      const piece = event?.message?.content;
      if (event?.message?.thinking?.trim()) throw new Error('Il modello ha attivato il ragionamento nonostante think: false. Scegli una variante Instruct compatibile.');
      if (typeof piece === "string") content += piece;
      if (event?.done) {
        finalStats = {
          total_duration: event.total_duration ?? null,
          load_duration: event.load_duration ?? null,
          prompt_eval_count: event.prompt_eval_count ?? null,
          eval_count: event.eval_count ?? null
        };
      }
    }

    if (!content.trim()) {
      throw new Error("IA ha restituito una risposta vuota.");
    }

    port.postMessage({
      type: "OLLAMA_RESULT",
      requestId,
      content,
      stats: finalStats
    });

  } catch (error) {
    let message;

    if (controller.signal.aborted) {
      message =
        controller.signal.reason === "timeout"
          ? "Timeout locale: IA non ha completato questo blocco entro 6 minuti."
          : "Richiesta Ollama annullata.";
    } else if (error instanceof TypeError && /fetch/i.test(String(error))) {
      message =
        "Il motore IA sul computer non risponde. " +
        "Verifica che Ollama sia avviato e riprova.";
    } else {
      message = error?.message || String(error);
    }

    try {
      port.postMessage({
        type: "OLLAMA_ERROR",
        requestId,
        message
      });
    } catch {}

  } finally {
    clearInterval(keepAliveTimer);
    clearTimeout(timeoutTimer);
    try { await reader?.cancel(); } catch {}
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "segretario-mmg-ollama") return;

  const controllers = new Map();

  port.onMessage.addListener((message) => {
    if (message?.type !== "OLLAMA_CHAT" || !message.requestId) return;

    const controller = new AbortController();
    controllers.set(message.requestId, controller);

    ollamaStreamChat(
      message.payload || {},
      port,
      message.requestId,
      controller
    ).finally(() => {
      controllers.delete(message.requestId);
    });
  });

  port.onDisconnect.addListener(() => {
    for (const controller of controllers.values()) {
      try { controller.abort("port_disconnected"); } catch {}
    }
    controllers.clear();
  });
});
