import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { AcpModeId, DroidPermissionOption, PermissionRequest } from "../../types.ts";

export function extractDroidPermissionOptions(
  params: PermissionRequest,
): DroidPermissionOption[] | null {
  const candidates: unknown[] = [];

  const maybePush = (value: unknown) => {
    if (Array.isArray(value)) candidates.push(value);
  };

  maybePush((params as unknown as { options?: unknown }).options);

  const toolUses = (params as unknown as { toolUses?: unknown }).toolUses;
  if (Array.isArray(toolUses)) {
    for (const toolUse of toolUses) {
      if (!toolUse || typeof toolUse !== "object") continue;
      const tu = toolUse as Record<string, unknown>;
      maybePush(tu.options);
      const details = tu.details;
      if (details && typeof details === "object") {
        maybePush((details as Record<string, unknown>).options);
      }
    }
  }

  for (const candidate of candidates) {
    const normalized = (candidate as unknown[])
      .map((opt) => opt as { value?: unknown; label?: unknown })
      .map((opt) => ({
        value: typeof opt.value === "string" ? opt.value : null,
        label: typeof opt.label === "string" ? opt.label : null,
      }))
      .filter((opt): opt is { value: string; label: string } => !!opt.value && !!opt.label)
      .map((opt) => ({ value: opt.value, label: opt.label }));

    if (normalized.length > 0) return normalized;
  }

  return null;
}

export function mapExitSpecModeSelection(optionId: string): {
  nextMode: AcpModeId | null;
  droidSelectedOption: string;
} {
  // Preferred: optionId equals ACP mode id.
  switch (optionId) {
    case "off":
      return { nextMode: "off", droidSelectedOption: "proceed_once" };
    case "low":
      return { nextMode: "low", droidSelectedOption: "proceed_auto_run_low" };
    case "medium":
      return { nextMode: "medium", droidSelectedOption: "proceed_auto_run_medium" };
    case "high":
      return { nextMode: "high", droidSelectedOption: "proceed_auto_run_high" };
    case "spec":
      return { nextMode: "spec", droidSelectedOption: "cancel" };
    default:
      break;
  }

  // Back-compat: accept Droid option ids directly (or other clients returning them).
  switch (optionId) {
    case "proceed_once":
      return { nextMode: "off", droidSelectedOption: "proceed_once" };
    case "proceed_auto_run_low":
      return { nextMode: "low", droidSelectedOption: "proceed_auto_run_low" };
    case "proceed_auto_run_medium":
      return { nextMode: "medium", droidSelectedOption: "proceed_auto_run_medium" };
    case "proceed_auto_run_high":
      return { nextMode: "high", droidSelectedOption: "proceed_auto_run_high" };
    case "cancel":
      return { nextMode: "spec", droidSelectedOption: "cancel" };
    default:
      return { nextMode: null, droidSelectedOption: optionId };
  }
}

export function specApprovalOptions(
  droidOptions: DroidPermissionOption[] | null,
): PermissionOption[] {
  const has = (value: string): boolean => droidOptions?.some((o) => o.value === value) === true;

  const candidates: Array<{
    modeId: AcpModeId;
    droidValue: string;
    name: string;
    kind: PermissionOption["kind"];
  }> = [
    {
      modeId: "off",
      droidValue: "proceed_once",
      name: "Proceed (manual)",
      kind: "allow_once",
    },
    {
      modeId: "low",
      droidValue: "proceed_auto_run_low",
      name: "Proceed (low)",
      kind: "allow_once",
    },
    {
      modeId: "medium",
      droidValue: "proceed_auto_run_medium",
      name: "Proceed (medium)",
      kind: "allow_once",
    },
    {
      modeId: "high",
      droidValue: "proceed_auto_run_high",
      name: "Proceed (high)",
      kind: "allow_once",
    },
    {
      modeId: "spec",
      droidValue: "cancel",
      name: "Stay in Spec",
      kind: "reject_once",
    },
  ];

  const options = candidates
    .filter((c) => !droidOptions || has(c.droidValue))
    .map((c) => ({ optionId: c.modeId, name: c.name, kind: c.kind }));

  if (options.length > 0) return options;

  // Fallback: expose raw Droid options if we can't match.
  return (
    droidOptions?.map((o) => ({
      optionId: o.value,
      name: o.label,
      kind: "allow_once" as const,
    })) ?? [
      { optionId: "off", name: "Proceed (manual approvals)", kind: "allow_once" },
      { optionId: "spec", name: "No, keep iterating (stay in Spec)", kind: "reject_once" },
    ]
  );
}
