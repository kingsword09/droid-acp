import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AvailableCommand,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  SessionNotification,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { DroidProcess, type DroidMessage, type DroidOptions } from "./droid-process.ts";
import { type Logger, nodeToWebReadable, nodeToWebWritable, Pushable } from "./utils.ts";

const packageJson = { name: "droid-acp", version: "0.1.0" };

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "plan";

interface Session {
  droidProcess: DroidProcess;
  input: Pushable<PromptRequest>;
  cancelled: boolean;
  permissionMode: PermissionMode;
  cwd: string;
  currentModel?: string;
}

interface ToolUseCache {
  [key: string]: {
    id: string;
    name: string;
    input: unknown;
  };
}

const AVAILABLE_MODELS = [
  {
    modelId: "claude-opus-4-5-20251101",
    name: "Claude Opus 4.5",
    description: "Claude Opus 4.5 (default)",
  },
  {
    modelId: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    description: "Claude Sonnet 4.5",
  },
  {
    modelId: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    description: "Claude Haiku 4.5",
  },
  { modelId: "gpt-5.1", name: "GPT-5.1", description: "OpenAI GPT-5.1" },
  { modelId: "gpt-5.1-codex", name: "GPT-5.1-Codex", description: "OpenAI GPT-5.1-Codex" },
  { modelId: "gpt-5.1-codex-max", name: "GPT-5.1-Codex-Max", description: "GPT-5.1-Codex-Max" },
  { modelId: "gpt-5.2", name: "GPT-5.2", description: "OpenAI GPT-5.2" },
  { modelId: "gemini-3-pro-preview", name: "Gemini 3 Pro", description: "Gemini 3 Pro" },
  { modelId: "glm-4.6", name: "Droid Core", description: "Droid Core (GLM-4.6)" },
];

export class DroidAcpAgent implements Agent {
  sessions: Record<string, Session> = {};
  client: AgentSideConnection;
  toolUseCache: ToolUseCache = {};
  clientCapabilities?: ClientCapabilities;
  logger: Logger;

