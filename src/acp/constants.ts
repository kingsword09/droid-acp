import type { AcpModeId, DroidAutonomyLevel } from "../types.ts";

// Mirrors Droid TUI context indicator (see bundled CLI: N_B / L93)
export const DROID_CONTEXT_INDICATOR_MIN_TOKENS = 11_000;
export const DROID_CONTEXT_INDICATOR_MAX_TOKENS = 300_000;
export const DROID_CONTEXT_INDICATOR_MAX_TOKENS_ANTHROPIC = 200_000;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ACP_MODE_TO_DROID_AUTONOMY: Record<AcpModeId, DroidAutonomyLevel> = {
  off: "normal",
  low: "auto-low",
  medium: "auto-medium",
  high: "auto-high",
  spec: "spec",
};

export function droidAutonomyToAcpModeId(value: string): AcpModeId | null {
  switch (value) {
    case "normal":
      return "off";
    case "auto-low":
      return "low";
    case "auto-medium":
      return "medium";
    case "auto-high":
      return "high";
    case "spec":
      return "spec";
    // legacy values
    case "suggest":
      return "low";
    case "full":
      return "high";
    default:
      return null;
  }
}
