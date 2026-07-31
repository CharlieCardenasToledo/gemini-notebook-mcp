import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CONFIG } from "../config.js";

export type ArtifactType = "audio_overview";
export type ArtifactJobStatus = "started" | "in_progress" | "ready" | "error";

export interface ArtifactJob {
  job_id: string;
  artifact_id: string | null;
  artifact_type: ArtifactType;
  owner_id: string;
  notebook_url: string;
  status: ArtifactJobStatus;
  created_at: string;
  updated_at: string;
  message?: string;
  file_path?: string;
}

const artifactJobSchema = z.object({
  job_id: z.string().uuid(),
  artifact_id: z.string().nullable(),
  artifact_type: z.literal("audio_overview"),
  owner_id: z.string().min(1),
  notebook_url: z.string().min(1),
  status: z.enum(["started", "in_progress", "ready", "error"]),
  created_at: z.string(),
  updated_at: z.string(),
  message: z.string().optional(),
  file_path: z.string().optional(),
});

const artifactStoreSchema = z.object({
  version: z.literal("1.0.0"),
  jobs: z.array(artifactJobSchema),
});

export class ArtifactStore {
  private readonly storePath: string;
  private jobs: ArtifactJob[];

  constructor(storePath = path.join(CONFIG.dataDir, "artifact-jobs.json")) {
    this.storePath = storePath;
    this.jobs = this.load();
  }

  create(ownerId: string, notebookUrl: string, artifactType: ArtifactType): ArtifactJob {
    const active = this.jobs.find(
      (job) =>
        job.owner_id === ownerId &&
        job.notebook_url === notebookUrl &&
        job.artifact_type === artifactType &&
        (job.status === "started" || job.status === "in_progress")
    );
    if (active) return { ...active };

    const now = new Date().toISOString();
    const job: ArtifactJob = {
      job_id: randomUUID(),
      artifact_id: null,
      artifact_type: artifactType,
      owner_id: ownerId,
      notebook_url: notebookUrl,
      status: "started",
      created_at: now,
      updated_at: now,
    };
    this.jobs.push(job);
    this.save();
    return { ...job };
  }

  update(
    jobId: string,
    ownerId: string,
    patch: Partial<Pick<ArtifactJob, "status" | "artifact_id" | "message" | "file_path">>
  ): ArtifactJob | null {
    const index = this.jobs.findIndex((job) => job.job_id === jobId && job.owner_id === ownerId);
    if (index < 0) return null;
    this.jobs[index] = {
      ...this.jobs[index],
      ...patch,
      updated_at: new Date().toISOString(),
    };
    this.save();
    return { ...this.jobs[index] };
  }

  get(jobId: string, ownerId: string): ArtifactJob | null {
    const job = this.jobs.find((entry) => entry.job_id === jobId && entry.owner_id === ownerId);
    return job ? { ...job } : null;
  }

  list(ownerId: string, notebookUrl?: string): ArtifactJob[] {
    return this.jobs
      .filter(
        (job) => job.owner_id === ownerId && (!notebookUrl || job.notebook_url === notebookUrl)
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map((job) => ({ ...job }));
  }

  private load(): ArtifactJob[] {
    try {
      if (!fs.existsSync(this.storePath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.storePath, "utf8"));
      return artifactStoreSchema.parse(raw).jobs;
    } catch {
      if (fs.existsSync(this.storePath)) {
        fs.copyFileSync(this.storePath, `${this.storePath}.corrupt-${Date.now()}`);
      }
      return [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const temporaryPath = `${this.storePath}.${process.pid}.tmp`;
    const payload = JSON.stringify({ version: "1.0.0", jobs: this.jobs }, null, 2);
    try {
      fs.writeFileSync(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, this.storePath);
    } catch (error) {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      throw error;
    }
  }
}
