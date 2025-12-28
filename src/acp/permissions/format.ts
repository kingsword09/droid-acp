import { isEnvEnabled } from "../../utils.ts";
import { safeCodeFenceContent } from "../text.ts";
import { extractFilePathFromRawInput, resolvePermissionFilePath } from "./paths.ts";

export function toolCallRawInputForClient(rawInput: unknown): unknown {
  return isEnvEnabled(process.env.DROID_DEBUG) ? rawInput : undefined;
}

export function formatPermissionDetailsMarkdown(params: {
  toolName: string;
  riskLevel: "low" | "medium" | "high";
  rawInput: unknown;
}): string {
  const lines: string[] = [
    "**Details**",
    `- Tool: \`${params.toolName}\``,
    `- Risk: \`${params.riskLevel}\``,
  ];

  const rawInputObj =
    params.rawInput && typeof params.rawInput === "object"
      ? (params.rawInput as Record<string, unknown>)
      : null;

  const command =
    rawInputObj && typeof rawInputObj.command === "string" ? rawInputObj.command.trim() : null;

  if (command && command.length > 0) {
    lines.push("", "**Command**", "```bash", safeCodeFenceContent(command), "```");
    return lines.join("\n");
  }

  const inputSummary: string[] = [];
  const pushField = (label: string, value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    inputSummary.push(`- ${label}: \`${trimmed}\``);
  };

  if (rawInputObj) {
    pushField("From", rawInputObj.from_path ?? rawInputObj.fromPath ?? rawInputObj.from);
    pushField("To", rawInputObj.to_path ?? rawInputObj.toPath ?? rawInputObj.to);
    pushField("Path", rawInputObj.path);
    pushField("File", rawInputObj.file);
    pushField("File path", rawInputObj.file_path ?? rawInputObj.filePath);
    pushField("URL", rawInputObj.url);
    pushField("Query", rawInputObj.query);
    pushField("Pattern", rawInputObj.pattern);
    pushField("Glob", rawInputObj.glob);
  }

  if (inputSummary.length > 0) {
    lines.push("", "**Input (summary)**", ...inputSummary);
  }

  const shouldShowRawInput = isEnvEnabled(process.env.DROID_DEBUG);

  if (shouldShowRawInput) {
    const scrubbed = (() => {
      if (!rawInputObj) return params.rawInput;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawInputObj)) {
        if (typeof v === "string" && v.length > 1200) {
          out[k] = `${v.slice(0, 1200)}… (truncated, ${v.length} chars)`;
          continue;
        }
        out[k] = v;
      }
      return out;
    })();

    let json: string | null = null;
    try {
      json = JSON.stringify(scrubbed, null, 2);
    } catch {
      json = null;
    }

    if (json && json !== "{}") {
      const maxChars = 12_000;
      const truncated = json.length > maxChars ? `${json.slice(0, maxChars)}\n… (truncated)` : json;
      lines.push("", "**Input (raw)**", "```json", safeCodeFenceContent(truncated), "```");
    }
  }

  return lines.join("\n");
}

export function formatPermissionToolCallTitle(params: {
  stage?: "permission" | "run";
  toolName: string;
  riskLevel: "low" | "medium" | "high";
  rawInput: unknown;
  cwd: string;
}): string {
  const stage = params.stage ?? "permission";
  const rawInputObj =
    params.rawInput && typeof params.rawInput === "object"
      ? (params.rawInput as Record<string, unknown>)
      : null;

  const filePath = extractFilePathFromRawInput(rawInputObj);
  const resolvedPath = filePath ? resolvePermissionFilePath(params.cwd, filePath).label : null;

  if (params.toolName === "Bash") {
    const command =
      rawInputObj && typeof rawInputObj.command === "string" ? rawInputObj.command.trim() : null;
    const firstLine = command ? (command.split(/\r?\n/, 1)[0]?.trim() ?? "") : "";
    const summary = firstLine.length > 0 ? firstLine : "command";
    return stage === "permission" ? `Run (${params.riskLevel}): ${summary}` : `Run: ${summary}`;
  }

  if (params.toolName === "Fetch") {
    const url = rawInputObj && typeof rawInputObj.url === "string" ? rawInputObj.url.trim() : null;
    if (url && url.length > 0) return `Fetch: ${url}`;
  }

  if (resolvedPath) {
    const prefix = params.toolName === "LS" ? "List" : params.toolName;
    return stage === "permission"
      ? `${prefix} (${params.riskLevel}): ${resolvedPath}`
      : `${prefix}: ${resolvedPath}`;
  }

  if (params.toolName === "Grep" || params.toolName === "Glob") {
    const pattern =
      rawInputObj && typeof rawInputObj.pattern === "string" ? rawInputObj.pattern.trim() : null;
    if (pattern && pattern.length > 0) {
      return stage === "permission"
        ? `${params.toolName} (${params.riskLevel}): ${pattern}`
        : `${params.toolName}: ${pattern}`;
    }
  }

  return stage === "permission"
    ? `Permission required: ${params.toolName} (${params.riskLevel})`
    : `Running ${params.toolName}`;
}
