import {
  type Agent,
  AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type AvailableCommand,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
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
  type PermissionRequest,
} from "./types.ts";
import { isEnvEnabled, type Logger, nodeToWebReadable, nodeToWebWritable } from "./utils.ts";

const nodeRequire = createRequire(import.meta.url);
const packageJson = nodeRequire("../package.json") as {
  name: string;
  version: string;
};

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
// Note: Only commands that can be implemented via Droid's JSON-RPC API are supported.
// CLI-only commands (clear, compact, sessions, etc.) don't have API equivalents.
function getAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: "help",
      description: "Show available slash commands",
      input: null,
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
}

interface Session {
  id: string;
  droid: DroidAdapter;
  droidSessionId: string;
  model: string;
  mode: AcpModeId;
  cancelled: boolean;
  promptResolve: ((result: PromptResponse) => void) | null;
  activeToolCallIds: Set<string>;
  toolCallStatus: Map<string, "pending" | "in_progress" | "completed" | "failed">;
  toolNames: Map<string, string>;
  availableModels: Array<{ id: string; displayName: string }>;
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
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
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

  async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = request.cwd || process.cwd();
    this.logger.log("newSession:", cwd);

    const droid = createDroidAdapter({ cwd, logger: this.logger });
    const initResult = await droid.start();

    const sessionId = initResult.sessionId;
    const initialMode: AcpModeId =
      typeof initResult.settings?.autonomyLevel === "string"
        ? (droidAutonomyToAcpModeId(initResult.settings.autonomyLevel) ?? "off")
        : "off";
    const session: Session = {
      id: sessionId,
      droid,
      droidSessionId: initResult.sessionId,
      model: initResult.settings?.modelId || "unknown",
      mode: initialMode,
      cancelled: false,
      promptResolve: null,
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
    droid.onNotification((n) => this.handleNotification(session, n));

    // Forward raw events for debugging (enable with DROID_DEBUG=1)
    if (process.env.DROID_DEBUG) {
      droid.onRawEvent(async (event) => {
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
      if (method === "droid.request_permission") {
        return this.handlePermission(session, params as PermissionRequest);
      }
      throw new Error("Method not supported");
    });

    // Handle droid process exit
    droid.onExit((code) => {
      this.logger.log("Droid exited, cleaning up session:", session.id, "code:", code);
      if (session.promptResolve) {
        session.promptResolve({ stopReason: "end_turn" });
        session.promptResolve = null;
      }
      this.sessions.delete(session.id);
    });

    this.sessions.set(sessionId, session);
    this.logger.log("Session created:", sessionId);

    // Help diagnose Zed env + websearch proxy wiring (only emits when relevant env is set).
    const shouldEmitWebsearchStatus =
      isEnvEnabled(process.env.DROID_ACP_WEBSEARCH) ||
      Boolean(process.env.DROID_ACP_WEBSEARCH_FORWARD_URL) ||
      Boolean(process.env.SMITHERY_API_KEY) ||
      Boolean(process.env.SMITHERY_PROFILE);
    if (shouldEmitWebsearchStatus) {
      const websearchProxyBaseUrl = droid.getWebsearchProxyBaseUrl();
      const parentFactoryApiKey = process.env.FACTORY_API_KEY;
      const willInjectDummyFactoryApiKey = isEnvEnabled(process.env.DROID_ACP_WEBSEARCH) && !parentFactoryApiKey;
      setTimeout(() => {
        void this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text:
                [
                  "[droid-acp] WebSearch 状态",
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

    return {
      sessionId,
      models: {
        availableModels: initResult.availableModels.map((m) => ({
          modelId: m.id,
          name: m.displayName,
        })),
        currentModelId: initResult.settings?.modelId || "unknown",
      },
      modes: {
        currentModeId: initialMode,
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
      },
    };
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

    // Handle slash commands
    if (text.startsWith("/")) {
      const handled = await this.handleSlashCommand(session, text);
      if (handled) {
        return { stopReason: "end_turn" };
      }
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
            return `- \`/${cmd.name}${inputHint}\` - ${cmd.description}`;
          }),
        ].join("\n");
        await this.sendAgentMessage(session, helpText);
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

      default:
        // Unknown command - show error
        await this.sendAgentMessage(
          session,
          `Unknown command: \`/${command}\`. Type \`/help\` to see available commands.`,
        );
        return true;
    }
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

      const explicit = stripped.match(/^(?:Option|方案)\s*([A-Z])\s*[：:–—.)-]\s*(.+)$/i);
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
                `我选择方案 ${choiceId}。请基于该方案继续完善计划/关键改动点，并在准备好执行时再提示退出 spec。`,
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
          // Handle tool use in message
          if (n.toolUse) {
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
          if (n.text) {
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
