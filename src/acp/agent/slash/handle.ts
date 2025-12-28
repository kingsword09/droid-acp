import type { Session } from "../../session-types.ts";
import type { AgentRuntime } from "../runtime.ts";
import { handleHelp } from "./help.ts";
import { handleContext } from "./context.ts";
import { handleCompress } from "./compress.ts";
import { handleModel } from "./model.ts";
import { handleMode } from "./mode.ts";
import { handleConfig } from "./config.ts";
import { handleStatus } from "./status.ts";
import { handleSessions } from "./sessions.ts";

export async function handleSlashCommand(
  ctx: AgentRuntime,
  session: Session,
  text: string,
): Promise<boolean> {
  const match = text.match(/^\/(\S+)(?:\s+(.*))?$/);
  if (!match) return false;

  const [, command, args] = match;
  const trimmedArgs = args?.trim() || "";
  const name = command.toLowerCase();

  switch (name) {
    case "help":
      await handleHelp(ctx, session);
      return true;
    case "context":
      await handleContext(ctx, session);
      return true;
    case "compress":
    case "compact":
      await handleCompress(ctx, session, trimmedArgs);
      return true;
    case "model":
      await handleModel(ctx, session, trimmedArgs);
      return true;
    case "mode":
      await handleMode(ctx, session, trimmedArgs);
      return true;
    case "config":
      await handleConfig(ctx, session);
      return true;
    case "status":
      await handleStatus(ctx, session);
      return true;
    case "sessions":
      await handleSessions(ctx, session, trimmedArgs);
      return true;
    default:
      await handleHelp(ctx, session, `Unknown command: /${command}`);
      return true;
  }
}
