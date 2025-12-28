import { streamFactorySessionJsonl } from "../../factory-sessions.ts";
import { sanitizeHistoryTextForDisplay } from "../text.ts";

export async function buildHistoryTranscriptFromJsonl(
  jsonlPath: string,
  maxChars: number,
): Promise<string> {
  const lines: string[] = [];
  let includedSessionHistory = false;

  for await (const entry of streamFactorySessionJsonl(jsonlPath)) {
    const record = entry as { type?: unknown; message?: unknown };
    if (record.type !== "message") continue;

    const message = record.message as { role?: unknown; content?: unknown };
    const role = message?.role;
    const content = message?.content;
    if (role !== "user" && role !== "assistant") continue;
    if (!Array.isArray(content)) continue;

    const rawText = content
      .filter((c) => (c as Record<string, unknown>)?.type === "text")
      .map((c) => ((c as Record<string, unknown>)?.text as string) ?? "")
      .join("");

    if (role === "user") {
      const sessionHistoryMatch = rawText.match(
        /<context[^>]*\sref=["']session_history["'][^>]*>([\s\S]*?)<\/context>/i,
      );
      const embeddedHistory = sessionHistoryMatch?.[1] ? sessionHistoryMatch[1].trim() : "";
      if (!includedSessionHistory && embeddedHistory.length > 0) {
        const cleanedHistory = sanitizeHistoryTextForDisplay(embeddedHistory);
        if (cleanedHistory.length > 0) {
          includedSessionHistory = true;
          lines.push(`[Previous session transcript]\n${cleanedHistory}`);
        }
      }

      const withoutSessionHistory = rawText.replace(
        /<context[^>]*\sref=["']session_history["'][^>]*>[\s\S]*?<\/context>/gi,
        "",
      );
      const cleanedUserText = sanitizeHistoryTextForDisplay(withoutSessionHistory);
      if (cleanedUserText.length > 0) {
        lines.push(`User: ${cleanedUserText}`);
      }
      continue;
    }

    const cleanedAssistantText = sanitizeHistoryTextForDisplay(rawText);
    if (cleanedAssistantText.length > 0) {
      lines.push(`Assistant: ${cleanedAssistantText}`);
    }
  }

  const transcript = lines.join("\n\n").trim();
  if (transcript.length <= maxChars) return transcript;
  return transcript.slice(transcript.length - maxChars);
}
