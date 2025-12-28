import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { getAvailableCommands } from "../commands.ts";
import { droidAutonomyToAcpModeId } from "../constants.ts";
import type { DroidAdapter } from "../../droid-adapter.ts";
import type { Session } from "../session-types.ts";
import type {
  AcpModeId,
  DroidNotification,
  InitSessionResult,
  PermissionRequest,
} from "../../types.ts";
import type { Logger } from "../../utils.ts";
import { isEnvEnabled } from "../../utils.ts";

export function attachSession(params: {
  sessionId: string;
  cwd: string;
  droid: DroidAdapter;
  initResult: InitSessionResult;
  title?: string | null;
  client: AgentSideConnection;
  logger: Logger;
  sessions: Map<string, Session>;
  handlers: {
    handleNotification: (session: Session, n: DroidNotification) => Promise<void>;
    handlePermission: (
      session: Session,
      params: PermissionRequest,
    ) => Promise<{ selectedOption: string }>;
  };
}): { session: Session; initialMode: AcpModeId } {
  const { sessionId, cwd, droid, initResult } = params;

  const initialMode =
    typeof initResult.settings?.autonomyLevel === "string"
      ? (droidAutonomyToAcpModeId(initResult.settings.autonomyLevel) ?? "off")
      : "off";

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
    keepAliveOnDroidExit: false,
    cancelled: false,
    restartPromise: null,
    promptResolve: null,
    capture: null,
    lastSessionsListing: null,
    toolCallContentById: new Map(),
    toolCallRawInputById: new Map(),
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
    const current = params.sessions.get(sessionId);
    if (!current || current.droid !== droid) return;
    void params.handlers.handleNotification(current, n);
  });

  // Forward raw events for debugging (enable with DROID_DEBUG=1)
  if (process.env.DROID_DEBUG) {
    droid.onRawEvent(async (event) => {
      const current = params.sessions.get(sessionId);
      if (!current || current.droid !== droid) return;
      await params.client.sessionUpdate({
        sessionId: current.id,
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
  droid.onRequest(async (method, p) => {
    const current = params.sessions.get(sessionId);
    if (!current || current.droid !== droid) {
      return { selectedOption: "proceed_once" };
    }
    if (method === "droid.request_permission") {
      return params.handlers.handlePermission(current, p as PermissionRequest);
    }
    throw new Error("Method not supported");
  });

  // Handle droid process exit
  droid.onExit((code) => {
    const current = params.sessions.get(sessionId);
    if (!current || current.droid !== droid) {
      params.logger.log("Droid exited (stale), ignoring:", sessionId, "code:", code);
      return;
    }

    if (current.keepAliveOnDroidExit) {
      params.logger.log(
        "Droid exited (restart requested), keeping session:",
        sessionId,
        "code:",
        code,
      );
      current.keepAliveOnDroidExit = false;
      if (current.promptResolve) {
        current.promptResolve({ stopReason: "end_turn" });
        current.promptResolve = null;
      }
      return;
    }

    params.logger.log("Droid exited, cleaning up session:", sessionId, "code:", code);
    if (current.promptResolve) {
      current.promptResolve({ stopReason: "end_turn" });
      current.promptResolve = null;
    }
    params.sessions.delete(sessionId);
  });

  params.sessions.set(sessionId, session);
  params.logger.log("Session created:", sessionId);

  // Ensure clients can track sessions and populate "History" UIs.
  setTimeout(() => {
    void params.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });
  }, 0);

  // Optional diagnostics for Zed env + websearch proxy wiring.
  // Enable with DROID_DEBUG=1.
  const shouldEmitWebsearchStatus = isEnvEnabled(process.env.DROID_DEBUG);
  if (shouldEmitWebsearchStatus) {
    const websearchProxyBaseUrl = droid.getWebsearchProxyBaseUrl();
    const parentFactoryApiKey = process.env.FACTORY_API_KEY;
    const hasExplicitToggle = typeof process.env.DROID_ACP_WEBSEARCH === "string";
    const smitheryConfigured =
      typeof process.env.SMITHERY_API_KEY === "string" &&
      process.env.SMITHERY_API_KEY.trim().length > 0 &&
      typeof process.env.SMITHERY_PROFILE === "string" &&
      process.env.SMITHERY_PROFILE.trim().length > 0;
    const forwardConfigured =
      typeof process.env.DROID_ACP_WEBSEARCH_FORWARD_URL === "string" &&
      process.env.DROID_ACP_WEBSEARCH_FORWARD_URL.trim().length > 0;
    const websearchEnabled = hasExplicitToggle
      ? isEnvEnabled(process.env.DROID_ACP_WEBSEARCH)
      : smitheryConfigured || forwardConfigured;
    const willInjectDummyFactoryApiKey = websearchEnabled && !parentFactoryApiKey;

    const forwardModeRaw = process.env.DROID_ACP_WEBSEARCH_FORWARD_MODE;
    const forwardModeNormalized =
      typeof forwardModeRaw === "string" ? forwardModeRaw.trim().toLowerCase() : "";
    const forwardUrlRaw = process.env.DROID_ACP_WEBSEARCH_FORWARD_URL ?? "";
    const forwardModeEffective =
      forwardModeNormalized === "mcp"
        ? "mcp"
        : forwardModeNormalized === "http"
          ? "http"
          : /^mcp:/i.test(forwardUrlRaw.trim())
            ? "mcp"
            : "http";

    setTimeout(() => {
      void params.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              [
                "[droid-acp] WebSearch status",
                `- DROID_ACP_WEBSEARCH: ${process.env.DROID_ACP_WEBSEARCH ?? "<unset>"}`,
                `- enabled: ${websearchEnabled ? "true" : "false"}${hasExplicitToggle ? "" : " (auto)"}`,
                `- DROID_ACP_WEBSEARCH_PORT: ${process.env.DROID_ACP_WEBSEARCH_PORT ?? "<unset>"}`,
                `- DROID_ACP_WEBSEARCH_FORWARD_MODE: ${process.env.DROID_ACP_WEBSEARCH_FORWARD_MODE ?? "<unset>"}`,
                `- forwardMode: ${forwardModeEffective}`,
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
    void params.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: getAvailableCommands(),
      },
    });
  }, 0);

  return { session, initialMode };
}
