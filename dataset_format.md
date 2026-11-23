# Dataset format: `gt.eumed.json`

Status: implemented for text PDFs by `tools/eval.mjs` (see `docs/SVILUPPO.md`); image and scanned-page OCR is not supported in standalone mode.

This document specifies the evaluation dataset for the report-to-Eumed
pipeline. Each case pairs one lab report with the values that should end up
in Eumed, so OCR, parser and LLM changes can be measured end to end without
the Chrome extension or Eumed.

Scope of this version:

- One ground-truth file per case: `gt.eumed.json`.
- Only the **prescribed** workflow (`runAutoWorkflow`) is scored.
- There is no OCR ground truth and no ground truth for intermediate steps.
  These may be added later as extra files next to `gt.eumed.json`.

## 1. Privacy rules

- Real reports, and annotations derived from them, contain patient data.
  They must **never** be committed to this repository. Keep them in a
  directory outside the repo and pass its path to the tooling.
- Only synthetic cases (`meta.synthetic: true`) may be committed, under
  `tests/fixtures/dataset/`.
- Tooling must not log full report text or values to shared outputs.

## 2. Directory layout

```
<dataset_root>/
  index.csv                         optional, see section 7
  cases/
    <case_id>/
      source.pdf                    or page-01.jpg, page-02.jpg, ... (exactly one source form)
      gt.eumed.json                 ground truth (this spec)
      runs/
        <run_id>/
          prediction.json           normalized pipeline output (section 5)
          score.json                scorer output (section 6)
          raw/                      optional free-form debug output (OCR text, LLM replies)
```

- `case_id` must match `^[a-z0-9][a-z0-9_-]{2,63}$`, for example `aoupd-0001`.
  It must not contain names, birth dates or other patient identifiers.
- Source files:
  - `source.pdf` covers both text PDFs and scanned PDFs.
  - `page-NN.(jpg|jpeg|png)` (two-digit, starting from `01`) is for photos or
    scans that never were a PDF. Pages are processed in numeric order.
- `run_id` is free-form but should identify the code and model, for example
  `2026-11-23_v1.4.2_qwen3.5-4b`.
- All JSON files are UTF-8, without a BOM, pretty-printed with 2-space
  indentation.

## 3. `gt.eumed.json`

### 3.1 Example

```json
{
  "format_version": 1,
  "meta": {
    "source_type": "scan_pdf",
    "lab_layout": "AOU_PADOVA",
    "synthetic": false,
    "annotator": "AC",
    "notes": ""
  },
  "input": {
    "workflow": "prescribed",
    "eumed_targets": ["COLESTEROLO TOTALE", "FERRITINA", "EMOCROMO", "PSA REFLEX"]
  },
  "expected": {
    "report_date": "2026-11-03",
    "targets": {
      "COLESTEROLO TOTALE": {
        "status": "filled",
        "value": "166",
        "unit": "mg/dL",
        "min": "",
        "max": "200",
        "source": "Colesterolo totale 4,29 mmol/L (<5,17)"
      },
      "FERRITINA": { "status": "absent" },
      "EMOCROMO": {
        "status": "long_report",
        "must_contain": ["WBC", "Hb", "PLT"]
      },
      "PSA REFLEX": {
        "status": "uncertain",
        "reason": "only free PSA reported"
      }
    },
    "not_in_eumed": ["Creatinina urinaria"]
  }
}
```

### 3.2 Top-level fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `format_version` | integer | yes | Always `1` for this spec. |
| `meta` | object | yes | Information about the case. It is not used for scoring, but can be used to group results. |
| `input` | object | yes | Everything the pipeline receives besides the source file. |
| `expected` | object | yes | Ground truth. |

### 3.3 `meta`

| Field | Type | Required | Values |
|---|---|---|---|
| `source_type` | string | yes | `text_pdf`, `scan_pdf`, `mixed_pdf` (some pages text, some scanned), or `image`. |
| `lab_layout` | string | yes | The lab the report comes from, as a person reads it: `SYNLAB_DATA_MEDICA`, `AOU_PADOVA`, `ULSS6_SCHIAVONIA`, `INLINE_CBC_CHEMISTRY`, or `OTHER`. This is ground truth, not the output of `detectKnownLabLayout`. |
| `synthetic` | boolean | yes | `true` only when the report was generated and contains no real patient data. |
| `annotator` | string | yes | Initials of the person who wrote the ground truth. |
| `notes` | string | no | Free text, for example "page 2 rotated" or "hand-written correction". |

### 3.4 `input`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `workflow` | string | yes | Must be `prescribed` in this version. `unprescribed` and `prescription_list` are reserved for later versions. |
| `eumed_targets` | string[] | yes | Names of the Eumed exam rows that were **empty** when the report was processed, in Eumed order, spelled exactly as Eumed shows them. These play the role of `getEmptyEumedExams()`. |

