# droid-acp

ACP (Agent Client Protocol) adapter for [Droid](https://factory.ai) - Factory's AI coding agent.

Use Droid from any [ACP-compatible](https://agentclientprotocol.com) clients such as [Zed](https://zed.dev)!

## Features

- Context @-mentions
- Tool calls
- TODO lists
- Image prompts (e.g. paste screenshots in Zed)
- Context / token usage indicator (`/context`)
- Context compaction (`/compress`)
- Multiple model support
- Session modes (Spec, Manual, Auto Low/Medium/High)
- Experimental: sessions/history (session list/load + `/sessions`)
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

# Enable experimental sessions/history helpers
npx droid-acp --experiment-sessions

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

**Enable experimental sessions/history (`/sessions`, `session/list`, `session/load`):**

```json
{
  "agent_servers": {
    "Droid Sessions (Experimental)": {
      "type": "custom",
      "command": "npx",
      "args": ["droid-acp", "--experiment-sessions"]
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
- `DROID_ACP_FACTORY_DIR` - Override Factory config dir (defaults to `~/.factory`)
- `DROID_ACP_EXPERIMENT_SESSIONS` - Enable experimental sessions/history features (same as `--experiment-sessions`)

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
- The proxy forces `Accept-Encoding: identity` upstream and strips `content-encoding`/`content-length` when proxying to avoid Brotli decompression errors in some client setups.

## Sessions (History / Resume)

This is an **experimental** feature. Enable with `npx droid-acp --experiment-sessions` (or set `DROID_ACP_EXPERIMENT_SESSIONS=1`).

droid-acp supports ACP `session/list`, `session/load` and `session/resume`, plus an in-thread workaround command:

- `/sessions`: list/load sessions from local Droid history (useful because some clients don’t yet persist external ACP agent history)
- `session/load`: replays the full conversation history back to the client
- `session/resume`: resumes without replay (faster, but the client won’t get old messages from the agent)

### `/sessions` usage

- `/sessions` (or `/sessions list`) - list sessions for the current `cwd`
- `/sessions all` - list recent sessions across all `cwd`s (prefers the current `cwd`)
- `/sessions load <session_id>` - switch to that session/history

When loading:

- droid-acp first tries to resume Droid via `--session-id` (fast path).
- If resume fails, it replays history from disk and automatically appends a transcript to your _next_ message so Droid can continue without a Factory login.

Notes:

- History is replayed from Droid’s local session store under `~/.factory/sessions` (override with `DROID_ACP_FACTORY_DIR`).
- For a cleaner UI, history replay filters out system reminders, embedded `<context ...>` blocks, and tool calls/tool results.
- Session titles are sanitized (some Droid sessions store titles like `<context ref="session_history"> ...`).
- Session IDs are displayed as plain text for easy copy/paste.
- Times shown in `/sessions` are displayed as `YYYY-MM-DD HH:mm:ss` in your local timezone.
- Native ACP mode (`--acp`) does not support these helpers.

## Context / Token Usage (`/context`)

Some ACP clients don’t expose Droid’s built-in token usage indicator UI. Use `/context` to print the **last model call** context indicator (matching Droid’s TUI). droid-acp reads this from `~/.factory/logs/droid-log-single.log`.

Notes:

- `Total` is computed as `inputTokens + outputTokens + cacheReadTokens` (matching Droid’s internal “lastTokenUsage”).
- The context % matches Droid’s TUI: `max=200000` for Anthropic models, otherwise `max=300000`.

## Compress / Compact (`/compress`, `/compact`)

Droid’s built-in `/compress` is TUI-only. In stream-jsonrpc mode, droid-acp implements an equivalent workflow:

1. Ask Droid to generate a short `<summary>...</summary>` of the current conversation
2. Restart the underlying Droid exec session
3. Inject the summary as embedded context on your next message (so the new session continues with a smaller context)

Notes:

- This is an adapter-level feature; it is **not available** in native ACP mode (`npx droid-acp --acp`).
- The generated summary is captured silently (it is not shown in the chat transcript) and will be appended to your next message as embedded context.
- You can pass optional instructions: `/compress focus on current code changes and next steps`.

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
