# Segretario MMG – Architecture

This document describes how Segretario MMG is built: the Chrome extension that runs inside Eumed, the local AI and OCR engines it uses, and the Windows installer/updater that deploys it. For build and test commands see [SVILUPPO.md](SVILUPPO.md).

## 1. System context

Segretario MMG is a Chrome Manifest V3 extension injected into `https://medici.eumedweb.com/*`. It reads lab reports or exam lists (pasted text, PDF, JPEG, PNG), interprets them deterministically or with a local LLM, matches the exams against a bundled lab catalog and fills the Eumed (Vaadin) forms row by row. The final save in Eumed is always left to the doctor.

All AI inference runs on the local machine through Ollama on `127.0.0.1:11434`. Cloud models are filtered out. The only Internet endpoint used by the extension is the public GitHub Releases API, for the update check, and it never receives patient data.

```mermaid
flowchart LR
    Doctor(["Doctor"])

    subgraph PC["Windows PC"]
        subgraph Chrome["Google Chrome"]
            Eumed["Eumed web app<br/>medici.eumedweb.com"]
            Ext["Segretario MMG extension<br/>C:\AI\segretario-mmg-extension"]
        end
        Ollama["Ollama server<br/>127.0.0.1:11434<br/>local models only"]
        Tasks["Scheduled tasks<br/>SegretarioMMG-Startup<br/>SegretarioMMG-Update"]
        State["%LOCALAPPDATA%\SegretarioMMG<br/>logs, backups, install record"]
    end

    GitHub["GitHub<br/>1702micky/segretariommg<br/>Releases API + assets"]
    OllamaCom["ollama.com<br/>Ollama installer + models"]

    Doctor -- "uses MMG panel" --> Ext
    Doctor -- "final manual save" --> Eumed
    Ext -- "reads/writes DOM" --> Eumed
    Ext -- "HTTP /api/chat, /api/tags, /api/show" --> Ollama
    Ext -- "latest release check only" --> GitHub
    Tasks -- "start ollama serve" --> Ollama
    Tasks -- "download update zip<br/>when Chrome is closed" --> GitHub
    Tasks --> State
    Ollama -. "model pull at setup" .-> OllamaCom
```

## 2. Extension components

The extension has three runtime contexts, isolated by Chrome:

- **Content script** – [segretario.js](../segretario.js). Runs inside the Eumed page. It contains the whole application: UI panel (in a Shadow DOM), parsing, catalog matching, unit conversion, prompts, Vaadin automation and diagnostics. It cannot call Ollama directly, so AI requests are proxied through the service worker.
- **Service worker** – [background.js](../background.js). Holds the extension host permissions. It streams chat requests to Ollama, lists and inspects local models, checks GitHub for updates and toggles the panel when the toolbar icon is clicked.
- **OCR sandbox** – [paddle_sandbox.html](../paddle_sandbox.html) + [paddle_sandbox.js](../paddle_sandbox.js). A sandboxed extension page, loaded as a hidden iframe in the panel Shadow DOM. Its CSP allows `wasm-unsafe-eval`, which PaddleOCR (ONNX Runtime WASM) needs and which the Eumed page context does not allow.

Static resources are exposed through `web_accessible_resources` in [manifest.json](../manifest.json): `lab_catalog.json`, `installation-defaults.json`, PDF.js (`vendor/pdf.mjs`, `vendor/pdf.worker.mjs`) and the PaddleOCR bundle, models and WASM files under `vendor/paddleocr/`.

