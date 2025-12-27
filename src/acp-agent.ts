import {
  type Agent,
  AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type AvailableCommand,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type PermissionOption,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { createRequire } from "node:module";
import { createDroidAdapter, type DroidAdapter } from "./droid-adapter.ts";
import {
  ACP_MODES,
  type AcpModeId,
  type DroidAutonomyLevel,
  type DroidNotification,
  type DroidPermissionOption,
  type InitSessionResult,
  type PermissionRequest,
} from "./types.ts";
import {
  listFactorySessions,
  readFactorySessionStart,
  type FactorySessionSettings,
  resolveFactorySessionJsonlPath,
  resolveFactorySessionSettingsJsonPath,
  readFactorySessionSettings,
  streamFactorySessionJsonl,
} from "./factory-sessions.ts";
import { readLastAgentStreamingResult } from "./factory-logs.ts";
import { isEnvEnabled, type Logger, nodeToWebReadable, nodeToWebWritable } from "./utils.ts";

const nodeRequire = createRequire(import.meta.url);
const packageJson = nodeRequire("../package.json") as {
  name: string;
  version: string;
};

// Mirrors Droid TUI context indicator (see bundled CLI: N_B / L93)
const DROID_CONTEXT_INDICATOR_MIN_TOKENS = 11_000;
const DROID_CONTEXT_INDICATOR_MAX_TOKENS = 300_000;
const DROID_CONTEXT_INDICATOR_MAX_TOKENS_ANTHROPIC = 200_000;

function isExperimentSessionsEnabled(): boolean {
  return isEnvEnabled(process.env.DROID_ACP_EXPERIMENT_SESSIONS);
}

function sanitizeHistoryTextForDisplay(text: string): string {
  let out = text;
  out = out.replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/gi, "");
  out = out.replace(/<context[^>]*>[\s\S]*?(<\/context>|$)/gi, "");
  out = out.replace(/<\/?context[^>]*>/gi, "");
  out = out.replace(/<\/?system-reminder>/gi, "");
  out = out.replace(/\r\n/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

function sanitizeSessionTitle(title: string): string {
  let out = title;
  out = out.replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/gi, "");
  out = out.replace(/<\/?context[^>]*>/gi, "");
  out = out.replace(/<\/?system-reminder>/gi, "");
  out = out.replace(/^\s*(User|Assistant)\s*:\s*/i, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function formatTimestampForDisplay(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return isoTimestamp;
  const pad2 = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function normalizeBase64DataUrl(
  data: string,
  fallbackMimeType: string,
): { mimeType: string; base64: string } {
  const trimmed = data.trim();
  const match = trimmed.match(/^data:([^;,]+);base64,(.*)$/s);
  if (match) {
    const mimeType = match[1]?.trim() || fallbackMimeType;
    const base64 = match[2]?.trim().replace(/\s+/g, "");
    return { mimeType, base64 };
  }

  return { mimeType: fallbackMimeType, base64: trimmed.replace(/\s+/g, "") };
}

// Available slash commands for ACP adapter
// Note: Most commands are implemented via Droid's JSON-RPC API, but a few are implemented
// in the adapter itself (e.g. /context, /compress, /sessions).
function getAvailableCommands(): AvailableCommand[] {
  const commands: AvailableCommand[] = [
    {
      name: "help",
      description: "Show available slash commands",
      input: null,
    },
    {
      name: "context",
      description: "Show token usage (context indicator) for this session",
      input: null,
    },
    {
      name: "compress",
      description: "Compress conversation history (summary + restart)",
      input: { hint: "[optional instructions]" },
    },
    {
      name: "compact",
      description: "Alias for /compress",
      input: { hint: "[optional instructions]" },
    },
    {
      name: "model",
      description: "Show or change the current model",
      input: { hint: "[model_id]" },
    },
    {
      name: "mode",
      description: "Show or change the autonomy mode (off|low|medium|high|spec)",
      input: { hint: "[mode]" },
    },
    {
      name: "config",
      description: "Show current session configuration",
      input: null,
    },
    {
      name: "status",
      description: "Show current session status",
      input: null,
    },
  ];

  if (isExperimentSessionsEnabled()) {
    commands.push({
      name: "sessions",
      description: "List or load previous sessions (local Droid history)",
      input: { hint: "[load <session_id>|all]" },
    });
  }

  return commands;
}

interface SessionCapture {
  purpose: "compress_summary";
  buffer: string;
  timeoutId: NodeJS.Timeout;
  finalizeTimeoutId: NodeJS.Timeout | null;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

interface Session {
  id: string;
  droid: DroidAdapter;
  droidSessionId: string;
  title: string | null;
  updatedAt: string | null;
  pendingHistoryContext: string | null;
  model: string;
  mode: AcpModeId;
  cancelled: boolean;
  promptResolve: ((result: PromptResponse) => void) | null;
  capture: SessionCapture | null;
  activeToolCallIds: Set<string>;
  toolCallStatus: Map<string, "pending" | "in_progress" | "completed" | "failed">;
  toolNames: Map<string, string>;
  availableModels: InitSessionResult["availableModels"];
  cwd: string;
  specChoice: string | null;
  specChoicePromptSignature: string | null;
  specPlanDetailsSignature: string | null;
  specPlanDetailsToolCallId: string | null;
}

const ACP_MODE_TO_DROID_AUTONOMY: Record<AcpModeId, DroidAutonomyLevel> = {
  off: "normal",
  low: "auto-low",
  medium: "auto-medium",
  high: "auto-high",
  spec: "spec",
};

function droidAutonomyToAcpModeId(value: string): AcpModeId | null {
  switch (value) {
    case "normal":
      return "off";
    case "auto-low":
      return "low";
    case "auto-medium":
      return "medium";
    case "auto-high":
      return "high";
    case "spec":
      return "spec";
    // legacy values
    case "suggest":
      return "low";
    case "full":
      return "high";
    default:
      return null;
  }
}

export class DroidAcpAgent implements Agent {
  private sessions: Map<string, Session> = new Map();
  private client: AgentSideConnection;
  private logger: Logger;

  constructor(client: AgentSideConnection, logger?: Logger) {
    this.client = client;
    this.logger = logger ?? console;
    this.logger.log("DroidAcpAgent initialized");
  }

  async initialize(_request: InitializeRequest): Promise<InitializeResponse> {
    this.logger.log("initialize");
    const enableSessions = isExperimentSessionsEnabled();
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: enableSessions,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: enableSessions ? { list: {}, resume: {} } : {},
      },
      agentInfo: {
        name: packageJson.name,
        title: "Factory Droid",
        version: packageJson.version,
      },
      authMethods: [
        {
          id: "factory-api-key",
          name: "Factory API Key",
          description: "Set FACTORY_API_KEY environment variable",
        },
      ],
    };
  }

  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse> {
    this.logger.log("authenticate:", request.methodId);
    if (request.methodId === "factory-api-key") {
      if (!process.env.FACTORY_API_KEY) {
        throw new Error("FACTORY_API_KEY environment variable is not set");
      }
      return {};
    }
    throw new Error(`Unknown auth method: ${request.methodId}`);
  }

  private getInitialMode(initResult: InitSessionResult): AcpModeId {
    return typeof initResult.settings?.autonomyLevel === "string"
      ? (droidAutonomyToAcpModeId(initResult.settings.autonomyLevel) ?? "off")
      : "off";
  }

  private getModelsState(initResult: InitSessionResult): NonNullable<NewSessionResponse["models"]> {
    return {
      availableModels: initResult.availableModels.map((m) => ({
        modelId: m.id,
        name: m.displayName,
      })),
      currentModelId: initResult.settings?.modelId || "unknown",
    };
  }

  private getModesState(currentModeId: AcpModeId): NonNullable<NewSessionResponse["modes"]> {
    return {
      currentModeId,
      availableModes: [
        {
          id: "spec",
          name: "Spec",
          description: "Research and plan only - no code changes",
        },
        {
          id: "off",
          name: "Auto Off",
          description: "Read-only mode - safe for reviewing planned changes without execution",
        },
        {
          id: "low",
          name: "Auto Low",
          description: "Low-risk operations - file creation/modification, no system changes",
        },
        {
          id: "medium",
          name: "Auto Medium",
          description: "Development operations - npm install, git commit, build commands",
        },
        {
          id: "high",
          name: "Auto High",
          description: "Production operations - git push, deployments, database migrations",
        },
      ],
    };
  }

  private attachSession(params: {
    sessionId: string;
    cwd: string;
    droid: DroidAdapter;
    initResult: InitSessionResult;
    title?: string | null;
  }): { session: Session; initialMode: AcpModeId } {
    const { sessionId, cwd, droid, initResult } = params;

    const initialMode = this.getInitialMode(initResult);
    const now = new Date().toISOString();
    const session: Session = {
      id: sessionId,
      droid,
      droidSessionId: initResult.sessionId,
      title: typeof params.title === "string" ? params.title : "New Session",
      updatedAt: now,
      pendingHistoryContext: null,
      model: initResult.settings?.modelId || "unknown",
      mode: initialMode,
      cancelled: false,
      promptResolve: null,
      capture: null,
      activeToolCallIds: new Set(),
      toolCallStatus: new Map(),
      toolNames: new Map(),
      availableModels: initResult.availableModels,
      cwd,
      specChoice: null,
      specChoicePromptSignature: null,
      specPlanDetailsSignature: null,
      specPlanDetailsToolCallId: null,
    };

    // Set up notification handler
    droid.onNotification((n) => {
      const current = this.sessions.get(sessionId);
      if (!current || current.droid !== droid) return;
      void this.handleNotification(current, n);
    });

    // Forward raw events for debugging (enable with DROID_DEBUG=1)
    if (process.env.DROID_DEBUG) {
      droid.onRawEvent(async (event) => {
        const current = this.sessions.get(sessionId);
        if (!current || current.droid !== droid) return;
        await this.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `\n\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\`\n`,
            },
          },
        });
      });
    }

    // Handle permission requests
    droid.onRequest(async (method, params) => {
      const current = this.sessions.get(sessionId);
      if (!current || current.droid !== droid) {
        return { selectedOption: "proceed_once" };
      }
      if (method === "droid.request_permission") {
        return this.handlePermission(current, params as PermissionRequest);
      }
      throw new Error("Method not supported");
    });

    // Handle droid process exit
    droid.onExit((code) => {
      const current = this.sessions.get(sessionId);
      if (!current || current.droid !== droid) {
        this.logger.log("Droid exited (stale), ignoring:", sessionId, "code:", code);
        return;
      }
      this.logger.log("Droid exited, cleaning up session:", sessionId, "code:", code);
      if (current.promptResolve) {
        current.promptResolve({ stopReason: "end_turn" });
        current.promptResolve = null;
      }
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    this.logger.log("Session created:", sessionId);

    // Ensure clients can track sessions and populate "History" UIs.
    setTimeout(() => {
      void this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          title: session.title,
          updatedAt: session.updatedAt,
        },
      });
    }, 0);

    // Optional diagnostics for Zed env + websearch proxy wiring.
    // Enable with DROID_ACP_WEBSEARCH_DEBUG=1 (or DROID_DEBUG=1).
    const shouldEmitWebsearchStatus =
      isEnvEnabled(process.env.DROID_ACP_WEBSEARCH_DEBUG) || isEnvEnabled(process.env.DROID_DEBUG);
    if (shouldEmitWebsearchStatus) {
      const websearchProxyBaseUrl = droid.getWebsearchProxyBaseUrl();
      const parentFactoryApiKey = process.env.FACTORY_API_KEY;
      const willInjectDummyFactoryApiKey =
        isEnvEnabled(process.env.DROID_ACP_WEBSEARCH) && !parentFactoryApiKey;
      setTimeout(() => {
        void this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text:
                [
                  "[droid-acp] WebSearch status",
                  `- DROID_ACP_WEBSEARCH: ${process.env.DROID_ACP_WEBSEARCH ?? "<unset>"}`,
                  `- DROID_ACP_WEBSEARCH_PORT: ${process.env.DROID_ACP_WEBSEARCH_PORT ?? "<unset>"}`,
                  `- DROID_ACP_WEBSEARCH_FORWARD_MODE: ${process.env.DROID_ACP_WEBSEARCH_FORWARD_MODE ?? "<unset>"}`,
                  `- DROID_ACP_WEBSEARCH_FORWARD_URL: ${process.env.DROID_ACP_WEBSEARCH_FORWARD_URL ?? "<unset>"}`,
                  `- FACTORY_API_KEY: ${parentFactoryApiKey ? "set" : "<unset>"}${willInjectDummyFactoryApiKey ? " (droid child auto-inject dummy)" : ""}`,
                  `- SMITHERY_API_KEY: ${process.env.SMITHERY_API_KEY ? "set" : "<unset>"}`,
                  `- SMITHERY_PROFILE: ${process.env.SMITHERY_PROFILE ? "set" : "<unset>"}`,
                  `- proxyBaseUrl: ${websearchProxyBaseUrl ?? "<not running>"}`,
                  websearchProxyBaseUrl ? `- health: ${websearchProxyBaseUrl}/health` : null,
                ]
                  .filter((l): l is string => typeof l === "string")
                  .join("\n") + "\n",
            },
          },
        });
      }, 0);
    }

    // Send available commands update after session response
    setTimeout(() => {
      void this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: getAvailableCommands(),
        },
      });
    }, 0);

    return { session, initialMode };
  }

  async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = request.cwd || process.cwd();
    this.logger.log("newSession:", cwd);

    const droid = createDroidAdapter({ cwd, logger: this.logger });
    const initResult = await droid.start();

    const sessionId = initResult.sessionId;
    const { initialMode } = this.attachSession({ sessionId, cwd, droid, initResult });

    return {
      sessionId,
      models: this.getModelsState(initResult),
      modes: this.getModesState(initialMode),
    };
  }

  async loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isExperimentSessionsEnabled()) {
      throw new Error(
        "Session load is experimental. Start droid-acp with --experiment-sessions (or set DROID_ACP_EXPERIMENT_SESSIONS=1).",
      );
    }

    const requestCwd = request.cwd || process.cwd();
    this.logger.log("loadSession:", request.sessionId, requestCwd);

    const existing = this.sessions.get(request.sessionId);
    if (existing?.droid.isRunning()) {
      return {
        models: {
          availableModels: existing.availableModels.map((m) => ({
            modelId: m.id,
            name: m.displayName,
          })),
          currentModelId: existing.model,
        },
        modes: this.getModesState(existing.mode),
      };
    }

    if (existing) {
      try {
        await existing.droid.stop();
      } catch {}
      this.sessions.delete(request.sessionId);
    }

    const jsonlPath = await resolveFactorySessionJsonlPath({
      sessionId: request.sessionId,
      cwd: requestCwd,
    });

    const header = jsonlPath ? await readFactorySessionStart(jsonlPath) : null;
    const cwd = header?.cwd ?? requestCwd;

    const droid = createDroidAdapter({
      cwd,
      logger: this.logger,
      resumeSessionId: request.sessionId,
    });
    const initResult = await droid.start();

    if (initResult.sessionId !== request.sessionId) {
      await droid.stop();
      throw new Error(
        `Failed to load session: expected ${request.sessionId} but got ${initResult.sessionId}`,
      );
    }

    const { session, initialMode } = this.attachSession({
      sessionId: request.sessionId,
      cwd,
      droid,
      initResult,
      title: header?.title ? sanitizeSessionTitle(header.title) : null,
    });

    if (jsonlPath) {
      await this.replayHistoryFromJsonl(session, jsonlPath);
    } else if (Array.isArray(initResult.session?.messages)) {
      await this.replayHistoryFromInitMessages(session, initResult.session.messages);
    } else {
      throw new Error(`Session history not found for ${request.sessionId}`);
    }

    return {
      models: this.getModelsState(initResult),
      modes: this.getModesState(initialMode),
    };
  }

  async unstable_listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
    if (!isExperimentSessionsEnabled()) {
      throw new Error(
        "Session list is experimental. Start droid-acp with --experiment-sessions (or set DROID_ACP_EXPERIMENT_SESSIONS=1).",
      );
    }

    this.logger.log(
      "listSessions:",
      request.cwd ?? "<unset>",
      "cursor:",
      request.cursor ?? "<unset>",
    );
    const { sessions, nextCursor } = await listFactorySessions({
      cwd: request.cwd ?? null,
      cursor: request.cursor ?? null,
      preferredCwd: request.cwd ?? process.cwd(),
    });
    this.logger.log("listSessions result:", sessions.length, "nextCursor:", nextCursor ?? "<none>");

    return {
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title ? sanitizeSessionTitle(s.title) : null,
        updatedAt: s.updatedAt,
      })),
      nextCursor,
    };
  }

  async unstable_resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (!isExperimentSessionsEnabled()) {
      throw new Error(
        "Session resume is experimental. Start droid-acp with --experiment-sessions (or set DROID_ACP_EXPERIMENT_SESSIONS=1).",
      );
    }

    const cwd = request.cwd || process.cwd();
    this.logger.log("resumeSession:", request.sessionId, cwd);

    const existing = this.sessions.get(request.sessionId);
    if (existing?.droid.isRunning()) {
      return {
        models: {
          availableModels: existing.availableModels.map((m) => ({
            modelId: m.id,
            name: m.displayName,
          })),
          currentModelId: existing.model,
        },
        modes: this.getModesState(existing.mode),
      };
    }

    if (existing) {
      try {
        await existing.droid.stop();
      } catch {}
      this.sessions.delete(request.sessionId);
    }

    const droid = createDroidAdapter({
      cwd,
      logger: this.logger,
      resumeSessionId: request.sessionId,
    });
    const initResult = await droid.start();

    if (initResult.sessionId !== request.sessionId) {
      await droid.stop();
      throw new Error(
        `Failed to resume session: expected ${request.sessionId} but got ${initResult.sessionId}`,
      );
    }

    const { initialMode } = this.attachSession({
      sessionId: request.sessionId,
      cwd,
      droid,
      initResult,
    });

    return {
      models: this.getModelsState(initResult),
      modes: this.getModesState(initialMode),
    };
  }

  private async replayHistoryFromJsonl(session: Session, jsonlPath: string): Promise<void> {
    this.logger.log("Replaying session history from:", jsonlPath);

    for await (const entry of streamFactorySessionJsonl(jsonlPath)) {
      const record = entry as { type?: unknown; message?: unknown; id?: unknown };
      if (record.type !== "message") continue;

      const message = record.message as {
        role?: unknown;
        content?: unknown;
      };
      const role = message?.role;
      const content = message?.content;
      if (role !== "user" && role !== "assistant" && role !== "system") continue;
      if (!Array.isArray(content)) continue;

      const messageId = typeof record.id === "string" ? record.id : "message";
      await this.replayHistoryMessage(session, {
        role,
        id: messageId,
        content,
      });
    }
  }

  private async replayHistoryFromInitMessages(
    session: Session,
    messages: unknown[],
  ): Promise<void> {
    this.logger.log("Replaying session history from init result (messages):", messages.length);

    for (const entry of messages) {
      const message = entry as { role?: unknown; content?: unknown; id?: unknown };
      const role = message?.role;
      const content = message?.content;

      if (role !== "user" && role !== "assistant" && role !== "system") continue;
      if (!Array.isArray(content)) continue;

      const id = typeof message.id === "string" ? message.id : "message";
      await this.replayHistoryMessage(session, {
        role,
        id,
        content,
      });
    }
  }

  private async replayHistoryMessage(
    session: Session,
    message: { role: "user" | "assistant" | "system"; id: string; content: unknown[] },
  ): Promise<void> {
    if (message.role === "user") {
      for (const block of message.content) {
        const b = block as Record<string, unknown>;
        const blockType = b.type as string | undefined;
        if (blockType === "tool_result") continue;

        if (blockType === "text") {
          const text = typeof b.text === "string" ? b.text : "";
          const cleaned = sanitizeHistoryTextForDisplay(text);
          if (cleaned.length > 0) {
            await this.client.sessionUpdate({
              sessionId: session.id,
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: cleaned },
              },
            });
          }
          continue;
        }

        if (blockType === "image") {
          const source = b.source as { type?: unknown; data?: unknown } | undefined;
          const data = typeof source?.data === "string" ? source.data : null;
          const mimeType =
            (typeof b.media_type === "string" ? b.media_type : null) ??
            (typeof b.mediaType === "string" ? b.mediaType : null);
          if (data && mimeType) {
            await this.client.sessionUpdate({
              sessionId: session.id,
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "image", data, mimeType },
              },
            });
          }
          continue;
        }
      }
      return;
    }

    if (message.role === "assistant") {
      const textParts = message.content
        .filter((c) => (c as Record<string, unknown>)?.type === "text")
        .map((c) => ((c as Record<string, unknown>)?.text as string) ?? "")
        .filter((t) => typeof t === "string" && t.length > 0)
        .map((t) => sanitizeHistoryTextForDisplay(t))
        .filter((t) => t.length > 0);

      if (textParts.length > 0) {
        await this.handleNotification(session, {
          type: "message",
          role: "assistant",
          id: message.id,
          text: textParts.join(""),
        });
      }
    }
  }

  private async buildHistoryTranscriptFromJsonl(
    jsonlPath: string,
    maxChars: number,
  ): Promise<string> {
    const lines: string[] = [];
    let includedSessionHistory = false;

    for await (const entry of streamFactorySessionJsonl(jsonlPath)) {
      const record = entry as { type?: unknown; message?: unknown };
      if (record.type !== "message") continue;

      const message = record.message as { role?: unknown; content?: unknown };
      const role = message?.role;
      const content = message?.content;
      if (role !== "user" && role !== "assistant") continue;
      if (!Array.isArray(content)) continue;

      const rawText = content
        .filter((c) => (c as Record<string, unknown>)?.type === "text")
        .map((c) => ((c as Record<string, unknown>)?.text as string) ?? "")
        .join("");

      if (role === "user") {
        const sessionHistoryMatch = rawText.match(
          /<context[^>]*\sref=["']session_history["'][^>]*>([\s\S]*?)<\/context>/i,
        );
        const embeddedHistory = sessionHistoryMatch?.[1] ? sessionHistoryMatch[1].trim() : "";
        if (!includedSessionHistory && embeddedHistory.length > 0) {
          const cleanedHistory = sanitizeHistoryTextForDisplay(embeddedHistory);
          if (cleanedHistory.length > 0) {
            includedSessionHistory = true;
            lines.push(`[Previous session transcript]\n${cleanedHistory}`);
          }
        }

        const withoutSessionHistory = rawText.replace(
          /<context[^>]*\sref=["']session_history["'][^>]*>[\s\S]*?<\/context>/gi,
          "",
        );
        const cleanedUserText = sanitizeHistoryTextForDisplay(withoutSessionHistory);
        if (cleanedUserText.length > 0) {
          lines.push(`User: ${cleanedUserText}`);
        }
        continue;
      }

      const cleanedAssistantText = sanitizeHistoryTextForDisplay(rawText);
      if (cleanedAssistantText.length > 0) {
        lines.push(`Assistant: ${cleanedAssistantText}`);
      }
    }

    const transcript = lines.join("\n\n").trim();
    if (transcript.length <= maxChars) return transcript;
    return transcript.slice(transcript.length - maxChars);
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) throw new Error(`Session not found: ${request.sessionId}`);
    if (session.cancelled) throw new Error("Session cancelled");
    if (session.promptResolve) throw new Error("Another prompt is already in progress");

    this.logger.log("prompt:", request.sessionId);

    // Convert ACP prompt blocks into Droid user message (text + images).
    const textParts: string[] = [];
    const images: Array<{ type: "base64"; data: string; mediaType: string }> = [];
    for (const chunk of request.prompt) {
      switch (chunk.type) {
        case "text":
          textParts.push(chunk.text);
          break;

        case "image": {
          const mimeType = chunk.mimeType || "application/octet-stream";
          if (chunk.data) {
            const normalized = normalizeBase64DataUrl(chunk.data, mimeType);
            images.push({
              type: "base64",
              data: normalized.base64,
              mediaType: normalized.mimeType,
            });
          } else if (chunk.uri) {
            textParts.push(`(image: ${chunk.uri})`);
          }
          break;
        }

        case "resource":
          if ("text" in chunk.resource) {
            const contextText = `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`;
            textParts.push(contextText);
          } else if ("blob" in chunk.resource) {
            const mimeType =
              (chunk.resource as { mimeType?: string | null }).mimeType ||
              "application/octet-stream";
            const uri = (chunk.resource as { uri?: string }).uri;
            if (mimeType.startsWith("image/")) {
              const data = (chunk.resource as { blob?: unknown }).blob;
              if (typeof data === "string" && data.length > 0) {
                const normalized = normalizeBase64DataUrl(data, mimeType);
                images.push({
                  type: "base64",
                  data: normalized.base64,
                  mediaType: normalized.mimeType,
                });
              }
            } else {
              const note = uri
                ? `\n<context ref="${uri}">\n(binary resource: ${mimeType})\n</context>`
                : `\n(binary resource: ${mimeType})`;
              textParts.push(note);
            }
          }
          break;
        case "resource_link":
          textParts.push(`@${chunk.uri}`);
          break;
        default:
          break;
      }
    }
    let text = textParts.join("\n").trim();
    if (text.length === 0 && images.length > 0) {
      text = "Please see the attached image(s).";
    }

    const derivedTitle = (() => {
      const firstLine = text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (!firstLine) return null;
      const cleaned = sanitizeSessionTitle(firstLine);
      if (cleaned.length === 0) return null;
      return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
    })();

    const now = new Date().toISOString();
    session.updatedAt = now;
    if ((!session.title || session.title === "New Session") && derivedTitle) {
      session.title = derivedTitle;
    }
    void this.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "session_info_update",
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });

    // Handle slash commands
    if (text.startsWith("/")) {
      const handled = await this.handleSlashCommand(session, text);
      if (handled) {
        return { stopReason: "end_turn" };
      }
    }

    if (session.pendingHistoryContext) {
      const historyContext = session.pendingHistoryContext;
      session.pendingHistoryContext = null;
      text = `${text}\n\n<context ref="session_history">\n${historyContext}\n</context>`.trim();
    }

    // Send message and wait for completion
    return new Promise((resolve) => {
      const timeoutId = setTimeout(
        () => {
          if (session.promptResolve) {
            session.promptResolve({ stopReason: "end_turn" });
            session.promptResolve = null;
          }
        },
        5 * 60 * 1000,
      );

      session.promptResolve = resolve;
      session.droid.sendUserMessage({
        text,
        images: images.length > 0 ? images : undefined,
      });

      // Ensure we don't leak timers if the prompt resolves normally.
      const originalResolve = session.promptResolve;
      session.promptResolve = (result) => {
        clearTimeout(timeoutId);
        originalResolve?.(result);
      };
    });
  }

  async cancel(request: CancelNotification): Promise<void> {
    const session = this.sessions.get(request.sessionId);
    if (session) {
      this.logger.log("cancel:", request.sessionId);
      session.cancelled = true;
      if (session.promptResolve) {
        session.promptResolve({ stopReason: "cancelled" });
        session.promptResolve = null;
      }
      await session.droid.stop();
      this.sessions.delete(request.sessionId);
    }
  }

  async unstable_setSessionModel(
    request: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const session = this.sessions.get(request.sessionId);
    if (session) {
      this.logger.log("setSessionModel:", request.modelId);
      session.model = request.modelId;
      session.droid.setModel(request.modelId);
    }
  }

  async setSessionMode(request: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(request.sessionId);
    if (session) {
      this.logger.log("setSessionMode:", request.modeId);
      const modeId = ACP_MODES.includes(request.modeId as AcpModeId)
        ? (request.modeId as AcpModeId)
        : null;
      if (modeId) {
        session.mode = modeId;
        session.droid.setMode(ACP_MODE_TO_DROID_AUTONOMY[modeId]);
      }
    }
    return {};
  }

  private async handleSlashCommand(session: Session, text: string): Promise<boolean> {
    const match = text.match(/^\/(\S+)(?:\s+(.*))?$/);
    if (!match) return false;

    const [, command, args] = match;
    const trimmedArgs = args?.trim() || "";

    switch (command.toLowerCase()) {
      case "help": {
        const commands = getAvailableCommands();
        const helpText = [
          "**Available Commands:**\n",
          ...commands.map((cmd) => {
            const inputHint = cmd.input && "hint" in cmd.input ? ` ${cmd.input.hint}` : "";
            return `- /${cmd.name}${inputHint} - ${cmd.description}`;
          }),
        ].join("\n");
        await this.sendAgentMessage(session, helpText);
        return true;
      }

      case "context": {
        const settingsPath = await resolveFactorySessionSettingsJsonPath({
          sessionId: session.droidSessionId,
          cwd: session.cwd,
        });
        const settings = settingsPath ? await readFactorySessionSettings(settingsPath) : null;
        const modelFromSettings = settings?.model ?? null;
        const reasoningEffort = settings?.reasoningEffort ?? "unknown";

        // Prefer Droid's per-call token usage from the Factory log (matches TUI's context indicator).
        const streaming = await readLastAgentStreamingResult({ sessionId: session.droidSessionId });
        if (!streaming) {
          const usage: FactorySessionSettings["tokenUsage"] | undefined = settings?.tokenUsage;
          if (!usage) {
            await this.sendAgentMessage(
              session,
              "No token usage data yet.\n\nSend at least one message first, then run `/context` again.",
            );
            return true;
          }

          const inputTokens = usage.inputTokens ?? 0;
          const outputTokens = usage.outputTokens ?? 0;
          const cacheReadTokens = usage.cacheReadTokens ?? 0;
          const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
          const thinkingTokens = usage.thinkingTokens ?? 0;
          const total = inputTokens + outputTokens + cacheReadTokens;
          const n = (v: number) => v.toLocaleString();

          await this.sendAgentMessage(
            session,
            [
              `**Context / Token Usage:**`,
              `- Model: ${modelFromSettings ?? session.model}`,
              `- Reasoning effort: ${reasoningEffort}`,
              "",
              "Could not find the last per-call usage in `~/.factory/logs/droid-log-single.log`.",
              "Showing cumulative session totals from `*.settings.json` instead (not a context %).",
              "",
              `**Cumulative totals:**`,
              `- total (input + output + cacheRead): ${n(total)} tokens`,
              `- inputTokens: ${n(inputTokens)}`,
              `- outputTokens: ${n(outputTokens)}`,
              `- cacheReadTokens: ${n(cacheReadTokens)}`,
              `- cacheCreationTokens: ${n(cacheCreationTokens)}`,
              `- thinkingTokens: ${n(thinkingTokens)}`,
            ].join("\n"),
          );
          return true;
        }

        const modelId = modelFromSettings ?? streaming.modelId ?? session.model;
        const provider = session.availableModels.find((m) => m.id === modelId)?.modelProvider;

        const inputTokens = streaming.inputTokens;
        const outputTokens = streaming.outputTokens;
        const cacheReadTokens = streaming.cacheReadInputTokens;
        const cacheCreationTokens = streaming.cacheCreationInputTokens;

        const total = inputTokens + outputTokens + cacheReadTokens;
        const n = (v: number) => v.toLocaleString();

        const maxTokens =
          provider === "anthropic"
            ? DROID_CONTEXT_INDICATOR_MAX_TOKENS_ANTHROPIC
            : DROID_CONTEXT_INDICATOR_MAX_TOKENS;
        const denom = Math.max(1, maxTokens - DROID_CONTEXT_INDICATOR_MIN_TOKENS);
        const numer = Math.max(0, total - DROID_CONTEXT_INDICATOR_MIN_TOKENS);
        const pctRounded = Math.min(100, Math.round((numer / denom) * 100));
        const contextPct = total > 0 && pctRounded === 0 ? "<1%" : `${pctRounded}%`;

        const timeLine = streaming.timestamp
          ? `- Time: ${formatTimestampForDisplay(streaming.timestamp)}`
          : null;

        await this.sendAgentMessage(
          session,
          [
            `**Context / Token Usage (last model call):**`,
            `- Model: ${modelId}`,
            `- Reasoning effort: ${reasoningEffort}`,
            timeLine,
            `- Context: ${contextPct} (total=${n(total)}, max=${n(maxTokens)})`,
            "",
            `**Breakdown (last call):**`,
            `- inputTokens: ${n(inputTokens)}`,
            `- outputTokens: ${n(outputTokens)}`,
            `- cacheReadTokens: ${n(cacheReadTokens)}`,
            `- cacheCreationTokens: ${n(cacheCreationTokens)} (not counted above)`,
          ]
            .filter((l): l is string => typeof l === "string")
            .join("\n"),
        );

        return true;
      }

      case "compress":
      case "compact": {
        if (!session.droid.isRunning()) {
          await this.sendAgentMessage(session, "Droid is not running.");
          return true;
        }
        if (session.capture) {
          await this.sendAgentMessage(session, "Another operation is already in progress.");
          return true;
        }

        const extra = trimmedArgs.length > 0 ? `\n\nExtra instructions: ${trimmedArgs}` : "";
        const summaryPrompt = [
          "Create a compact handoff summary of our conversation so far.",
          "",
          "Requirements:",
          "- Keep it short and information-dense.",
          "- Include: goal, current state, key decisions, important files/paths, and next TODOs.",
          "- Do NOT include tool call logs, <system-reminder>, or <context> blocks.",
          "- Output must be ONLY a single <summary>...</summary> block.",
          extra,
        ]
          .join("\n")
          .trim();

        await this.sendAgentMessage(session, "Compressing conversation history…");

        let summaryRaw: string;
        try {
          summaryRaw = await this.captureNextAssistantText(session, summaryPrompt, {
            timeoutMs: 2 * 60 * 1000,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.sendAgentMessage(session, `Failed to generate summary: ${msg}`);
          return true;
        }

        const summaryText = this.extractSummaryText(summaryRaw);
        const cleanedSummary = sanitizeHistoryTextForDisplay(summaryText);
        if (cleanedSummary.length === 0) {
          await this.sendAgentMessage(
            session,
            "Compression failed: summary was empty. Try again with fewer instructions.",
          );
          return true;
        }

        const oldDroid = session.droid;
        const oldMode = session.mode;
        const oldModel = session.model;
        const title = session.title;
        const cwd = session.cwd;

        await this.sendAgentMessage(
          session,
          "Starting a fresh Droid session with summary context…",
        );

        const newDroid = createDroidAdapter({ cwd, logger: this.logger });
        const initResult = await newDroid.start();
        const { session: newSession } = this.attachSession({
          sessionId: session.id,
          cwd,
          droid: newDroid,
          initResult,
          title,
        });

        // Best-effort: preserve the current mode/model across the restart.
        newSession.mode = oldMode;
        newSession.droid.setMode(ACP_MODE_TO_DROID_AUTONOMY[oldMode]);
        await this.client.sessionUpdate({
          sessionId: newSession.id,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: oldMode,
          },
        });

        if (newSession.availableModels.some((m) => m.id === oldModel)) {
          newSession.model = oldModel;
          newSession.droid.setModel(oldModel);
        }

        // Stop the old process after the new session is attached (so stale exit events are ignored).
        await oldDroid.stop();

        // Inject the compressed context on the next user message.
        newSession.pendingHistoryContext = cleanedSummary;

        await this.sendAgentMessage(
          newSession,
          "Compression complete.\n\nYour next message will automatically include the summary context.",
        );

        return true;
      }

      case "model": {
        if (trimmedArgs) {
          // Change model
          const modelId = trimmedArgs;
          const model = session.availableModels.find(
            (m) => m.id === modelId || m.displayName.toLowerCase() === modelId.toLowerCase(),
          );
          if (model) {
            session.model = model.id;
            session.droid.setModel(model.id);
            await this.sendAgentMessage(session, `Model changed to: **${model.displayName}**`);
          } else {
            const available = session.availableModels.map((m) => `- ${m.id} (${m.displayName})`);
            await this.sendAgentMessage(
              session,
              `Model "${modelId}" not found.\n\n**Available models:**\n${available.join("\n")}`,
            );
          }
        } else {
          // Show current model
          const available = session.availableModels.map((m) => {
            const current = m.id === session.model ? " **(current)**" : "";
            return `- ${m.id} (${m.displayName})${current}`;
          });
          await this.sendAgentMessage(
            session,
            `**Current model:** ${session.model}\n\n**Available models:**\n${available.join("\n")}`,
          );
        }
        return true;
      }

      case "mode": {
        const inputMode = trimmedArgs.toLowerCase() as AcpModeId;
        if (trimmedArgs && ACP_MODES.includes(inputMode)) {
          session.mode = inputMode;
          session.droid.setMode(ACP_MODE_TO_DROID_AUTONOMY[inputMode]);
          await this.sendAgentMessage(session, `Autonomy mode changed to: **${inputMode}**`);
          await this.client.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: inputMode,
            },
          });
        } else {
          const modeList = ACP_MODES.map((m) => {
            const current = m === session.mode ? " **(current)**" : "";
            return `- ${m}${current}`;
          }).join("\n");
          await this.sendAgentMessage(
            session,
            `**Current mode:** ${session.mode}\n\n**Available modes:**\n${modeList}`,
          );
        }
        return true;
      }

      case "config": {
        const config = [
          `**Session Configuration:**`,
          `- Session ID: ${session.id}`,
          `- Working Directory: ${session.cwd}`,
          `- Model: ${session.model}`,
          `- Mode: ${session.mode}`,
        ].join("\n");
        await this.sendAgentMessage(session, config);
        return true;
      }

      case "status": {
        const status = [
          `**Session Status:**`,
          `- Active Tool Calls: ${session.activeToolCallIds.size}`,
          `- Droid Running: ${session.droid.isRunning()}`,
        ].join("\n");
        await this.sendAgentMessage(session, status);
        return true;
      }

      case "sessions": {
        if (!isExperimentSessionsEnabled()) {
          await this.sendAgentMessage(
            session,
            "Experimental feature disabled.\n\nEnable with `npx droid-acp --experiment-sessions` (or set `DROID_ACP_EXPERIMENT_SESSIONS=1`).",
          );
          return true;
        }

        const parts = trimmedArgs.split(/\s+/).filter((p) => p.length > 0);
        const sub = parts[0]?.toLowerCase();

        if (!sub || sub === "list") {
          const { sessions } = await listFactorySessions({
            cwd: session.cwd,
            cursor: null,
            pageSize: 20,
          });

          if (sessions.length === 0) {
            await this.sendAgentMessage(
              session,
              `No sessions found for:\n\n- cwd: ${session.cwd}\n\nTry: /sessions all`,
            );
            return true;
          }

          const lines = sessions.map((s) => {
            const time = s.updatedAt ? ` — ${formatTimestampForDisplay(s.updatedAt)}` : "";
            const cleanedTitle = s.title ? sanitizeSessionTitle(s.title) : "";
            const title = cleanedTitle.length > 0 ? ` — ${cleanedTitle}` : "";
            return `- ${s.sessionId}${title}${time}`;
          });

          await this.sendAgentMessage(
            session,
            [`**Sessions (${session.cwd})**`, "", ...lines, "", "Use: /sessions load <session_id>"]
              .join("\n")
              .trim(),
          );
          return true;
        }

        if (sub === "all") {
          const { sessions } = await listFactorySessions({
            cwd: null,
            cursor: null,
            pageSize: 20,
            preferredCwd: session.cwd,
          });

          if (sessions.length === 0) {
            await this.sendAgentMessage(session, "No sessions found in local history.");
            return true;
          }

          const lines = sessions.map((s) => {
            const time = s.updatedAt ? ` — ${formatTimestampForDisplay(s.updatedAt)}` : "";
            const cleanedTitle = s.title ? sanitizeSessionTitle(s.title) : "";
            const title = cleanedTitle.length > 0 ? ` — ${cleanedTitle}` : "";
            return `- ${s.sessionId} (${s.cwd})${title}${time}`;
          });

          await this.sendAgentMessage(
            session,
            ["**Recent Sessions**", "", ...lines, "", "Use: /sessions load <session_id>"]
              .join("\n")
              .trim(),
          );
          return true;
        }

        if (sub === "load" && typeof parts[1] === "string" && parts[1].length > 0) {
          const targetSessionId = parts[1];
          await this.sendAgentMessage(session, `Loading session: ${targetSessionId}…`);

          const jsonlPath = await resolveFactorySessionJsonlPath({
            sessionId: targetSessionId,
            cwd: session.cwd,
          });
          if (!jsonlPath) {
            await this.sendAgentMessage(
              session,
              `Session history not found on disk for: ${targetSessionId}`,
            );
            return true;
          }

          const header = await readFactorySessionStart(jsonlPath);
          const cwd = header?.cwd ?? session.cwd;

          try {
            await session.droid.stop();
          } catch {}

          let droid = createDroidAdapter({
            cwd,
            logger: this.logger,
            resumeSessionId: targetSessionId,
          });
          let initResult = await droid.start();
          const resumed = initResult.sessionId === targetSessionId;
          if (!resumed) {
            try {
              await droid.stop();
            } catch {}
            droid = createDroidAdapter({ cwd, logger: this.logger });
            initResult = await droid.start();
          }

          const { session: newSession } = this.attachSession({
            sessionId: session.id,
            cwd,
            droid,
            initResult,
            title: header?.title ? sanitizeSessionTitle(header.title) : null,
          });

          if (!resumed) {
            const transcript = await this.buildHistoryTranscriptFromJsonl(jsonlPath, 12000);
            if (transcript.length > 0) {
              newSession.pendingHistoryContext = transcript;
            }
            await this.sendAgentMessage(
              newSession,
              `\n\nNote: history is loaded from disk for ${targetSessionId}, but Droid could not resume this session id.\n\nYour next message will automatically include a transcript as context (so Droid can continue without a Factory login).`,
            );
          }

          await this.replayHistoryFromJsonl(newSession, jsonlPath);
          return true;
        }

        await this.sendAgentMessage(
          session,
          "Usage:\n\n- /sessions (list current cwd)\n- /sessions all (list global)\n- /sessions load <session_id>",
        );
        return true;
      }

      default:
        // Unknown command - show error
        await this.sendAgentMessage(
          session,
          `Unknown command: /${command}. Type /help to see available commands.`,
        );
        return true;
    }
  }

  private extractSummaryText(text: string): string {
    const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (match) return match[1]?.trim() ?? "";
    return text.trim();
  }

  private captureNextAssistantText(
    session: Session,
    prompt: string,
    options?: { timeoutMs?: number },
  ): Promise<string> {
    if (session.capture) {
      return Promise.reject(new Error("Capture already in progress"));
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? 2 * 60 * 1000;
      const timeoutId = setTimeout(() => {
        if (!session.capture) return;
        const capture = session.capture;
        session.capture = null;
        if (capture.finalizeTimeoutId) clearTimeout(capture.finalizeTimeoutId);
        capture.reject(new Error("Timed out while waiting for summary"));
      }, timeoutMs);

      session.capture = {
        purpose: "compress_summary",
        buffer: "",
        timeoutId,
        finalizeTimeoutId: null,
        resolve: (t: string) => resolve(t),
        reject: (e: Error) => reject(e),
      };

      session.droid.sendUserMessage({ text: prompt });
    });
  }

  private async sendAgentMessage(session: Session, text: string): Promise<void> {
    await this.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  private extractSpecTitleAndPlan(rawInput: unknown): {
    title: string | null;
    plan: string | null;
  } {
    if (!rawInput || typeof rawInput !== "object") return { title: null, plan: null };

    const obj = rawInput as Record<string, unknown>;

    const title =
      typeof obj.title === "string"
        ? obj.title
        : typeof obj.specTitle === "string"
          ? obj.specTitle
          : typeof obj.name === "string"
            ? obj.name
            : null;

    const candidates: unknown[] = [
      obj.plan,
      (obj as { planMarkdown?: unknown }).planMarkdown,
      (obj as { markdown?: unknown }).markdown,
      (obj as { content?: unknown }).content,
      (obj as { text?: unknown }).text,
    ];

    const toMarkdown = (value: unknown): string | null => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        const parts = value.map((v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2)));
        const joined = parts.join("\n").trim();
        return joined.length > 0 ? joined : null;
      }
      if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        if (typeof v.markdown === "string") return v.markdown;
        if (typeof v.text === "string") return v.text;
        const json = JSON.stringify(v, null, 2);
        return json && json !== "{}" ? json : null;
      }
      return null;
    };

    for (const c of candidates) {
      const plan = toMarkdown(c);
      if (plan) return { title, plan };
    }

    return { title, plan: null };
  }

  private planEntriesFromMarkdown(planMarkdown: string): Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority: "medium";
  }> {
    const entries: Array<{
      content: string;
      status: "pending" | "in_progress" | "completed";
      priority: "medium";
    }> = [];
    let inCodeFence = false;

    for (const rawLine of planMarkdown.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("```")) {
        inCodeFence = !inCodeFence;
        continue;
      }
      if (inCodeFence) continue;
      if (!line) continue;

      const checkbox = line.match(/^- \[([ xX~])\]\s+(.*)$/);
      if (checkbox) {
        const [, mark, content] = checkbox;
        const status =
          mark === "x" || mark === "X"
            ? ("completed" as const)
            : mark === "~"
              ? ("in_progress" as const)
              : ("pending" as const);
        entries.push({ content, status, priority: "medium" as const });
        continue;
      }

      const bullet = line.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        entries.push({
          content: bullet[1],
          status: "pending",
          priority: "medium",
        });
        continue;
      }

      const numbered = line.match(/^\d+\.\s+(.*)$/);
      if (numbered) {
        entries.push({
          content: numbered[1],
          status: "pending",
          priority: "medium",
        });
        continue;
      }
    }

    return entries.filter((e) => e.content.length > 0);
  }

  private extractPlanChoices(planMarkdown: string): Array<{ id: string; title: string }> {
    const explicitChoices: Array<{ id: string; title: string }> = [];
    const looseChoices: Array<{ id: string; title: string }> = [];
    const seenExplicit = new Set<string>();
    const seenLoose = new Set<string>();

    for (const rawLine of planMarkdown.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      const stripped = line
        .replace(/^>\s+/, "")
        .replace(/^#+\s*/, "")
        .replace(/^[-*]\s+/, "")
        .trim()
        .replace(/^[*_`]+/, "")
        .trim();

      const explicit = stripped.match(/^(?:Option)\s*([A-Z])\s*[：:–—.)-]\s*(.+)$/i);
      if (explicit) {
        const id = explicit[1].toUpperCase();
        if (seenExplicit.has(id)) continue;
        seenExplicit.add(id);

        const title = explicit[2].trim();
        explicitChoices.push({ id, title });
        continue;
      }

      // Looser fallback: allow "A: ..." / "B) ..." style lines (only if we find multiple).
      const loose = stripped.match(/^([A-F])\s*[：:–—.)-]\s*(.+)$/);
      if (!loose) continue;

      const id = loose[1].toUpperCase();
      if (seenLoose.has(id)) continue;
      seenLoose.add(id);

      const title = loose[2].trim();
      looseChoices.push({ id, title });
    }

    if (explicitChoices.length > 0) return explicitChoices;
    if (looseChoices.length >= 2) return looseChoices;
    return [];
  }

  private handlePermission(
    session: Session,
    params: PermissionRequest,
  ): Promise<{ selectedOption: string }> {
    const toolUse = params.toolUses?.[0]?.toolUse;
    if (!toolUse) {
      return Promise.resolve({ selectedOption: "proceed_once" });
    }

    const toolCallId = toolUse.id;
    const toolName = toolUse.name;
    const rawInput = toolUse.input;
    const spec = toolName === "ExitSpecMode" ? this.extractSpecTitleAndPlan(rawInput) : null;
    const command =
      typeof rawInput?.command === "string"
        ? rawInput.command
        : toolName === "ExitSpecMode" && typeof spec?.title === "string"
          ? spec.title
          : JSON.stringify(rawInput);
    const commandSummary = command.length > 200 ? command.slice(0, 200) + "…" : command;
    const isReadOnlyTool =
      toolName === "Read" || toolName === "Grep" || toolName === "Glob" || toolName === "LS";
    const riskLevelRaw = (rawInput as { riskLevel?: unknown } | null | undefined)?.riskLevel;
    const riskLevel =
      riskLevelRaw === "low" || riskLevelRaw === "medium" || riskLevelRaw === "high"
        ? riskLevelRaw
        : isReadOnlyTool
          ? "low"
          : "medium";

    this.logger.log(
      "Permission request for tool:",
      toolCallId,
      "risk:",
      riskLevel,
      "mode:",
      session.mode,
    );

    const toolCallTitle =
      toolName === "ExitSpecMode"
        ? spec?.title
          ? `Exit spec mode: ${spec.title}`
          : "Exit spec mode"
        : `Running ${toolName} (${riskLevel}): ${commandSummary}`;
    const toolCallKind = toolName === "ExitSpecMode" ? ("switch_mode" as const) : undefined;
    const toolCallContent =
      toolName === "ExitSpecMode" && spec?.plan
        ? [
            {
              type: "content" as const,
              content: { type: "text" as const, text: spec.plan },
            },
          ]
        : undefined;

    // Emit tool_call (pending), de-duping if the tool call was already created from a tool_use block.
    const alreadyTracked = session.activeToolCallIds.has(toolCallId);
    session.activeToolCallIds.add(toolCallId);
    session.toolNames.set(toolCallId, toolName);
    session.toolCallStatus.set(toolCallId, "pending");

    if (alreadyTracked) {
      void this.client.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          title: toolCallTitle,
          status: "pending",
          kind: toolCallKind,
          content: toolCallContent,
          rawInput,
        },
      });
    } else {
      void this.client.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolCallTitle,
          status: "pending",
          kind: toolCallKind,
          content: toolCallContent,
          rawInput,
        },
      });
    }

    return this.decidePermission(session, {
      toolCallId,
      toolName,
      command: commandSummary,
      riskLevel,
      rawInput,
      droidOptions: this.extractDroidPermissionOptions(params),
    });
  }

  private extractDroidPermissionOptions(params: PermissionRequest): DroidPermissionOption[] | null {
    const candidates: unknown[] = [];

    const maybePush = (value: unknown) => {
      if (Array.isArray(value)) candidates.push(value);
    };

    maybePush((params as unknown as { options?: unknown }).options);

    const toolUses = (params as unknown as { toolUses?: unknown }).toolUses;
    if (Array.isArray(toolUses)) {
      for (const toolUse of toolUses) {
        if (!toolUse || typeof toolUse !== "object") continue;
        const tu = toolUse as Record<string, unknown>;
        maybePush(tu.options);
        const details = tu.details;
        if (details && typeof details === "object") {
          maybePush((details as Record<string, unknown>).options);
        }
      }
    }

    for (const candidate of candidates) {
      const normalized = (candidate as unknown[])
        .map((opt) => opt as { value?: unknown; label?: unknown })
        .map((opt) => ({
          value: typeof opt.value === "string" ? opt.value : null,
          label: typeof opt.label === "string" ? opt.label : null,
        }))
        .filter((opt): opt is { value: string; label: string } => !!opt.value && !!opt.label)
        .map((opt) => ({ value: opt.value, label: opt.label }));

      if (normalized.length > 0) return normalized;
    }

    return null;
  }

  private mapExitSpecModeSelection(optionId: string): {
    nextMode: AcpModeId | null;
    droidSelectedOption: string;
  } {
    // Preferred: optionId equals ACP mode id.
    switch (optionId) {
      case "off":
        return { nextMode: "off", droidSelectedOption: "proceed_once" };
      case "low":
        return { nextMode: "low", droidSelectedOption: "proceed_auto_run_low" };
      case "medium":
        return { nextMode: "medium", droidSelectedOption: "proceed_auto_run_medium" };
      case "high":
        return { nextMode: "high", droidSelectedOption: "proceed_auto_run_high" };
      case "spec":
        return { nextMode: "spec", droidSelectedOption: "cancel" };
      default:
        break;
    }

    // Back-compat: accept Droid option ids directly (or other clients returning them).
    switch (optionId) {
      case "proceed_once":
        return { nextMode: "off", droidSelectedOption: "proceed_once" };
      case "proceed_auto_run_low":
        return { nextMode: "low", droidSelectedOption: "proceed_auto_run_low" };
      case "proceed_auto_run_medium":
        return { nextMode: "medium", droidSelectedOption: "proceed_auto_run_medium" };
      case "proceed_auto_run_high":
        return { nextMode: "high", droidSelectedOption: "proceed_auto_run_high" };
      case "cancel":
        return { nextMode: "spec", droidSelectedOption: "cancel" };
      default:
        return { nextMode: null, droidSelectedOption: optionId };
    }
  }

  private specApprovalOptions(droidOptions: DroidPermissionOption[] | null): PermissionOption[] {
    const has = (value: string): boolean => droidOptions?.some((o) => o.value === value) === true;

    const candidates: Array<{
      modeId: AcpModeId;
      droidValue: string;
      name: string;
      kind: PermissionOption["kind"];
    }> = [
      {
        modeId: "off",
        droidValue: "proceed_once",
        name: "Proceed (manual approvals)",
        kind: "allow_once",
      },
      {
        modeId: "low",
        droidValue: "proceed_auto_run_low",
        name: "Proceed (Auto Low)",
        kind: "allow_once",
      },
      {
        modeId: "medium",
        droidValue: "proceed_auto_run_medium",
        name: "Proceed (Auto Medium)",
        kind: "allow_once",
      },
      {
        modeId: "high",
        droidValue: "proceed_auto_run_high",
        name: "Proceed (Auto High)",
        kind: "allow_once",
      },
      {
        modeId: "spec",
        droidValue: "cancel",
        name: "No, keep iterating (stay in Spec)",
        kind: "reject_once",
      },
    ];

    const options = candidates
      .filter((c) => !droidOptions || has(c.droidValue))
      .map((c) => ({ optionId: c.modeId, name: c.name, kind: c.kind }));

    if (options.length > 0) return options;

    // Fallback: expose raw Droid options if we can't match.
    return (
      droidOptions?.map((o) => ({
        optionId: o.value,
        name: o.label,
        kind: "allow_once" as const,
      })) ?? [
        { optionId: "off", name: "Proceed (manual approvals)", kind: "allow_once" },
        { optionId: "spec", name: "No, keep iterating (stay in Spec)", kind: "reject_once" },
      ]
    );
  }

  private async decidePermission(
    session: Session,
    params: {
      toolCallId: string;
      toolName: string;
      command: string;
      riskLevel: "low" | "medium" | "high";
      rawInput: unknown;
      droidOptions: DroidPermissionOption[] | null;
    },
  ): Promise<{ selectedOption: string }> {
    if (session.cancelled) {
      session.toolCallStatus.set(params.toolCallId, "completed");
      session.activeToolCallIds.delete(params.toolCallId);
      await this.client.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: params.toolCallId,
          status: "completed",
        },
      });
      return { selectedOption: "cancel" };
    }

    const permissionKindFromOptionValue = (value: string): PermissionOption["kind"] => {
      switch (value) {
        case "proceed_once":
        case "proceed_edit":
          return "allow_once";
        case "proceed_auto_run_low":
        case "proceed_auto_run_medium":
        case "proceed_auto_run_high":
        case "proceed_auto_run":
        case "proceed_always":
          return "allow_always";
        case "cancel":
          return "reject_once";
        default:
          return "allow_once";
      }
    };

    const toAcpPermissionOption = (opt: DroidPermissionOption): PermissionOption => {
      const value = opt.value;
      let name = opt.label;
      switch (value) {
        case "proceed_once":
          name = "Allow once";
          break;
        case "proceed_always": {
          const labelLower = opt.label.toLowerCase();
          if (labelLower.includes("low")) {
            name = "Allow & auto-run low risk commands";
            break;
          }
          if (labelLower.includes("medium")) {
            name = "Allow & auto-run medium risk commands";
            break;
          }
          if (labelLower.includes("high")) {
            name = "Allow & auto-run high risk commands";
            break;
          }
          name = "Allow always";
          break;
        }
        case "proceed_auto_run_low":
          name = "Proceed & auto-run (low risk)";
          break;
        case "proceed_auto_run_medium":
          name = "Proceed & auto-run (medium risk)";
          break;
        case "proceed_auto_run_high":
          name = "Proceed & auto-run (high risk)";
          break;
        default:
          break;
      }
      return {
        optionId: value,
        name,
        kind: permissionKindFromOptionValue(value),
      };
    };

    const droidOptions = params.droidOptions?.length ? params.droidOptions : null;
    const acpOptions: PermissionOption[] =
      params.toolName === "ExitSpecMode"
        ? this.specApprovalOptions(droidOptions)
        : droidOptions
          ? droidOptions.map(toAcpPermissionOption)
          : [
              { optionId: "proceed_once", name: "Allow once", kind: "allow_once" },
              { optionId: "cancel", name: "Reject", kind: "reject_once" },
            ];

    const spec = this.extractSpecTitleAndPlan(params.rawInput);
    const planTitle = spec.title;
    const planMarkdown = spec.plan;

    if (params.toolName === "ExitSpecMode" && planMarkdown) {
      const signature = `${planTitle ?? ""}\n${planMarkdown}`;
      if (session.specChoicePromptSignature !== signature) {
        session.specChoicePromptSignature = signature;
        session.specChoice = null;
      }

      if (session.specPlanDetailsSignature !== signature) {
        session.specPlanDetailsSignature = signature;
        session.specPlanDetailsToolCallId = `${params.toolCallId}:plan_details`;
        await this.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: session.specPlanDetailsToolCallId,
            title: planTitle ? `Plan details: ${planTitle}` : "Plan details",
            kind: "think",
            status: "completed",
            content: [
              {
                type: "content",
                content: { type: "text", text: planMarkdown },
              },
            ],
          },
        });
      }

      if (session.specChoice === null) {
        const choices = this.extractPlanChoices(planMarkdown);
        if (choices.length > 0) {
          const detailsHint = session.specPlanDetailsToolCallId
            ? `Expand **${session.specPlanDetailsToolCallId}** to view the full plan details.`
            : "Expand the Plan details tool call to view the full plan details.";
          const choicePrompt = [
            planTitle ? `**${planTitle}**` : "**Choose an implementation option**",
            "",
            detailsHint,
            "Choose one to continue iterating in spec mode.",
            ...choices.map((c) => `- Option ${c.id}: ${c.title}`),
          ]
            .filter((p) => p.length > 0)
            .join("\n");

          const response = await this.client.requestPermission({
            sessionId: session.id,
            toolCall: {
              toolCallId: `${params.toolCallId}:choose_plan`,
              title: planTitle ? `Choose plan: ${planTitle}` : "Choose plan option",
              status: "pending",
              kind: "think",
              rawInput: { choices },
              content: [
                {
                  type: "content",
                  content: { type: "text", text: choicePrompt },
                },
              ],
            },
            options: [
              ...choices.map((c) => ({
                optionId: `choose_plan:${c.id}`,
                name: `Choose Option ${c.id}`,
                kind: "allow_once" as const,
              })),
              { optionId: "choose_plan:skip", name: "Skip", kind: "reject_once" as const },
            ],
          });

          const outcome =
            response.outcome.outcome === "selected"
              ? response.outcome.optionId
              : "choose_plan:skip";
          const match = outcome.match(/^choose_plan:([A-Z])$/);
          if (match) {
            const choiceId = match[1];
            session.specChoice = choiceId;

            // Close the temporary "choose plan" permission prompt tool call.
            await this.client.sessionUpdate({
              sessionId: session.id,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: `${params.toolCallId}:choose_plan`,
                status: "completed",
              },
            });

            // Close the original ExitSpecMode tool call since we're explicitly staying in spec mode.
            session.toolCallStatus.set(params.toolCallId, "completed");
            session.activeToolCallIds.delete(params.toolCallId);
            await this.client.sessionUpdate({
              sessionId: session.id,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: params.toolCallId,
                status: "completed",
                content: [
                  {
                    type: "content",
                    content: {
                      type: "text",
                      text: `Continuing in spec mode with Option ${choiceId}.`,
                    },
                  },
                ],
              },
            });

            await this.sendAgentMessage(
              session,
              `Selected **Option ${choiceId}**. Continuing in spec mode.`,
            );
            setTimeout(() => {
              session.droid.sendMessage(
                `I choose Option ${choiceId}. Please continue refining the plan and key changes based on this option, and when you are ready to execute, prompt to exit spec mode.`,
              );
            }, 0);
            return { selectedOption: "cancel" };
          }

          session.specChoice = "skip";
        }
      }
    }

    if (params.toolName === "ExitSpecMode" && planMarkdown) {
      const entries = this.planEntriesFromMarkdown(planMarkdown);

      if (entries.length > 0) {
        await this.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "plan",
            entries,
          },
        });
      } else if (planMarkdown.trim().length > 0) {
        await this.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "plan",
            entries: [
              {
                content: planMarkdown.trim(),
                status: "pending",
                priority: "medium",
              },
            ],
          },
        });
      }
    }

    // Decide whether to auto-approve, auto-reject, or ask the client UI.
    let autoDecision: string | null = null;
    if (params.toolName === "ExitSpecMode") {
      // Exiting spec triggers execution; always ask the user which mode to proceed with.
      autoDecision = null;
      this.logger.log("Prompting (ExitSpecMode)");
    } else if (session.mode === "high") {
      autoDecision = "proceed_always";
      this.logger.log("Auto-approved (high mode)");
    } else if (session.mode === "medium") {
      autoDecision = params.riskLevel === "high" ? null : "proceed_once";
      this.logger.log(
        autoDecision ? "Auto-approved (medium mode, low/med risk)" : "Prompting (medium mode)",
      );
    } else if (session.mode === "low") {
      autoDecision = params.riskLevel === "low" ? "proceed_once" : null;
      this.logger.log(autoDecision ? "Auto-approved (low mode, low risk)" : "Prompting (low mode)");
    } else if (session.mode === "spec") {
      // Spec mode: allow low-risk operations (read/search) without prompting.
      if (params.riskLevel === "low") {
        autoDecision = "proceed_once";
        this.logger.log("Auto-approved (spec mode, low risk)");
      } else {
        autoDecision = "cancel";
        this.logger.log("Auto-rejected (spec mode, medium/high risk)");
      }
    } else {
      // off mode: ask the user (no auto-approval)
      autoDecision = null;
      this.logger.log("Prompting (off mode)");
    }

    if (autoDecision) {
      const selectedOption =
        droidOptions?.some((o) => o.value === autoDecision) === true
          ? autoDecision
          : autoDecision === "cancel"
            ? "cancel"
            : droidOptions
              ? (droidOptions?.find((o) => permissionKindFromOptionValue(o.value) === "allow_once")
                  ?.value ??
                droidOptions?.find((o) => o.value !== "cancel")?.value ??
                "proceed_once")
              : autoDecision;

      const isExitSpecMode = params.toolName === "ExitSpecMode";
      const status =
        selectedOption === "cancel" || isExitSpecMode
          ? ("completed" as const)
          : ("in_progress" as const);

      session.toolCallStatus.set(params.toolCallId, status);
      if (status === "completed") {
        session.activeToolCallIds.delete(params.toolCallId);
      }
      await this.client.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: params.toolCallId,
          status,
          content:
            selectedOption === "cancel"
              ? [
                  {
                    type: "content",
                    content: {
                      type: "text",
                      text: `Permission denied for \`${params.toolName}\` (${params.riskLevel}).`,
                    },
                  },
                ]
              : undefined,
        },
      });
      return { selectedOption };
    }

    let permission: Awaited<ReturnType<AgentSideConnection["requestPermission"]>>;
    try {
      const title =
        params.toolName === "ExitSpecMode"
          ? planTitle
            ? `Exit spec mode: ${planTitle}`
            : "Exit spec mode"
          : `Running ${params.toolName} (${params.riskLevel}): ${params.command}`;

      permission = await this.client.requestPermission({
        sessionId: session.id,
        toolCall: {
          toolCallId: params.toolCallId,
          title,
          rawInput: params.rawInput,
        },
        options: acpOptions,
      });
    } catch (error) {
      this.logger.error("requestPermission failed:", error);
      session.toolCallStatus.set(params.toolCallId, "completed");
      session.activeToolCallIds.delete(params.toolCallId);
      await this.client.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: params.toolCallId,
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: `Permission request failed for \`${params.toolName}\`. Cancelling the operation.`,
              },
            },
          ],
        },
      });
      return { selectedOption: "cancel" };
    }

    let selectedOption = "cancel";
    if (permission.outcome.outcome === "selected") {
      selectedOption = permission.outcome.optionId;
    } else {
      selectedOption = "cancel";
    }

    if (params.toolName === "ExitSpecMode") {
      const mapped = this.mapExitSpecModeSelection(selectedOption);
      selectedOption = mapped.droidSelectedOption;

      if (mapped.nextMode) {
        session.mode = mapped.nextMode;
        await this.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: mapped.nextMode,
          },
        });
      }
    }

    const isExitSpecMode = params.toolName === "ExitSpecMode";
    const status =
      selectedOption === "cancel" || isExitSpecMode
        ? ("completed" as const)
        : ("in_progress" as const);

    session.toolCallStatus.set(params.toolCallId, status);
    if (status === "completed") {
      session.activeToolCallIds.delete(params.toolCallId);
    }

    // Close ExitSpecMode prompts explicitly so the UI doesn't leave them hanging.
    if (isExitSpecMode) {
      await this.client.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: params.toolCallId,
          status,
          content:
            selectedOption === "cancel"
              ? [
                  {
                    type: "content",
                    content: { type: "text", text: "Staying in Spec mode." },
                  },
                ]
              : undefined,
        },
      });
    } else if (selectedOption !== "cancel") {
      // If the user explicitly rejected the permission prompt, the Client will already
      // reflect that in the UI (e.g. "Rejected"). Avoid overwriting it with a "completed" status.
      await this.client.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: params.toolCallId,
          status,
        },
      });
    }

    return { selectedOption };
  }

  private async handleNotification(session: Session, n: DroidNotification): Promise<void> {
    this.logger.log("notification:", n.type);

    switch (n.type) {
      case "settings_updated": {
        const autonomyLevel =
          typeof n.settings.autonomyLevel === "string"
            ? droidAutonomyToAcpModeId(n.settings.autonomyLevel)
            : null;

        if (autonomyLevel && autonomyLevel !== session.mode) {
          session.mode = autonomyLevel;
          await this.client.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: autonomyLevel,
            },
          });
        }

        if (typeof n.settings.modelId === "string") {
          session.model = n.settings.modelId;
        }
        break;
      }

      case "message":
        if (n.role === "assistant") {
          const suppressAssistantOutput =
            session.capture?.purpose === "compress_summary" &&
            !isEnvEnabled(process.env.DROID_DEBUG);

          if (session.capture && n.text) {
            const capture = session.capture;
            capture.buffer += n.text;

            if (capture.purpose === "compress_summary" && /<\/summary>/i.test(capture.buffer)) {
              session.capture = null;
              clearTimeout(capture.timeoutId);
              if (capture.finalizeTimeoutId) clearTimeout(capture.finalizeTimeoutId);
              capture.resolve(capture.buffer);
            }
          }

          // Handle tool use in message
          if (n.toolUse && !suppressAssistantOutput) {
            if (n.toolUse.name === "TodoWrite") {
              const todos = (n.toolUse.input as { todos?: unknown })?.todos;
              if (Array.isArray(todos)) {
                const toStatus = (status: unknown): "pending" | "in_progress" | "completed" => {
                  switch (status) {
                    case "pending":
                    case "in_progress":
                    case "completed":
                      return status;
                    default:
                      return "pending";
                  }
                };

                const entries = todos
                  .map((t) => {
                    const todo = t as { content?: unknown; status?: unknown };
                    return {
                      content: typeof todo.content === "string" ? todo.content : "",
                      status: toStatus(todo.status),
                      priority: "medium" as const,
                    };
                  })
                  .filter((e) => e.content.length > 0);

                await this.client.sessionUpdate({
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "plan",
                    entries,
                  },
                });
              }
              break;
            }

            const toolCallId = n.toolUse.id;
            const isExitSpecMode = n.toolUse.name === "ExitSpecMode";
            const existingStatus = session.toolCallStatus.get(toolCallId);
            if (existingStatus !== "completed" && existingStatus !== "failed") {
              if (!session.activeToolCallIds.has(toolCallId)) {
                session.activeToolCallIds.add(toolCallId);
                session.toolNames.set(toolCallId, n.toolUse.name);

                const initialStatus = isExitSpecMode ? "pending" : "in_progress";
                session.toolCallStatus.set(toolCallId, initialStatus);

                const spec = isExitSpecMode ? this.extractSpecTitleAndPlan(n.toolUse.input) : null;
                await this.client.sessionUpdate({
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: toolCallId,
                    title: isExitSpecMode
                      ? spec?.title
                        ? `Exit spec mode: ${spec.title}`
                        : "Exit spec mode"
                      : `Running ${n.toolUse.name}`,
                    kind: isExitSpecMode ? ("switch_mode" as const) : undefined,
                    status: initialStatus,
                    rawInput: n.toolUse.input,
                    content:
                      isExitSpecMode && spec?.plan
                        ? [{ type: "content", content: { type: "text", text: spec.plan } }]
                        : undefined,
                  },
                });
              } else {
                const status = session.toolCallStatus.get(toolCallId);
                if (status !== "completed" && status !== "failed" && status !== "pending") {
                  session.toolCallStatus.set(toolCallId, "in_progress");
                  await this.client.sessionUpdate({
                    sessionId: session.id,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: toolCallId,
                      status: "in_progress",
                    },
                  });
                }
              }
            }
          }

          // Handle text content
          if (n.text && !suppressAssistantOutput) {
            await this.client.sessionUpdate({
              sessionId: session.id,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: n.text },
              },
            });
          }
        }
        break;

      case "tool_result":
        if (!session.activeToolCallIds.has(n.toolUseId)) {
          session.activeToolCallIds.add(n.toolUseId);
          const name = session.toolNames.get(n.toolUseId) ?? "Tool";
          await this.client.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: n.toolUseId,
              title: `Running ${name}`,
              status: "in_progress",
            },
          });
        }

        const finalStatus = n.isError ? ("failed" as const) : ("completed" as const);

        // Send the tool response content + completion status
        await this.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: n.toolUseId,
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: n.content,
                },
              },
            ],
            rawOutput: n.content,
            status: finalStatus,
          },
        });

        session.toolCallStatus.set(n.toolUseId, finalStatus);
        session.activeToolCallIds.delete(n.toolUseId);
        break;

      case "error":
        if (session.capture) {
          const capture = session.capture;
          session.capture = null;
          clearTimeout(capture.timeoutId);
          if (capture.finalizeTimeoutId) clearTimeout(capture.finalizeTimeoutId);
          capture.reject(new Error(n.message));
        }
        await this.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Error: ${n.message}` },
          },
        });
        if (session.promptResolve) {
          session.promptResolve({ stopReason: "end_turn" });
          session.promptResolve = null;
        }
        break;

      case "complete":
        if (session.capture) {
          const capture = session.capture;
          if (!capture.finalizeTimeoutId) {
            capture.finalizeTimeoutId = setTimeout(() => {
              if (session.capture !== capture) return;
              session.capture = null;
              clearTimeout(capture.timeoutId);
              capture.resolve(capture.buffer);
            }, 1000);
          }
          break;
        }
        if (session.promptResolve) {
          session.promptResolve({ stopReason: "end_turn" });
          session.promptResolve = null;
        }
        break;
    }
  }

  async cleanup(): Promise<void> {
    for (const [, session] of this.sessions) {
      await session.droid.stop();
    }
    this.sessions.clear();
  }
}

export function runAcp(): void {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new DroidAcpAgent(client), stream);
}
