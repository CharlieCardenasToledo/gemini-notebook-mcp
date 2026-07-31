# Tools

Browser-backed calls honor MCP request cancellation. Cancellation returns a
structured `CANCELLED` error; an unverified required selector returns
`UI_CHANGED` instead of an ambiguous empty result.

Every tool registered in the current 2.x release, with parameter schema, an example invocation (MCP `tools/call` arguments shape), and the expected return shape.

The server returns each tool result wrapped as `{ "success": true, "data": <object> }` (or `{ "success": false, "error": <string> }`). The shapes below describe the inner `data`.

---

## ask_question

Ask a question against a notebook. Reuses an existing browser session when `session_id` is supplied. Citation extraction reads the DOM citation panel after the answer settles.

**v2 additions**: `source_format`, `_provenance` envelope on the result, AI-generated answer prefix.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `question` | string | yes | The question to ask. |
| `session_id` | string | no | Reuse an existing session for context. Omit to create a new one. |
| `notebook_id` | string | no | Library notebook ID. Falls back to active notebook. |
| `notebook_url` | string | no | Ad-hoc NotebookLM URL. Overrides `notebook_id`. |
| `source_format` | `none` \| `inline` \| `footnotes` \| `json` | no | Citation rendering. Default `none`. |
| `show_browser` | bool | no | Shorthand for `browser_options.show`. |
| `browser_options` | object | no | Per-call browser overrides — see [`docs/configuration.md`](./configuration.md#per-call-browser-options). |

### Example

```json
{
  "name": "ask_question",
  "arguments": {
    "question": "How does the OAuth refresh token rotation work?",
    "notebook_id": "auth-notebook",
    "source_format": "footnotes"
  }
}
```

### Return shape

```jsonc
{
  "status": "success",
  "question": "How does the OAuth refresh token rotation work?",
  "answer": "[AI-GENERATED ...] The refresh token is rotated each ...\n\nSources:\n[1] auth-spec.pdf — ...",
  "session_id": "ses_…",
  "notebook_url": "https://notebook.google.com/notebook/…",
  "session_info": {
    "age_seconds": 12,
    "message_count": 3,
    "last_activity": "2026-04-30T12:00:00.000Z"
  },
  "_provenance": {
    "provider": "google-notebooklm",
    "model": "google-managed",
    "model_selection": "managed-by-notebooklm",
    "via": "chrome-automation",
    "grounding": "user-uploaded-documents",
    "ai_generated": true
  },
  "source_format": "footnotes",
  "sources": [
    { "index": 1, "title": "auth-spec.pdf", "excerpt": "Refresh tokens MUST be rotated…" }
  ]
}
```

`sources` is omitted when `source_format=none` or when no citations were found.

---

## add_source — new in v2

Add a source to a notebook. v2 supports `type=url` (web crawl) and `type=text` (paste). File / YouTube / Drive uploads are not supported.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `type` | `url` \| `text` | yes | |
| `content` | string | yes | URL when `type=url`, raw text when `type=text`. |
| `title` | string | no | Optional display title. NotebookLM picks a default. |
| `session_id` | string | no | Reuse an existing browser session. |
| `notebook_id` | string | no | Library notebook ID. |
| `notebook_url` | string | no | Ad-hoc URL. Overrides `notebook_id`. |

### Example

```json
{
  "name": "add_source",
  "arguments": {
    "type": "url",
    "content": "https://docs.n8n.io/code/builtin/json-jmespath/",
    "title": "n8n JMESPath builtin"
  }
}
```

### Return shape

```jsonc
{
  "status": "success",
  "type": "url",
  "title": "n8n JMESPath builtin",
  "source_count_before": 12,
  "source_count_after": 13,
  "added": true
}
```

---

## generate_audio — new in v2

Generate a podcast-style Audio Overview for a notebook. Resolves when the audio element is ready.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `custom_prompt` | string | no | Optional focus prompt. |
| `timeout_ms` | number | no | Wait ceiling. Default `600000`. |
| `session_id` | string | no | |
| `notebook_id` | string | no | |
| `notebook_url` | string | no | |

### Example

```json
{
  "name": "generate_audio",
  "arguments": {
    "custom_prompt": "Focus on the migration strategy",
    "timeout_ms": 900000
  }
}
```

### Return shape

```jsonc
{
  "status": "success",
  "ready": true,
  "duration_ms": 412000
}
```

Pair with `download_audio` to persist the file. Video / Infographic / Slides are not currently exposed.

---

## download_audio — new in v2

Download the most recent Audio Overview to disk.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `destination_dir` | string | yes | Directory under `NOTEBOOKLM_OUTPUT_DIR`; `.` selects the configured root. Created if missing. |
| `session_id` | string | no | |
| `notebook_id` | string | no | |
| `notebook_url` | string | no | |

### Example

```json
{
  "name": "download_audio",
  "arguments": {
    "destination_dir": "."
  }
}
```

### Return shape

```jsonc
{
  "status": "success",
  "file_path": "<NOTEBOOKLM_OUTPUT_DIR>/overview-2026-04-30.m4a",
  "size_bytes": 9_412_000
}
```

Run `generate_audio` first if no Audio Overview exists yet.

---

## add_notebook

Add a NotebookLM share-URL to the local library. The tool description enforces a confirmation workflow on the host agent — do not call without explicit user consent.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | NotebookLM share URL. |
| `name` | string | yes | Display name. |
| `description` | string | yes | Short description of the notebook content. |
| `topics` | string[] | yes | Topics covered. |
| `content_types` | string[] | no | e.g. `["documentation", "examples"]`. |
| `use_cases` | string[] | no | When to consult this notebook. |
| `tags` | string[] | no | Optional organizational tags. |

### Return shape

```jsonc
{
  "status": "added",
  "id": "nb_abcd",
  "name": "n8n Documentation",
  "active": true
}
```

---

## list_notebooks

No parameters. Returns the full library.

### Return shape

```jsonc
{
  "active_notebook_id": "nb_abcd",
  "notebooks": [
    {
      "id": "nb_abcd",
      "name": "n8n Documentation",
      "url": "https://notebook.google.com/notebook/…",
      "description": "n8n core + builtin nodes",
      "topics": ["workflow automation", "n8n"],
      "use_cases": ["building n8n workflows"],
      "tags": ["docs"],
      "use_count": 42
    }
  ]
}
```

---

## get_notebook

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

Returns one entry from `list_notebooks`.

---

## select_notebook

Set a notebook as the active default.

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

### Return shape

```jsonc
{ "status": "active", "id": "nb_abcd", "name": "n8n Documentation" }
```

---

## update_notebook

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |
| `name` | string | no |
| `description` | string | no |
| `topics` | string[] | no |
| `content_types` | string[] | no |
| `use_cases` | string[] | no |
| `tags` | string[] | no |
| `url` | string | no |

Returns the updated entry.

---

## remove_notebook

Removes the entry from the local library only — does not delete the notebook in NotebookLM.

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

---

## search_notebooks

Searches name, description, topics, tags.

| Name | Type | Required |
|---|---|---|
| `query` | string | yes |

Returns an array of matching entries.

---

## get_library_stats

No parameters. Returns total notebooks, total queries, top-used notebooks.

---

## list_sessions

No parameters. Returns active sessions with age, message count, last-activity timestamp.

---

## close_session

| Name | Type | Required |
|---|---|---|
| `session_id` | string | yes |

---

## reset_session

Clears chat history while keeping the same `session_id`.

| Name | Type | Required |
|---|---|---|
| `session_id` | string | yes |

---

## get_health

No parameters.

### Return shape

```jsonc
{
  "status": "ok",
  "auth_state_present": true,
  "authenticated": null,
  "authentication_check": "Authentication is verified when opening NotebookLM",
  "active_sessions": 1,
  "version": "2.0.0",
  "config": {
    "headless": true,
    "stealth_enabled": true,
    "max_sessions": 10,
    "answer_timeout_ms": 600000
  }
}
```

`auth_state_present` means that `state.json` exists, is readable, and contains a
cookie array. It is not proof that Google currently accepts those cookies.
`authenticated` is therefore `null`; live authentication is checked when a
browser-driven NotebookLM tool opens the service. A missing backup may produce a
non-destructive tip, but never justifies `re_auth` or `cleanup_data` by itself.

---

## setup_auth

Opens a visible Chrome for first-time Google login.

| Name | Type | Required | Notes |
|---|---|---|---|
| `show_browser` | bool | no | Default `true` for setup. |
| `browser_options` | object | no | Same shape as `ask_question`. |

The call waits for login completion for up to 10 minutes and reports progress. A subsequent NotebookLM operation performs the live authentication check; `get_health` only reports saved-state presence.

---

## re_auth

Closes all sessions, deletes saved cookies + Chrome profile, opens a fresh login window.

| Name | Type | Required | Notes |
|---|---|---|---|
| `show_browser` | bool | no | Default `true`. |
| `browser_options` | object | no | |

---

## cleanup_data

Preview + deletion restricted to the configured `NOTEBOOKLM_DATA_DIR`. The tool never scans or deletes npm caches, Claude/Cursor/VS Code data, system temporary files, or trash.

| Name | Type | Required | Notes |
|---|---|---|---|
| `confirm` | bool | yes | `false` = preview only. `true` = execute using the preview token. |
| `preserve_library` | bool | no | Keep `library.json` while wiping everything else. Default `false`. |
| `preview_token` | string | when confirming | Expiring one-time token returned by the preview. |

Workflow:

1. `cleanup_data({ confirm: false, preserve_library: true })` — review paths, digest, and expiry.
2. Close all browser sessions.
3. `cleanup_data({ confirm: true, preview_token: "..." })` — execute only if the manifest is unchanged.

---

## Resources (read-only)

| URI | Purpose |
|---|---|
| `notebooklm://library` | JSON view of the full library. |
| `notebooklm://library/{id}` | One notebook by ID. The `{id}` template autocompletes from the library. |
| `notebooklm://metadata` | Deprecated. Use `notebooklm://library` instead. |

The MCP server does not respond to `mcp://notebooklm` — that URI scheme never existed. Use `notebooklm://`.