```mermaid
flowchart TB
    subgraph Page["Eumed tab"]
        DOM["Eumed Vaadin DOM<br/>grids, combo boxes, date pickers,<br/>Vedi referto popup"]
        subgraph CS["Content script: segretario.js"]
            UI["Panel UI in Shadow DOM<br/>MMG button, mode picker,<br/>model selector, update status"]
            Input["Input acquisition<br/>paste, PDF, image"]
            Parse["Deterministic parsers<br/>lab-specific layouts,<br/>simple numeric lines"]
            AI["AI client<br/>ollamaChatOnce, prompts,<br/>schemas, adaptive split"]
            Catalog["Catalog + concepts<br/>matchCatalog, resolveExamName,<br/>getExamConcept, convertMeasurement"]
            Writer["Vaadin writers<br/>setExamRecords, setLongReportRecords,<br/>writePrescriptionListItems"]
            Diag["Diagnostics<br/>recordDiagnosticEvent,<br/>createDiagnosticReport"]
        end
        subgraph SB["Sandbox iframe: paddle_sandbox.html"]
            Paddle["PaddleOCR PP-OCRv6 tiny<br/>ONNX Runtime WASM"]
        end
        PDFJS["PDF.js<br/>vendor/pdf.mjs"]
    end

    subgraph SW["Service worker: background.js"]
        Stream["ollamaStreamChat<br/>NDJSON streaming, think:false,<br/>6 min timeout, keep-alive"]
        Models["listLocalOllamaModels<br/>getLocalOllamaModelInfo<br/>cloud model filter"]
        Upd["getExtensionUpdateStatus<br/>GitHub latest release"]
    end

    Res[("Bundled resources<br/>lab_catalog.json<br/>installation-defaults.json")]
    Store[("chrome.storage.local<br/>segretarioMmgAiModel<br/>segretarioMmgPosition<br/>segretarioMmgLatestRelease")]
    Ollama["Ollama 127.0.0.1:11434"]
    GH["api.github.com"]

    UI --> Input
    Input --> PDFJS
    Input -- "MessagePort" --> Paddle
    Input --> Parse
    Parse --> Catalog
    Parse -- "residual / fallback" --> AI
    AI --> Catalog
    Catalog --> Writer
    Writer --> DOM
    Writer -- "reads rows, duplicates" --> DOM
    UI --> Diag
    Catalog --> Res
    UI --> Store

    AI -- "Port segretario-mmg-ollama" --> Stream
    UI -- "sendMessage" --> Models
    UI -- "sendMessage" --> Upd
    Stream --> Ollama
    Models --> Ollama
    Upd --> GH
    Upd --> Store
```

### Main content-script areas

| Area | Responsibility | Key functions |
|---|---|---|
| Configuration | Constants, preferred units, PDF/OCR limits | `CONFIG` |
| Exam concepts | Maps lab wording to canonical concepts and long-report kinds | `getExamConcept`, `getLongReportKind` |
| Eumed grid reader | Indexes existing grid rows and finds empty prescribed rows | `scanAllEumedRows`, `getEmptyEumedExams` |
| Lab catalog | Loads `lab_catalog.json`, ranks candidates by name, alias and specimen | `matchCatalog`, `resolveExamName` |
| Numeric writer | Writes date, value, min, max and re-reads each cell | `setExamRecords`, `setExamRecord`, `setExamField` |
| Long-report writer | Opens "Vedi referto", writes text, closes and verifies | `setLongReportRecords`, `writeLongReportText` |
| Unit conversion | Deterministic conversion of values and ranges | `convertMeasurement`, `convertRange` |
| AI client | Chunking, prompts, JSON schemas, port calls | `splitTextAdaptive`, `ollamaChatOnce`, `extractReportChunk` |
| Deterministic parsers | Lab-specific layouts and simple "name value unit" lines | `extractSimpleNumericReport`, `extractPaddleTabularResults` |
| OCR pipeline | PDF text layer, page rendering, PaddleOCR or vision-model OCR | `extractTextFromPdfFile`, `extractTextFromImageFile`, `createPaddleSandboxClient` |
| Workflows | One analyze/compile pair per mode | `analyzeReport`/`compileValidated`, `analyzeUnprescribedReport`/`compileUnprescribedValidated`, `analyzePrescriptionList`/`compilePrescriptionList` |
| Diagnostics | Content-free event log and downloadable `.txt` report | `recordDiagnosticEvent`, `createDiagnosticReport` |

## 3. Workflow modes

The panel offers three modes (`WORKFLOW_MODE`). Each mode has an **analyze** step that produces a preview for the doctor, and a **compile** step that writes to Eumed only after the doctor confirms.

