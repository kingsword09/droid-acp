import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { findDroidExecutable, type Logger } from "./utils.ts";
import type {
  DroidAutonomyLevel,
  DroidNotification,
  FactoryRequest,
  FactoryMessage,
  InitSessionResult,
  PermissionResponse,
} from "./types.ts";

export interface DroidAdapterOptions {
  cwd: string;
  logger?: Logger;
}

export interface DroidAdapter {
  start(): Promise<InitSessionResult>;
  sendMessage(text: string): void;
  sendUserMessage(message: {
    text: string;
    images?: Array<{ type: "base64"; data: string; mediaType: string }>;
  }): void;
  setMode(level: DroidAutonomyLevel): void;
  setModel(modelId: string): void;
  onNotification(handler: (notification: DroidNotification) => void | Promise<void>): void;
  onRawEvent(handler: (event: unknown) => void | Promise<void>): void;
  onRequest(handler: (method: string, params: unknown) => Promise<PermissionResponse>): void;
  onExit(handler: (code: number | null) => void): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSessionId(): string | null;
}

export function createDroidAdapter(options: DroidAdapterOptions): DroidAdapter {
  let process: ChildProcess | null = null;
  let sessionId: string | null = null;
  const machineId = randomUUID();
  const logger = options.logger ?? console;

  const notificationHandlers: Array<(n: DroidNotification) => void | Promise<void>> = [];
  const rawEventHandlers: Array<(e: unknown) => void | Promise<void>> = [];
  const exitHandlers: Array<(code: number | null) => void> = [];
  let requestHandler: ((method: string, params: unknown) => Promise<PermissionResponse>) | null =
    null;

  let initResolve: ((result: InitSessionResult) => void) | null = null;
  let initReject: ((error: Error) => void) | null = null;

  // State for message ordering (handle out-of-order idle notification)
  let isStreamingAssistant = false;
  let pendingIdle = false;
  let pendingIdleTimer: NodeJS.Timeout | null = null;

  const send = (method: string, params: Record<string, unknown>) => {
    if (!process?.stdin?.writable) return;
    const msg: FactoryRequest = {
      jsonrpc: "2.0",
      factoryApiVersion: "1.0.0",
      type: "request",
      method,
      params,
      id: randomUUID(),
    };
    process.stdin.write(JSON.stringify(msg) + "\n");
    logger.log("Sent:", method);
  };

  const emit = async (n: DroidNotification) => {
    for (const h of notificationHandlers) {
      await h(n);
    }
  };

  // Process queue sequentially using promise chain
  let processingChain: Promise<void> = Promise.resolve();

  const queueLine = (line: string) => {
    processingChain = processingChain.then(() => handleLine(line));
  };

  const handleLine = async (line: string) => {
    try {
      const msg = JSON.parse(line) as FactoryMessage;

      // Emit raw event for debugging
      for (const h of rawEventHandlers) {
        await h(msg);
      }

      // Handle init response
      if (
        msg.type === "response" &&
        "result" in msg &&
        msg.result &&
        "sessionId" in msg.result &&
        initResolve
      ) {
        const r = msg.result as unknown as InitSessionResult;
        sessionId = r.sessionId;
        initResolve({
          sessionId: r.sessionId,
          session: r.session,
          settings: r.settings,
          availableModels: r.availableModels || [],
        });
        initResolve = null;
        initReject = null;
        return;
      }

      // Handle error response
      if (msg.type === "response" && "error" in msg && msg.error && initReject) {
        initReject(new Error(msg.error.message));
        initResolve = null;
        initReject = null;
        return;
      }

      // Handle notifications
      if (msg.type === "notification" && msg.method === "droid.session_notification") {
        const notification = (msg.params as { notification?: Record<string, unknown> })
          ?.notification;
        if (!notification) return;

        const notificationType = notification.type as string;

        switch (notificationType) {
          case "settings_updated": {
            const settings = notification.settings as Record<string, unknown> | undefined;
            if (settings) {
              await emit({
                type: "settings_updated",
                settings: {
                  modelId: typeof settings.modelId === "string" ? settings.modelId : undefined,
                  reasoningEffort:
                    typeof settings.reasoningEffort === "string"
                      ? settings.reasoningEffort
                      : undefined,
                  autonomyLevel:
                    typeof settings.autonomyLevel === "string" ? settings.autonomyLevel : undefined,
                  specModeModelId:
                    typeof settings.specModeModelId === "string"
                      ? settings.specModeModelId
                      : undefined,
                  specModeReasoningEffort:
                    typeof settings.specModeReasoningEffort === "string"
                      ? settings.specModeReasoningEffort
                      : undefined,
                },
              });
            }
            break;
          }

          case "droid_working_state_changed": {
            const newState = notification.newState as string;
            await emit({
              type: "working_state",
              state: newState as "idle" | "streaming_assistant_message",
            });

            if (newState === "streaming_assistant_message") {
              isStreamingAssistant = true;
              pendingIdle = false;
              if (pendingIdleTimer) {
                clearTimeout(pendingIdleTimer);
                pendingIdleTimer = null;
              }
            } else if (newState === "idle") {
              // Handle out-of-order idle notification
              // Droid CLI sometimes sends idle before the final assistant message
              if (isStreamingAssistant) {
                pendingIdle = true;

                // Droid can also transition through streaming→idle without emitting a final
                // assistant create_message (e.g. after rejecting ExitSpecMode). In that case,
                // ensure we still complete the prompt after a short grace period.
                if (pendingIdleTimer) {
                  clearTimeout(pendingIdleTimer);
                }
                pendingIdleTimer = setTimeout(() => {
                  if (!pendingIdle) return;
                  pendingIdle = false;
                  isStreamingAssistant = false;
                  pendingIdleTimer = null;
                  void emit({ type: "complete" });
                }, 250);
              } else {
                await emit({ type: "complete" });
              }
            }
            break;
          }

          case "create_message": {
            const message = notification.message as {
              role: string;
              id: string;
              content?: Array<{
                type: string;
                text?: string;
                id?: string;
                toolUseId?: string;
                tool_use_id?: string;
                tool_call_id?: string;
                callId?: string;
                call_id?: string;
                name?: string;
                toolName?: string;
                tool_name?: string;
                input?: unknown;
              }>;
            };
            if (message) {
              const blocks = Array.isArray(message.content) ? message.content : [];

              const textParts = blocks
                .filter((c) => c.type === "text" && typeof c.text === "string")
                .map((c) => c.text as string);

              if (textParts.length > 0) {
                await emit({
                  type: "message",
                  role: message.role as "user" | "assistant" | "system",
                  text: textParts.join(""),
                  id: message.id,
                });
              }

              const toolUses = blocks.filter((c) => c.type === "tool_use");
              for (const toolUseContent of toolUses) {
                const id =
                  toolUseContent.id ??
                  toolUseContent.toolUseId ??
                  toolUseContent.tool_use_id ??
                  toolUseContent.tool_call_id ??
                  toolUseContent.callId ??
                  toolUseContent.call_id ??
                  randomUUID();
                const name =
                  toolUseContent.name ?? toolUseContent.toolName ?? toolUseContent.tool_name;
                await emit({
                  type: "message",
                  role: message.role as "user" | "assistant" | "system",
                  id: message.id,
                  toolUse: {
                    id,
                    name: name || "unknown",
                    input: toolUseContent.input,
                  },
                });
              }

              // If we were waiting for this assistant message, now complete
              if (message.role === "assistant") {
                isStreamingAssistant = false;
                if (pendingIdleTimer) {
                  clearTimeout(pendingIdleTimer);
                  pendingIdleTimer = null;
                }
                if (pendingIdle) {
                  await emit({ type: "complete" });
                  pendingIdle = false;
                }
              }
            }
            break;
          }

          case "tool_result": {
            const toolUseIdRaw =
              (notification as Record<string, unknown>).toolUseId ??
              (notification as Record<string, unknown>).tool_use_id ??
              (notification as Record<string, unknown>).tool_call_id ??
              (notification as Record<string, unknown>).callId ??
              (notification as Record<string, unknown>).call_id ??
              (notification as Record<string, unknown>).id;
            const toolUseId = typeof toolUseIdRaw === "string" ? toolUseIdRaw : null;

            const rawContent =
              (notification as Record<string, unknown>).content ??
              (notification as Record<string, unknown>).value;
            const content =
              typeof rawContent === "string"
                ? rawContent
                : JSON.stringify(rawContent ?? "", null, 2);

            const isErrorRaw =
              (notification as Record<string, unknown>).isError ??
              (notification as Record<string, unknown>).is_error;
            const isError = typeof isErrorRaw === "boolean" ? isErrorRaw : false;

            if (!toolUseId) {
              logger.error("Missing tool_use_id/toolUseId for tool_result notification");
              break;
            }
            await emit({
              type: "tool_result",
              toolUseId,
              content,
              isError,
            });
            break;
          }

          case "error": {
            isStreamingAssistant = false;
            pendingIdle = false;
            const message =
              typeof notification.message === "string"
                ? (notification.message as string)
                : JSON.stringify(notification.message ?? "Unknown error");
            await emit({ type: "error", message });
            break;
          }
        }
      }

      // Handle incoming requests (like permissions)
      if (msg.type === "request") {
        const requestId = msg.id;
        const method = msg.method;
        const params = msg.params;

        if (requestHandler && method === "droid.request_permission") {
          try {
            const result = await requestHandler(method, params);
            const response = {
              jsonrpc: "2.0" as const,
              factoryApiVersion: "1.0.0" as const,
              type: "response" as const,
              id: requestId,
              result,
            };
            if (process?.stdin) {
              process.stdin.write(JSON.stringify(response) + "\n");
            }
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : "Internal error";
            const response = {
              jsonrpc: "2.0" as const,
              factoryApiVersion: "1.0.0" as const,
              type: "response" as const,
              id: requestId,
              error: {
                code: -32603,
                message: errorMessage,
              },
            };
            if (process?.stdin) {
              process.stdin.write(JSON.stringify(response) + "\n");
            }
          }
        } else if (method === "droid.request_permission") {
          // Auto-approve as fallback if no handler
          const response = {
            jsonrpc: "2.0" as const,
            factoryApiVersion: "1.0.0" as const,
            type: "response" as const,
            id: requestId,
            result: { selectedOption: "proceed_once" },
          };
          if (process?.stdin) {
            process.stdin.write(JSON.stringify(response) + "\n");
          }
          logger.log("Auto-approved permission request (fallback):", requestId);
        }
      }
    } catch (err) {
      logger.error("Parse error:", (err as Error).message);
    }
  };

  return {
    async start(): Promise<InitSessionResult> {
      const executable = findDroidExecutable();
      const args = [
        "exec",
        "--input-format",
        "stream-jsonrpc",
        "--output-format",
        "stream-jsonrpc",
        "--cwd",
        options.cwd,
      ];

      logger.log("Starting droid:", executable, args.join(" "));
      process = spawn(executable, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...globalThis.process.env,
          FORCE_COLOR: "0",
        },
      });

      if (process.stdout) {
        createInterface({ input: process.stdout }).on("line", queueLine);
      }
      if (process.stderr) {
        createInterface({ input: process.stderr }).on("line", (l) =>
          logger.error("[droid stderr]", l),
        );
      }

      process.on("error", (err) => {
        if (initReject) initReject(err);
      });
      process.on("exit", (code) => {
        logger.log("Droid exit:", code);
        process = null;
        exitHandlers.forEach((h) => h(code));
      });

      return new Promise((resolve, reject) => {
        initResolve = resolve;
        initReject = reject;
        send("droid.initialize_session", { machineId, cwd: options.cwd });

        const initTimeout = parseInt(globalThis.process.env.DROID_INIT_TIMEOUT || "60000", 10);
        setTimeout(() => {
          if (initReject) {
            initReject(new Error("Droid init timeout"));
            initResolve = null;
            initReject = null;
          }
        }, initTimeout);
      });
    },

    sendMessage(text: string) {
      this.sendUserMessage({ text });
    },

    sendUserMessage(message: {
      text: string;
      images?: Array<{ type: "base64"; data: string; mediaType: string }>;
    }) {
      if (!sessionId) return;
      const params: Record<string, unknown> = {
        sessionId,
        text: message.text,
      };
      if (Array.isArray(message.images) && message.images.length > 0) {
        params.images = message.images;
      }
      send("droid.add_user_message", params);
    },

    setMode(level: DroidAutonomyLevel) {
      if (!sessionId) return;
      send("droid.update_session_settings", {
        sessionId,
        autonomyLevel: level,
      });
    },

    setModel(modelId: string) {
      if (!sessionId) return;
      send("droid.update_session_settings", {
        sessionId,
        modelId,
      });
    },

    onNotification(handler) {
      notificationHandlers.push(handler);
    },

    onRawEvent(handler) {
      rawEventHandlers.push(handler);
    },

    onRequest(handler) {
      requestHandler = handler;
    },

    onExit(handler) {
      exitHandlers.push(handler);
    },

    async stop() {
      if (process) {
        process.stdin?.end();
        process.kill("SIGTERM");
        process = null;
      }
    },

    isRunning() {
      return process !== null && !process.killed;
    },

    getSessionId() {
      return sessionId;
    },
  };
}
