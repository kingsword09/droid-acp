import type { FactorySessionRecord } from "../../../../factory-sessions.ts";
import { sanitizeSessionTitle } from "../../../text.ts";

export function filterEmptySessions(sessions: FactorySessionRecord[]): FactorySessionRecord[] {
  return sessions.filter((s) => {
    const cleanedTitle = s.title ? sanitizeSessionTitle(s.title) : "";
    if (!cleanedTitle) return false;
    return cleanedTitle.toLowerCase() !== "new session";
  });
}
