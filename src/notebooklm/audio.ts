/**
 * NotebookLM Audio Overview generation + download (issue #11).
 *
 * 2026-05 Studio UX (verified live in DE/EN locales):
 *   - The "Audio Overview" entry is a `<div role="button">` with a Material-
 *     Symbols `audio_magic_eraser` icon. *One click* on it kicks off
 *     generation; there is no separate "Generate" step unless the user
 *     opens the per-card "Anpassen" sub-dialog first.
 *   - While generating, NotebookLM shows a "Audio-Zusammenfassung wird … —
 *     Kommen Sie in ein paar Minuten wieder" tile with a spinner.
 *   - When generation completes, NotebookLM mounts an `artifact-library-item`
 *     tile with a Play button (`button.artifact-action-button`, locale-bound
 *     aria-label "Wiedergeben"/"Play"/…) and a three-dot menu containing
 *     "Download" / "Herunterladen" / "Télécharger" / …. There is *no real*
 *     `<audio>` element in the DOM.
 *
 * Two operations:
 *   - `generateAudioOverview(page, opts)` — async by default: returns
 *     immediately with `status: "started"` after triggering the generation,
 *     so the caller doesn't block for the 5–10 minute render. Pass
 *     `waitForCompletion: true` for the legacy synchronous behaviour.
 *   - `downloadAudioOverview(page, destDir)` — opens the three-dot menu on
 *     the completed audio tile, clicks the "Download" item, and persists
 *     the file via Patchright's `download` event.
 *
 * Companion: `getAudioStatus(page)` — non-blocking status probe for callers
 * that want to poll without holding open a long-running RPC.
 */

import type { Page } from "patchright";
import fs from "node:fs/promises";
import path from "node:path";
import { Selectors, joinAlt } from "./selectors.js";
import { safeSleep, isRecoverable } from "../browser/watchdog.js";
import { log } from "../utils/logger.js";
import { CONFIG } from "../config.js";

export type AudioStatus = "ready" | "in_progress" | "not_started";

export interface GenerateAudioOptions {
  /** Optional focus prompt fed into the customise dialog before generation. */
  customPrompt?: string;
  /**
   * If `true`, block until the audio tile is ready (legacy behaviour). If
   * `false` (default), return immediately after triggering generation —
   * callers poll via `get_audio_status`.
   */
  waitForCompletion?: boolean;
  /** How long to wait when `waitForCompletion=true`. Default 10 min. */
  timeoutMs?: number;
}

export interface AudioGenerationResult {
  status: AudioStatus | "started" | "error";
  /** True when an Audio Overview already existed before this call. */
  alreadyExisted?: boolean;
  message?: string;
}

