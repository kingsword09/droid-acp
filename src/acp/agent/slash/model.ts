import type { Session } from "../../session-types.ts";
import { sendAgentMessage } from "../messages.ts";
import type { AgentRuntime } from "../runtime.ts";

export async function handleModel(
  ctx: AgentRuntime,
  session: Session,
  trimmedArgs: string,
): Promise<void> {
  if (trimmedArgs) {
    const modelId = trimmedArgs;
    const model = session.availableModels.find(
      (m) => m.id === modelId || m.displayName.toLowerCase() === modelId.toLowerCase(),
    );
    if (model) {
      session.model = model.id;
      session.droid.setModel(model.id);
      await sendAgentMessage(ctx.client, session, `Model changed to: **${model.displayName}**`);
    } else {
      const available = session.availableModels.map((m) => `- ${m.id} (${m.displayName})`);
      await sendAgentMessage(
        ctx.client,
        session,
        `Model "${modelId}" not found.\n\n**Available models:**\n${available.join("\n")}`,
      );
    }
    return;
  }

  const available = session.availableModels.map((m) => {
    const current = m.id === session.model ? " **(current)**" : "";
    return `- ${m.id} (${m.displayName})${current}`;
  });
  await sendAgentMessage(
    ctx.client,
    session,
    `**Current model:** ${session.model}\n\n**Available models:**\n${available.join("\n")}`,
  );
}
