import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PACKAGE_NAME = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

function repositorySlug(repository) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }

  const value = raw.trim().replace(/^git\+/, "");
  if (value.startsWith("git@github.com:")) {
    return value.slice("git@github.com:".length).replace(/\.git$/, "");
  }

  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    return url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch {
    return null;
  }
}

export function validateReleaseMetadata(packageJson, releaseTag, githubRepository) {
  if (!packageJson || typeof packageJson !== "object") {
    throw new Error("package.json must contain an object");
  }
  if (typeof packageJson.name !== "string" || !PACKAGE_NAME.test(packageJson.name)) {
    throw new Error("package.json must contain a valid scoped npm package name");
  }
  if (typeof packageJson.version !== "string" || !STABLE_SEMVER.test(packageJson.version)) {
    throw new Error("Automated releases require a stable x.y.z package version");
  }
  if (packageJson.private === true) {
    throw new Error("A private package cannot be published");
  }
  if (packageJson.publishConfig?.access !== "public") {
    throw new Error('publishConfig.access must be "public"');
  }

  const expectedTag = `v${packageJson.version}`;
  if (releaseTag !== expectedTag) {
    throw new Error(`Release tag must be ${expectedTag}; received ${releaseTag || "<empty>"}`);
  }

  if (typeof githubRepository !== "string" || githubRepository.trim() === "") {
    throw new Error("GITHUB_REPOSITORY is required");
  }
  const packageRepository = repositorySlug(packageJson.repository);
  if (packageRepository?.toLowerCase() !== githubRepository.toLowerCase()) {
    throw new Error(
      `package.json repository ${packageRepository || "<invalid>"} does not match ${githubRepository}`
    );
  }

  return {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    packageSpec: `${packageJson.name}@${packageJson.version}`,
  };
}

async function main() {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  const metadata = validateReleaseMetadata(
    packageJson,
    process.env.RELEASE_TAG,
    process.env.GITHUB_REPOSITORY
  );

  const output = [
    `package_name=${metadata.packageName}`,
    `package_version=${metadata.packageVersion}`,
    `package_spec=${metadata.packageSpec}`,
  ].join("\n");

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${output}\n`, "utf8");
  } else {
    process.stdout.write(`${output}\n`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Release validation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
