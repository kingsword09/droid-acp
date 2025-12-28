import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import type { AcpModeId, InitSessionResult } from "../../types.ts";

export function getModelsState(
  initResult: InitSessionResult,
): NonNullable<NewSessionResponse["models"]> {
  return {
    availableModels: initResult.availableModels.map((m) => ({
      modelId: m.id,
      name: m.displayName,
    })),
    currentModelId: initResult.settings?.modelId || "unknown",
  };
}

export function getModesState(currentModeId: AcpModeId): NonNullable<NewSessionResponse["modes"]> {
  return {
    currentModeId,
    availableModes: [
      { id: "spec", name: "Spec", description: "Research and plan only - no code changes" },
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
