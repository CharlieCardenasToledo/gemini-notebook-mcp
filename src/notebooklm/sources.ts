/**
 * NotebookLM source ingestion (issue #25).
 *
 * The current browser backend supports the two source types that cover the bulk of real usage:
 *   - `url`  — paste a website URL (NotebookLM crawls and indexes it)
 *   - `text` — paste raw text (treated as a copied document)
 *
 * File-upload, YouTube and Google-Drive ingestion are intentionally out of
 * scope for this module — they require different overlay flows.
 *
 * Robustness strategy (2026-05, ported from the Fork's content-manager.ts):
 *
 *   1. Capture the *expected notebook UUID* from the URL up-front. NotebookLM
 *      sometimes redirects pasted-text uploads to a freshly-created notebook;
 *      we detect that and surface a clear error.
 *
 *   2. Resolve the dialog state defensively: if a dialog is already open we
 *      use it; otherwise we click the sidebar "Add source" button. The
 *      `[role="dialog"]` anchor is set synchronously on mount, so we do not
 *      have to race the Material `.mdc-dialog--open` animation class.
 *
 *   3. Source-type buttons no longer ship with aria-labels — see
 *      selectors.ts for the icon-/text-based anchors.
 *
 *   4. Insert acceptance is COUNT-BASED, but source identity is correlated
 *      separately by canonical URL or exact requested title. A concurrent
 *      source addition is never returned as though it belonged to this call.
 */

import type { Page } from "patchright";
import { createHash } from "node:crypto";
import { Selectors, joinAlt } from "./selectors.js";
import { UiChangedError } from "../errors.js";
import { safeSleep, isRecoverable } from "../browser/watchdog.js";
import { hashLogValue, log } from "../utils/logger.js";

export type SourceType = "url" | "text" | "youtube";

export type SourceIndexStatus = "ready" | "indexing" | "error" | "unknown";

export interface SourceSummary {
  source_id: string;
  name: string;
  type: "web" | "youtube" | "pdf" | "audio" | "image" | "text" | "unknown";
  status: SourceIndexStatus;
  url: string | null;
  position: number;
}

export interface AddSourceInput {
  type: SourceType;
  /** URL when `type === "url"`, raw text when `type === "text"`. */
  content: string;
  /** Optional title shown in the source list. NotebookLM uses a default if omitted. */
  title?: string;
}

export interface AddSourceResult {
  success: boolean;
  type: SourceType;
  sourceCountBefore: number;
  sourceCountAfter: number;
  correlation: SourceCorrelation;
  message?: string;
  source?: SourceSummary;
}

export interface SourceCorrelation {
  status: "exact" | "accepted_unverified" | "ambiguous" | "failed";
  matched_by: "url" | "title" | null;
  candidate_count: number;
}

