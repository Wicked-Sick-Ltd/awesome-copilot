---
name: transloadit-media-processing
description: 'Process media files (video, audio, images, documents) using Transloadit. Use when asked to encode video to HLS/MP4, generate thumbnails, resize or watermark images, extract audio, concatenate clips, add subtitles, OCR documents, or run any media processing pipeline. Covers 86+ processing robots for file transformation at scale.'
license: MIT
compatibility: Requires a free Transloadit account (https://transloadit.com/signup). Uses a pinned local install of the @transloadit/mcp-server MCP server or the @transloadit/node CLI.
---

# Transloadit Media Processing

Process, transform, and encode media files using Transloadit's cloud infrastructure.
Supports video, audio, images, and documents with 86+ specialized processing robots.

## When to Use This Skill

Use this skill when you need to:

- Encode video to HLS, MP4, WebM, or other formats
- Generate thumbnails or animated GIFs from video
- Resize, crop, watermark, or optimize images
- Convert between image formats (JPEG, PNG, WebP, AVIF, HEIF)
- Extract or transcode audio (MP3, AAC, FLAC, WAV)
- Concatenate video or audio clips
- Add subtitles or overlay text on video
- OCR documents (PDF, scanned images)
- Run speech-to-text or text-to-speech
- Apply AI-based content moderation or object detection
- Build multi-step media pipelines that chain operations together

## Setup

### Install pinned versions once

The MCP server and the CLI receive your Transloadit credentials, so run them from a
local install at an exact version, never through `npx`, `npm exec`, `pnpm dlx`,
`yarn dlx`, or `bunx`. Those launchers download whatever version the registry serves
at each start and run it with your credentials in its environment.

```bash
mkdir -p ~/.transloadit-tools
cd ~/.transloadit-tools
printf '{ "private": true }\n' > package.json
npm install --save-exact --ignore-scripts @transloadit/mcp-server@0.8.9 @transloadit/node@6.9.1
```

`--save-exact` records the exact versions, and the generated `package-lock.json` records
the integrity hash of every installed package. Keep that lockfile. To reinstall, run
`npm ci --ignore-scripts` in `~/.transloadit-tools`, which refuses packages whose
contents do not match the lockfile. Upgrade only by changing a version above on purpose
after reviewing the release.

This installs two binaries:

- `~/.transloadit-tools/node_modules/.bin/transloadit-mcp` (MCP server)
- `~/.transloadit-tools/node_modules/.bin/transloadit` (CLI)

On Windows, use the `.cmd` files with the same names in that folder.

### Option A: MCP Server (recommended for Copilot)

Add the Transloadit MCP server to your IDE config. This gives the agent direct access
to Transloadit tools (`create_template`, `create_assembly`, `list_assembly_notifications`, etc.).

**VS Code / GitHub Copilot** (`.vscode/mcp.json` or user settings):

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "transloadit-key",
      "description": "Transloadit Auth Key"
    },
    {
      "type": "promptString",
      "id": "transloadit-secret",
      "description": "Transloadit Auth Secret",
      "password": true
    }
  ],
  "servers": {
    "transloadit": {
      "type": "stdio",
      "command": "${userHome}/.transloadit-tools/node_modules/.bin/transloadit-mcp",
      "args": ["stdio"],
      "env": {
        "TRANSLOADIT_KEY": "${input:transloadit-key}",
        "TRANSLOADIT_SECRET": "${input:transloadit-secret}"
      }
    }
  }
}
```

The `command` points at the pinned local binary, so nothing is fetched from the registry
when the server starts. VS Code prompts for the key and secret and stores them in its
secret storage instead of writing them into `mcp.json`. Do not replace the inputs with
literal credential values, and do not change `command` back to `npx`.

Get your API credentials at https://transloadit.com/c/-/api-credentials

### Option B: CLI

If you prefer running commands directly, use the pinned `transloadit` binary:

```bash
~/.transloadit-tools/node_modules/.bin/transloadit assemblies create \
  --steps '{"encoded": {"robot": "/video/encode", "use": ":original", "preset": "hls-1080p"}}' \
  --wait \
  --input ./my-video.mp4
```

If a tool result or error message suggests a command such as `npx -y @transloadit/node upload`,
run the same subcommand with `~/.transloadit-tools/node_modules/.bin/transloadit` instead
of the suggested `npx` command.

## Core Workflows

### Encode Video to HLS (Adaptive Streaming)

```json
{
  "steps": {
    "encoded": {
      "robot": "/video/encode",
      "use": ":original",
      "preset": "hls-1080p"
    }
  }
}
```

### Generate Thumbnails from Video

```json
{
  "steps": {
    "thumbnails": {
      "robot": "/video/thumbs",
      "use": ":original",
      "count": 8,
      "width": 320,
      "height": 240
    }
  }
}
```

### Resize and Watermark Images

```json
{
  "steps": {
    "resized": {
      "robot": "/image/resize",
      "use": ":original",
      "width": 1200,
      "height": 800,
      "resize_strategy": "fit"
    },
    "watermarked": {
      "robot": "/image/resize",
      "use": "resized",
      "watermark_url": "https://example.com/logo.png",
      "watermark_position": "bottom-right",
      "watermark_size": "15%"
    }
  }
}
```

### OCR a Document

```json
{
  "steps": {
    "recognized": {
      "robot": "/document/ocr",
      "use": ":original",
      "provider": "aws",
      "format": "text"
    }
  }
}
```

### Concatenate Audio Clips

```json
{
  "steps": {
    "imported": {
      "robot": "/http/import",
      "url": ["https://example.com/clip1.mp3", "https://example.com/clip2.mp3"]
    },
    "concatenated": {
      "robot": "/audio/concat",
      "use": "imported",
      "preset": "mp3"
    }
  }
}
```

## Multi-Step Pipelines

Steps can be chained using the `"use"` field. Each step references a previous step's output:

```json
{
  "steps": {
    "resized": {
      "robot": "/image/resize",
      "use": ":original",
      "width": 1920
    },
    "optimized": {
      "robot": "/image/optimize",
      "use": "resized"
    },
    "exported": {
      "robot": "/s3/store",
      "use": "optimized",
      "bucket": "my-bucket",
      "path": "processed/${file.name}"
    }
  }
}
```

## Key Concepts

- **Assembly**: A single processing job. Created via `create_assembly` (MCP) or `assemblies create` (CLI).
- **Template**: A reusable set of steps stored on Transloadit. Created via `create_template` (MCP) or `templates create` (CLI).
- **Robot**: A processing unit (e.g., `/video/encode`, `/image/resize`). See full list at https://transloadit.com/docs/transcoding/
- **Steps**: JSON object defining the pipeline. Each key is a step name, each value configures a robot.
- **`:original`**: Refers to the uploaded input file.

## Tips

- Use `--wait` with the CLI to block until processing completes.
- Use `preset` values (e.g., `"hls-1080p"`, `"mp3"`, `"webp"`) for common format targets instead of specifying every parameter.
- Chain `"use": "step_name"` to build multi-step pipelines without intermediate downloads.
- For batch processing, use `/http/import` to pull files from URLs, S3, GCS, Azure, FTP, or Dropbox.
- Templates can include `${variables}` for dynamic values passed at assembly creation time.
