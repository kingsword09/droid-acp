import {
  type Agent,
  AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
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
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { createDroidAdapter, type DroidAdapter } from "./droid-adapter.ts";
import {
  ACP_TO_DROID_MODE,
  type AutonomyLevel,
  type DroidNotification,
  type PermissionRequest,
} from "./types.ts";
import { type Logger, nodeToWebReadable, nodeToWebWritable } from "./utils.ts";

const packageJson = { name: "droid-acp", version: "0.1.0" };

interface Session {
  id: string;
  droid: DroidAdapter;
  droidSessionId: string;
  model: string;
  mode: string;
  cancelled: boolean;
  promptResolve: ((result: PromptResponse) => void) | null;
  activeToolCallIds: Set<string>;
  toolCallStatus: Map<string, "pending" | "in_progress" | "completed">;
  toolNames: Map<string, string>;
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
        promptCapabilities: { image: false, embeddedContext: true },
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
    const session: Session = {
      id: sessionId,
      droid,
      droidSessionId: initResult.sessionId,
      model: initResult.settings?.modelId || "unknown",
      mode: "medium",
      cancelled: false,
      promptResolve: null,
      activeToolCallIds: new Set(),
      toolCallStatus: new Map(),
      toolNames: new Map(),
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
    droid.onExit(() => {
      this.logger.log("Droid exited, cleaning up session:", session.id);
      this.sessions.delete(session.id);
    });

    this.sessions.set(sessionId, session);
    this.logger.log("Session created:", sessionId);

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
        currentModeId: "medium",
        availableModes: [
          {
            id: "low",
            name: "Suggest",
            description: "Low - Safe file operations, requires confirmation",
          },
          {
            id: "medium",
            name: "Normal",
            description: "Medium - Development tasks with moderate autonomy",
          },
          {
            id: "high",
            name: "Full",
            description: "High - Production operations with full autonomy",
          },
        ],
      },
    };
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) throw new Error(`Session not found: ${request.sessionId}`);
    if (session.cancelled) throw new Error("Session cancelled");

    this.logger.log("prompt:", request.sessionId);

    // Extract text from prompt content
    const parts: string[] = [];
    for (const chunk of request.prompt) {
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
    const text = parts.join("\n");

    // Send message and wait for completion
    return new Promise((resolve) => {
      session.promptResolve = resolve;
      session.droid.sendMessage(text);

      // Timeout after 5 minutes
      setTimeout(
        () => {
          if (session.promptResolve) {
            session.promptResolve({ stopReason: "end_turn" });
            session.promptResolve = null;
          }
        },
        5 * 60 * 1000,
      );
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
      session.mode = request.modeId;
      const droidMode = ACP_TO_DROID_MODE[request.modeId] as AutonomyLevel | undefined;
      if (droidMode) {
        session.droid.setMode(droidMode);
      }
    }
    return {};
  }

  private handlePermission(
    session: Session,
    params: PermissionRequest,
  ): { selectedOption: "proceed_once" | "proceed_always" | "cancel" } {
    const toolUse = params.toolUses?.[0]?.toolUse;
    if (!toolUse) {
      return { selectedOption: "proceed_once" };
    }

    const toolCallId = toolUse.id;
    const toolName = toolUse.name;
    const command = toolUse.input?.command || JSON.stringify(toolUse.input);
    const riskLevel = toolUse.input?.riskLevel || "medium";

    this.logger.log(
      "Permission request for tool:",
      toolCallId,
      "risk:",
      riskLevel,
      "mode:",
      session.mode,
    );

    // Emit tool_call (pending)
    session.activeToolCallIds.add(toolCallId);
    session.toolNames.set(toolCallId, toolName);
    session.toolCallStatus.set(toolCallId, "pending");

    void this.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: toolCallId,
        title: `Running ${toolName}: ${String(command)}`,
        status: "pending",
      },
    });

    // Auto-approve/reject based on session mode and risk level
    let decision: "proceed_once" | "proceed_always" | "cancel";

    if (session.mode === "high") {
      decision = "proceed_always";
      this.logger.log("Auto-approved (high mode)");
    } else if (session.mode === "medium") {
      if (riskLevel === "low" || riskLevel === "medium") {
        decision = "proceed_once";
        this.logger.log("Auto-approved (medium mode, low/med risk)");
      } else {
        decision = "cancel";
        this.logger.log("Auto-rejected (medium mode, high risk)");
      }
    } else {
      decision = "cancel";
      this.logger.log("Auto-rejected (low mode)");
    }

    // Update status based on decision
    if (decision === "cancel") {
      session.toolCallStatus.set(toolCallId, "completed");
    } else {
      session.toolCallStatus.set(toolCallId, "in_progress");
    }

    return { selectedOption: decision };
  }

  private async handleNotification(session: Session, n: DroidNotification): Promise<void> {
    this.logger.log("notification:", n.type);

    switch (n.type) {
      case "message":
        if (n.role === "assistant") {
          // Handle tool use in message
          if (n.toolUse) {
            const toolCallId = n.toolUse.id;
            if (!session.activeToolCallIds.has(toolCallId)) {
              session.activeToolCallIds.add(toolCallId);
              session.toolNames.set(toolCallId, n.toolUse.name);
              session.toolCallStatus.set(toolCallId, "in_progress");
              await this.client.sessionUpdate({
                sessionId: session.id,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: toolCallId,
                  title: `Running ${n.toolUse.name}`,
                  status: "in_progress",
                },
              });
            } else {
              const status = session.toolCallStatus.get(toolCallId);
              if (status !== "completed") {
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
        // Send the tool response content
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
          },
        });

        // Send the completion status
        session.toolCallStatus.set(n.toolUseId, "completed");
        await this.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: n.toolUseId,
            status: "completed",
          },
        });
        break;

      case "error":
        await this.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Error: ${n.message}` },
          },
        });
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
