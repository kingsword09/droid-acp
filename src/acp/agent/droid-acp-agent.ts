import {
  type Agent,
  AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from "@agentclientprotocol/sdk";
import type { DroidNotification, PermissionRequest } from "../../types.ts";
import type { Logger } from "../../utils.ts";
import { isExperimentSessionsEnabled } from "../flags.ts";
import { packageInfo } from "../package-info.ts";
import { handleNotification as handleDroidNotification } from "../notifications/handle-notification.ts";
import { handlePermission as handlePermissionRequest } from "../permissions/handle-permission.ts";
import type { Session } from "../session-types.ts";
import { sendAgentMessage } from "./messages.ts";
import { cancel, prompt, setSessionMode, unstable_setSessionModel } from "./prompt.ts";
import {
  loadSession,
  newSession,
  unstable_listSessions,
  unstable_resumeSession,
} from "./sessions.ts";

export class DroidAcpAgent implements Agent {
  private sessions: Map<string, Session> = new Map();
  private client: AgentSideConnection;
  private logger: Logger;

  constructor(client: AgentSideConnection, logger?: Logger) {
    this.client = client;
    this.logger = logger ?? console;
    this.logger.log("DroidAcpAgent initialized");
  }

  async initialize(_request: InitializeRequest): Promise<InitializeResponse> {
    this.logger.log("initialize");
    const enableSessions = isExperimentSessionsEnabled();
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: enableSessions,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: enableSessions ? { list: {}, resume: {} } : {},
      },
      agentInfo: {
        name: packageInfo.name,
        title: "Factory Droid",
        version: packageInfo.version,
      },
      authMethods: [
        {
          id: "factory-api-key",
          name: "Factory API Key",
          description: "Set FACTORY_API_KEY environment variable",
        },
      ],
    };
  }

  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse> {
    this.logger.log("authenticate:", request.methodId);
    if (request.methodId === "factory-api-key") {
      if (!process.env.FACTORY_API_KEY) {
        throw new Error("FACTORY_API_KEY environment variable is not set");
      }
      return {};
    }
    throw new Error(`Unknown auth method: ${request.methodId}`);
  }

  async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    return newSession(this.getRuntime(), request);
  }

  async loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    return loadSession(this.getRuntime(), request);
  }

  async unstable_listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
    return unstable_listSessions(this.getRuntime(), request);
  }

  async unstable_resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return unstable_resumeSession(this.getRuntime(), request);
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    return prompt(this.getRuntime(), request);
  }

  async cancel(request: CancelNotification): Promise<void> {
    return cancel(this.getRuntime(), request);
  }

  async unstable_setSessionModel(
    request: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    return unstable_setSessionModel(this.getRuntime(), request);
  }

  async setSessionMode(request: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return setSessionMode(this.getRuntime(), request);
  }

  async cleanup(): Promise<void> {
    for (const [, session] of this.sessions) {
      await session.droid.stop();
    }
    this.sessions.clear();
  }

  private getRuntime() {
    return {
      client: this.client,
      logger: this.logger,
      sessions: this.sessions,
      getAttachHandlers: () => this.getAttachHandlers(),
    };
  }

  private getAttachHandlers(): {
    handleNotification: (session: Session, n: DroidNotification) => Promise<void>;
    handlePermission: (
      session: Session,
      params: PermissionRequest,
    ) => Promise<{ selectedOption: string }>;
  } {
    return {
      handleNotification: (session, n) => this.handleNotification(session, n),
      handlePermission: (session, params) => this.handlePermission(session, params),
    };
  }

  private async handlePermission(
    session: Session,
    params: PermissionRequest,
  ): Promise<{ selectedOption: string }> {
    return handlePermissionRequest(
      {
        client: this.client,
        logger: this.logger,
        sendAgentMessage: (s, text) => sendAgentMessage(this.client, s, text),
      },
      session,
      params,
    );
  }

  private async handleNotification(session: Session, n: DroidNotification): Promise<void> {
    await handleDroidNotification({ client: this.client, logger: this.logger }, session, n);
  }
}
