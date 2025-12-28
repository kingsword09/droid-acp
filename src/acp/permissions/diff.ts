import { readFile, stat } from "node:fs/promises";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { extractFilePathFromRawInput, resolvePermissionFilePath } from "./paths.ts";

export async function buildPermissionDiffContent(params: {
  toolName: string;
  rawInput: unknown;
  cwd: string;
}): Promise<ToolCallContent | null> {
  const rawInputObj =
    params.rawInput && typeof params.rawInput === "object"
      ? (params.rawInput as Record<string, unknown>)
      : null;
  if (!rawInputObj) return null;

  const filePath = extractFilePathFromRawInput(rawInputObj);
  if (!filePath) return null;
  const resolved = resolvePermissionFilePath(params.cwd, filePath);

  const MAX_FILE_BYTES = 256 * 1024;

  if (params.toolName === "Edit") {
    const oldStr =
      typeof rawInputObj.old_str === "string"
        ? rawInputObj.old_str
        : typeof rawInputObj.oldStr === "string"
          ? rawInputObj.oldStr
          : null;
    const newStr =
      typeof rawInputObj.new_str === "string"
        ? rawInputObj.new_str
        : typeof rawInputObj.newStr === "string"
          ? rawInputObj.newStr
          : null;
    if (oldStr === null || newStr === null) return null;

    // Best-effort: show a full-file diff when we can apply a single unambiguous replacement.
    try {
      const fileStat = await stat(resolved.absPath);
      if (fileStat.isFile() && fileStat.size <= MAX_FILE_BYTES && oldStr.length > 0) {
        const oldText = await readFile(resolved.absPath, "utf8");
        const occurrences = oldText.split(oldStr).length - 1;
        if (occurrences === 1) {
          const newText = oldText.replace(oldStr, newStr);
          return {
            type: "diff",
            path: resolved.label,
            oldText,
            newText,
          };
        }
      }
    } catch {
      // Fall back to a snippet diff below.
    }

    // Fallback: show a focused snippet diff of the replacement only.
    return {
      type: "diff",
      path: resolved.label,
      oldText: oldStr,
      newText: newStr,
    };
  }

  if (params.toolName === "Write") {
    const newText =
      typeof rawInputObj.content === "string"
        ? rawInputObj.content
        : typeof rawInputObj.text === "string"
          ? rawInputObj.text
          : null;
    if (newText === null) return null;

    let oldText: string | null = null;
    try {
      const fileStat = await stat(resolved.absPath);
      if (fileStat.isFile() && fileStat.size <= MAX_FILE_BYTES) {
        oldText = await readFile(resolved.absPath, "utf8");
      }
    } catch {
      oldText = null;
    }

    return {
      type: "diff",
      path: resolved.label,
      oldText,
      newText,
    };
  }

  return null;
}
