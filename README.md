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
droid-acp
```

### With Zed Editor

Configure Zed to use droid-acp as an external agent.

### Environment Variables

- `FACTORY_API_KEY` - Your Factory API key (required)
- `DROID_EXECUTABLE` - Path to the droid binary (optional, defaults to `droid` in PATH)

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