```mermaid
flowchart TD
    Start(["Doctor opens MMG panel"]) --> Mode{"Choose mode"}

    Mode -- "Referto già prescritto" --> P1["Scan Eumed grid<br/>scanAllEumedRows, getEmptyEumedExams"]
    P1 --> P2["Deterministic parse<br/>of the report"]
    P2 --> P3["AI on residual exams only<br/>runResidualQwenAnalysis"]
    P3 --> P4["Match to existing empty rows<br/>resolveExamName"]
    P4 --> Prev

    Mode -- "Referto non prescritto" --> U1["Known long-report layouts<br/>and simple numeric lines"]
    U1 --> U2["AI fallback<br/>extractUnprescribedWithQwen"]
    U2 --> U3["Catalog match + unit conversion<br/>numeric and complex items"]
    U3 --> Prev

    Mode -- "Prescrivi esami da lista" --> L1{"Input type"}
    L1 -- "text" --> L2["extractPrescriptionListWithQwenText"]
    L1 -- "photo / PDF" --> L3["extractPrescriptionListWithQwenVision<br/>reads X and check marks"]
    L2 --> L4["Catalog match<br/>uncertain items flagged"]
    L3 --> L4
    L4 --> Prev

    Prev["Preview with flagged items<br/>doctor reviews"] --> Confirm{"Doctor confirms?"}
    Confirm -- "no" --> Stop(["Nothing written"])
    Confirm -- "yes" --> W{"Mode"}

    W -- "già prescritto" --> WP["compileValidated<br/>fill values, then dates,<br/>then long reports"]
    W -- "non prescritto" --> WU["compileUnprescribedValidated<br/>select exam in catalog combo,<br/>create row, fill fields"]
    W -- "da lista" --> WL["compilePrescriptionList<br/>check Accertamenti page,<br/>today's duplicates, add rows"]

    WP --> Verify["Re-read each written cell"]
    WU --> Verify
    WL --> Verify
    Verify --> Done(["Doctor checks and saves in Eumed"])
```

Notes on the modes:

- **Referto già prescritto** fills only rows already present in "Inserimento da prescrizioni". Exams recognised with certainty but without a row are offered as a copyable block for the "non prescritto" mode, which re-validates it without AI.
- **Referto non prescritto** can skip AI entirely when every line is a simple, unambiguous "name value unit" line. Urine, 24-hour collections and composite reports (e.g. blood count) are written as long reports.
- **Prescrivi esami da lista** treats a row as a duplicate only when its "Data presc." is today. Unreadable dates require explicit confirmation.

## 4. Input and OCR pipeline

PDF files are read with PDF.js first. Pages with less than `CONFIG.pdfTextPageMinChars` useful characters are treated as scans and rendered to images (max `CONFIG.pdfVisionMaxPages`). Scanned pages and image files go to PaddleOCR by default, or to the selected vision model when the doctor chooses AI reading.

```mermaid
flowchart LR
    In{"Input"} -- "pasted text" --> Text["Source text"]
    In -- "PDF" --> PDF["PDF.js<br/>getTextContent per page"]
    In -- "JPEG / PNG" --> Img["Image to base64"]

    PDF --> Check{"Enough text<br/>on page?"}
    Check -- "yes" --> Text
    Check -- "no: scanned page" --> Render["Render page to image"]
    Render --> Engine
    Img --> Engine{"OCR engine"}

    Engine -- "fast reading (default)" --> Paddle["PaddleOCR in sandbox<br/>PP-OCRv6 tiny, WASM"]
    Engine -- "AI reading" --> Vision["Ollama vision model<br/>OCR JSON schema"]
    Paddle --> Layout["Rebuild rows and columns<br/>paddleItemsToLayoutText"]
    Layout --> Text
    Vision --> Text
    Text --> Analyze["Mode-specific analysis"]
```

The sandbox handshake uses a dedicated `MessageChannel`, because the sandbox has an opaque origin:

