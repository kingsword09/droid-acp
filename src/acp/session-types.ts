import type { PromptResponse, ToolCallContent } from "@agentclientprotocol/sdk";
import type { DroidAdapter } from "../droid-adapter.ts";
import type { AcpModeId, InitSessionResult } from "../types.ts";
import type { FactorySessionRecord } from "../factory-sessions.ts";

export interface SessionCapture {
  purpose: "compress_summary";
  buffer: string;
  timeoutId: NodeJS.Timeout;
  finalizeTimeoutId: NodeJS.Timeout | null;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

export interface Session {
  id: string;
  droid: DroidAdapter;
  droidSessionId: string;
  title: string | null;
  updatedAt: string | null;
  pendingHistoryContext: string | null;
  model: string;
  mode: AcpModeId;
  keepAliveOnDroidExit: boolean;
  cancelled: boolean;
  restartPromise: Promise<void> | null;
  promptResolve: ((result: PromptResponse) => void) | null;
  capture: SessionCapture | null;
  lastSessionsListing: {
    scope: "cwd" | "all";
    sessions: FactorySessionRecord[];
  } | null;
  toolCallContentById: Map<string, ToolCallContent[]>;
  toolCallRawInputById: Map<string, unknown>;
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
