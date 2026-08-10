import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { existsSync as exists } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PACKAGE_NAME = "@charlie.act7/gemini-notebook-mcp";
const REGISTRY = "https://registry.npmjs.org";
const version = process.argv[2];
let tempRoot;
let context = { version, action: "startup" };

function fail(message) {
  throw new Error(message);
}

function bounded(value, limit = 4000) {
  return String(value ?? "").slice(-limit);
}

async function run(command, args, action) {
  context = { ...context, action };
  try {
    return await exec(command, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch (error) {
    error.action = action;
    throw error;
  }
}

function parseJson(stdout, action) {
  try {
    return JSON.parse(stdout);
  } catch {
    fail(`${action} stdout was not valid JSON`);
  }
}

function assertChromium(result, action, installedRequired) {
  if (result.browser !== "chromium") fail(`${action}: browser is not chromium`);
  if (typeof result.patchrightVersion !== "string" || !result.patchrightVersion) {
    fail(`${action}: patchrightVersion is missing`);
  }
  if (installedRequired && (result.installed !== true || result.hermetic !== true)) {
    fail(`${action}: installed/hermetic contract failed`);
  }
}

async function assertExecutable(result, nodeModulesRoot, action) {
  if (typeof result.executablePath !== "string" || !result.executablePath) {
    fail(`${action}: executablePath is missing`);
  }
  if (!exists(result.executablePath) || !(await stat(result.executablePath)).isFile()) {
    fail(`${action}: executablePath is not a file`);
  }
  const root = await realpath(nodeModulesRoot);
  const executable = await realpath(result.executablePath);
  const relative = path.relative(root, executable);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    fail(`${action}: executablePath is outside the isolated node_modules`);
  }
  return executable;
}

async function printDiagnostics(error) {
  console.error("[registry-browser-smoke] failure diagnostics");
  console.error(
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        npm: context.npmVersion,
        package: PACKAGE_NAME,
        version: context.version,
        integrity: context.integrity,
        action: error.action ?? context.action,
        exitCode: error.code ?? null,
        signal: error.signal ?? null,
        stderr: bounded(error.stderr),
        stdout: bounded(error.stdout),
      },
      null,
      2
    )
  );
  const browserRoot =
    tempRoot &&
    path.join(tempRoot, "install", "node_modules", "patchright-core", ".local-browsers");
  if (browserRoot && exists(browserRoot)) {
    try {
      console.error(
        "browser tree:",
        (await readdir(browserRoot, { recursive: true })).slice(0, 80).join("\n")
      );
    } catch (listingError) {
      console.error("browser tree warning:", listingError.message);
    }
  }
}

try {
  if (process.argv.length !== 3 || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    fail("usage: node scripts/registry-browser-smoke.mjs <stable version>");
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const spec = `${PACKAGE_NAME}@${version}`;
  const npmVersion = await run(npm, ["--version"], "npm version");
  context.npmVersion = npmVersion.stdout.trim();
  const viewedVersion = (
    await run(npm, ["view", spec, "version", "--json", "--registry", REGISTRY], "registry version")
  ).stdout
    .trim()
    .replace(/^"|"$/g, "");
  if (viewedVersion !== version) fail(`registry version mismatch: ${viewedVersion}`);
  const integrity = (
    await run(
      npm,
      ["view", spec, "dist.integrity", "--json", "--registry", REGISTRY],
      "registry integrity"
    )
  ).stdout
    .trim()
    .replace(/^"|"$/g, "");
  if (!integrity.startsWith("sha512-")) fail("registry integrity is not sha512");
  context.integrity = integrity;
  console.log(
    `package: ${PACKAGE_NAME}\nversion: ${version}\norigin: ${REGISTRY}\nintegrity: ${integrity}\nplatform: ${process.platform}\narch: ${process.arch}\nNode version: ${process.version}\nnpm version: ${context.npmVersion}`
  );
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "gemini-notebook-registry-"));
  const installRoot = path.join(tempRoot, "install");
  await run(
    npm,
    [
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry",
      REGISTRY,
      spec,
    ],
    "npm install"
  );
  const packageRoot = path.join(
    installRoot,
    "node_modules",
    "@charlie.act7",
    "gemini-notebook-mcp"
  );
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== PACKAGE_NAME || manifest.version !== version)
    fail("installed manifest mismatch");
  const binEntry =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["gemini-notebook-mcp"];
  if (!binEntry || path.isAbsolute(binEntry) || binEntry.split(/[\\/]/).includes(".."))
    fail("unsafe bin entry");
  const bin = path.resolve(packageRoot, binEntry);
  const packageReal = await realpath(packageRoot);
  const binReal = await realpath(bin);
  const binRel = path.relative(packageReal, binReal);
  if (!binRel || path.isAbsolute(binRel) || binRel === ".." || binRel.startsWith(`..${path.sep}`))
    fail("bin resolves outside package");
  const nodeModulesRoot = path.join(installRoot, "node_modules");
  const statusBefore = parseJson(
    (
      await run(
        process.execPath,
        [bin, "browser", "status", "--json"],
        "browser status before install"
      )
    ).stdout,
    "status before install"
  );
  assertChromium(statusBefore, "status before install", false);
  const install = parseJson(
    (await run(process.execPath, [bin, "browser", "install", "--json"], "browser install")).stdout,
    "browser install"
  );
  assertChromium(install, "browser install", true);
  await assertExecutable(install, nodeModulesRoot, "browser install");
  const statusAfter = parseJson(
    (
      await run(
        process.execPath,
        [bin, "browser", "status", "--json"],
        "browser status after install"
      )
    ).stdout,
    "status after install"
  );
  assertChromium(statusAfter, "status after install", true);
  const firstExecutable = await assertExecutable(
    statusAfter,
    nodeModulesRoot,
    "browser status after install"
  );
  const repeat = parseJson(
    (await run(process.execPath, [bin, "browser", "install", "--json"], "browser install repeat"))
      .stdout,
    "browser install repeat"
  );
  assertChromium(repeat, "browser install repeat", true);
  const repeatExecutable = await assertExecutable(
    repeat,
    nodeModulesRoot,
    "browser install repeat"
  );
  const finalStatus = parseJson(
    (await run(process.execPath, [bin, "browser", "status", "--json"], "browser status final"))
      .stdout,
    "browser status final"
  );
  assertChromium(finalStatus, "browser status final", true);
  const finalExecutable = await assertExecutable(
    finalStatus,
    nodeModulesRoot,
    "browser status final"
  );
  if (firstExecutable !== repeatExecutable || firstExecutable !== finalExecutable)
    fail("executable realpath changed");
  console.log(`[registry-browser-smoke] ${process.platform} ${spec} Chromium provisioning OK`);
} catch (error) {
  await printDiagnostics(error);
  process.exitCode = 1;
} finally {
  if (tempRoot) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      console.error(`[registry-browser-smoke] cleanup warning: ${error.message}`);
    }
  }
}
