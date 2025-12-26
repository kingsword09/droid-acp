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

## Installation

```bash
npm install droid-acp
```

## Usage

### Prerequisites

1. Install Droid CLI from [Factory](https://factory.ai)
2. Set your Factory API key:
   ```bash
   export FACTORY_API_KEY=fk-...
   ```

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

### Modes

| Command               | Mode           | Custom Models    | Description                   |
| --------------------- | -------------- | ---------------- | ----------------------------- |
| `npx droid-acp`       | stream-jsonrpc | ✅ Supported     | Default, recommended          |
| `npx droid-acp --acp` | native ACP     | ❌ Not supported | Lighter, direct pipe to droid |

> **Note:** Native ACP mode (`--acp`) has a limitation in droid where custom models configured in `~/.factory/config.json` are not recognized. Use the default stream-jsonrpc mode if you need custom models.

### Environment Variables

- `FACTORY_API_KEY` - Your Factory API key (required)
- `DROID_EXECUTABLE` - Path to the droid binary (optional, defaults to `droid` in PATH)
- `DROID_ACP_WEBSEARCH` - Enable local proxy to optionally intercept Droid websearch (`/api/tools/exa/search`)
- `DROID_ACP_WEBSEARCH_FORWARD_URL` - Optional forward target for websearch (base URL or full URL)
- `DROID_ACP_WEBSEARCH_FORWARD_MODE` - Forward mode for `DROID_ACP_WEBSEARCH_FORWARD_URL` (`http` or `mcp`, default: `http`)
- `DROID_ACP_WEBSEARCH_UPSTREAM_URL` - Optional upstream Factory API base URL (default: `FACTORY_API_BASE_URL_OVERRIDE` or `https://api.factory.ai`)
- `DROID_ACP_WEBSEARCH_HOST` - Optional proxy bind host (default: `127.0.0.1`)
- `DROID_ACP_WEBSEARCH_PORT` - Optional proxy bind port (default: random available port)

- `SMITHERY_API_KEY` - Optional (recommended) Smithery Exa MCP API key (enables high-quality websearch)
- `SMITHERY_PROFILE` - Optional Smithery Exa MCP profile id

### WebSearch Proxy (optional)

If you want to route Droid's websearch requests (`POST /api/tools/exa/search`) to your own handler:

```bash
DROID_ACP_WEBSEARCH=1 \
DROID_ACP_WEBSEARCH_FORWARD_URL="http://127.0.0.1:20002" \
npx droid-acp
```

If you want to use Smithery Exa (MCP) like `droid-patch`, set:

```bash
export SMITHERY_API_KEY="your_smithery_key"
export SMITHERY_PROFILE="your_profile_id"
DROID_ACP_WEBSEARCH=1 npx droid-acp
```

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