export async function addSource(page: Page, input: AddSourceInput): Promise<AddSourceResult> {
  const initialUrl = page.url();
  const expectedUuid = initialUrl.match(/notebook\/([a-f0-9-]+)/)?.[1];
  log.info(
    `📄 [add_source] type=${input.type} target_hash=${expectedUuid ? hashLogValue(expectedUuid) : "unknown"}`
  );

  try {
    let inventoryBefore = await listSources(page).catch(() => [] as SourceSummary[]);
    // 1. Open the Add-source dialog (or use one that's already open).
    await openAddSourceOverlay(page);

    // 2. Pick the source type if there is a picker. Some overlay variants
    //    drop straight into an input field; pickSourceType is a no-op then.
    await pickSourceType(page, input.type);

    // 3. Fill the content + optional title.
    await fillSourceContent(page, input);

    // 4. Snapshot the source count *before* submitting. The Fork captures it
    //    here (dialog still open, sidebar list not yet updated) so the
    //    post-close poll can detect a real increment.
    inventoryBefore = await listSources(page).catch(() => inventoryBefore);
    const before = Math.max(await countSources(page), inventoryBefore.length);
    log.info(`  📊 source count before submit: ${before}`);

    // 5. Click the primary "Insert" / "Hinzufügen" button.
    await confirmInsert(page);

    // 6. Wait for the dialog to animate away. NotebookLM doesn't append the
    //    new sidebar entry until the modal is fully gone.
    await waitForOverlayToClose(page);

    // 7. UUID redirect check: pasted-text uploads occasionally land in a new
    //    "Untitled notebook" instead of the target. Catch that here so the
    //    caller sees a useful error instead of a phantom success.
    if (expectedUuid) {
      const currentUrl = page.url();
      const currentUuid = currentUrl.match(/notebook\/([a-f0-9-]+)/)?.[1];
      if (currentUuid && currentUuid !== expectedUuid) {
        log.error(`  ❌ Notebook redirect did not match the requested notebook`);
        return {
          success: false,
          type: input.type,
          sourceCountBefore: before,
          sourceCountAfter: before,
          correlation: failedCorrelation(),
          message:
            `NotebookLM redirected to a different notebook (${currentUuid}) instead of ` +
            `the target (${expectedUuid}). This is a known quirk for pasted-text uploads — ` +
            `the source landed in a new "Untitled notebook".`,
        };
      }
    }

    // 8. Poll the source count for up to 90 s; URL crawls and large pastes
    //    can take a while to materialise as a sidebar entry.
    const firstObservedCount = await waitForSourceCountIncrease(page, before, 90_000);

    if (firstObservedCount > before) {
      const observation = await waitForSourceCorrelation(
        page,
        input,
        inventoryBefore,
        firstObservedCount,
        3_000
      );
      const after = observation.sourceCountAfter;
      const correlated = observation.result;
      log.success(`  ✅ source added (count ${before} → ${after})`);
      return {
        success: true,
        type: input.type,
        sourceCountBefore: before,
        sourceCountAfter: after,
        correlation: correlated.correlation,
        ...(correlated.source && { source: correlated.source }),
        ...(correlated.message && { message: correlated.message }),
      };
    }

    // 9. Last-ditch: maybe an error toast surfaced; surface it verbatim.
    const errorText = await readDialogError(page);
    return {
      success: false,
      type: input.type,
      sourceCountBefore: before,
      sourceCountAfter: firstObservedCount,
      correlation: failedCorrelation(),
      message:
        errorText ||
        "Source dialog completed but the source list did not grow within 90 s. " +
          "Either NotebookLM is still crawling/indexing or the upload silently failed.",
    };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    log.warning(`  ⚠️  add_source failed: ${err}`);
    return {
      success: false,
      type: input.type,
      sourceCountBefore: 0,
      sourceCountAfter: 0,
      correlation: failedCorrelation(),
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

interface CorrelatedSourceResult {
  correlation: SourceCorrelation;
  source?: SourceSummary;
  message?: string;
}

/**
 * Compare two inventories without trusting DOM order. Source IDs are stable
 * best-effort identities; fallback IDs include duplicate occurrence indexes,
 * so a newly added duplicate still appears in this set difference.
 */
export function diffSourceInventories(
  before: readonly SourceSummary[],
  after: readonly SourceSummary[]
): SourceSummary[] {
  const knownIds = new Set(before.map((source) => source.source_id));
  return after.filter((source) => !knownIds.has(source.source_id));
}

/**
 * Return a source only when its identity can be tied to the submitted input.
 * A single new row is not sufficient: it may have been added concurrently by
 * another browser or MCP instance.
 */
export function correlateAddedSource(
  input: AddSourceInput,
  before: readonly SourceSummary[],
  after: readonly SourceSummary[]
): CorrelatedSourceResult {
  const candidates = diffSourceInventories(before, after);
  const expectedUrl = input.type === "url" || input.type === "youtube" ? input.content : null;
  const canonicalExpectedUrl = expectedUrl ? canonicalSourceUrl(expectedUrl, input.type) : null;
  const urlMatches = canonicalExpectedUrl
    ? candidates.filter(
        (source) =>
          source.url !== null &&
          !isDerivedSourceId(source.source_id) &&
          canonicalSourceUrl(source.url, input.type) === canonicalExpectedUrl
      )
    : [];
  if (urlMatches.length === 1) {
    return {
      correlation: {
        status: "exact",
        matched_by: "url",
        candidate_count: candidates.length,
      },
      source: urlMatches[0],
    };
  }
  if (urlMatches.length > 1) return ambiguousCorrelation(candidates.length, "url");

  const expectedTitle = input.type === "text" ? normalizeSourceTitle(input.title) : null;
  const titleMatches = expectedTitle
    ? candidates.filter((source) => normalizeSourceTitle(source.name) === expectedTitle)
    : [];
  if (titleMatches.length === 1) {
    return {
      correlation: {
        status: "exact",
        matched_by: "title",
        candidate_count: candidates.length,
      },
      source: titleMatches[0],
    };
  }
  if (titleMatches.length > 1) return ambiguousCorrelation(candidates.length, "title");

  if (candidates.length > 1) return ambiguousCorrelation(candidates.length, null);
  return {
    correlation: {
      status: "accepted_unverified",
      matched_by: null,
      candidate_count: candidates.length,
    },
    message:
      "NotebookLM accepted the source submission and the source count increased, " +
      "but the new row did not expose enough identity metadata for safe correlation. " +
      "Do not retry automatically; call list_sources to inspect the current inventory.",
  };
}

function ambiguousCorrelation(
  candidateCount: number,
  matchedBy: SourceCorrelation["matched_by"]
): CorrelatedSourceResult {
  return {
    correlation: {
      status: "ambiguous",
      matched_by: matchedBy,
      candidate_count: candidateCount,
    },
    message:
      "NotebookLM accepted the source submission, but concurrent inventory changes " +
      "made the new source identity ambiguous. No source_id was returned. Do not retry " +
      "automatically; call list_sources to reconcile the notebook inventory.",
  };
}

function failedCorrelation(): SourceCorrelation {
  return { status: "failed", matched_by: null, candidate_count: 0 };
}

function normalizeSourceTitle(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return normalized || null;
}

function isDerivedSourceId(value: string): boolean {
  return /^src_[0-9a-f]{16}$/i.test(value);
}

function canonicalSourceUrl(value: string, type: SourceType): string | null {
  try {
    const parsed = new URL(value);
    if (type === "youtube") {
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      const videoId =
        host === "youtu.be"
          ? parsed.pathname.split("/").filter(Boolean)[0]
          : host.endsWith("youtube.com")
            ? parsed.searchParams.get("v") ||
              parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1]
            : null;
      if (videoId) return `youtube:${videoId}`;
    }
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Count sources in the sidebar via two independent anchors:
 *
 *   1. `.single-source-container` — the per-row sidebar element. Most
 *      direct, but only present once the sidebar has hydrated.
 *
 *   2. `.cover-subtitle-source-count` — a header label of the form
 *      `"3 Quellen"` / `"3 sources"`. Robust to a collapsed or partially
 *      hydrated sidebar because it lives in the chat header instead.
 *
 * We return whichever produces a higher count; mismatches between the two
 * usually mean the sidebar hasn't caught up yet, in which case the header
 * is the authoritative ground truth.
 */
export async function countSources(page: Page): Promise<number> {
  let containerCount = 0;
  try {
    containerCount = await page.locator(Selectors.sources.sourceContainer).count();
  } catch {
    /* fall through */
  }

  let headerCount = 0;
  try {
    const headerText = await page
      .locator(Selectors.sources.sourceCountIndicator)
      .first()
      .textContent({ timeout: 500 })
      .catch(() => null);
    const match = headerText?.match(/(\d+)/);
    if (match) headerCount = parseInt(match[1], 10);
  } catch {
    /* ignore */
  }

  return Math.max(containerCount, headerCount);
}

/**
 * Open the Add-source modal. Order of attempts:
 *   1. Dialog already open → use it (auto-modal on fresh notebooks).
 *   2. Click the sidebar "Add source" button.
 *   3. Last resort: navigate to `?addSource=true`, which auto-opens.
 */
async function openAddSourceOverlay(page: Page): Promise<void> {
  if (await isOverlayVisible(page)) {
    log.info("  ✅ Add-source dialog already open, reusing");
    return;
  }

  // Try the sidebar button first — fastest path on a populated notebook.
  try {
    await page.locator(joinAlt(Selectors.sources.addButton)).first().click({ timeout: 5_000 });
    await page
      .locator(Selectors.sources.overlayPane)
      .first()
      .waitFor({ state: "visible", timeout: 8_000 });
    return;
  } catch (err) {
    log.warning(
      `  ⚠️  Add-source button click failed (${err}), trying ?addSource=true URL fallback`
    );
  }

  // URL fallback — useful when the sidebar button is hidden or covered.
  const url = page.url();
  if (url && /\/notebook\//.test(url) && !url.includes("addSource=true")) {
    const u = new URL(url);
    u.searchParams.set("addSource", "true");
    await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page
      .locator(Selectors.sources.overlayPane)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    return;
  }

  throw new UiChangedError("sources.dialog");
}

async function isOverlayVisible(page: Page): Promise<boolean> {
  return page
    .locator(Selectors.sources.overlayPane)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
}

async function pickSourceType(page: Page, type: SourceType): Promise<void> {
  const candidates =
    type === "url"
      ? Selectors.sources.sourceTypeUrl
      : type === "youtube"
        ? Selectors.sources.sourceTypeYoutube
        : Selectors.sources.sourceTypeText;
  const overlay = page.locator(Selectors.sources.overlayPane).first();
  for (const sel of candidates) {
    const target = overlay.locator(sel).first();
    if (await target.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await target.click();
      // Sub-dialog needs a moment to hydrate before we type.
      await safeSleep(page, 500);
      return;
    }
  }
  // Older overlays drop straight to the input (no type picker) — that's fine.
}

export async function listSources(page: Page): Promise<SourceSummary[]> {
  const rows = (await page.$$eval(
    Selectors.sources.sourceContainer,
    (containers, selectors) =>
      containers.map((container, position) => {
        const findText = (candidates: readonly string[]) => {
          for (const selector of candidates) {
            const text = container.querySelector(selector)?.textContent?.trim();
            if (text) return text;
          }
          return "";
        };
        const rawText = (container.textContent || "").trim();
        const statusText = findText(selectors.status).toLowerCase();
        const iconText = findText(selectors.icons).toLowerCase();
        const link = selectors.links
          .map((selector) => container.querySelector(selector))
          .find(Boolean);
        return {
          rawId:
            container.getAttribute("data-source-id") ||
            container.getAttribute("data-id") ||
            container.id ||
            "",
          name:
            findText(selectors.titles) ||
            container.getAttribute("data-source-title") ||
            rawText.split("\n")[0]?.trim() ||
            `Source ${position + 1}`,
          rawText,
          statusText,
          iconText,
          url: link?.getAttribute("href") || link?.getAttribute("data-source-url") || null,
          busy:
            container.getAttribute("aria-busy") === "true" ||
            Boolean(container.querySelector("[role='progressbar']")),
          position,
        };
      }),
    {
      titles: Selectors.sources.sourceTitle,
      status: Selectors.sources.sourceStatus,
      links: Selectors.sources.sourceLink,
      icons: Selectors.sources.sourceTypeIcon,
    }
  )) as Array<{
    rawId: string;
    name: string;
    rawText: string;
    statusText: string;
    iconText: string;
    url: string | null;
    busy: boolean;
    position: number;
  }>;

  if (rows.length === 0) {
    const panelDetected =
      (await page
        .locator(joinAlt(Selectors.sources.addButton))
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)) ||
      (await page
        .locator(Selectors.sources.sourceCountIndicator)
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false));
    if (!panelDetected) throw new UiChangedError("sources.sourceContainer");
  }

  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const signature = `${row.name}\0${row.url ?? ""}`;
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    return {
      source_id:
        row.rawId ||
        `src_${createHash("sha256")
          .update(`${signature}\0${occurrence}`)
          .digest("hex")
          .slice(0, 16)}`,
      name: row.name,
      type: inferSourceType(row.name, row.url, row.iconText),
      status: inferSourceStatus(row.rawText, row.statusText, row.busy),
      url: row.url,
      position: row.position,
    };
  });
}

