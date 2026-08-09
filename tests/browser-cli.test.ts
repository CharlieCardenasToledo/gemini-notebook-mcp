import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePatchrightBin } from "../src/browser/browser-cli.js";

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
