---
name: microsoft-code-reference
description: Look up Microsoft API references, find working code samples, and verify SDK code is correct. Use when working with Azure SDKs, .NET libraries, or Microsoft APIs—to find the right method, check parameters, get working examples, or troubleshoot errors. Catches hallucinated methods, wrong signatures, and deprecated patterns by querying official docs.
compatibility: Works best with Microsoft Learn MCP Server (https://learn.microsoft.com/api/mcp). Can also use the mslearn CLI as a fallback.
---

# Microsoft Code Reference

## Tools

| Need | Tool | Example |
|------|------|---------|
| API method/class lookup | `microsoft_docs_search` | `"BlobClient UploadAsync Azure.Storage.Blobs"` |
| Working code sample | `microsoft_code_sample_search` | `query: "upload blob managed identity", language: "python"` |
| Full API reference | `microsoft_docs_fetch` | Fetch URL from `microsoft_docs_search` (for overloads, full signatures) |

## Finding Code Samples

Use `microsoft_code_sample_search` to get official, working examples:

```
microsoft_code_sample_search(query: "upload file to blob storage", language: "csharp")
microsoft_code_sample_search(query: "authenticate with managed identity", language: "python")
microsoft_code_sample_search(query: "send message service bus", language: "javascript")
```

**When to use:**
- Before writing code—find a working pattern to follow
- After errors—compare your code against a known-good sample
- Unsure of initialization/setup—samples show complete context

## API Lookups

```
# Verify method exists (include namespace for precision)
"BlobClient UploadAsync Azure.Storage.Blobs"
"GraphServiceClient Users Microsoft.Graph"

# Find class/interface
"DefaultAzureCredential class Azure.Identity"

# Find correct package
"Azure Blob Storage NuGet package"
"azure-storage-blob pip package"
```

Fetch full page when method has multiple overloads or you need complete parameter details.

## Error Troubleshooting

Use `microsoft_code_sample_search` to find working code samples and compare with your implementation. For specific errors, use `microsoft_docs_search` and `microsoft_docs_fetch`:

| Error Type | Query |
|------------|-------|
| Method not found | `"[ClassName] methods [Namespace]"` |
| Type not found | `"[TypeName] NuGet package namespace"` |
| Wrong signature | `"[ClassName] [MethodName] overloads"` → fetch full page |
| Deprecated warning | `"[OldType] migration v12"` |
| Auth failure | `"DefaultAzureCredential troubleshooting"` |
| 403 Forbidden | `"[ServiceName] RBAC permissions"` |

## When to Verify

Always verify when:
- Method name seems "too convenient" (`UploadFile` vs actual `Upload`)
- Mixing SDK versions (v11 `CloudBlobClient` vs v12 `BlobServiceClient`)
- Package name doesn't follow conventions (`Azure.*` for .NET, `azure-*` for Python)
- Using an API for the first time

## Validation Workflow

Before generating code using Microsoft SDKs, verify it's correct:

1. **Confirm method or package exists** — `microsoft_docs_search(query: "[ClassName] [MethodName] [Namespace]")`
2. **Fetch full details** (for overloads/complex params) — `microsoft_docs_fetch(url: "...")`
3. **Find working sample** — `microsoft_code_sample_search(query: "[task]", language: "[lang]")`

For simple lookups, step 1 alone may suffice. For complex API usage, complete all three steps.

## CLI Alternative

If the Learn MCP server is not available, use the `mslearn` CLI (Node.js 22+) from a terminal or shell (for example, Bash, PowerShell, or cmd) instead. Install it only from the lockfile bundled in this skill's [`learn-cli/`](learn-cli/package-lock.json) folder, which pins `@microsoft/learn-cli` 1.0.0 and every dependency to an exact version and integrity hash, then run that copy by path:

```sh
# One-time install: exact versions, integrity-checked, no install scripts
npm ci --prefix <skill-folder>/learn-cli --ignore-scripts --no-audit --no-fund

# Run the locked CLI (on Windows: <skill-folder>\learn-cli\node_modules\.bin\mslearn.cmd)
<skill-folder>/learn-cli/node_modules/.bin/mslearn search "BlobClient UploadAsync Azure.Storage.Blobs"
```

Replace `<skill-folder>` with the folder that contains this `SKILL.md`. If that folder is read-only, copy `learn-cli/package.json` and `learn-cli/package-lock.json` to a writable folder and run the same `npm ci` there. Never run the CLI through npx, a global npm install, or an `mslearn` already on your PATH: those fetch whatever release and dependencies are currently published and execute them. If `npm ci` fails, for example with an integrity error, stop and report it instead of falling back to an unlocked install.

| MCP Tool | Locked CLI Subcommand |
|----------|-----------------------|
| `microsoft_docs_search(query: "...")` | `search "..."` |
| `microsoft_code_sample_search(query: "...", language: "...")` | `code-search "..." --language ...` |
| `microsoft_docs_fetch(url: "...")` | `fetch "..."` |

Pass `--json` to `search` or `code-search` to get raw JSON output for further processing.