export async function getSource(
  page: Page,
  selector: { sourceId?: string; name?: string }
): Promise<SourceSummary | null> {
  const sources = await listSources(page);
  return (
    sources.find((source) => selector.sourceId && source.source_id === selector.sourceId) ??
    sources.find((source) => selector.name && source.name === selector.name) ??
    null
  );
}

function inferSourceStatus(text: string, statusText: string, busy: boolean): SourceIndexStatus {
  const value = `${text} ${statusText}`.toLowerCase();
  if (/error|failed|fehler|falló|erro|échec|失敗/.test(value)) return "error";
  if (busy || /index|processing|uploading|wird|procesando|traitement|処理中/.test(value)) {
    return "indexing";
  }
  return value ? "ready" : "unknown";
}

function inferSourceType(
  name: string,
  url: string | null,
  iconText: string
): SourceSummary["type"] {
  const value = `${name} ${url ?? ""} ${iconText}`.toLowerCase();
  if (/youtube|youtu\.be|video_youtube/.test(value)) return "youtube";
  if (/\.pdf(?:$|[?#])|picture_as_pdf/.test(value)) return "pdf";
  if (/\.(?:mp3|m4a|wav|ogg)(?:$|[?#])|audio/.test(value)) return "audio";
  if (/\.(?:png|jpe?g|gif|webp)(?:$|[?#])|image/.test(value)) return "image";
  if (/^https?:|\blink\b|language/.test(value)) return "web";
  if (/text|content_paste|document/.test(value)) return "text";
  return "unknown";
}

async function fillSourceContent(page: Page, input: AddSourceInput): Promise<void> {
  const overlay = page.locator(Selectors.sources.overlayPane).first();

  // Wait for the overlay to actually contain a textarea (the picker swap is
  // animated, so a tight 500 ms wait beats a busy poll).
  await safeSleep(page, 500);

  let target = null;
  for (const sel of Selectors.sources.contentInput) {
    const candidate = page.locator(sel).first();
    if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
      target = candidate;
      break;
    }
  }

  if (!target) {
    throw new UiChangedError("sources.contentInput");
  }

  // Title goes in a separate input when one is present; otherwise we prefix
  // it onto the text content (Fork's fallback for older overlays).
  let body = input.content;
  if (input.title && input.type === "text") {
    let titleInputFound = false;
    for (const sel of Selectors.sources.titleInput) {
      const candidate = overlay.locator(sel).first();
      if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
        await candidate.fill(input.title).catch(() => undefined);
        titleInputFound = true;
        break;
      }
    }
    if (!titleInputFound) {
      body = `${input.title}\n\n${input.content}`;
    }
  }

  await target.fill(body);
  // Small settle delay before clicking submit; Material's primary button
  // briefly stays disabled after `fill()` while validators run.
  await safeSleep(page, 300);
}

async function confirmInsert(page: Page): Promise<void> {
  const overlay = page.locator(Selectors.sources.overlayPane).first();
  for (const sel of Selectors.sources.insertConfirm) {
    const btn = overlay.locator(sel).first();
    if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const disabled = await btn.isDisabled().catch(() => false);
      if (disabled) continue;
      await btn.click();
      log.info(`  ✅ submit clicked (selector: ${sel})`);
      return;
    }
  }
  throw new UiChangedError("sources.insertConfirm");
}

/**
 * Wait until the Add-source modal animates away. NotebookLM only appends the
 * new sidebar entry once the modal is fully gone, so we *must* wait here.
 */
async function waitForOverlayToClose(page: Page, timeoutMs: number = 30_000): Promise<void> {
  await page
    .locator(Selectors.sources.overlayPane)
    .first()
    .waitFor({ state: "hidden", timeout: timeoutMs })
    .catch(() => undefined);
}

async function waitForSourceCountIncrease(
  page: Page,
  before: number,
  timeoutMs: number = 90_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await countSources(page);
    if (current > before) return current;
    await safeSleep(page, 500);
  }
  return await countSources(page);
}

async function waitForSourceCorrelation(
  page: Page,
  input: AddSourceInput,
  inventoryBefore: readonly SourceSummary[],
  initialCount: number,
  settleMs: number
): Promise<{ sourceCountAfter: number; result: CorrelatedSourceResult }> {
  const deadline = Date.now() + settleMs;
  let sourceCountAfter = initialCount;
  let result: CorrelatedSourceResult;
  do {
    const inventoryAfter = await listSources(page).catch(() => [] as SourceSummary[]);
    sourceCountAfter = Math.max(sourceCountAfter, inventoryAfter.length, await countSources(page));
    result = correlateAddedSource(input, inventoryBefore, inventoryAfter);
    if (result.correlation.status === "exact") break;
    if (result.correlation.status === "ambiguous" && result.correlation.matched_by) break;
    if (Date.now() < deadline) await safeSleep(page, 500);
  } while (Date.now() < deadline);
  return { sourceCountAfter, result };
}

/**
 * Look for an error toast / `[role="alert"]` describing why the upload
 * failed. We filter against Material-icon-name leakage (e.g. `more_vert`),
 * which would otherwise produce nonsense error strings.
 */
async function readDialogError(page: Page): Promise<string | null> {
  const ICON_LEAKS = ["more_vert", "more_horiz", "open_in_new", "content_copy"];

  for (const sel of Selectors.sources.errorMessage) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;
      const txt = (await el.textContent({ timeout: 1_000 }).catch(() => null))?.trim();
      if (!txt || txt.length > 240) continue;
      if (ICON_LEAKS.some((leak) => txt.includes(leak))) continue;
      return txt;
    } catch {
      continue;
    }
  }
  return null;
}
