import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "../../utils.ts";
import { DroidAcpAgent } from "./droid-acp-agent.ts";

export function runAcp(): void {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new DroidAcpAgent(client), stream);
}
