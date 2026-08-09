import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathInside, resolvePatchrightBin } from "../src/browser/browser-cli.js";

test("resuelve bin string y object dentro del paquete", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchright-cli-"));
  await writeFile(join(root, "cli.js"), "");
  assert.equal(resolvePatchrightBin({ bin: "cli.js" }, root), join(root, "cli.js"));
  assert.equal(resolvePatchrightBin({ bin: { patchright: "cli.js" } }, root), join(root, "cli.js"));
});

test("rechaza escape, ruta absoluta y bin ausente", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchright-cli-"));
  assert.throws(() => resolvePatchrightBin({ bin: "../escape.js" }, root));
  assert.throws(() => resolvePatchrightBin({ bin: join(root, "cli.js") }, root));
  assert.throws(() => resolvePatchrightBin({ bin: "missing.js" }, root));
});

test("solo considera hermético un executable dentro del node_modules local", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-root-"));
  const modules = join(root, "node_modules");
  const local = join(modules, "patchright-core", ".local-browsers", "chromium");
  const external = join(tmpdir(), "global-playwright", "chromium");
  await mkdir(local, { recursive: true });
  await mkdir(external, { recursive: true });
  await mkdir(join(`${root}-evil`, "node_modules"), { recursive: true });
  await writeFile(join(local, "browser"), "");
  await writeFile(join(external, "browser"), "");
  assert.equal(isPathInside(modules, join(local, "browser")), true);
  assert.equal(isPathInside(modules, join(external, "browser")), false);
  assert.equal(isPathInside(join(`${root}-evil`, "node_modules"), join(local, "browser")), false);
});
