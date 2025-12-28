import type { AcpModeId } from "../../types.ts";
import type { Logger } from "../../utils.ts";

export function computeAutoDecision(params: {
  toolName: string;
  sessionMode: AcpModeId;
  riskLevel: "low" | "medium" | "high";
  logger: Logger;
}): string | null {
  if (params.toolName === "ExitSpecMode") {
    // Exiting spec triggers execution; always ask the user which mode to proceed with.
    params.logger.log("Prompting (ExitSpecMode)");
    return null;
  }

  if (params.sessionMode === "high") {
    params.logger.log("Auto-approved (high mode)");
    return "proceed_always";
  }

  if (params.sessionMode === "medium") {
    const decision = params.riskLevel === "high" ? null : "proceed_once";
    params.logger.log(
      decision ? "Auto-approved (medium mode, low/med risk)" : "Prompting (medium mode)",
    );
    return decision;
  }

  if (params.sessionMode === "low") {
    const decision = params.riskLevel === "low" ? "proceed_once" : null;
    params.logger.log(decision ? "Auto-approved (low mode, low risk)" : "Prompting (low mode)");
    return decision;
  }

  if (params.sessionMode === "spec") {
    // Spec mode: allow low-risk operations (read/search) without prompting.
    if (params.riskLevel === "low") {
      params.logger.log("Auto-approved (spec mode, low risk)");
      return "proceed_once";
    }
    params.logger.log("Auto-rejected (spec mode, medium/high risk)");
    return "cancel";
  }

  // off mode: ask the user (no auto-approval)
  params.logger.log("Prompting (off mode)");
  return null;
}
