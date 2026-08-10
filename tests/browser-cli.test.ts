import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPathInside,
  resolvePatchrightBin,
  runPatchrightInstall,
} from "../src/browser/browser-cli.js";

function fakeChild(
  close: { code: number | null; signal?: NodeJS.Signals | null } | { error: Error }
) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if ("error" in close) child.emit("error", close.error);
    else child.emit("close", close.code, close.signal ?? null);
  });
  return child;
}

test("supervisa códigos de salida y señales de Patchright", async () => {
  await assert.doesNotReject(() =>
    runPatchrightInstall("cli.js", (() => fakeChild({ code: 0 })) as never)
  );
  await assert.rejects(
    () => runPatchrightInstall("cli.js", (() => fakeChild({ code: 1 })) as never),
    /código 1/
  );
  await assert.rejects(
    () => runPatchrightInstall("cli.js", (() => fakeChild({ code: 4294967295 })) as never),
    /4294967295/
  );
  await assert.rejects(
    () =>
      runPatchrightInstall("cli.js", (() => fakeChild({ code: null, signal: "SIGTERM" })) as never),
    /signal SIGTERM/
  );
  await assert.rejects(
    () =>
      runPatchrightInstall("cli.js", (() =>
        fakeChild({ error: new Error("spawn denied") })) as never),
    /spawn denied/
  );
});

test("reserva stdout para JSON y redirige la salida de Patchright a stderr", async () => {
  const source = await readFile(new URL("../src/browser/browser-cli.ts", import.meta.url), "utf8");
  assert.match(source, /stdio:\s*\["inherit",\s*"pipe",\s*"pipe"\]/);
  assert.match(source, /process\.stderr\.write/);
  assert.doesNotMatch(source, /stdio:\s*"inherit"/);
});

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
