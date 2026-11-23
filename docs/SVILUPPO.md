# Sviluppo e distribuzione

La pagina iniziale è dedicata a chi usa il programma. Qui sono raccolti i riferimenti per chi lo mantiene.

## Struttura del codice

`segretario.js` è un file **generato e non versionato**: le sorgenti sono in `src/`. Per caricare l’estensione non pacchettizzata dalla cartella del repository eseguire prima `npm run build`; `npm test` e `tools/build_installer.py` lo rigenerano automaticamente.

| Cartella | Contenuto | Ambiente |
|---|---|---|
| `src/engine/` | Motore di analisi dei referti: parser deterministici, catalogo, referti lunghi, IA residua, workflow prescritto e non prescritto. | Qualsiasi (niente DOM, Chrome o Node) |
| `src/extension/content.js` | Interfaccia, Grid Eumed (Vaadin), lettura PDF/OCR nel browser, porta Ollama del service worker. | Content script Chrome |
| `src/standalone/` | Client Ollama HTTP, lettura PDF testuali, validazione e punteggio del dataset. | Node |

Il motore comunica con l’ambiente solo tramite i punti di contatto in `src/engine/host.js` (`getAvailableExams`, `ollamaChatOnce`, `recordDiagnosticEvent`, `loadLabCatalogData`). Nell’estensione sono le funzioni omonime di `content.js`; in Node si impostano con `configureHost()`. Il lint (`npm run lint`) segnala l’uso di API del browser o di Node in `src/engine`.

```powershell
npm ci
npm run build          # genera segretario.js da src/
npm run lint
```

## Valutazione senza browser

`tools/eval.mjs` esegue il workflow prescritto su un dataset nel formato di [dataset_format.md](../dataset_format.md), senza Chrome, browser o Eumed: per ogni caso scrive `runs/<run_id>/prediction.json` e `score.json` e stampa le metriche aggregate.

```powershell
npm run eval -- D:\dataset-referti --run-id 2026-11-23_v0.16.29_qwen3.5-4b
npm run eval -- tests\fixtures\dataset --run-id prova --deterministic-only
```

Per analizzare un singolo PDF senza ground truth basta indicare gli esami prescritti; il risultato (formato di `prediction.json`) va su stdout o nel file `--out`:

```powershell
npm run eval -- --pdf D:\referto.pdf --targets "GLUCOSIO,TSH,EMOCROMO"
npm run eval -- --pdf D:\referto.pdf --targets "GLUCOSIO" --out D:\esito\prediction.json --raw
```

`not_in_eumed` elenca gli esami riconosciuti nel referto ma non tra quelli indicati.

- Ollama deve essere locale (`127.0.0.1`); `--deterministic-only` esegue solo il parser, senza IA.
- Sono supportati solo PDF testuali: per pagine scansionate e immagini il caso termina con `run.error`.
- In Eumed la Grid contiene anche righe già compilate, mentre in modalità standalone gli esami disponibili sono solo `eumed_targets`: `not_in_eumed` può quindi differire da quanto mostrato nell’estensione.
- I dataset reali vanno tenuti fuori dal repository. `--raw` salva testo e risultati intermedi in `runs/<run_id>/raw/`: contengono dati del referto.
- L’unico caso nel repository è sintetico; `npm run fixtures` rigenera il suo `source.pdf`.

## Test

```powershell
npm test
node --check segretario.js
node --check background.js
```

## Installer e release

Il workflow `.github/workflows/release.yml` prepara PDF.js e PaddleOCR, esegue i test, compila l’installer su Windows e pubblica gli asset della versione indicata in `manifest.json`. Non sovrascrive release esistenti.

Per una nuova versione incrementare `manifest.version` e mantenere `manifest.key`, necessario per preservare l’identità dell’estensione e la configurazione delle origini Ollama.

Build locale su Windows, con i runtime già presenti in `vendor`:

```powershell
python tools/build_installer.py
```

L’installer è una build pilota non firmata. I controlli automatici non sostituiscono il collaudo completo su Windows pulito. Consultare la [guida di installazione e collaudo](../installer/LEGGIMI-INSTALLER.md).

## Dati e file esclusi

Non caricare referti, dati dei pazienti, log clinici, copie di lavoro o backup. Usare fixture sintetiche per i test. `vendor`, `work` e `outputs` sono esclusi dal repository; gli eseguibili si distribuiscono nelle release.

## Immagini della pagina iniziale

Le immagini SVG sono illustrazioni dell’interfaccia, dichiarate come tali. Non rappresentano schermate di Eumed con dati reali. I testi vanno mantenuti coerenti con quelli dell’estensione.