```mermaid
sequenceDiagram
    participant CS as Content script
    participant IF as Sandbox iframe
    participant OCR as PaddleOCR bundle

    CS->>IF: create hidden iframe in Shadow DOM
    CS->>IF: postMessage SEGRETARIO_PADDLE_CONNECT + port2, model and WASM URLs
    IF->>IF: check event.source is parent
    CS->>IF: INIT via port
    IF->>OCR: createSegretarioPaddleOCR(options)
    IF-->>CS: READY
    CS->>IF: PREDICT bytes, mime, options (ArrayBuffer transferred)
    IF->>OCR: predict(blob)
    IF-->>CS: RESULT items text/score/poly, metrics
    Note over CS,IF: Errors return ERROR with message, PING is used for health checks
```

## 5. AI request path

The content script opens a long-lived `chrome.runtime` Port named `segretario-mmg-ollama` for each request. The service worker validates the model, then streams the Ollama NDJSON response and forwards progress. Closing the port aborts the request.

```mermaid
sequenceDiagram
    participant CS as Content script
    participant SW as Service worker
    participant OL as Ollama

    CS->>SW: connect Port "segretario-mmg-ollama"
    CS->>SW: OLLAMA_CHAT requestId, model, messages, format, num_predict
    SW->>OL: POST /api/show (cached 30 s)
    alt cloud model, no completion, or images without vision
        SW-->>CS: OLLAMA_ERROR
    else valid local model
        SW->>OL: POST /api/chat stream:true, think:false, temperature 0
        loop NDJSON chunks
            OL-->>SW: message.content piece
            SW-->>CS: OLLAMA_PROGRESS chunksSeen, chars (max every 900 ms)
        end
        SW-->>CS: OLLAMA_RESULT content, stats
    end
    Note over SW: 20 s keep-alive while streaming, abort after 6 min
    CS--xSW: port disconnect aborts pending requests
```

Model metadata and update status use one-shot `chrome.runtime.sendMessage` calls:

| Message | Sender → receiver | Purpose |
|---|---|---|
| `OLLAMA_LIST_MODELS` | content script → service worker | Local models from `/api/tags`, cloud models removed |
| `OLLAMA_MODEL_INFO` | content script → service worker | `completion` and `vision` capabilities from `/api/show` |
| `SEGRETARIO_CHECK_UPDATE` | content script → service worker | Compare manifest version with the latest stable GitHub release |
| `SEGRETARIO_MMG_TOGGLE` | service worker → content script | Toolbar icon click opens or closes the panel |

The service worker accepts these messages only from its own extension id (`sender.id === chrome.runtime.id`).

## 6. Data and configuration

| Item | Location | Notes |
|---|---|---|
| Lab catalog | [lab_catalog.json](../lab_catalog.json) | Eumed exam names, codes, aliases, specimens. Maintained with [tools/reconcile_lab_catalog.py](../tools/reconcile_lab_catalog.py) from a regional workbook (read only). |
| Default model | `installation-defaults.json` | Written by the setup with the model chosen at install time. |
| User preferences | `chrome.storage.local` | Selected model, panel position, cached release status. |
| Extension identity | `manifest.key` | Fixes the extension id, used for `OLLAMA_ORIGINS`. Must not change. |
| Install state | `%LOCALAPPDATA%\SegretarioMMG` | `setup.log`, `update.log`, `installation.json`, backups, previous Ollama environment. |

Patient data is held only in page memory during a session. Diagnostics record timings, counts and states, not report content.

## 7. Build, release and deployment

A push to `main` runs [.github/workflows/release.yml](../.github/workflows/release.yml) on Windows. It runs the tests, downloads PDF.js and PaddleOCR, builds the installer with [tools/build_installer.py](../tools/build_installer.py) and creates release `v<manifest.version>` if it does not exist yet.

```mermaid
flowchart LR
    Push(["push to main"]) --> Tests["Tests<br/>node --check, node --test,<br/>PowerShell and Python installer tests"]
    Tests --> Vendor["Fetch runtimes<br/>PDF.js, PaddleOCR bundle,<br/>models, WASM"]
    Vendor --> Build["build_installer.py"]

    subgraph Build_out["Build outputs"]
        Inv["inventory.json<br/>path + SHA-256 per file"]
        Zip["segretario-mmg-update.zip"]
        Pkg["installer-package.zip<br/>payload + Setup.ps1 + runtime/"]
        Exe["SegretarioMMG-Setup-x.y.z.exe<br/>Launcher.cs compiled with csc,<br/>package embedded as resource"]
    end

    Build --> Inv --> Zip --> Pkg --> Exe
    Exe --> Rel["GitHub release vX.Y.Z<br/>setup exe, update zip,<br/>.sha256, LEGGIMI-INSTALLER.md"]
    Zip --> Rel
```

