/** Citation extraction for completed NotebookLM answers. */

import type { Page } from "patchright";
import { safeSleep } from "../browser/watchdog.js";
import { throwIfAborted } from "../utils/operation.js";
import { Selectors, joinAlt } from "./selectors.js";

export type SourceFormat = "none" | "inline" | "footnotes" | "json";

export interface Citation {
  marker: string;
  number: number;
  sourceName: string;
  sourceText: string;
  source_id: string | null;
  source_name: string;
  source_type: "web" | "youtube" | "pdf" | "audio" | "video" | "document" | "unknown";
  source_url: string | null;
  location: {
    page?: number;
    slide?: number;
    timestamp_seconds?: number;
  } | null;
  excerpt: string | null;
  extraction_status: "complete" | "partial" | "unavailable";
}

export interface ExtractCitationsResult {
  citations: Citation[];
  formattedAnswer: string;
}

export interface CitationExtractionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface CitationStub {
  number: number;
  sourceName: string;
  sourceId: string | null;
  sourceUrl: string | null;
}

export async function extractCitations(
  page: Page,
  answerText: string,
  format: SourceFormat = "none",
  options: CitationExtractionOptions = {}
): Promise<ExtractCitationsResult> {
  if (format === "none") {
    return { citations: [], formattedAnswer: answerText };
  }

  const { timeoutMs = 8_000, signal } = options;
  throwIfAborted(signal);
  const rawCitations = await readCitationStubs(page);
  throwIfAborted(signal);
  if (rawCitations.length === 0) {
    return { citations: [], formattedAnswer: answerText };
  }

  // Citation panels share one DOM region, so extraction remains sequential,
  // but one total budget prevents latency from growing with citation count.
  const citations: Citation[] = [];
  const deadline = Date.now() + timeoutMs;
  for (const stub of rawCitations) {
    throwIfAborted(signal);
    const remaining = deadline - Date.now();
    const excerpt =
      remaining > 0
        ? await extractExcerpt(page, stub.number, Math.min(1_500, remaining), signal)
        : "";
    const sourceText = excerpt || stub.sourceName;
    citations.push({
      marker: `[${stub.number}]`,
      number: stub.number,
      sourceName: stub.sourceName,
      sourceText,
      source_id: stub.sourceId,
      source_name: stub.sourceName,
      source_type: inferCitationSourceType(stub.sourceName, stub.sourceUrl),
      source_url: stub.sourceUrl,
      location: inferCitationLocation(`${stub.sourceName} ${excerpt}`),
      excerpt: excerpt || null,
      extraction_status: excerpt ? "complete" : stub.sourceName ? "partial" : "unavailable",
    });
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await safeSleep(page, 100);
  return {
    citations,
    formattedAnswer: formatAnswer(answerText, citations, format),
  };
}

async function readCitationStubs(page: Page): Promise<CitationStub[]> {
  try {
    return (await page.evaluate(
      ({ answerSelector, buttonSelector, labelSelector }) => {
        const containers = document.querySelectorAll(answerSelector);
        const scope = containers.length > 0 ? containers[containers.length - 1] : document;
        const buttons = scope.querySelectorAll(buttonSelector);
        const seen = new Set<number>();
        const out: CitationStub[] = [];
        buttons.forEach((button) => {
          const match = (button.textContent || "").match(/(\d+)/);
          if (!match) return;
          const number = Number.parseInt(match[1], 10);
          if (seen.has(number)) return;
          seen.add(number);
          const label = button.querySelector(labelSelector)?.getAttribute("aria-label") || "";
          const colon = label.indexOf(": ");
          const link = button.closest("a[href]") || button.querySelector("a[href]");
          out.push({
            number,
            sourceName: colon > 0 ? label.slice(colon + 2).trim() : label.trim(),
            sourceId:
              button.getAttribute("data-source-id") ||
              button.getAttribute("data-citation-id") ||
              null,
            sourceUrl: link?.getAttribute("href") || null,
          });
        });
        return out.sort((left, right) => left.number - right.number);
      },
      {
        answerSelector: Selectors.chat.answerText,
        buttonSelector: joinAlt(Selectors.citations.button),
        labelSelector: Selectors.citations.label,
      }
    )) as CitationStub[];
  } catch {
    return [];
  }
}

async function extractExcerpt(
  page: Page,
  number: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  try {
    throwIfAborted(signal);
    const clicked = await page.evaluate(
      ({ answerSelector, buttonSelector, citationNumber }) => {
        const containers = document.querySelectorAll(answerSelector);
        const scope = containers.length > 0 ? containers[containers.length - 1] : document;
        const buttons = scope.querySelectorAll(buttonSelector);
        for (const button of buttons) {
          const match = (button.textContent || "").match(/(\d+)/);
          if (match && Number.parseInt(match[1], 10) === citationNumber) {
            (button as HTMLElement).scrollIntoView?.({ block: "center" });
            (button as HTMLElement).click();
            return true;
          }
        }
        return false;
      },
      {
        answerSelector: Selectors.chat.answerText,
        buttonSelector: joinAlt(Selectors.citations.button),
        citationNumber: number,
      }
    );
    if (!clicked) return "";

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const text = (await page.evaluate(
        ({ highlightSelector, paragraphSelector }) => {
          const highlights = document.querySelectorAll(highlightSelector);
          if (highlights.length === 0) return "";
          const highlightedText = Array.from(highlights)
            .map((element) =>
              ((element as HTMLElement).innerText || element.textContent || "").trim()
            )
            .filter(Boolean)
            .join(" ");
          if (!highlightedText) return "";
          const parent = highlights[0].closest(paragraphSelector) || highlights[0].parentElement;
          const paragraphText = (
            (parent as HTMLElement | null)?.innerText ||
            parent?.textContent ||
            ""
          ).trim();
          return paragraphText.length > highlightedText.length ? paragraphText : highlightedText;
        },
        {
          highlightSelector: Selectors.citations.highlight,
          paragraphSelector: Selectors.citations.paragraph,
        }
      )) as string;
      if (text) {
        await page.keyboard.press("Escape").catch(() => undefined);
        return text;
      }
      await safeSleep(page, 150);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    return "";
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof Error && error.name === "OperationCancelledError") throw error;
    return "";
  }
}