  constructor(client: AgentSideConnection, logger?: Logger) {
    this.client = client;
    this.logger = logger ?? console;
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;

    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          image: false,
          embeddedContext: true,
        },
        sessionCapabilities: {},
      },
      agentInfo: {
        name: packageJson.name,
        title: "Droid",
        version: packageJson.version,
      },
      authMethods: [
        {
          id: "api-key",
          name: "API Key",
          description: "Set FACTORY_API_KEY environment variable",
        },
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomUUID();

    const droidOptions: DroidOptions = {
      cwd: params.cwd,
      sessionId,
      logger: this.logger,
      autoLevel: "medium",
    };

    const droidProcess = new DroidProcess(droidOptions);
    const input = new Pushable<PromptRequest>();

    this.sessions[sessionId] = {
      droidProcess,
      input,
      cancelled: false,
      permissionMode: "default",
      cwd: params.cwd,
      currentModel: "claude-opus-4-5-20251101",
    };

    await droidProcess.start();

    droidProcess.on("message", (message: DroidMessage) => {
      void this.handleDroidMessage(sessionId, message);
    });

    droidProcess.on("close", (code: number) => {
      this.logger.log(`Droid process closed with code ${code}`);
    });

    droidProcess.on("error", (err: Error) => {
      this.logger.error(`Droid process error: ${err.message}`);
    });

    const availableCommands: AvailableCommand[] = [];

    setTimeout(() => {
      void this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands,
        },
      });
    }, 0);

    const availableModes = [
      {
        id: "default",
        name: "Default",
        description: "Standard behavior (read-only mode)",
      },
      {
        id: "acceptEdits",
        name: "Auto Low",
        description: "Low-risk operations",
      },
      {
        id: "dontAsk",
        name: "Auto Medium",
        description: "Development operations",
      },
      {
        id: "bypassPermissions",
        name: "Auto High",
        description: "Production operations (dangerous)",
      },
    ];

    return {
      sessionId,
      models: {
        availableModels: AVAILABLE_MODELS,
        currentModelId: "claude-opus-4-5-20251101",
      },
      modes: {
        currentModeId: "default",
        availableModes,
      },
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    throw new Error(
      "Authentication via API key is required. Set FACTORY_API_KEY environment variable.",
    );
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }

    session.cancelled = false;

    const promptText = this.extractPromptText(params);
    if (!promptText) {
      return { stopReason: "end_turn" };
    }

    const droidMessage: DroidMessage = {
      type: "user",
      role: "user",
      content: promptText,
    };

    return new Promise<PromptResponse>((resolve, reject) => {
      const messageHandler = (message: DroidMessage) => {
        if (session.cancelled) {
          session.droidProcess.removeListener("message", messageHandler);
          resolve({ stopReason: "cancelled" });
          return;
        }

        if (message.type === "result" || message.type === "end") {
          session.droidProcess.removeListener("message", messageHandler);
          resolve({ stopReason: "end_turn" });
          return;
        }

        if (message.type === "error") {
          session.droidProcess.removeListener("message", messageHandler);
          const errorMsg = typeof message.message === "string" ? message.message : "Unknown error";
          reject(new Error(errorMsg));
          return;
        }
      };

      session.droidProcess.on("message", messageHandler);

      session.droidProcess.on("close", () => {
        session.droidProcess.removeListener("message", messageHandler);
        resolve({ stopReason: "end_turn" });
      });

      try {
        session.droidProcess.send(droidMessage);
      } catch (err) {
        session.droidProcess.removeListener("message", messageHandler);
        reject(err);
      }
    });
  }

  private extractPromptText(params: PromptRequest): string {
    const parts: string[] = [];

    for (const chunk of params.prompt) {
      switch (chunk.type) {
        case "text":
          parts.push(chunk.text);
          break;
        case "resource":
          if ("text" in chunk.resource) {
            parts.push(
              `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`,
            );
          }
          break;
        case "resource_link":
          parts.push(`@${chunk.uri}`);
          break;
        default:
          break;
      }
    }

    return parts.join("\n");
  }

  private async handleDroidMessage(sessionId: string, message: DroidMessage): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;

    const notifications = this.droidMessageToAcpNotifications(sessionId, message);
    for (const notification of notifications) {
      await this.client.sessionUpdate(notification);
    }
  }

  private droidMessageToAcpNotifications(
    sessionId: string,
    message: DroidMessage,
  ): SessionNotification[] {
    const notifications: SessionNotification[] = [];

    switch (message.type) {
      case "text":
      case "assistant":
        if (message.content) {
          const text =
            typeof message.content === "string" ? message.content : JSON.stringify(message.content);
          notifications.push({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text,
              },
            },
          });
        }
        break;

      case "thinking":
        if (message.content) {
          const text =
            typeof message.content === "string" ? message.content : JSON.stringify(message.content);
          notifications.push({
            sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: {
                type: "text",
                text,
              },
            },
          });
        }
        break;

      case "tool_use":
      case "tool_call": {
        const toolId = typeof message.id === "string" ? message.id : randomUUID();
        const toolName = typeof message.name === "string" ? message.name : "unknown";
        const toolInput = message.input;

        this.toolUseCache[toolId] = {
          id: toolId,
          name: toolName,
          input: toolInput,
        };

        notifications.push({
          sessionId,
          update: {
            toolCallId: toolId,
            sessionUpdate: "tool_call",
            rawInput: toolInput,
            status: "in_progress",
            title: toolName,
          },
        });
        break;
      }

      case "tool_result": {
        const toolUseId = typeof message.tool_use_id === "string" ? message.tool_use_id : "";
        const cached = this.toolUseCache[toolUseId];

        if (cached) {
          notifications.push({
            sessionId,
            update: {
              toolCallId: toolUseId,
              sessionUpdate: "tool_call_update",
              status: message.is_error ? "failed" : "completed",
            },
          });
        }
        break;
      }

      case "todo":
      case "plan":
        if (Array.isArray(message.entries)) {
          notifications.push({
            sessionId,
            update: {
              sessionUpdate: "plan",
              entries: (
                message.entries as Array<{ title?: string; status?: string; content?: string }>
              ).map((entry, index) => {
                const title = entry.title || JSON.stringify(entry);
                return {
                  id: `todo-${index}`,
                  title,
                  content: entry.content || title,
                  priority: "medium" as const,
                  status: (entry.status === "completed"
                    ? "completed"
                    : entry.status === "in_progress"
                      ? "in_progress"
                      : "pending") as "pending" | "in_progress" | "completed",
                };
              }),
            },
          });
        }
        break;

      default:
        break;
    }

    return notifications;
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }

    session.cancelled = true;
    await session.droidProcess.stop();
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }

    session.currentModel = params.modelId;

    const newDroidOptions: DroidOptions = {
      cwd: session.cwd,
      sessionId: params.sessionId,
      model: params.modelId,
      logger: this.logger,
      autoLevel: this.permissionModeToAutoLevel(session.permissionMode),
    };

    await session.droidProcess.stop();
    session.droidProcess = new DroidProcess(newDroidOptions);
    await session.droidProcess.start();

    session.droidProcess.on("message", (message: DroidMessage) => {
      void this.handleDroidMessage(params.sessionId, message);
    });
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }

    const validModes: PermissionMode[] = [
      "default",
      "acceptEdits",
      "bypassPermissions",
      "dontAsk",
      "plan",
    ];

    if (!validModes.includes(params.modeId as PermissionMode)) {
      throw new Error("Invalid Mode");
    }

    session.permissionMode = params.modeId as PermissionMode;

    const newDroidOptions: DroidOptions = {
      cwd: session.cwd,
      sessionId: params.sessionId,
      model: session.currentModel,
      logger: this.logger,
      autoLevel: this.permissionModeToAutoLevel(session.permissionMode),
    };

    await session.droidProcess.stop();
    session.droidProcess = new DroidProcess(newDroidOptions);
    await session.droidProcess.start();

    session.droidProcess.on("message", (message: DroidMessage) => {
      void this.handleDroidMessage(params.sessionId, message);
    });

    return {};
  }

  private permissionModeToAutoLevel(mode: PermissionMode): "low" | "medium" | "high" | undefined {
    switch (mode) {
      case "default":
        return undefined;
      case "acceptEdits":
        return "low";
      case "dontAsk":
        return "medium";
      case "bypassPermissions":
        return "high";
      case "plan":
        return undefined;
      default:
        return undefined;
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return await this.client.readTextFile(params);
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return await this.client.writeTextFile(params);
  }
}

export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new DroidAcpAgent(client), stream);
}
