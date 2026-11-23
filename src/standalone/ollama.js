// Client Ollama per Node: stesse opzioni del service worker dell'estensione
// (background.js), ma con una chiamata HTTP diretta. Solo Ollama locale.
"use strict";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3.5:4b";
const REQUEST_TIMEOUT_MS = 6 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function assertLocalOllamaUrl(url) {
  const parsed = new URL(url);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Ollama deve essere locale (127.0.0.1/localhost): ${parsed.hostname} non è ammesso.`
    );
  }
  return parsed;
}

function thinkingError() {
  return new Error(
    "Il modello ha attivato il ragionamento nonostante think: false. " +
    "Scegli una variante Instruct compatibile."
  );
}

// Restituisce una funzione con la firma di ollamaChatOnce dell'estensione:
// (messages, onProgress, numPredict, formatSchema) -> testo della risposta.
function createOllamaChat({
  url = DEFAULT_OLLAMA_URL,
  model = DEFAULT_MODEL,
  keepAlive = "30m",
  timeoutMs = REQUEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = new URL("/api/chat", assertLocalOllamaUrl(url)).toString();

  return async function ollamaChatOnce(
    messages,
    onProgress = null,
    numPredict = 900,
    formatSchema = null
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    const body = {
      model,
      messages: messages || [],
      stream: true,
      think: false,
      keep_alive: keepAlive,
      options: {
        temperature: 0,
        num_predict: numPredict || 900,
      },
    };
    if (formatSchema !== undefined && formatSchema !== null) body.format = formatSchema;

    let content = "";
    let chunksSeen = 0;
    let lastProgressAt = 0;

    const handleLine = (line) => {
      line = line.trim();
      if (!line) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.error) throw new Error(`Ollama stream error: ${event.error}`);
      chunksSeen += 1;
      if (event?.message?.thinking?.trim()) throw thinkingError();
      if (typeof event?.message?.content === "string") content += event.message.content;
      const now = Date.now();
      if (onProgress && now - lastProgressAt >= 900) {
        lastProgressAt = now;
        onProgress({ type: "OLLAMA_PROGRESS", chunksSeen, chars: content.length });
      }
    };

    try {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new Error(
          `Ollama non risponde su ${endpoint}: verificare che sia avviato. (${error?.message || error})`
        );
      }
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Ollama HTTP ${response.status}: ${errorText || response.statusText}`);
      }
      if (!response.body) throw new Error("Ollama non ha restituito uno stream leggibile.");

      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        lines.forEach(handleLine);
      }
      handleLine(buffer + decoder.decode());

      if (!content.trim()) throw new Error("IA ha restituito una risposta vuota.");
      return content;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          controller.signal.reason === "timeout"
            ? `Timeout locale: IA non ha completato questo blocco entro ${Math.round(timeoutMs / 1000)} s.`
            : "Richiesta Ollama annullata."
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_URL,
  assertLocalOllamaUrl,
  createOllamaChat,
};
