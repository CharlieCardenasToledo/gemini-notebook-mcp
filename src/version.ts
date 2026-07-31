import { readFileSync } from "node:fs";

interface PackageMetadata {
  version?: unknown;
}

function readPackageVersion(): string {
  try {
    const packageUrl = new URL("../package.json", import.meta.url);
    const metadata = JSON.parse(readFileSync(packageUrl, "utf8")) as PackageMetadata;
    if (typeof metadata.version === "string" && metadata.version.trim()) {
      return metadata.version.trim();
    }
  } catch {
    // Keep startup resilient if a non-standard packager omits package.json.
  }
  return "0.0.0-unknown";
}

/** Runtime package version; package.json remains the single source of truth. */
export const APP_VERSION = readPackageVersion();