export async function generateAudioOverview(
  page: Page,
  options: GenerateAudioOptions = {}
): Promise<AudioGenerationResult> {
  const { customPrompt, waitForCompletion = false, timeoutMs = 600_000 } = options;

  try {
    // 1. Idempotency: if the completed audio tile is already mounted, the
    //    user already has an Audio Overview — report ready and do nothing.
    if (await audioIsReady(page)) {
      log.info("  ✅ Audio Overview already generated, skipping click");
      return { status: "ready", alreadyExisted: true };
    }

    // 2. Generation may already be running. Detect the spinner tile and
    //    skip clicking again — duplicate clicks would either be no-ops or
    //    spawn a parallel generation we'd then have to clean up.
    if (await audioGenerationInProgress(page)) {
      log.info("  ⏳ Audio Overview generation already running");
      if (waitForCompletion) {
        return await waitForAudioReady(page, timeoutMs);
      }
      return {
        status: "in_progress",
        message:
          "Audio Overview generation is already running. Poll `get_audio_status` " +
          "every ~30 s — the audio tile usually appears in 2–10 minutes.",
      };
    }

    // 3. The Studio panel can be collapsed by the user — expand it before
    //    we hunt for the card.
    await ensureStudioPanelExpanded(page);

    // 4. Trigger generation.
    if (customPrompt) {
      await openAudioCustomiseDialog(page);
      const overlay = page.locator(Selectors.sources.overlayPane).first();
      const promptField = overlay.locator("textarea, input[type='text']").first();
      if (await promptField.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await promptField.fill(customPrompt);
        await safeSleep(page, 200);
      }
      await clickFirstVisible(page, Selectors.studio.generateButton, "Generate button");
    } else {
      await clickFirstVisible(page, Selectors.studio.audioOverviewButton, "Audio overview entry");
    }

    log.info("  🎙️  Audio Overview generation triggered");

    // 5. Either return immediately (default async mode) or block until ready.
    if (!waitForCompletion) {
      return {
        status: "started",
        message:
          "Audio Overview generation started. It typically takes 2–10 minutes. " +
          "Poll `get_audio_status` to check completion, then call `download_audio`.",
      };
    }

    return await waitForAudioReady(page, timeoutMs);
  } catch (err) {
    if (isRecoverable(err)) throw err;
    log.warning(`  ⚠️  Audio generation failed: ${err}`);
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function waitForAudioReady(page: Page, timeoutMs: number): Promise<AudioGenerationResult> {
  const tile = page.locator(joinAlt(Selectors.studio.audioPlayer)).first();
  await tile.waitFor({ state: "visible", timeout: timeoutMs });
  return { status: "ready" };
}

/**
 * Non-blocking status probe used by the `get_audio_status` MCP tool.
 */
export async function getAudioStatusOnPage(page: Page): Promise<AudioGenerationResult> {
  try {
    if (await audioIsReady(page)) {
      return { status: "ready" };
    }
    if (await audioGenerationInProgress(page)) {
      return {
        status: "in_progress",
        message: "Audio Overview is still being generated.",
      };
    }
    return {
      status: "not_started",
      message: "No Audio Overview exists yet for this notebook.",
    };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function audioIsReady(page: Page): Promise<boolean> {
  return page
    .locator(joinAlt(Selectors.studio.audioPlayer))
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
}

/**
 * Detect a generation-in-progress tile. NotebookLM renders a tile with a
 * spinner and a localised "come back in a few minutes" message while it
 * works. Coverage spans EN, DE, FR, ES, IT, PT, NL, JA.
 */
const GENERATION_IN_PROGRESS_PHRASES = [
  // English
  "check back in a few minutes",
  "come back in a few minutes",
  "audio overview is being generated",
  "generating your audio",
  // German
  "kommen sie in ein paar minuten wieder",
  "audio-zusammenfassung wird erstellt",
  "audio-zusammenfassung wird gener",
  // French
  "revenez dans quelques minutes",
  "génération de l'aperçu audio",
  // Spanish
  "vuelve en unos minutos",
  "generando el resumen de audio",
  // Italian
  "torna tra qualche minuto",
  "generazione della panoramica audio",
  // Portuguese
  "volte em alguns minutos",
  "gerando a visão geral de áudio",
  // Dutch
  "kom over een paar minuten terug",
  "audio-overzicht wordt gegenereerd",
  // Japanese
  "数分後にもう一度ご確認ください",
  "音声の概要を生成しています",
];

async function audioGenerationInProgress(page: Page): Promise<boolean> {
  try {
    const studioText = await page
      .locator(".studio-panel")
      .first()
      .textContent({ timeout: 500 })
      .catch(() => null);
    if (!studioText) return false;
    const lower = studioText.toLowerCase();
    return GENERATION_IN_PROGRESS_PHRASES.some((p) => lower.includes(p));
  } catch {
    return false;
  }
}

/**
 * The Studio panel can be collapsed via the dock-arrow icon. When collapsed
 * the cards aren't in the DOM at all; click the expand-arrow first.
 */
async function ensureStudioPanelExpanded(page: Page): Promise<void> {
  const cardVisible = await page
    .locator(joinAlt(Selectors.studio.audioOverviewButton))
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (cardVisible) return;

  const expandSelectors = [
    'button:has(mat-icon:text-is("dock_to_left"))',
    'button[aria-label*="erweitern" i][aria-label*="studio" i]',
    'button[aria-label*="expand" i][aria-label*="studio" i]',
    'button[aria-label*="ouvrir" i][aria-label*="studio" i]',
    'button[aria-label*="abrir" i][aria-label*="studio" i]',
    'button[aria-label*="aprire" i][aria-label*="studio" i]',
  ];
  for (const sel of expandSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click().catch(() => undefined);
      await safeSleep(page, 400);
      return;
    }
  }
}

async function openAudioCustomiseDialog(page: Page): Promise<void> {
  const customiseSelectors = [
    'button[aria-label*="audio-zusammenfassung anpassen" i]',
    'button[aria-label*="audio" i][aria-label*="anpassen" i]',
    'button[aria-label*="customise audio" i]',
    'button[aria-label*="customize audio" i]',
    'button[aria-label*="personnaliser" i][aria-label*="audio" i]',
    'button[aria-label*="personalizar" i][aria-label*="audio" i]',
    'button[aria-label*="personalizza" i][aria-label*="audio" i]',
  ];
  await clickFirstVisible(page, customiseSelectors, "Audio customise button");
}

export interface DownloadAudioResult {
  success: boolean;
  filePath?: string;
  message?: string;
}

/**
 * Download the completed Audio Overview. Strategy:
 *   1. Verify the audio tile exists (else surface a clear error).
 *   2. Click the per-tile three-dot "Mehr"/"More" button to open the menu.
 *   3. Click the "Download" / "Herunterladen" / … menu item.
 *   4. Capture the resulting `download` event and save to `destinationDir`.
 */
export async function downloadAudioOverview(
  page: Page,
  destinationDir: string,
  preferredFileName: string = "notebooklm-audio.m4a"
): Promise<DownloadAudioResult> {
  try {
    const resolvedDestination = await prepareOutputDirectory(destinationDir);

    if (!(await audioIsReady(page))) {
      return {
        success: false,
        message:
          "No completed Audio Overview found. Trigger `generate_audio` first " +
          "and wait for `get_audio_status` to report `ready`.",
      };
    }

    // Open the three-dot menu on the audio tile.
    await clickFirstVisible(page, Selectors.studio.audioMoreMenuButton, "Audio more-menu button");
    await safeSleep(page, 250);

    // Now race the download event against the menu-item click.
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await clickFirstVisible(
      page,
      Selectors.studio.audioDownloadMenuItem,
      "Audio download menu item"
    );
    const download = await downloadPromise;

    const suggested = sanitizeDownloadName(download.suggestedFilename() || preferredFileName);
    const targetPath = await chooseAvailablePath(resolvedDestination, suggested);
    await download.saveAs(targetPath);

    return { success: true, filePath: targetPath };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    log.warning(`  ⚠️  Audio download failed: ${err}`);
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function resolveOutputDirectory(
  destinationDir: string,
  outputRoot = CONFIG.outputDir
): string {
  const allowedRoot = path.resolve(outputRoot);
  const requestedDir = destinationDir.trim() || ".";
  const targetPath = path.isAbsolute(requestedDir)
    ? path.resolve(requestedDir)
    : path.resolve(allowedRoot, requestedDir);
  const relative = path.relative(allowedRoot, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("OUTPUT_PATH_DENIED: destination_dir must be inside NOTEBOOKLM_OUTPUT_DIR");
  }
  return targetPath;
}

export async function prepareOutputDirectory(
  destinationDir: string,
  outputRoot = CONFIG.outputDir
): Promise<string> {
  const allowedRoot = path.resolve(outputRoot);
  const targetPath = resolveOutputDirectory(destinationDir, allowedRoot);
  await fs.mkdir(allowedRoot, { recursive: true });
  await fs.mkdir(targetPath, { recursive: true });

  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(allowedRoot),
    fs.realpath(targetPath),
  ]);
  const relative = path.relative(realRoot, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("OUTPUT_PATH_DENIED: destination_dir resolves outside NOTEBOOKLM_OUTPUT_DIR");
  }
  return realTarget;
}

export function sanitizeDownloadName(input: string): string {
  const base = path
    .basename(input)
    .replace(/[<>:"/\\|?*]/g, "_")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .trim();
  const safe = base.replace(/^\.+/, "").slice(0, 180);
  if (!safe) return "notebooklm-audio.m4a";
  return path.extname(safe) ? safe : `${safe}.m4a`;
}

async function chooseAvailablePath(directory: string, fileName: string): Promise<string> {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  for (let index = 0; index < 10_000; index++) {
    const candidate = path.join(directory, index === 0 ? fileName : `${stem}-${index}${extension}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("Unable to allocate a unique audio filename");
}

async function clickFirstVisible(
  page: Page,
  selectors: readonly string[],
  label: string
): Promise<void> {
  for (const sel of selectors) {
    const candidate = page.locator(sel).first();
    if (await candidate.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await candidate.click();
      await safeSleep(page, 300);
      return;
    }
  }
  throw new Error(
    `Could not find ${label} — selectors: ${selectors.join(" | ")}. ` +
      "NotebookLM Studio UI may have changed."
  );
}
