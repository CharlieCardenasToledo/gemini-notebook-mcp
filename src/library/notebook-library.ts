/**
 * NotebookLM Library Manager
 *
 * Manages a persistent library of NotebookLM notebooks.
 * Allows Claude to autonomously add, remove, and switch between
 * multiple notebooks based on the task at hand.
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { CONFIG } from "../config.js";
import { hashLogValue, log } from "../utils/logger.js";
import type {
  NotebookEntry,
  Library,
  AddNotebookInput,
  UpdateNotebookInput,
  LibraryStats,
  AccountNotebookRecord,
  LibrarySyncResult,
} from "./types.js";
import { normalizeNotebookUrl } from "../notebooklm/url.js";
import { z } from "zod";

const notebookEntrySchema = z.object({
  id: z.string().min(1),
  slug: z.string().optional(),
  google_notebook_id: z.string().optional(),
  url: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  topics: z.array(z.string()).default([]),
  content_types: z.array(z.string()).default([]),
  use_cases: z.array(z.string()).default([]),
  added_at: z.string(),
  last_used: z.string(),
  use_count: z.number().int().nonnegative().default(0),
  tags: z.array(z.string()).optional(),
  source_count: z.number().int().nonnegative().nullable().optional(),
  sync_status: z.enum(["available", "missing", "unknown"]).optional(),
  last_synced_at: z.string().optional(),
});

const librarySchema = z.object({
  notebooks: z.array(notebookEntrySchema),
  active_notebook_id: z.string().nullable(),
  last_modified: z.string(),
  version: z.string(),
});

export class NotebookLibrary {
  private libraryPath: string;
  private library: Library;

  constructor(libraryPath = path.join(CONFIG.dataDir, "library.json")) {
    this.libraryPath = libraryPath;
    this.library = this.loadLibrary();

    log.info("📚 NotebookLibrary initialized");
    log.diagnostic("Library path", this.libraryPath);
    log.info(`  Notebooks: ${this.library.notebooks.length}`);
    if (this.library.active_notebook_id) {
      log.info(`  Active notebook hash: ${hashLogValue(this.library.active_notebook_id)}`);
    }
  }

  /**
   * Load library from disk, or create default if not exists
   */
  private loadLibrary(): Library {
    try {
      if (fs.existsSync(this.libraryPath)) {
        const data = fs.readFileSync(this.libraryPath, "utf-8");
        const library = librarySchema.parse(JSON.parse(data)) as Library;
        log.success(`  ✅ Loaded library with ${library.notebooks.length} notebooks`);
        return library;
      }
    } catch (error) {
      log.warning(`  ⚠️  Failed to load library: ${error}`);
      if (fs.existsSync(this.libraryPath)) {
        const backupPath = `${this.libraryPath}.corrupt-${Date.now()}`;
        fs.copyFileSync(this.libraryPath, backupPath);
        log.warning(`  🛟 Preserved unreadable library for diagnostics`);
        log.diagnostic("Unreadable library backup", backupPath);
      }
    }

    // Create default library with current CONFIG as first entry
    log.info("  🆕 Creating new library...");
    const defaultLibrary = this.createDefaultLibrary();
    this.saveLibrary(defaultLibrary);
    return defaultLibrary;
  }

  /**
   * Create default library from current CONFIG
   */
  private createDefaultLibrary(): Library {
    const hasConfig =
      CONFIG.notebookUrl &&
      CONFIG.notebookDescription &&
      CONFIG.notebookDescription !==
        "General knowledge base - configure NOTEBOOK_DESCRIPTION to help Claude understand what's in this notebook";

    const notebooks: NotebookEntry[] = [];

    if (hasConfig) {
      // Create first entry from CONFIG
      const id = randomUUID();
      const normalizedUrl = normalizeNotebookUrl(CONFIG.notebookUrl);
      notebooks.push({
        id,
        slug: this.generateSlug(CONFIG.notebookDescription),
        google_notebook_id: this.extractGoogleNotebookId(normalizedUrl),
        url: normalizedUrl,
        name: CONFIG.notebookDescription.substring(0, 50), // First 50 chars as name
        description: CONFIG.notebookDescription,
        topics: CONFIG.notebookTopics,
        content_types: CONFIG.notebookContentTypes,
        use_cases: CONFIG.notebookUseCases,
        added_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 0,
        tags: [],
        sync_status: "unknown",
      });

      log.success(`  ✅ Created default notebook: ${hashLogValue(id)}`);
    }

    return {
      notebooks,
      active_notebook_id: notebooks.length > 0 ? notebooks[0].id : null,
      last_modified: new Date().toISOString(),
      version: "2.0.0",
    };
  }

  /**
   * Save library to disk
   */
  private saveLibrary(library: Library): void {
    const temporaryPath = `${this.libraryPath}.${process.pid}.tmp`;
    try {
      library.last_modified = new Date().toISOString();
      const data = JSON.stringify(library, null, 2);
      fs.writeFileSync(temporaryPath, data, { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(temporaryPath, this.libraryPath);
      this.library = library;
      log.success(`  💾 Library saved (${library.notebooks.length} notebooks)`);
    } catch (error) {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
      log.error(`  ❌ Failed to save library: ${error}`);
      throw error;
    }
  }

  /**
   * Generate a unique ID from a string (slug format)
   */
  private generateSlug(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 30);

    const safeBase = base || "notebook";
    let id = safeBase;
    let counter = 1;
    while (this.library.notebooks.some((n) => n.slug === id)) {
      id = `${safeBase}-${counter}`;
      counter++;
    }

    return id;
  }

  /**
   * Add a new notebook to the library
   */
  addNotebook(input: AddNotebookInput): NotebookEntry {
    log.info(`📝 Adding notebook (${input.name.length} name characters)`);
    const normalizedUrl = normalizeNotebookUrl(input.url);
    const googleNotebookId = this.extractGoogleNotebookId(normalizedUrl);
    const existing = this.library.notebooks.find(
      (notebook) =>
        notebook.url === normalizedUrl ||
        (googleNotebookId && notebook.google_notebook_id === googleNotebookId)
    );
    if (existing) {
      throw new Error(`Notebook is already registered: ${existing.id}`);
    }

    const id = randomUUID();

    // Create entry
    const notebook: NotebookEntry = {
      id,
      slug: this.generateSlug(input.name),
      google_notebook_id: googleNotebookId,
      url: normalizedUrl,
      name: input.name,
      description: input.description,
      topics: input.topics,
      content_types: input.content_types || ["documentation", "examples"],
      use_cases: input.use_cases || [
        `Learning about ${input.name}`,
        `Implementing features with ${input.name}`,
      ],
      added_at: new Date().toISOString(),
      last_used: new Date().toISOString(),
      use_count: 0,
      tags: input.tags || [],
      sync_status: "unknown",
    };

    // Add to library
    const updated = { ...this.library, notebooks: [...this.library.notebooks] };
    updated.notebooks.push(notebook);

    // Set as active if it's the first notebook
    if (updated.notebooks.length === 1) {
      updated.active_notebook_id = id;
    }

    this.saveLibrary(updated);
    log.success(`✅ Notebook added: ${hashLogValue(id)}`);

    return notebook;
  }

  /**
   * List all notebooks in library
   */
  listNotebooks(): NotebookEntry[] {
    return this.library.notebooks.map((notebook) => ({
      ...notebook,
      topics: [...notebook.topics],
      content_types: [...notebook.content_types],
      use_cases: [...notebook.use_cases],
      ...(notebook.tags && { tags: [...notebook.tags] }),
    }));
  }

  /**
   * Get a specific notebook by ID
   */
  getNotebook(id: string): NotebookEntry | null {
    const notebook = this.library.notebooks.find((n) => n.id === id);
    return notebook
      ? {
          ...notebook,
          topics: [...notebook.topics],
          content_types: [...notebook.content_types],
          use_cases: [...notebook.use_cases],
          ...(notebook.tags && { tags: [...notebook.tags] }),
        }
      : null;
  }

  /**
   * Get the currently active notebook
   */
  getActiveNotebook(): NotebookEntry | null {
    if (!this.library.active_notebook_id) {
      return null;
    }
    return this.getNotebook(this.library.active_notebook_id);
  }

  /**
   * Select a notebook as active
   */
  selectNotebook(id: string): NotebookEntry {
    const notebook = this.getNotebook(id);
    if (!notebook) {
      throw new Error(`Notebook not found: ${id}`);
    }

    log.info(`🎯 Selecting notebook: ${hashLogValue(id)}`);

    const updated = { ...this.library, notebooks: [...this.library.notebooks] };
    updated.active_notebook_id = id;

    // Update last_used
    const notebookIndex = updated.notebooks.findIndex((n) => n.id === id);
    updated.notebooks[notebookIndex] = {
      ...notebook,
      last_used: new Date().toISOString(),
    };

    this.saveLibrary(updated);
    log.success(`✅ Active notebook: ${hashLogValue(id)}`);

    return updated.notebooks[notebookIndex];
  }

  /**
   * Update notebook metadata
   */
  updateNotebook(input: UpdateNotebookInput): NotebookEntry {
    const notebook = this.getNotebook(input.id);
    if (!notebook) {
      throw new Error(`Notebook not found: ${input.id}`);
    }

    log.info(`📝 Updating notebook: ${hashLogValue(input.id)}`);

    const normalizedUrl = input.url !== undefined ? normalizeNotebookUrl(input.url) : undefined;
    const googleNotebookId = normalizedUrl
      ? this.extractGoogleNotebookId(normalizedUrl)
      : undefined;
    const previousGoogleNotebookId =
      notebook.google_notebook_id ?? this.extractGoogleNotebookId(notebook.url);
    const identityChanged =
      normalizedUrl !== undefined && googleNotebookId !== previousGoogleNotebookId;

    if (normalizedUrl !== undefined) {
      const duplicate = this.library.notebooks.find((candidate) => {
        if (candidate.id === input.id) {
          return false;
        }

        const candidateGoogleNotebookId =
          candidate.google_notebook_id ?? this.extractGoogleNotebookId(candidate.url);

        return (
          candidate.url === normalizedUrl ||
          (googleNotebookId !== undefined && candidateGoogleNotebookId === googleNotebookId)
        );
      });

      if (duplicate) {
        throw new Error(`Notebook is already registered: ${duplicate.id}`);
      }
    }

    const updated = { ...this.library, notebooks: [...this.library.notebooks] };
    const index = updated.notebooks.findIndex((n) => n.id === input.id);

    updated.notebooks[index] = {
      ...notebook,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.topics !== undefined && { topics: input.topics }),
      ...(input.content_types !== undefined && { content_types: input.content_types }),
      ...(input.use_cases !== undefined && { use_cases: input.use_cases }),
      ...(input.tags !== undefined && { tags: input.tags }),
      ...(normalizedUrl !== undefined && {
        url: normalizedUrl,
        google_notebook_id: googleNotebookId,
      }),
      ...(identityChanged && {
        source_count: null,
        sync_status: "unknown" as const,
        last_synced_at: undefined,
      }),
    };

    this.saveLibrary(updated);
    log.success(`✅ Notebook updated: ${hashLogValue(input.id)}`);

    return updated.notebooks[index];
  }

  /**
   * Remove notebook from library
   */
  removeNotebook(id: string): boolean {
    const notebook = this.getNotebook(id);
    if (!notebook) {
      return false;
    }

    log.info(`🗑️  Removing notebook: ${hashLogValue(id)}`);

    const updated = { ...this.library, notebooks: [...this.library.notebooks] };
    updated.notebooks = updated.notebooks.filter((n) => n.id !== id);

    // If we removed the active notebook, select another one
    if (updated.active_notebook_id === id) {
      updated.active_notebook_id = updated.notebooks.length > 0 ? updated.notebooks[0].id : null;
    }

    this.saveLibrary(updated);
    log.success(`✅ Notebook removed: ${hashLogValue(id)}`);

    return true;
  }

  /**
   * Increment use count for a notebook
   */
  incrementUseCount(id: string): NotebookEntry | null {
    const notebookIndex = this.library.notebooks.findIndex((n) => n.id === id);
    if (notebookIndex === -1) {
      return null;
    }

    const notebook = this.library.notebooks[notebookIndex];
    const updated = { ...this.library, notebooks: [...this.library.notebooks] };
    const updatedNotebook: NotebookEntry = {
      ...notebook,
      use_count: notebook.use_count + 1,
      last_used: new Date().toISOString(),
    };

    updated.notebooks[notebookIndex] = updatedNotebook;
    this.saveLibrary(updated);

    return updatedNotebook;
  }

  /**
   * Get library statistics
   */
  getStats(): LibraryStats {
    const totalQueries = this.library.notebooks.reduce((sum, n) => sum + n.use_count, 0);

    const mostUsed = this.library.notebooks.reduce(
      (max, n) => (n.use_count > (max?.use_count || 0) ? n : max),
      null as NotebookEntry | null
    );

    return {
      total_notebooks: this.library.notebooks.length,
      active_notebook: this.library.active_notebook_id,
      most_used_notebook: mostUsed?.id || null,
      total_queries: totalQueries,
      last_modified: this.library.last_modified,
    };
  }

  /**
   * Search notebooks by query (searches name, description, topics)
   */
  searchNotebooks(query: string): NotebookEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.listNotebooks().filter(
      (n) =>
        n.name.toLowerCase().includes(lowerQuery) ||
        n.description.toLowerCase().includes(lowerQuery) ||
        n.topics.some((t) => t.toLowerCase().includes(lowerQuery)) ||
        n.tags?.some((t) => t.toLowerCase().includes(lowerQuery))
    );
  }

  importAccountNotebook(
    accountNotebook: AccountNotebookRecord,
    metadata: Partial<
      Pick<AddNotebookInput, "description" | "topics" | "content_types" | "use_cases" | "tags">
    > = {}
  ): NotebookEntry {
    const normalizedUrl = normalizeNotebookUrl(accountNotebook.url);
    const existing = this.library.notebooks.find(
      (notebook) =>
        notebook.google_notebook_id === accountNotebook.id || notebook.url === normalizedUrl
    );
    if (existing) return this.getNotebook(existing.id)!;

    const now = new Date().toISOString();
    const notebook: NotebookEntry = {
      id: randomUUID(),
      slug: this.generateSlug(accountNotebook.name),
      google_notebook_id: accountNotebook.id,
      url: normalizedUrl,
      name: accountNotebook.name,
      description: metadata.description ?? "",
      topics: metadata.topics ?? [],
      content_types: metadata.content_types ?? [],
      use_cases: metadata.use_cases ?? [],
      tags: metadata.tags ?? [],
      added_at: now,
      last_used: now,
      use_count: 0,
      source_count: accountNotebook.sourceCount,
      sync_status: "available",
      last_synced_at: now,
    };
    const updated = { ...this.library, notebooks: [...this.library.notebooks, notebook] };
    if (!updated.active_notebook_id) updated.active_notebook_id = notebook.id;
    updated.version = "2.0.0";
    this.saveLibrary(updated);
    return this.getNotebook(notebook.id)!;
  }

  syncAccountNotebooks(
    accountNotebooks: AccountNotebookRecord[],
    apply = false
  ): LibrarySyncResult {
    const now = new Date().toISOString();
    const accountById = new Map(accountNotebooks.map((notebook) => [notebook.id, notebook]));
    const existingByGoogleId = new Map(
      this.library.notebooks
        .filter((notebook) => notebook.google_notebook_id)
        .map((notebook) => [notebook.google_notebook_id!, notebook])
    );
    const added: NotebookEntry[] = [];
    const updatedEntries: NotebookEntry[] = [];
    const missing: NotebookEntry[] = [];
    let unchanged = 0;

    for (const accountNotebook of accountNotebooks) {
      const normalizedUrl = normalizeNotebookUrl(accountNotebook.url);
      const local =
        existingByGoogleId.get(accountNotebook.id) ??
        this.library.notebooks.find((notebook) => notebook.url === normalizedUrl);
      if (!local) {
        added.push(this.createSyncedEntry(accountNotebook, normalizedUrl, now));
        continue;
      }
      const changed =
        local.name !== accountNotebook.name ||
        local.url !== normalizedUrl ||
        local.google_notebook_id !== accountNotebook.id ||
        local.source_count !== accountNotebook.sourceCount ||
        local.sync_status !== "available";
      if (changed) {
        updatedEntries.push({
          ...local,
          name: accountNotebook.name,
          url: normalizedUrl,
          google_notebook_id: accountNotebook.id,
          source_count: accountNotebook.sourceCount,
          sync_status: "available",
          last_synced_at: now,
        });
      } else {
        unchanged++;
      }
    }

    for (const local of this.library.notebooks) {
      const googleId = local.google_notebook_id ?? this.extractGoogleNotebookId(local.url);
      if (googleId && !accountById.has(googleId)) {
        missing.push({
          ...local,
          google_notebook_id: googleId,
          sync_status: "missing",
          last_synced_at: now,
        });
      }
    }

    if (apply) {
      const replacements = new Map(
        [...updatedEntries, ...missing].map((notebook) => [notebook.id, notebook])
      );
      const notebooks = this.library.notebooks.map(
        (notebook) => replacements.get(notebook.id) ?? notebook
      );
      notebooks.push(...added);
      const next = { ...this.library, notebooks, version: "2.0.0" };
      if (!next.active_notebook_id && notebooks.length > 0) {
        next.active_notebook_id = notebooks[0].id;
      }
      this.saveLibrary(next);
    }

    return {
      applied: apply,
      added: added.map((entry) => ({ ...entry })),
      updated: updatedEntries.map((entry) => ({ ...entry })),
      missing: missing.map((entry) => ({ ...entry })),
      unchanged,
    };
  }

  private createSyncedEntry(
    accountNotebook: AccountNotebookRecord,
    normalizedUrl: string,
    now: string
  ): NotebookEntry {
    return {
      id: randomUUID(),
      slug: this.generateSlug(accountNotebook.name),
      google_notebook_id: accountNotebook.id,
      url: normalizedUrl,
      name: accountNotebook.name,
      description: "",
      topics: [],
      content_types: [],
      use_cases: [],
      tags: [],
      added_at: now,
      last_used: now,
      use_count: 0,
      source_count: accountNotebook.sourceCount,
      sync_status: "available",
      last_synced_at: now,
    };
  }

  private extractGoogleNotebookId(url: string): string | undefined {
    return url.match(/\/notebook\/([^/?#]+)/)?.[1];
  }
}
