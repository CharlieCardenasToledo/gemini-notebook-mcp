# Project status and remaining work

Last updated: 2026-07-31.

This document summarizes the work already delivered, the state of the current
release candidate, and the remaining roadmap. It distinguishes merged, published,
and still-pending work.

## Current release state

| Surface | Version | State |
| --- | --- | --- |
| GitHub `main` | 2.3.1 | Merged through PR #13 (`47e0a0a`) |
| npm registry | 2.3.1 | Published under the `latest` tag |

## Completed work

### 2.1.2 — Authentication persistence

- Removed the artificial 24-hour expiry for `state.json`.
- Separated saved-state presence from live authentication in `get_health`.
- Persisted rotated cookies after successful authenticated navigation.
- Changed the default browser profile strategy to `single` to avoid silent clean
  profiles when another process owns the main profile.
- Added coverage proving that old but valid state remains accepted and malformed state
  is rejected.

### 2.1.3 — Security and consistency

- Made tool descriptions static so notebook/user content cannot become trusted MCP
  metadata.
- Replaced the hardcoded Gemini model claim with `google-managed` provenance and made
  the runtime version derive from `package.json`.
- Restricted cleanup and downloads to configured roots, including preview-token,
  manifest, traversal, filename, collision, and symbolic-link protections.
- Added UUID browser sessions with ownership isolation between MCP connections.
- Added privacy-first logging, Zod validation, structured error details, and
  `structuredContent` responses.
- Added the common authenticated browser operation boundary, configurable locale and
  timezone, multi-platform CI, CodeQL, Dependabot, and package checks.

### 2.2.0 — Browser robustness and protocol

- Centralized and versioned browser selectors, with multilingual anonymized fixtures.
- Added operation-wide cancellation, timeout budgets, bounded recovery, and explicit
  `UI_CHANGED` failures.
- Strengthened Streamable-HTTP authentication, Host/Origin/body/session controls and
  added adversarial transport tests.
- Added installed-tarball MCP smoke coverage for initialization, runtime version, and
  tool discovery.
- Kept the MCP SDK on the stable 1.x line because a stable 2.x npm release was not
  available when the migration was evaluated.

### 2.3.0 — NotebookLM features

- Added source inventory/status, YouTube ingestion, batch ingestion, and stable
  best-effort source IDs.
- Added account import and preview-first library synchronization, with stable local
  UUIDs separate from Google notebook IDs.
- Added persistent generic Studio jobs for Audio Overview generation, status, listing,
  and download.
- Enriched citations with structured source, location, excerpt, and extraction-status
  fields under one total extraction budget.

### 2.3.1 — Safe live verification

- Added a browser-independent MCP preflight using a temporary data directory.
- Added an authenticated read-only smoke runner for the account grid, sources, source
  status, Audio Overview status, library-sync preview, and persisted artifact jobs.
- Made the default `mcp:test-live` command non-mutating and protected legacy chat/DOM
  diagnostics behind explicit environment acknowledgements.
- Added redaction for URLs, Windows/POSIX paths, email addresses, and identifiers; live
  output contains only aggregate counts and states.
- Distinguished a verified empty NotebookLM account from a broken home-grid selector.
- Added the safe preflight to every operating-system/Node combination in CI.

Local validation completed for 2.3.1:

- `npm run check`: 42/42 tests passed; format, lint, and TypeScript build passed.
- `npm run test:live:preflight`: passed as version 2.3.1.
- `npm audit --json`: zero known vulnerabilities.
- `npm run package:smoke`: passed with version 2.3.1 and 31 tools.
- `npm pack --dry-run --json`: valid 2.3.1 tarball with 177 entries.
- `npm run test:live:readonly`: all seven authenticated, read-only checks passed
  against the live NotebookLM interface without mutating the account.
- GitHub CI: CodeQL, package smoke, and all Windows/macOS/Ubuntu jobs on Node
  22/24 passed before PR #13 was merged.
- npm registry verification: `latest` resolves to 2.3.1 and the remote tarball
  exposes 177 entries with valid SHA-512 integrity metadata.

## 2.3.1 completion status

Version 2.3.1 is complete: the implementation is merged, CI and the authenticated
read-only browser suite pass, npm publication is live, and the remote tarball has been
verified. No release-specific activity remains open.

## Remaining product roadmap

### Browser/UI verification

- Run authenticated fixtures against the current live NotebookLM UI on a regular
  release cadence and update selectors only from observed evidence.
- Add verified fixtures for more account-empty variants, infinite/virtualized notebook
  grids, source types, citation locations, and Studio states.
- Add failure-injection coverage for real login redirects, browser renderer hangs,
  interrupted downloads, and plan/quota dialogs.

### Source lifecycle

- Implement source rename, removal, and refresh after stable controls and permission
  boundaries are verified.
- Add file and Google Drive source pickers, including upload progress, indexing state,
  cancellation, size/type validation, and account permission handling.
- Improve batch correlation so concurrent account changes cannot be mistaken for the
  source created by the current call.

### Studio artifacts

- Add other verified artifact types such as reports, mind maps, quizzes, flashcards,
  infographics, slide decks, tables, and video when available to the account.
- Add remote artifact deletion only with a preview/confirmation contract.
- Persist richer job diagnostics and reconcile jobs whose browser work completed while
  the MCP was offline.

### Citations

- Improve verified page, slide, and audio/video timestamp extraction across source
  types and languages.
- Add more fixtures for partial/unavailable citation panels and large citation sets.

### Gemini API backend

- Perform a separate official-API discovery spike for Gemini API and File Search.
- If implemented, expose a separately named tool, explicit model selection, API key,
  costs/quotas, storage, and provenance. Do not represent API output as NotebookLM
  output or assume existing notebooks are available to File Search.

### MCP and deployment architecture

- Re-evaluate migration when the official TypeScript MCP SDK 2.x line is stable and
  compatible with supported clients.
- Keep the documented deployment single-user. A future multi-user mode must isolate
  Google profiles, storage, libraries, artifacts, and sessions by authenticated
  principal—not only session IDs.
- Add CI-backed authenticated browser testing only through a secure profile/secret
  strategy that does not expose Google cookies or account content.

### Release operations

- Automate npm publication from protected tags or GitHub releases with provenance.
- Verify registry version, integrity, executable startup, and tool count after every
  publication.
- Remove merged remote branches after each release and keep `main` as the only
  long-lived branch unless a maintenance branch is explicitly required.