function formatAnswer(answer: string, citations: Citation[], format: SourceFormat): string {
  if (format === "none" || citations.length === 0) return answer;

  if (format === "json") return answer;
  if (format === "inline") {
    let output = answer;
    for (const citation of citations) {
      const replacement = citation.sourceText
        ? `${citation.marker} (${citation.sourceName}: "${truncate(citation.sourceText, 200)}")`
        : `${citation.marker} (${citation.sourceName})`;
      output = output.split(citation.marker).join(replacement);
    }
    return output;
  }

  const footnotes = citations
    .map(
      (citation) =>
        `${citation.marker} ${citation.sourceName}${
          citation.sourceText && citation.sourceText !== citation.sourceName
            ? ` — "${truncate(citation.sourceText, 240)}"`
            : ""
        }`
    )
    .join("\n");
  return `${answer}\n\nSources:\n${footnotes}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function inferCitationSourceType(
  sourceName: string,
  sourceUrl: string | null
): Citation["source_type"] {
  const value = `${sourceName} ${sourceUrl ?? ""}`.toLowerCase();
  if (/youtube|youtu\.be/.test(value)) return "youtube";
  if (/\.pdf(?:\b|[?#])/.test(value)) return "pdf";
  if (/\.(?:mp3|m4a|wav|ogg)(?:\b|[?#])/.test(value)) return "audio";
  if (/\.(?:mp4|mov|webm)(?:\b|[?#])/.test(value)) return "video";
  if (/^https?:/.test(sourceUrl ?? "")) return "web";
  if (/\.(?:docx?|pptx?|xlsx?|epub|txt)(?:\b|[?#])/.test(value)) return "document";
  return "unknown";
}

function inferCitationLocation(text: string): Citation["location"] {
  const page = text.match(/(?:page|página|seite|pagina|ページ)\s*(\d+)/i);
  if (page) return { page: Number(page[1]) };
  const slide = text.match(/(?:slide|diapositiva|folie|スライド)\s*(\d+)/i);
  if (slide) return { slide: Number(slide[1]) };
  const timestamp = text.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
  if (timestamp) {
    return {
      timestamp_seconds:
        Number(timestamp[1] ?? 0) * 3600 + Number(timestamp[2]) * 60 + Number(timestamp[3]),
    };
  }
  return null;
}
