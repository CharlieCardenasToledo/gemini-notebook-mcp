/**
 * Constrained cleanup for NotebookLM MCP-owned data.
 *
 * The MCP tool intentionally cannot scan or delete npm caches, editor logs,
 * other applications' data, the system temporary directory, or trash. A
 * separate preview/confirm handshake binds execution to an unchanged path
 * manifest under the configured NOTEBOOKLM_DATA_DIR.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";

export type CleanupMode = "data";

export interface CleanupCategory {
  name: string;
  description: string;
  paths: string[];
  totalBytes: number;
  optional: false;
}

export interface CleanupPreview {
  mode: CleanupMode;
  previewToken: string;
  expiresAt: string;
  pathDigest: string;
  preserveLibrary: boolean;
  categories: CleanupCategory[];
  totalPaths: string[];
  totalSizeBytes: number;
}

export interface CleanupResult {
  success: boolean;
  mode: CleanupMode;
  deletedPaths: string[];
  failedPaths: string[];
  totalSizeBytes: number;
  categorySummary: Record<string, { count: number; bytes: number }>;
}

interface StoredPreview {
  expiresAtMs: number;
  preserveLibrary: boolean;
  pathDigest: string;
  targetPaths: string[];
  totalSizeBytes: number;
}

interface Snapshot {
  categories: CleanupCategory[];
  targetPaths: string[];
  totalPaths: string[];
  totalSizeBytes: number;
  pathDigest: string;
}

const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;

export class CleanupManager {
  private readonly dataDir: string;
  private readonly previewTtlMs: number;
  private readonly previews = new Map<string, StoredPreview>();

  constructor(dataDir = CONFIG.dataDir, previewTtlMs = DEFAULT_PREVIEW_TTL_MS) {
    this.dataDir = path.resolve(dataDir);
    this.previewTtlMs = previewTtlMs;
    this.assertSafeConfiguredRoot();
  }

  async createPreview(preserveLibrary = false): Promise<CleanupPreview> {
    this.pruneExpiredPreviews();
    const snapshot = await this.buildSnapshot(preserveLibrary);
    const previewToken = randomBytes(32).toString("base64url");
    const expiresAtMs = Date.now() + this.previewTtlMs;

    this.previews.set(previewToken, {
      expiresAtMs,
      preserveLibrary,
      pathDigest: snapshot.pathDigest,
      targetPaths: snapshot.targetPaths,
      totalSizeBytes: snapshot.totalSizeBytes,
    });

    return {
      mode: "data",
      previewToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
      pathDigest: snapshot.pathDigest,
      preserveLibrary,
      categories: snapshot.categories,
      totalPaths: snapshot.totalPaths,
      totalSizeBytes: snapshot.totalSizeBytes,
    };
  }

  async performCleanup(previewToken: string): Promise<CleanupResult> {
    this.pruneExpiredPreviews();
    const stored = this.previews.get(previewToken);
    this.previews.delete(previewToken);

    if (!stored) {
      throw new Error("Cleanup preview token is missing, expired, or already used");
    }

    const current = await this.buildSnapshot(stored.preserveLibrary);
    if (
      current.pathDigest !== stored.pathDigest ||
      !samePaths(current.targetPaths, stored.targetPaths)
    ) {
      throw new Error(
        "Cleanup targets changed after preview; generate a new preview before deleting"
      );
    }

    const deletedPaths: string[] = [];
    const failedPaths: string[] = [];
    let deletedBytes = 0;

    for (const targetPath of stored.targetPaths) {
      try {
        await this.assertSafeTarget(targetPath);
        if (await pathExists(targetPath)) {
          await fs.rm(targetPath, { recursive: true, force: true });
          deletedPaths.push(targetPath);
        }
      } catch (error) {
        log.error(`Cleanup failed for an owned data path: ${error}`);
        failedPaths.push(targetPath);
      }
    }

    if (failedPaths.length === 0) {
      deletedBytes = stored.totalSizeBytes;
    }

    return {
      success: failedPaths.length === 0,
      mode: "data",
      deletedPaths,
      failedPaths,
      totalSizeBytes: deletedBytes,
      categorySummary: {
        "NotebookLM MCP data": { count: deletedPaths.length, bytes: deletedBytes },
      },
    };
  }

  private async buildSnapshot(preserveLibrary: boolean): Promise<Snapshot> {
    this.assertSafeConfiguredRoot();
    if (!(await pathExists(this.dataDir))) {
      const pathDigest = digestManifest([]);
      return {
        categories: [],
        targetPaths: [],
        totalPaths: [],
        totalSizeBytes: 0,
        pathDigest,
      };
    }

    const rootStats = await fs.lstat(this.dataDir);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new Error("Configured data directory must be a real directory, not a symbolic link");
    }

    const targetPaths = preserveLibrary
      ? (await fs.readdir(this.dataDir, { withFileTypes: true }))
          .filter((entry) => entry.name !== "library.json")
          .map((entry) => path.join(this.dataDir, entry.name))
          .sort()
      : [this.dataDir];

    const manifest: string[] = [];
    let totalSizeBytes = 0;
    for (const targetPath of targetPaths) {
      await this.assertSafeTarget(targetPath);
      const measured = await this.walkManifest(targetPath, manifest);
      totalSizeBytes += measured;
    }

    const totalPaths = manifest.map((entry) => entry.split("\0", 1)[0]);
    const categories: CleanupCategory[] =
      targetPaths.length === 0
        ? []
        : [
            {
              name: "NotebookLM MCP data",
              description: preserveLibrary
                ? "Configured data directory contents except library.json"
                : "Configured NOTEBOOKLM_DATA_DIR only",
              paths: targetPaths,
              totalBytes: totalSizeBytes,
              optional: false,
            },
          ];

    return {
      categories,
      targetPaths,
      totalPaths,
      totalSizeBytes,
      pathDigest: digestManifest(manifest),
    };
  }

  private async walkManifest(entryPath: string, manifest: string[]): Promise<number> {
    this.assertContained(entryPath);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error("Cleanup refuses symbolic links inside NOTEBOOKLM_DATA_DIR");
    }

    const relativePath = path.relative(this.dataDir, entryPath) || ".";
    const kind = stats.isDirectory() ? "directory" : "file";
    manifest.push(`${relativePath}\0${kind}\0${stats.size}\0${Math.trunc(stats.mtimeMs)}`);

    if (!stats.isDirectory()) return stats.size;

    let total = 0;
    const children = (await fs.readdir(entryPath)).sort();
    for (const child of children) {
      total += await this.walkManifest(path.join(entryPath, child), manifest);
    }
    return total;
  }

  private async assertSafeTarget(targetPath: string): Promise<void> {
    this.assertContained(targetPath);
    if (await pathExists(targetPath)) {
      const stats = await fs.lstat(targetPath);
      if (stats.isSymbolicLink()) {
        throw new Error("Cleanup target cannot be a symbolic link");
      }
    }
  }

  private assertContained(targetPath: string): void {
    const resolved = path.resolve(targetPath);
    const relative = path.relative(this.dataDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Cleanup target escapes NOTEBOOKLM_DATA_DIR");
    }
  }

  private assertSafeConfiguredRoot(): void {
    const protectedRoots = new Set([
      path.parse(this.dataDir).root,
      path.resolve(os.homedir()),
      path.resolve(process.cwd()),
    ]);
    if (protectedRoots.has(this.dataDir)) {
      throw new Error("Refusing to use a broad or protected directory as NOTEBOOKLM_DATA_DIR");
    }
  }

  private pruneExpiredPreviews(): void {
    const now = Date.now();
    for (const [token, preview] of this.previews) {
      if (preview.expiresAtMs <= now) this.previews.delete(token);
    }
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const unit = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(unit)), sizes.length - 1);
    return `${Number.parseFloat((bytes / Math.pow(unit, index)).toFixed(2))} ${sizes[index]}`;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function digestManifest(manifest: string[]): string {
  return createHash("sha256")
    .update([...manifest].sort().join("\n"))
    .digest("hex");
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
