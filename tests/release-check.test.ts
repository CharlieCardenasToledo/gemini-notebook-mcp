import assert from "node:assert/strict";
import test from "node:test";
import { validateReleaseMetadata } from "../scripts/release-check.mjs";

const validPackage = {
  name: "@charlie.act7/gemini-notebook-mcp",
  version: "2.3.3",
  publishConfig: { access: "public" },
  repository: {
    type: "git",
    url: "git+https://github.com/CharlieCardenasToledo/gemini-notebook-mcp.git",
  },
};

test("accepts a stable release whose tag and repository match", () => {
  assert.deepEqual(
    validateReleaseMetadata(validPackage, "v2.3.3", "CharlieCardenasToledo/gemini-notebook-mcp"),
    {
      packageName: "@charlie.act7/gemini-notebook-mcp",
      packageVersion: "2.3.3",
      packageSpec: "@charlie.act7/gemini-notebook-mcp@2.3.3",
    }
  );
});

test("rejects a release tag that differs from package.json", () => {
  assert.throws(
    () =>
      validateReleaseMetadata(validPackage, "v2.3.2", "CharlieCardenasToledo/gemini-notebook-mcp"),
    /Release tag must be v2\.3\.3/
  );
});

test("rejects prerelease package versions", () => {
  assert.throws(
    () =>
      validateReleaseMetadata(
        { ...validPackage, version: "2.3.3-beta.1" },
        "v2.3.3-beta.1",
        "CharlieCardenasToledo/gemini-notebook-mcp"
      ),
    /stable x\.y\.z/
  );
});

test("rejects a repository mismatch", () => {
  assert.throws(
    () => validateReleaseMetadata(validPackage, "v2.3.3", "someone/other-repository"),
    /does not match/
  );
});

test("rejects private or non-public packages", () => {
  assert.throws(
    () =>
      validateReleaseMetadata(
        { ...validPackage, private: true },
        "v2.3.3",
        "CharlieCardenasToledo/gemini-notebook-mcp"
      ),
    /private package/
  );
  assert.throws(
    () =>
      validateReleaseMetadata(
        { ...validPackage, publishConfig: { access: "restricted" } },
        "v2.3.3",
        "CharlieCardenasToledo/gemini-notebook-mcp"
      ),
    /publishConfig\.access/
  );
});