Rules for `eumed_targets`:

- The list must not be empty and must not contain duplicates.
- The same report may correctly produce different outputs with different
  targets, because the pipeline only looks for these exams.
- Ideally, copy the list from Eumed at the moment the report is processed.
  Reconstructing it afterwards is error-prone.

### 3.5 `expected`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `report_date` | string | yes | The collection/report date the pipeline should pick, as `YYYY-MM-DD`, or `""` if the report has no usable date. |
| `targets` | object | yes | One entry per target. The **keys must be exactly the set** in `input.eumed_targets`. |
| `not_in_eumed` | string[] | yes | Exams present in the report that have no target row, written as printed in the report. May be `[]`. This list is informational (section 6.4). |

### 3.6 Target entries

Every entry has a `status` that decides which other fields are allowed.

#### `status: "filled"`

The report has a usable numeric result, which the pipeline should write.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `value` | string | yes | The value Eumed should receive. Must not be empty. |
| `unit` | string | yes | The unit Eumed should receive, or `""` for unitless results. |
| `min` | string | yes | Lower reference bound, or `""`. |
| `max` | string | yes | Upper reference bound, or `""`. |
| `source` | string | yes | The report text the value comes from, as printed. It is not scored; it lets a reviewer check the annotation. |

How to write values (this follows the pipeline's own normalization):

- **Unit conversion.** If the concept has a preferred unit (`PREFERRED_UNITS`
  in `segretario.js`), `value`, `min`, `max` and `unit` are written **after**
  conversion to that unit. Example: cholesterol `4,29 mmol/L` becomes
  `166 mg/dL`. Otherwise they are written in the printed unit.
- **Rounding.** Use the same number of decimals the pipeline produces for
  that concept. When unsure, the scorer's tolerance (section 6.2) absorbs
  small rounding differences.
- **Decimal separator.** Either `,` or `.` is accepted; the scorer
  normalizes it. Do not use thousands separators.
- **Comparators.** A printed `<x` value is written as `x`. A printed `>x`
  value is not `filled`: use `uncertain`.
- **Reference range.** A one-sided range (`<200`) has one empty bound
  (`"min": ""`, `"max": "200"`). If there is no range, or no single
  reliable range (for example ranges that depend on age, sex or cycle
  phase), both bounds are `""`.

#### `status: "absent"`

The exam is not in the report. The pipeline must leave the row empty. No
other fields are allowed except an optional `source` string that may
explain why, for example `"only urine creatinine reported"`.

#### `status: "long_report"`

The exam is a grouped report written to Eumed as a single text block. Use it
for the long-report kinds the pipeline handles: `EMOCROMO`, `URINE`,
`PROTIDOGRAMMA`, `TIPIZZAZIONE_LINFOCITARIA`, `TIPIZZAZIONE_MONOCLONALE`,
`BENCE_JONES` and `PSA_REFLEX`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `must_contain` | string[] | yes | Short labels that must appear in the written text, for example `["WBC", "Hb", "PLT"]`. Must not be empty. The check ignores case and repeated whitespace. |
| `source` | string | no | Free note for reviewers. |

The full text is not compared, because exact text matching would be fragile
and not very informative.

#### `status: "uncertain"`

A person must decide; the pipeline should **not** fill the row automatically.
Examples: qualitative results ("positivo", "assente"), `>x` values,
conflicting readings, ambiguous labels, or a partial panel.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `reason` | string | yes | Short explanation. Not scored. |
| `source` | string | no | Report text, as printed. |

### 3.7 Validation rules

An implementation must reject a `gt.eumed.json` when any of these fail:

1. `format_version` is `1`.
2. All required fields exist and have the right type; no unknown fields
   appear at any level.
3. `input.workflow` is `prescribed`.
4. `input.eumed_targets` is non-empty and has no duplicates.
5. The keys of `expected.targets` equal the set in `input.eumed_targets`.
6. Each target entry has only the fields allowed for its `status`.
7. For `filled`: `value` parses as a number after replacing `,` with `.`;
   `min` and `max` are either `""` or numeric in the same way.
8. `expected.report_date` is `""` or a valid date in the form `YYYY-MM-DD`.
9. The case directory contains exactly one source form: either `source.pdf`,
   or one or more `page-NN.*` images numbered consecutively from `01`.
10. When the dataset lives inside this repository, `meta.synthetic` is `true`.

A JSON Schema (draft 2020-12) for the file is in section 8.

## 4. Annotation guidelines

- Annotate what a careful doctor would accept in Eumed, not what the
  pipeline currently produces.
- Each `filled` entry needs a `source` quote so a second person can check it
  quickly.
- When a report has the same exam twice with different values, use
  `uncertain`.
- When in doubt between `filled` and `uncertain`, choose `uncertain`.
- Prefer real Eumed target lists. If a synthetic case uses made-up targets,
  include at least one target with `absent` status, so false fills can be
  measured.

## 5. `prediction.json` (pipeline output to be scored)

A harness that runs the pipeline converts its output to this shape before
scoring. This keeps the scorer independent of the pipeline's internal
structures.

```json
{
  "format_version": 1,
  "run": {
    "run_id": "2026-11-23_v1.4.2_qwen3.5-4b",
    "pipeline_version": "1.4.2",
    "model": "qwen3.5:4b",
    "ocr_engine": "paddle",
    "started_at": "2026-11-23T21:00:00+01:00",
    "duration_ms": 41230,
    "error": ""
  },
  "report_date": "2026-11-03",
  "targets": {
    "COLESTEROLO TOTALE": { "status": "filled", "value": "166", "unit": "mg/dL", "min": "", "max": "200" },
    "FERRITINA": { "status": "empty" },
    "EMOCROMO": { "status": "long_report", "text": "WBC 6,2 ... Hb 14,1 ... PLT 250 ..." },
    "PSA REFLEX": { "status": "uncertain", "reason": "qualitative" }
  },
  "not_in_eumed": ["CREATININA URINARIA"]
}
```

Rules:

- `targets` has one entry for **every** key in the case's
  `input.eumed_targets`.
- Allowed prediction statuses:

| Status | Meaning |
|---|---|
| `filled` | The pipeline would write a value. It must have `value`, `unit`, `min` and `max`. |
| `long_report` | The pipeline would write a text block. It must have `text`. |
| `uncertain` | The pipeline flagged the target for the doctor. `reason` is optional. |
| `empty` | The pipeline produced nothing for the target. |

- Mapping from the current code (informational):
  - `extractFromReport().results` and the post-merge write set become
    `filled`.
  - `longReports` becomes `long_report`.
  - `uncertain` becomes `uncertain`.
  - Targets that appear in none of these become `empty`.
  - `recognizedNotInGrid` becomes `not_in_eumed`.
- If the run crashed, set `run.error` and mark every target as `empty`. The
  case is then scored as all misses or abstentions, and also counted as an
  error (section 6.4).

## 6. Scoring

### 6.1 Outcome per target

Each target gets exactly one outcome:

| Expected \ Predicted | `filled`, value matches | `filled`, value differs | `long_report` | `uncertain` or `empty` |
|---|---|---|---|---|
| `filled` | `correct` | `wrong_value` | `wrong_value` | `missed` |
| `long_report` | `wrong_value` | `wrong_value` | `correct` if all `must_contain` match, else `wrong_value` | `missed` |
| `absent` | `false_fill` | `false_fill` | `false_fill` | `correct_abstention` |
| `uncertain` | `false_fill` | `false_fill` | `false_fill` | `correct_abstention` |

`wrong_value` and `false_fill` are the critical errors, because they put
wrong data into the clinical record. `missed` is less serious, because the
doctor fills those rows in by hand anyway.

### 6.2 Number comparison

- Replace `,` with `.`, trim, and parse as a decimal number.
- Two numbers match when `|a - b| <= max(0.01, 0.005 * |b|)`, where `b` is
  the expected value. This absorbs rounding after unit conversion.
- If either side does not parse, compare the trimmed strings, ignoring case.

### 6.3 Extra checks on correct `filled` targets

These are scored separately, so one mistake doesn't hide a correct value:

| Check | Rule |
|---|---|
| `unit_ok` | Units are equal after trimming, ignoring case, and treating `µ` and `u` as the same character. |
| `min_ok`, `max_ok` | Both empty, or both numeric and matching as in section 6.2. |

The case-level check `report_date_ok` is true when the predicted and
expected `report_date` strings are equal.

### 6.4 Aggregate metrics

For a run over N cases, report:

| Metric | Definition |
|---|---|
| `critical_error_rate` | (`wrong_value` + `false_fill`) / all targets. **This is the main metric and should be close to 0.** |
| `fill_precision` | `correct` / (`correct` + `wrong_value` + `false_fill`), counted over predicted fills. |
| `fill_recall` | `correct` / targets expected as `filled` or `long_report`. |
| `abstention_accuracy` | `correct_abstention` / targets expected as `absent` or `uncertain`. |
| `unit_accuracy`, `range_accuracy` | Over `correct` filled targets. `range_accuracy` requires both `min_ok` and `max_ok`. |
| `report_date_accuracy` | Over cases. |
| `not_in_eumed_recall` | Expected `not_in_eumed` names found in the prediction, matched ignoring case and accents. Informational only. |
| `error_cases` | Number of runs with a non-empty `run.error`. |

Also report all counts broken down by `meta.source_type` and
`meta.lab_layout`.

### 6.5 `score.json`

```json
{
  "format_version": 1,
  "case_id": "aoupd-0001",
  "run_id": "2026-11-23_v1.4.2_qwen3.5-4b",
  "report_date_ok": true,
  "targets": {
    "COLESTEROLO TOTALE": { "outcome": "correct", "unit_ok": true, "min_ok": true, "max_ok": true },
    "FERRITINA": { "outcome": "correct_abstention" },
    "EMOCROMO": { "outcome": "correct", "missing_terms": [] },
    "PSA REFLEX": { "outcome": "correct_abstention" }
  },
  "counts": { "correct": 2, "wrong_value": 0, "missed": 0, "false_fill": 0, "correct_abstention": 2 }
}
```

For `long_report` targets, `missing_terms` lists the `must_contain` entries
not found in the predicted text.

## 7. `index.csv` (optional)

An optional summary for quick inspection and filtering. Comma-separated,
with a header row, UTF-8. It can be generated from the case files.

```
case_id,source_type,lab_layout,synthetic,n_targets,n_filled,n_absent,n_long_report,n_uncertain,annotator
aoupd-0001,scan_pdf,AOU_PADOVA,false,4,1,1,1,1,AC
```

## 8. JSON Schema for `gt.eumed.json`

Rules 5, 7, 8 (date validity), 9 and 10 in section 3.7 cannot be expressed
in this schema and must be checked in code.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "gt.eumed.v1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["format_version", "meta", "input", "expected"],
  "properties": {
    "format_version": { "const": 1 },
    "meta": {
      "type": "object",
      "additionalProperties": false,
      "required": ["source_type", "lab_layout", "synthetic", "annotator"],
      "properties": {
        "source_type": { "enum": ["text_pdf", "scan_pdf", "mixed_pdf", "image"] },
        "lab_layout": {
          "enum": ["SYNLAB_DATA_MEDICA", "AOU_PADOVA", "ULSS6_SCHIAVONIA", "INLINE_CBC_CHEMISTRY", "OTHER"]
        },
        "synthetic": { "type": "boolean" },
        "annotator": { "type": "string", "minLength": 1 },
        "notes": { "type": "string" }
      }
    },
    "input": {
      "type": "object",
      "additionalProperties": false,
      "required": ["workflow", "eumed_targets"],
      "properties": {
        "workflow": { "const": "prescribed" },
        "eumed_targets": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": { "type": "string", "minLength": 1 }
        }
      }
    },
    "expected": {
      "type": "object",
      "additionalProperties": false,
      "required": ["report_date", "targets", "not_in_eumed"],
      "properties": {
        "report_date": {
          "type": "string",
          "pattern": "^(|\\d{4}-\\d{2}-\\d{2})$"
        },
        "targets": {
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/target" }
        },
        "not_in_eumed": { "type": "array", "items": { "type": "string" } }
      }
    }
  },
  "$defs": {
    "number_or_empty": { "type": "string", "pattern": "^(|-?\\d+([.,]\\d+)?)$" },
    "number": { "type": "string", "pattern": "^-?\\d+([.,]\\d+)?$" },
    "target": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["status", "value", "unit", "min", "max", "source"],
          "properties": {
            "status": { "const": "filled" },
            "value": { "$ref": "#/$defs/number" },
            "unit": { "type": "string" },
            "min": { "$ref": "#/$defs/number_or_empty" },
            "max": { "$ref": "#/$defs/number_or_empty" },
            "source": { "type": "string", "minLength": 1 }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["status"],
          "properties": {
            "status": { "const": "absent" },
            "source": { "type": "string" }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["status", "must_contain"],
          "properties": {
            "status": { "const": "long_report" },
            "must_contain": {
              "type": "array",
              "minItems": 1,
              "items": { "type": "string", "minLength": 1 }
            },
            "source": { "type": "string" }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["status", "reason"],
          "properties": {
            "status": { "const": "uncertain" },
            "reason": { "type": "string", "minLength": 1 },
            "source": { "type": "string" }
          }
        }
      ]
    }
  }
}
```

## 9. Planned extensions (not part of version 1)

- `workflow: "unprescribed"` and `workflow: "prescription_list"`. Targets
  would be `lab_catalog.json` codes instead of Eumed row names.
- OCR ground truth per page, for example `gt.text.page-NN.tsv`.
- Ground truth for intermediate steps (raw printed results, line numbers),
  so the parser and the LLM can be scored separately.
