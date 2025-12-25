import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { findDroidExecutable, type Logger } from "./utils.ts";
import type {
  AutonomyLevel,
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
  setMode(level: AutonomyLevel): void;
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
          case "droid_working_state_changed": {
            const newState = notification.newState as string;
            await emit({
              type: "working_state",
              state: newState as "idle" | "streaming_assistant_message",
            });

            if (newState === "streaming_assistant_message") {
              isStreamingAssistant = true;
              pendingIdle = false;
            } else if (newState === "idle") {
              // Handle out-of-order idle notification
              // Droid CLI sometimes sends idle before the final assistant message
              if (isStreamingAssistant) {
                pendingIdle = true;
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
                name?: string;
                input?: unknown;
              }>;
            };
            if (message) {
              const textContent = message.content?.find((c) => c.type === "text");
              const toolUseContent = message.content?.find((c) => c.type === "tool_use");

              if (textContent || toolUseContent) {
                await emit({
                  type: "message",
                  role: message.role as "user" | "assistant" | "system",
                  text: textContent?.text,
                  id: message.id,
                  toolUse: toolUseContent
                    ? {
                        id: toolUseContent.id || randomUUID(),
                        name: toolUseContent.name || "unknown",
                        input: toolUseContent.input,
                      }
                    : undefined,
                });

                // If we were waiting for this assistant message, now complete
                if (message.role === "assistant") {
                  isStreamingAssistant = false;
                  if (pendingIdle) {
                    await emit({ type: "complete" });
                    pendingIdle = false;
                  }
                }
              }
            }
            break;
          }

          case "tool_result": {
            await emit({
              type: "tool_result",
              toolUseId: notification.toolUseId as string,
              content: notification.content as string,
            });
            break;
          }

          case "error": {
            isStreamingAssistant = false;
            pendingIdle = false;
            await emit({ type: "error", message: notification.message as string });
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
      if (!sessionId) return;
      send("droid.add_user_message", { sessionId, text });
    },

    setMode(level: AutonomyLevel) {
      if (!sessionId) return;
      send("droid.update_session_settings", {
        sessionId,
        settings: { autonomyLevel: level },
      });
    },

    setModel(modelId: string) {
      if (!sessionId) return;
      send("droid.update_session_settings", {
        sessionId,
        settings: { modelId },
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
