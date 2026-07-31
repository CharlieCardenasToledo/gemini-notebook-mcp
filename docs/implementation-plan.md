# Implementation plan

This roadmap turns the security and reliability review into independently releasable changes. Each phase has an explicit compatibility boundary and acceptance criteria so that browser automation, protocol changes, and new product features are not mixed in one release.

## 2.1.3 — Security and consistency

Status: implemented on `agent/security-hardening-2.1.3`.

Scope:

- Keep all tool descriptions static and exclude notebook/user content from trusted MCP metadata.
- Report the NotebookLM model as `google-managed` and derive the server version from `package.json`.
- Limit `cleanup_data` to `NOTEBOOKLM_DATA_DIR`, with a short-lived preview token and an unchanged-manifest check.
- Replace short session IDs with UUIDs and scope browser sessions to the owning MCP connection.
- Redact content, URLs, paths, account identifiers, and DOM diagnostics from logs by default.
- Validate every tool call with Zod before opening a browser.
- Return machine-readable error details and `structuredContent` alongside text content.
- Constrain downloads to `NOTEBOOKLM_OUTPUT_DIR`, sanitize filenames, create the output directory, and avoid collisions.
- Apply one authenticated-page recovery wrapper to question, source, and audio operations.
- Make browser locale and timezone configurable.
- Add multi-platform CI, CodeQL, Dependabot, package checks, and focused regression tests.

Acceptance criteria:

- `npm run check` passes.
- `npm pack --dry-run` succeeds and reports version `2.1.3`.
- A notebook title/description containing instructions never appears in a tool description.
- Invalid input is rejected before browser initialization.
- A cleanup confirmation fails when its preview token expired or the target manifest changed.
- Cleanup and downloads cannot escape their configured roots, including through symbolic links.
- One HTTP/MCP connection cannot list, reset, or close another connection's browser sessions.
- Test questions, DOM fragments, full URLs, account names, and local paths do not appear in default logs.

## 2.2.0 — Browser robustness and MCP protocol

The following work is deliberately separate because it changes browser abstractions or protocol contracts.

1. Finish the selector registry
   - Move citations, sources, Studio, home-grid, and authentication selectors into one versioned registry.
   - Add verification callbacks and return `UI_CHANGED` when a selector group cannot be verified.
   - Add anonymized DOM fixtures for multiple languages and UI states.

2. Complete the browser operation boundary
   - Route every browser operation through the authenticated-page wrapper.
   - Add operation-wide timeout budgets, one bounded retry, overlay cleanup, and redacted diagnostics.
   - Propagate MCP cancellation through navigation, answer extraction, citations, generation, and downloads.

3. Strengthen transport isolation
   - Define and document the supported single-user deployment model.
   - If multi-user mode is added, require an authenticated principal and isolate profile, storage, library, and sessions per principal—not only browser session IDs.
   - Add tests for session hijacking, concurrent requests, SSE closure, oversized bodies, and invalid Host/Origin/token values.

4. Evaluate MCP SDK migration
   - Confirm the current official stable SDK and specification before changing dependencies.
   - Migrate on a dedicated branch, preserve compatibility where possible, and use registered input/output schemas, normalized errors, request context, cancellation, and resources.
   - Keep `structuredContent` contract tests against supported clients.

5. Expand the test pyramid
   - Add selector fixtures, concurrency/failure injection, log-privacy snapshots, and packaged-binary smoke tests.
   - Test Windows, macOS, and Linux with Node 22 and the next supported LTS.

Exit criteria:

- No browser-facing tool bypasses the common recovery/cancellation layer.
- Selector failure is distinguishable from a valid empty result.
- Transport ownership and deployment limits are documented and covered by adversarial tests.
- The packed CLI completes an MCP initialize/list-tools smoke test on every supported platform.

## 2.3.0 — NotebookLM features

This phase adds functionality without conflating NotebookLM browser automation with the Gemini API.

1. Source lifecycle
   - Add `list_sources`, `get_source`, `get_source_status`, `remove_source`, `rename_source`, `refresh_source`, and batch operations.
   - Add file, YouTube, and Drive import only after stable source IDs and indexing states are available.

2. Library synchronization
   - Add `sync_library` and account import/change detection.
   - Store a stable local UUID separately from the Google notebook ID and optional display slug.

3. Generic Studio artifacts
   - Add `generate_artifact`, `list_artifacts`, `get_artifact_status`, `download_artifact`, and `delete_artifact`.
   - Persist job IDs and states so polling survives an MCP restart.

4. Citation enrichment
   - Return source ID/type/URL when available, structured locations, excerpts, and extraction status.
   - Enforce one total citation-extraction budget instead of a full timeout per citation.

5. Optional Gemini API backend
   - Perform a discovery spike against current official Gemini API and File Search documentation.
   - Expose a separately named tool and provenance contract; never present API answers as NotebookLM answers.
   - Require explicit API configuration, document costs/quotas, and do not assume existing notebooks are automatically available.

Exit criteria:

- Source and artifact operations return stable IDs and observable states.
- Library synchronization handles rename, duplicate, deletion, and inaccessible-notebook cases.
- Citations remain structured and bounded in latency.
- Browser and API backends have unambiguous names, storage, quotas, and provenance.

## Release discipline

For each release:

1. Update schemas, implementation, tests, documentation, and changelog in the same pull request.
2. Run `npm run check` and `npm pack --dry-run` from a clean checkout.
3. Install the generated tarball and smoke-test MCP initialization and `tools/list`.
4. Merge only after CI passes.
5. Publish from the merged commit with npm provenance when the registry workflow is configured.
6. Verify the registry version and tarball integrity after publication.

