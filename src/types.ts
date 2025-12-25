/**
 * Factory API types for stream-jsonrpc protocol
 */

export type AutonomyLevel = "suggest" | "normal" | "full";

export const ACP_TO_DROID_MODE: Record<string, AutonomyLevel> = {
  low: "suggest",
  medium: "normal",
  high: "full",
};

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
  | { type: "tool_result"; toolUseId: string; content: string }
  | {
      type: "message";
      role: "user" | "assistant" | "system";
      text?: string;
      id: string;
      toolUse?: { id: string; name: string; input?: unknown };
    }
  | { type: "error"; message: string }
  | { type: "complete" };

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
  }>;
}

export interface PermissionResponse {
  selectedOption: "proceed_once" | "proceed_always" | "cancel";
}
