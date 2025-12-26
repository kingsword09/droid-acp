/**
 * Factory API types for stream-jsonrpc protocol
 */

// ACP mode ids exposed to the client (Zed).
export type AcpModeId = "off" | "low" | "medium" | "high" | "spec";
export const ACP_MODES: AcpModeId[] = ["off", "low", "medium", "high", "spec"];

// Droid `autonomyLevel` values (see Factory docs: Settings → autonomyLevel).
export type DroidAutonomyLevel =
  | "normal"
  | "spec"
  | "auto-low"
  | "auto-medium"
  | "auto-high"
  // legacy values (keep for compatibility with older CLIs)
  | "suggest"
  | "full";

export interface FactoryRequest {
  jsonrpc: "2.0";
  factoryApiVersion: "1.0.0";
  type: "request";
  method: string;
  params: Record<string, unknown>;
  id: string;
}

export interface FactoryResponse {
  jsonrpc: "2.0";
  type: "response";
  factoryApiVersion: "1.0.0";
  id: string;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
}

export interface FactoryNotification {
  jsonrpc: "2.0";
  type: "notification";
  factoryApiVersion: "1.0.0";
  method: string;
  params: Record<string, unknown>;
}

export type FactoryMessage = FactoryRequest | FactoryResponse | FactoryNotification;

export interface AvailableModel {
  id: string;
  modelId?: string;
  modelProvider: string;
  displayName: string;
  shortDisplayName?: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  isCustom: boolean;
  noImageSupport?: boolean;
}

export interface InitSessionResult {
  sessionId: string;
  session?: { messages: unknown[] };
  settings?: {
    modelId: string;
    reasoningEffort?: string;
    autonomyLevel?: string;
  };
  availableModels: AvailableModel[];
}

export type DroidNotification =
  | { type: "working_state"; state: "idle" | "streaming_assistant_message" }
  | {
      type: "settings_updated";
      settings: {
        modelId?: string;
        reasoningEffort?: string;
        autonomyLevel?: string;
        specModeModelId?: string;
        specModeReasoningEffort?: string;
      };
    }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | {
      type: "message";
      role: "user" | "assistant" | "system";
      text?: string;
      id: string;
      toolUse?: { id: string; name: string; input?: unknown };
    }
  | { type: "error"; message: string }
  | { type: "complete" };

export interface DroidPermissionOption {
  value: string;
  label: string;
}

export interface PermissionRequest {
  toolUses?: Array<{
    toolUse: {
      id: string;
      name: string;
      input?: {
        command?: string;
        riskLevel?: "low" | "medium" | "high";
        [key: string]: unknown;
      };
    };
    confirmationType?: string;
    details?: unknown;
  }>;
  options?: DroidPermissionOption[];
}

export interface PermissionResponse {
  selectedOption: string;
}
