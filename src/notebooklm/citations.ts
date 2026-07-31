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
    if (remaining <= 0) break;
    const sourceText = await extractExcerpt(page, stub.number, Math.min(1_500, remaining), signal);
    citations.push({
      marker: `[${stub.number}]`,
      number: stub.number,
      sourceName: stub.sourceName,
      sourceText: sourceText || stub.sourceName,
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
          out.push({
            number,
            sourceName: colon > 0 ? label.slice(colon + 2).trim() : label.trim(),
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
            (button as HTMLElement).scrollIntoView({ block: "center" });
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
            .map((element) => ((element as HTMLElement).innerText || "").trim())
            .filter(Boolean)
            .join(" ");
          if (!highlightedText) return "";
          const parent = highlights[0].closest(paragraphSelector) || highlights[0].parentElement;
          const paragraphText = ((parent as HTMLElement | null)?.innerText || "").trim();
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