### Installation

The setup EXE is a small WinForms launcher ([installer/Launcher.cs](../installer/Launcher.cs)) that extracts the embedded package and runs [installer/Setup.ps1](../installer/Setup.ps1) elevated, showing progress from a JSON file the script updates.

```mermaid
flowchart TD
    A["Launcher.exe<br/>extract package, show progress"] --> B["Setup.ps1<br/>admin + same user + 64-bit checks"]
    B --> C["Close user's Chrome<br/>choose model by RAM"]
    C --> D["1/7 Verify payload hashes,<br/>backup, copy to C:\AI\segretario-mmg-extension"]
    D --> E["2-3/7 Download Ollama,<br/>verify Authenticode signature, silent install"]
    E --> F["4/7 Compute extension id from manifest.key,<br/>set OLLAMA_ORIGINS and OLLAMA_HOST,<br/>start ollama serve"]
    F --> G["5/7 Pull model<br/>qwen3.5:4b or qwen3-vl:2b, optional"]
    G --> H["6/7 Verify: vision capability,<br/>test chat with think:false,<br/>origin check, PaddleOCR, PDF.js"]
    H --> I["7/7 Scheduled tasks, desktop updater link,<br/>uninstall entry, installation.json"]
    I --> J(["Doctor loads unpacked extension<br/>in chrome://extensions"])
```

### Automatic updates

Two update paths exist and complement each other:

- **In the panel**: the service worker checks the latest GitHub release and offers the setup EXE download. Downloading does not install anything.
- **Scheduled task**: [installer/runtime/Update.ps1](../installer/runtime/Update.ps1) runs at logon (via `Startup.ps1`, which also starts Ollama) and every hour. It replaces extension files only while Chrome is fully closed.

```mermaid
flowchart TD
    T(["Logon or hourly task"]) --> M{"Mutex free and<br/>repository configured?"}
    M -- "no" --> X(["Exit"])
    M -- "yes" --> R["GitHub releases/latest"]
    R --> N{"Newer stable version<br/>with update zip + sha256 digest?"}
    N -- "no" --> X
    N -- "yes" --> C1{"Chrome running?"}
    C1 -- "yes" --> Defer(["Postpone"])
    C1 -- "no" --> DL["Download zip from github.com<br/>repository path only"]
    DL --> V["Verify zip digest, safe paths,<br/>file allowlist, per-file SHA-256,<br/>same manifest.key and version"]
    V --> B["Backup current files"]
    B --> Copy["Copy files, re-check Chrome<br/>before each file"]
    Copy -- "error or Chrome started" --> Rollback["Restore backup"]
    Copy -- "ok" --> Rec["Update installation.json"]
```

Uninstall ([installer/runtime/Uninstall.ps1](../installer/runtime/Uninstall.ps1)) removes only files listed in `installation.json`, the scheduled tasks and shortcuts, and restores the previous Ollama environment variables. Ollama and models stay installed.

## 8. Safety and privacy design

- **Local-only AI**: requests go to `127.0.0.1:11434`. Models with `:cloud`, `-cloud`, `remote_host` or `remote_model` are rejected.
- **Deterministic first**: parsers and catalog rules run before AI. AI output is checked against the source text and the catalog; uncertain items are flagged, not written.
- **`think: false`, `temperature: 0`** on every chat request.
- **Human in the loop**: nothing is written before the preview is confirmed. Global save and prescription submission are never pressed.
- **Write verification**: each Vaadin cell is re-read after writing.
- **Duplicate guard** in list prescription: based on today's "Data presc." only.
- **Narrow permissions**: `storage`, host access only to local Ollama and the GitHub API, content script only on Eumed.
- **Update integrity**: GitHub digest, per-file hashes, path allowlist, unchanged `manifest.key`, backup and rollback.
- **No patient data in diagnostics, logs, update checks or the repository.**
