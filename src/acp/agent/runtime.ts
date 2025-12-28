import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { DroidNotification, PermissionRequest } from "../../types.ts";
import type { Logger } from "../../utils.ts";
import type { Session } from "../session-types.ts";

export type AttachHandlers = {
  handleNotification: (session: Session, n: DroidNotification) => Promise<void>;
  handlePermission: (
    session: Session,
    params: PermissionRequest,
  ) => Promise<{ selectedOption: string }>;
};

export type AgentRuntime = {
  client: AgentSideConnection;
  logger: Logger;
  sessions: Map<string, Session>;
  getAttachHandlers: () => AttachHandlers;
};
