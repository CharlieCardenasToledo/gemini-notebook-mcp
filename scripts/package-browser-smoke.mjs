import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(process.cwd());
const temp = join(tmpdir(), `notebooklm-package-browser-${process.pid}`);
const install = join(temp, "install");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
rmSync(temp, { recursive: true, force: true });
mkdirSync(temp, { recursive: true });
execFileSync(npm, ["pack", "--pack-destination", temp, "--ignore-scripts"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
const archive = readdirSync(temp).find((name) => name.endsWith(".tgz"));
assert.ok(archive, "npm pack no produjo un tarball");
execFileSync(
  npm,
  [
    "install",
    "--prefix",
    install,
    join(temp, archive),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ],
  { stdio: "inherit", shell: process.platform === "win32" }
);
const packageRoot = join(install, "node_modules", "@charlie.act7", "gemini-notebook-mcp");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["gemini-notebook-mcp"];
assert.ok(bin, "falta el bin público");
const binPath = resolve(packageRoot, bin);
assert.ok(existsSync(binPath));
const nodeModules = resolve(join(install, "node_modules"));
assert.ok(
  !isAbsolute(relative(nodeModules, binPath)) && !relative(nodeModules, binPath).startsWith("..")
);

function run(action) {
  console.log(`[package-browser-smoke] browser ${action}`);
  const result = spawnSync(process.execPath, [binPath, "browser", action, "--json"], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`browser ${action} falló: ${result.stderr || result.stdout}`);
  const status = JSON.parse(result.stdout);
  assert.equal(status.browser, "chromium");
  assert.equal(status.installed, true);
  assert.equal(status.hermetic, true);
  assert.ok(status.executablePath && existsSync(status.executablePath));
  const rel = relative(nodeModules, status.executablePath);
  assert.ok(rel && !isAbsolute(rel) && !rel.startsWith(".."));
}
run("install");
run("status");
console.log(`[package-browser-smoke] ${process.platform} Chromium provisioning OK`);
