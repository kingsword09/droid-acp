import { getAvailableCommands } from "../../commands.ts";
import type { Session } from "../../session-types.ts";
import { sendAgentMessage } from "../messages.ts";
import type { AgentRuntime } from "../runtime.ts";

export async function handleHelp(
  ctx: AgentRuntime,
  session: Session,
  header?: string,
): Promise<void> {
  const commands = getAvailableCommands();
  const helpText = [
    header ? `${header}\n` : null,
    "**Available Commands:**\n",
    ...commands.map((cmd) => {
      const inputHint = cmd.input && "hint" in cmd.input ? ` ${cmd.input.hint}` : "";
      return `- /${cmd.name}${inputHint} - ${cmd.description}`;
    }),
  ]
    .filter((l): l is string => typeof l === "string")
    .join("\n");

  await sendAgentMessage(ctx.client, session, helpText);
}
