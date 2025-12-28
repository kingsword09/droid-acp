import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { Session } from "../session-types.ts";

export async function sendAgentMessage(
  client: AgentSideConnection,
  session: Session,
  text: string,
): Promise<void> {
  await client.sessionUpdate({
    sessionId: session.id,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}
