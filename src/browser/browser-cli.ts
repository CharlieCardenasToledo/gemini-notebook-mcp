import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "patchright";

const require = createRequire(import.meta.url);

export function resolvePatchrightBin(
  manifest: { bin?: string | Record<string, string> },
  packageDir: string
): string {
  const bin =
    typeof manifest.bin === "string"
      ? manifest.bin
      : (manifest.bin?.["patchright"] ?? Object.values(manifest.bin ?? {})[0]);
  if (!bin || isAbsolute(bin) || bin.includes(".."))
    throw new Error("Patchright no expone un bin seguro.");
  const cli = resolve(packageDir, bin);
  if (
    !relative(packageDir, cli) ||
    relative(packageDir, cli).startsWith("..") ||
    !existsSync(cli)
  ) {
    throw new Error("El bin de Patchright no existe dentro de su paquete.");
  }
  return cli;
}

export function patchrightNodeModulesRoot(): string {
  return resolve(dirname(require.resolve("patchright/package.json")), "..");
}

export function isPathInside(root: string, candidate: string): boolean {
  const realRoot = realpathSync.native(root);
  const realCandidate = realpathSync.native(candidate);
  const suffix = relative(realRoot, realCandidate);
  return suffix !== "" && !isAbsolute(suffix) && !suffix.startsWith("..");
}

function patchrightCli(): string {
  const packageFile = require.resolve("patchright/package.json");
  const packageDir = dirname(packageFile);
  const manifest = require(packageFile) as { bin?: string | Record<string, string> };
  return resolvePatchrightBin(manifest, packageDir);
}

function status() {
  const executablePath = chromium.executablePath();
  const installed = Boolean(executablePath && existsSync(executablePath));
  const hermetic = !installed || isPathInside(patchrightNodeModulesRoot(), executablePath);
  return {
    browser: "chromium",
    installed: installed && hermetic,
    hermetic,
    executablePath: installed && hermetic ? executablePath : null,
    patchrightVersion: require("patchright/package.json").version,
  };
}

export function runPatchrightInstall(
  cli: string,
  spawnProcess: typeof spawn = spawn
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawnProcess(process.execPath, [cli, "install", "chromium"], {
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
    });
    let stderr = "";
    child.stdout?.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
      process.stderr.write(chunk);
    });
    child.once("error", (error) =>
      reject(
        new Error(
          `No se pudo iniciar Patchright (${process.platform}/${process.arch}, Node ${process.version}): ${error.message}`
        )
      )
    );
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const termination = code === null ? `signal ${signal ?? "desconocida"}` : `código ${code}`;
      reject(
        new Error(
          `Patchright terminó anómalamente con ${termination} (${process.platform}/${process.arch}, Node ${process.version}). Último stderr:\n${stderr || "(vacío)"}`
        )
      );
    });
  });
}

async function install() {
  const cli = patchrightCli();
  await runPatchrightInstall(cli);
  const result = status();
  if (!result.installed || !result.executablePath)
    throw new Error("Chromium no quedó instalado en el entorno hermético.");
  return result;
}

export async function runBrowserCli(args: string[]): Promise<void> {
  if ((args[0] !== "status" && args[0] !== "install") || args[1] !== "--json") {
    throw new Error("Uso: browser status --json | browser install --json");
  }
  const result = args[0] === "install" ? await install() : status();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
