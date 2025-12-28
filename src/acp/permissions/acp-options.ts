import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { DroidPermissionOption } from "../../types.ts";
import { specApprovalOptions } from "./options.ts";

export function permissionKindFromOptionValue(value: string): PermissionOption["kind"] {
  switch (value) {
    case "proceed_once":
    case "proceed_edit":
      return "allow_once";
    case "proceed_auto_run_low":
    case "proceed_auto_run_medium":
    case "proceed_auto_run_high":
    case "proceed_auto_run":
    case "proceed_always":
      return "allow_always";
    case "cancel":
      return "reject_once";
    default:
      return "allow_once";
  }
}

export function toAcpPermissionOption(opt: DroidPermissionOption): PermissionOption {
  const value = opt.value;
  let name = opt.label;
  switch (value) {
    case "proceed_once":
      name = "Allow once";
      break;
    case "proceed_always": {
      const labelLower = opt.label.toLowerCase();
      if (labelLower.includes("low")) {
        name = "Always (low)";
        break;
      }
      if (labelLower.includes("medium")) {
        name = "Always (medium)";
        break;
      }
      if (labelLower.includes("high")) {
        name = "Always (high)";
        break;
      }
      name = "Always";
      break;
    }
    case "proceed_auto_run_low":
      name = "Auto-run (low)";
      break;
    case "proceed_auto_run_medium":
      name = "Auto-run (medium)";
      break;
    case "proceed_auto_run_high":
      name = "Auto-run (high)";
      break;
    default:
      break;
  }
  return {
    optionId: value,
    name,
    kind: permissionKindFromOptionValue(value),
  };
}

export function buildAcpPermissionOptions(params: {
  toolName: string;
  droidOptions: DroidPermissionOption[] | null;
}): PermissionOption[] {
  if (params.toolName === "ExitSpecMode") {
    return specApprovalOptions(params.droidOptions);
  }
  if (params.droidOptions) {
    return params.droidOptions.map(toAcpPermissionOption);
  }
  return [
    { optionId: "proceed_once", name: "Allow once", kind: "allow_once" },
    { optionId: "cancel", name: "Reject", kind: "reject_once" },
  ];
}
