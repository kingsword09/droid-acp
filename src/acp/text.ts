export function sanitizeHistoryTextForDisplay(text: string): string {
  let out = text;
  out = out.replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/gi, "");
  out = out.replace(/<context[^>]*>[\s\S]*?(<\/context>|$)/gi, "");
  out = out.replace(/<\/?context[^>]*>/gi, "");
  out = out.replace(/<\/?system-reminder>/gi, "");
  out = out.replace(/\r\n/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

export function sanitizeSessionTitle(title: string): string {
  let out = title;
  out = out.replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/gi, "");
  out = out.replace(/<\/?context[^>]*>/gi, "");
  out = out.replace(/<\/?system-reminder>/gi, "");
  out = out.replace(/^\s*(User|Assistant)\s*:\s*/i, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

export function formatTimestampForDisplay(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return isoTimestamp;
  const pad2 = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function safeCodeFenceContent(text: string): string {
  return text.replace(/```/g, "``\u200b`");
}

export function normalizeBase64DataUrl(
  data: string,
  fallbackMimeType: string,
): { mimeType: string; base64: string } {
  const trimmed = data.trim();
  const match = trimmed.match(/^data:([^;,]+);base64,(.*)$/s);
  if (match) {
    const mimeType = match[1]?.trim() || fallbackMimeType;
    const base64 = match[2]?.trim().replace(/\s+/g, "");
    return { mimeType, base64 };
  }

  return { mimeType: fallbackMimeType, base64: trimmed.replace(/\s+/g, "") };
}
