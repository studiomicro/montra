# MONTRA docs

Every Markdown file except `CLAUDE.md` (Claude Code reads it only at the repository root) and the community files in
the repository root (`README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`) lives here.

| File | What it holds |
| --- | --- |
| [PRD.md](PRD.md) | Product requirements: problem, users, metrics, phases, risks |
| [FEATURES.md](FEATURES.md) | Feature catalog FN-00 – FN-33 |
| [design/DESIGN_SYSTEM.md](design/DESIGN_SYSTEM.md) | Design system v1: principles, tokens, components, patterns |
| [design/tokens.css](design/tokens.css) | Design tokens, light and dark, Tailwind v4 mapping |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Runtime map, sync, capture pipeline, account key, data model |
| [TASKS.md](TASKS.md) | Status summary and the open to-do list (owner-tagged) |
| [HISTORY.md](HISTORY.md) | Completed work and the test evidence log |
| [ACCEPTANCE.md](ACCEPTANCE.md) | What is verified, at which level, by which check |
| [ENGINEERING_CHECKLIST.md](ENGINEERING_CHECKLIST.md) | Recurring defect classes and pre-handoff probes |
| [SELF_HOSTING.md](SELF_HOSTING.md) | Cloudflare resources, variables and secrets a self-hoster needs; AGPL source link |
| [RUNBOOK.md](RUNBOOK.md) | Local setup, deploy, migrations, secrets |
| `features/<slug>/` | Per-feature PRD, QA, security and summary reports |
| `superpowers/` | Specs and plans for foundation and cross-cutting work |

Trackers: open work goes in `TASKS.md`; finished work and its evidence move to `HISTORY.md`; a row in
`ACCEPTANCE.md` changes only with a named check behind it.
