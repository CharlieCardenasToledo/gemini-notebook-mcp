import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "package.json");
const shrinkwrapPath = join(root, "npm-shrinkwrap.json");
const backupPath = join(root, ".npm-shrinkwrap.development.json");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function prepare() {
  if (await exists(backupPath)) {
    throw new Error("A development shrinkwrap backup already exists");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const developmentShrinkwrap = await readFile(shrinkwrapPath, "utf8");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "notebooklm-production-lock-"));
  let backupWritten = false;

  try {
    const productionManifest = { ...manifest };
    delete productionManifest.devDependencies;
    delete productionManifest.scripts;
    await writeFile(
      join(temporaryRoot, "package.json"),
      `${JSON.stringify(productionManifest, null, 2)}\n`,
      "utf8"
    );

    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is required to generate the production lock");
    const generated = spawnSync(
      process.execPath,
      [
        npmCli,
        "install",
        "--package-lock-only",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: temporaryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_dry_run: "false",
          npm_config_package_lock: "true",
        },
      }
    );
    if (generated.status !== 0) {
      throw new Error(generated.stderr || generated.stdout || "npm failed to generate lock");
    }

    const productionShrinkwrap = JSON.parse(
      await readFile(join(temporaryRoot, "package-lock.json"), "utf8")
    );
    const packages = Object.values(productionShrinkwrap.packages ?? {});
    if (packages.some((entry) => entry?.dev === true)) {
      throw new Error("Production shrinkwrap unexpectedly contains dev packages");
    }
    if (productionShrinkwrap.packages?.[""]?.devDependencies) {
      throw new Error("Production shrinkwrap root contains devDependencies");
    }

    await writeFile(backupPath, developmentShrinkwrap, "utf8");
    backupWritten = true;
    await writeFile(shrinkwrapPath, `${JSON.stringify(productionShrinkwrap, null, 2)}\n`, "utf8");
  } catch (error) {
    if (backupWritten) {
      await writeFile(shrinkwrapPath, developmentShrinkwrap, "utf8");
      await rm(backupPath, { force: true });
    }
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function restore() {
  if (!(await exists(backupPath))) {
    throw new Error("Development shrinkwrap backup is missing");
  }
  const developmentShrinkwrap = await readFile(backupPath, "utf8");
  await writeFile(shrinkwrapPath, developmentShrinkwrap, "utf8");
  await rm(backupPath, { force: true });
}

const action = process.argv[2];
if (action === "prepare") await prepare();
else if (action === "restore") await restore();
else throw new Error("Usage: package-shrinkwrap.mjs <prepare|restore>");
