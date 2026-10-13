# FN-16i Impor page layout — SUMMARY

Status: **complete** (2026-10-11). Goal: the Impor page follows the reference app's layout and is honest about which
banks Montra can read.

- Built: two-column desktop layout (left: import, Rapikan kategori when eligible, history, export; right: other ways,
  reading jobs), one wallet picker above every format, a 16-institution picker where only BCA, Mandiri, BNI and OCBC
  are selectable and the rest are disabled with the alternative named, "Pindai struk" linked to Scan struk, and a
  disabled "Pintasan — Segera hadir" row (owner decision). Shared `PickerSheet` gains `disabled`; a disabled option
  with a link renders as a disabled button (red team L1 fixed). No migration.
- QA: PASS (14 criteria). Red team: PASS (L1 fixed in cycle 2).
