import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { Session } from "../session-types.ts";
import { toolCallRawInputForClient } from "./format.ts";
import { extractPlanChoices, planEntriesFromMarkdown } from "./spec.ts";

export async function maybeHandleExitSpecModePlanChoice(
  ctx: {
    client: AgentSideConnection;
    sendAgentMessage: (session: Session, text: string) => Promise<void>;
  },
  session: Session,
  params: {
    toolCallId: string;
    planTitle: string | null;
    planMarkdown: string;
  },
): Promise<{ selectedOption: string } | null> {
  const signature = `${params.planTitle ?? ""}\n${params.planMarkdown}`;
  if (session.specChoicePromptSignature !== signature) {
    session.specChoicePromptSignature = signature;
    session.specChoice = null;
  }

  if (session.specPlanDetailsSignature !== signature) {
    session.specPlanDetailsSignature = signature;
    session.specPlanDetailsToolCallId = `${params.toolCallId}:plan_details`;
    await ctx.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: session.specPlanDetailsToolCallId,
        title: params.planTitle ? `Plan details: ${params.planTitle}` : "Plan details",
        kind: "think",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: params.planMarkdown },
          },
        ],
      },
    });
  }

  if (session.specChoice !== null) return null;

  const choices = extractPlanChoices(params.planMarkdown);
  if (choices.length === 0) return null;

  const detailsHint = session.specPlanDetailsToolCallId
    ? `Expand **${session.specPlanDetailsToolCallId}** to view the full plan details.`
    : "Expand the Plan details tool call to view the full plan details.";
  const choicePrompt = [
    params.planTitle ? `**${params.planTitle}**` : "**Choose an implementation option**",
    "",
    detailsHint,
    "Choose one to continue iterating in spec mode.",
    ...choices.map((c) => `- Option ${c.id}: ${c.title}`),
  ]
    .filter((p) => p.length > 0)
    .join("\n");

  const response = await ctx.client.requestPermission({
    sessionId: session.id,
    toolCall: {
      toolCallId: `${params.toolCallId}:choose_plan`,
      title: params.planTitle ? `Choose plan: ${params.planTitle}` : "Choose plan option",
      status: "pending",
      kind: "think",
      rawInput: toolCallRawInputForClient({ choices }),
      content: [
        {
          type: "content",
          content: { type: "text", text: choicePrompt },
        },
      ],
    },
    options: [
      ...choices.map((c) => ({
        optionId: `choose_plan:${c.id}`,
        name: `Choose Option ${c.id}`,
        kind: "allow_once" as const,
      })),
      { optionId: "choose_plan:skip", name: "Skip", kind: "reject_once" as const },
    ],
  });

  const outcome =
    response.outcome.outcome === "selected" ? response.outcome.optionId : "choose_plan:skip";
  const match = outcome.match(/^choose_plan:([A-Z])$/);
  if (!match) {
    session.specChoice = "skip";
    return null;
  }

  const choiceId = match[1];
  session.specChoice = choiceId;

  // Close the temporary "choose plan" permission prompt tool call.
  await ctx.client.sessionUpdate({
    sessionId: session.id,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: `${params.toolCallId}:choose_plan`,
      status: "completed",
    },
  });

  // Close the original ExitSpecMode tool call since we're explicitly staying in spec mode.
  session.toolCallStatus.set(params.toolCallId, "completed");
  session.activeToolCallIds.delete(params.toolCallId);
  await ctx.client.sessionUpdate({
    sessionId: session.id,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: params.toolCallId,
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: `Continuing in spec mode with Option ${choiceId}.`,
          },
        },
      ],
    },
  });

  await ctx.sendAgentMessage(session, `Selected **Option ${choiceId}**. Continuing in spec mode.`);
  setTimeout(() => {
    session.droid.sendMessage(
      `I choose Option ${choiceId}. Please continue refining the plan and key changes based on this option, and when you are ready to execute, prompt to exit spec mode.`,
    );
  }, 0);

  return { selectedOption: "cancel" };
}

export async function emitExitSpecModePlanUpdate(
  ctx: { client: AgentSideConnection },
  session: Session,
  planMarkdown: string,
): Promise<void> {
  const entries = planEntriesFromMarkdown(planMarkdown);

  if (entries.length > 0) {
    await ctx.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "plan",
        entries,
      },
    });
    return;
  }

  if (planMarkdown.trim().length > 0) {
    await ctx.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "plan",
        entries: [
          {
            content: planMarkdown.trim(),
            status: "pending",
            priority: "medium",
          },
        ],
      },
    });
  }
}
