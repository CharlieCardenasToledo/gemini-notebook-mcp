#!/usr/bin/env node

process.env.PLAYWRIGHT_BROWSERS_PATH = "0";

const args = process.argv.slice(2);
if (args[0] === "browser") {
  const { runBrowserCli } = await import("./browser/browser-cli.js");
  await runBrowserCli(args.slice(1));
} else {
  await import("./index.js");
}
