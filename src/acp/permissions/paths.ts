import os from "node:os";
import path from "node:path";
import type { ToolCallLocation } from "@agentclientprotocol/sdk";

export function extractFilePathFromRawInput(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const obj = rawInput as Record<string, unknown>;
  const candidates: unknown[] = [obj.file_path, obj.filePath, obj.path];
  for (const v of candidates) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

export function resolvePermissionFilePath(
  cwd: string,
  filePath: string,
): { absPath: string; label: string } {
  const expanded = (() => {
    const trimmed = filePath.trim();
    if (trimmed === "~") return os.homedir();
    if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
    return trimmed;
  })();

  const absPath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  const label = absPath.startsWith(cwd + path.sep) ? path.relative(cwd, absPath) : absPath;
  return { absPath, label };
}

export function permissionLocationsFromRawInput(params: {
  toolName: string;
  rawInput: unknown;
  cwd: string;
}): ToolCallLocation[] | undefined {
  const wantsLocation = new Set(["Edit", "Write", "Read", "LS", "Grep", "Glob", "Move", "Delete"]);
  if (!wantsLocation.has(params.toolName)) return undefined;

  const rawInputObj =
    params.rawInput && typeof params.rawInput === "object"
      ? (params.rawInput as Record<string, unknown>)
      : null;
  if (!rawInputObj) return undefined;

  const normalize = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const addLocation = (acc: ToolCallLocation[], value: string | null) => {
    if (!value) return;
    const resolved = resolvePermissionFilePath(params.cwd, value);
    if (acc.some((l) => l.path === resolved.label)) return;
    acc.push({ path: resolved.label });
  };

  const locations: ToolCallLocation[] = [];

  if (params.toolName === "Move") {
    addLocation(
      locations,
      normalize(
        rawInputObj.from_path ?? rawInputObj.fromPath ?? rawInputObj.source ?? rawInputObj.from,
      ),
    );
    addLocation(
      locations,
      normalize(
        rawInputObj.to_path ?? rawInputObj.toPath ?? rawInputObj.destination ?? rawInputObj.to,
      ),
    );
  }

  if (locations.length === 0) {
    addLocation(locations, extractFilePathFromRawInput(rawInputObj));
  }

  return locations.length > 0 ? locations : undefined;
}
