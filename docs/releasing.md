# Releasing to npm

The npm package is published from a GitHub Release by `.github/workflows/publish.yml`.
The workflow uses npm trusted publishing (OIDC), so it does not store or receive an
`NPM_TOKEN` secret. npm also records provenance for the published package.

## One-time trusted publisher setup

An npm package owner must configure the publisher before creating the first automated
release:

1. Open the package settings for `@charlie.act7/gemini-notebook-mcp` on npm.
2. Under **Trusted Publisher**, select **GitHub Actions**.
3. Enter these exact values:
   - Organization or user: `CharlieCardenasToledo`
   - Repository: `gemini-notebook-mcp`
   - Workflow filename: `publish.yml`
   - Environment: leave empty
4. Save the trusted publisher.
5. After one successful OIDC publication, configure package access so ordinary npm
   tokens cannot publish this package.

The workflow filename is case-sensitive. It must be configured as the filename only,
not `.github/workflows/publish.yml`.

## Release gates

The workflow publishes only a non-prerelease GitHub Release and verifies all of the
following before calling `npm publish`:

- the tag is exactly `v<package.json version>`;
- the package version is a stable `x.y.z` version;
- the package is public and its repository matches the current GitHub repository;
- the checked-out release commit is an ancestor of the default branch;
- formatting, lint, build, tests, MCP preflight, and local package smoke checks pass;
- the npm registry is reachable.

No npm token is provided to the job. `id-token: write` is limited to the publication
workflow so npm can exchange GitHub's short-lived OIDC identity for publication
authorization.

## Creating a release

Prepare the version, changelog, tests, and documentation in one pull request. After
that pull request is merged and all required checks pass:

```bash
git switch main
git pull --ff-only
gh release create v2.3.3 --target main --generate-notes
```

Replace `2.3.3` with the version in `package.json`. Publishing the GitHub Release
starts the npm workflow. Do not create the tag or release from an unmerged branch.

The job is safe to rerun. If the exact package version already exists, it skips
`npm publish` and continues with registry verification.

## Post-publication verification

The workflow waits for registry consistency, inspects the remote tarball, installs it
into a clean temporary prefix, starts its compiled MCP server, and verifies the
runtime version and discovered tools.

Useful manual checks are:

```bash
npm view @charlie.act7/gemini-notebook-mcp version
npm view @charlie.act7/gemini-notebook-mcp@2.3.3 dist.integrity dist.attestations
npm pack @charlie.act7/gemini-notebook-mcp@2.3.3 --dry-run --json
```

If the workflow fails before publication, correct the repository and rerun it. If it
fails after npm accepted the immutable version, do not bump or republish solely to
rerun verification; rerun the same workflow, which will detect and verify the
existing version.
