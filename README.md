# droid-acp

ACP (Agent Client Protocol) adapter for [Droid](https://factory.ai) - Factory's AI coding agent.

Use Droid from any [ACP-compatible](https://agentclientprotocol.com) clients such as [Zed](https://zed.dev)!

## Features

- Context @-mentions
- Tool calls
- TODO lists
- Image prompts (e.g. paste screenshots in Zed)
- Multiple model support
- Session modes (Spec, Manual, Auto Low/Medium/High)
- Optional WebSearch proxy (Smithery Exa MCP / custom forward)

## Installation

```bash
npm install droid-acp
```

## Usage

### Prerequisites

1. Install Droid CLI from [Factory](https://factory.ai)
2. (Recommended) Set your Factory API key for Factory-hosted features:
   ```bash
   export FACTORY_API_KEY=fk-...
   ```

> If you only need WebSearch via the built-in proxy + Smithery Exa MCP, a valid Factory key is not required (droid-acp injects a dummy key into the spawned droid process to satisfy droid's local auth gate).

### Running

```bash
# Default mode (stream-jsonrpc, supports custom models)
npx droid-acp

# Native ACP mode (lighter, but no custom model support)
npx droid-acp --acp
```

### With Zed Editor

Add to your Zed `settings.json`:

```json
{
  "agent_servers": {
    "Droid": {
      "type": "custom",
      "command": "npx",
      "args": ["droid-acp"],
      "env": {
        "FACTORY_API_KEY": "fk-your-api-key-here"
      }
    }
  }
}
```

**Using native ACP mode (no custom model support):**

```json
{
  "agent_servers": {
    "Droid Native": {
      "type": "custom",
      "command": "npx",
      "args": ["droid-acp", "--acp"],
      "env": {
        "FACTORY_API_KEY": "fk-your-api-key-here"
      }
    }
  }
}
```

**Using a custom droid binary (e.g., patched version):**

```json
{
  "agent_servers": {
    "Droid Custom": {
      "type": "custom",
      "command": "npx",
      "args": ["droid-acp"],
      "env": {
        "FACTORY_API_KEY": "fk-your-api-key-here",
        "DROID_EXECUTABLE": "/path/to/custom/droid"
      }
    }
  }
}
```

**Enable WebSearch proxy (Smithery Exa MCP):**

```json
{
  "agent_servers": {
    "Droid WebSearch": {
      "type": "custom",
      "command": "npx",
      "args": ["droid-acp"],
      "env": {
        "DROID_ACP_WEBSEARCH": "1",
        "SMITHERY_API_KEY": "your_smithery_key",
        "SMITHERY_PROFILE": "your_profile_id"
      }
    }
  }
}
```

### Modes

| Command               | Mode           | Custom Models    | Description                   |
| --------------------- | -------------- | ---------------- | ----------------------------- |
| `npx droid-acp`       | stream-jsonrpc | ✅ Supported     | Default, recommended          |
| `npx droid-acp --acp` | native ACP     | ❌ Not supported | Lighter, direct pipe to droid |

> **Note:** Native ACP mode (`--acp`) has a limitation in droid where custom models configured in `~/.factory/config.json` are not recognized. Use the default stream-jsonrpc mode if you need custom models.

### Environment Variables

- `FACTORY_API_KEY` - Your Factory API key (recommended for Factory-hosted features)
- `DROID_EXECUTABLE` - Path to the droid binary (optional, defaults to `droid` in PATH)

- `DROID_ACP_WEBSEARCH` - Enable local proxy to optionally intercept Droid websearch (`/api/tools/exa/search`)
- `DROID_ACP_WEBSEARCH_FORWARD_URL` - Optional forward target for websearch (base URL or full URL)
- `DROID_ACP_WEBSEARCH_FORWARD_MODE` - Forward mode for `DROID_ACP_WEBSEARCH_FORWARD_URL` (`http` or `mcp`, default: `http`)
- `DROID_ACP_WEBSEARCH_UPSTREAM_URL` - Optional upstream Factory API base URL (default: `FACTORY_API_BASE_URL_OVERRIDE` or `https://api.factory.ai`)
- `DROID_ACP_WEBSEARCH_HOST` - Optional proxy bind host (default: `127.0.0.1`)
- `DROID_ACP_WEBSEARCH_PORT` - Optional proxy bind port (default: auto-assign an available port)
- `DROID_ACP_WEBSEARCH_DEBUG` - Emit a WebSearch status message in the ACP UI (e.g. Zed) for debugging

- `SMITHERY_API_KEY` - Optional (recommended) Smithery Exa MCP API key (enables high-quality websearch)
- `SMITHERY_PROFILE` - Optional Smithery Exa MCP profile id

### WebSearch Proxy (optional)

Enable the built-in proxy to intercept `POST /api/tools/exa/search` and serve results from Smithery Exa MCP (recommended):

```bash
export SMITHERY_API_KEY="your_smithery_key"
export SMITHERY_PROFILE="your_profile_id"
DROID_ACP_WEBSEARCH=1 npx droid-acp
```

To debug proxy wiring (shows `proxyBaseUrl` and a `/health` link in the ACP UI):

```bash
DROID_ACP_WEBSEARCH=1 DROID_ACP_WEBSEARCH_DEBUG=1 npx droid-acp
```

To forward WebSearch to your own HTTP handler instead:

```bash
DROID_ACP_WEBSEARCH=1 \
DROID_ACP_WEBSEARCH_FORWARD_URL="http://127.0.0.1:20002" \
npx droid-acp
```

To forward WebSearch to an MCP endpoint (JSON-RPC `tools/call`), set:

```bash
DROID_ACP_WEBSEARCH=1 \
DROID_ACP_WEBSEARCH_FORWARD_MODE=mcp \
DROID_ACP_WEBSEARCH_FORWARD_URL="http://127.0.0.1:20002" \
npx droid-acp
```

Notes:

- The proxy exposes `GET /health` on `proxyBaseUrl` (handy for troubleshooting).
- When `DROID_ACP_WEBSEARCH=1`, droid-acp injects a dummy `FACTORY_API_KEY` into the spawned droid process if none is set, so WebSearch requests can reach the proxy even without Factory login.

## Session Modes

| Mode        | Description                                 | Droid autonomy level |
| ----------- | ------------------------------------------- | -------------------- |
| Spec        | Plan-only (read-only)                       | `spec`               |
| Auto Off    | Prompts before edits/commands (per-tool)    | `normal`             |
| Auto Low    | Low-risk operations (basic file operations) | `auto-low`           |
| Auto Medium | Development operations                      | `auto-medium`        |
| Auto High   | Production operations (dangerous)           | `auto-high`          |

## Available Models

- Claude Opus 4.5 (default)
- Claude Sonnet 4.5
- Claude Haiku 4.5
- GPT-5.1
- GPT-5.1-Codex
- GPT-5.1-Codex-Max
- GPT-5.2
- Gemini 3 Pro
- Droid Core (GLM-4.6)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Dev mode (watch)
npm run dev

# Lint
npm run lint

# Format
npm run format

# Check (lint + format)
npm run check
```

## License

Apache-2.0
