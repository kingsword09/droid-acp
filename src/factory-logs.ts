import path from "node:path";
import { open, type FileHandle } from "node:fs/promises";
import { getFactoryDir } from "./factory-sessions.ts";

export interface FactoryAgentStreamingResult {
  timestamp: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  modelId: string | null;
}

export function getFactoryLogFilePath(): string {
  return path.join(getFactoryDir(), "logs", "droid-log-single.log");
}

export async function readLastAgentStreamingResult(params: {
  sessionId: string;
  logFilePath?: string;
  maxBytes?: number;
  chunkBytes?: number;
}): Promise<FactoryAgentStreamingResult | null> {
  const logFilePath = params.logFilePath ?? getFactoryLogFilePath();
  const maxBytes = params.maxBytes ?? 4 * 1024 * 1024;
  const chunkBytes = params.chunkBytes ?? 256 * 1024;

  let handle: FileHandle | null = null;
  try {
    handle = await open(logFilePath, "r");
    const stat = await handle.stat();
    const size = stat.size;
    if (size <= 0) return null;

    let offset = size;
    let scanned = 0;
    let carry = "";

    while (offset > 0 && scanned < maxBytes) {
      const start = Math.max(0, offset - chunkBytes);
      const readSize = offset - start;
      const buffer = Buffer.alloc(readSize);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      if (bytesRead <= 0) break;

      scanned += bytesRead;
      offset = start;

      const text = buffer.toString("utf8", 0, bytesRead);
      const combined = text + carry;
      const lines = combined.split(/\r?\n/);

      // The first line may be truncated due to chunk boundaries; keep it for the next iteration.
      carry = lines[0] ?? "";

      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i];
        if (!line) continue;
        if (!line.includes("[Agent] Streaming result")) continue;
        if (!line.includes(`"sessionId":"${params.sessionId}"`)) continue;

        const ctxIndex = line.indexOf("| Context:");
        if (ctxIndex === -1) continue;
        const contextText = line.slice(ctxIndex + "| Context:".length).trim();

        let contextJson: unknown;
        try {
          contextJson = JSON.parse(contextText);
        } catch {
          continue;
        }

        const obj = contextJson as Record<string, unknown>;
        const tags = (obj.tags && typeof obj.tags === "object" ? obj.tags : null) as Record<
          string,
          unknown
        > | null;

        const toNumber = (v: unknown): number =>
          typeof v === "number" && Number.isFinite(v) ? v : 0;
        const modelId = typeof tags?.modelId === "string" ? tags.modelId : null;
        const timestampMatch = line.match(/^\[([^\]]+)\]/);

        return {
          timestamp: timestampMatch?.[1] ?? null,
          inputTokens: toNumber(obj.count),
          outputTokens: toNumber(obj.outputTokens),
          cacheReadInputTokens: toNumber(obj.cacheReadInputTokens),
          cacheCreationInputTokens: toNumber(obj.contextCount),
          modelId,
        };
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
