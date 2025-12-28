import {
  DROID_CONTEXT_INDICATOR_MAX_TOKENS,
  DROID_CONTEXT_INDICATOR_MAX_TOKENS_ANTHROPIC,
  DROID_CONTEXT_INDICATOR_MIN_TOKENS,
} from "../../constants.ts";
import type { Session } from "../../session-types.ts";
import { formatTimestampForDisplay } from "../../text.ts";
import {
  readFactorySessionSettings,
  resolveFactorySessionSettingsJsonPath,
  type FactorySessionSettings,
} from "../../../factory-sessions.ts";
import { readLastAgentStreamingResult } from "../../../factory-logs.ts";
import { sendAgentMessage } from "../messages.ts";
import type { AgentRuntime } from "../runtime.ts";

export async function handleContext(ctx: AgentRuntime, session: Session): Promise<void> {
  const settingsPath = await resolveFactorySessionSettingsJsonPath({
    sessionId: session.droidSessionId,
    cwd: session.cwd,
  });
  const settings = settingsPath ? await readFactorySessionSettings(settingsPath) : null;
  const modelFromSettings = settings?.model ?? null;
  const reasoningEffort = settings?.reasoningEffort ?? "unknown";

  const streaming = await readLastAgentStreamingResult({ sessionId: session.droidSessionId });
  if (!streaming) {
    const usage: FactorySessionSettings["tokenUsage"] | undefined = settings?.tokenUsage;
    if (!usage) {
      await sendAgentMessage(
        ctx.client,
        session,
        "No token usage data yet.\n\nSend at least one message first, then run `/context` again.",
      );
      return;
    }

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cacheReadTokens = usage.cacheReadTokens ?? 0;
    const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
    const thinkingTokens = usage.thinkingTokens ?? 0;
    const total = inputTokens + outputTokens + cacheReadTokens;
    const n = (v: number) => v.toLocaleString();

    await sendAgentMessage(
      ctx.client,
      session,
      [
        `**Context / Token Usage:**`,
        `- Model: ${modelFromSettings ?? session.model}`,
        `- Reasoning effort: ${reasoningEffort}`,
        "",
        "Could not find the last per-call usage in `~/.factory/logs/droid-log-single.log`.",
        "Showing cumulative session totals from `*.settings.json` instead (not a context %).",
        "",
        `**Cumulative totals:**`,
        `- total (input + output + cacheRead): ${n(total)} tokens`,
        `- inputTokens: ${n(inputTokens)}`,
        `- outputTokens: ${n(outputTokens)}`,
        `- cacheReadTokens: ${n(cacheReadTokens)}`,
        `- cacheCreationTokens: ${n(cacheCreationTokens)}`,
        `- thinkingTokens: ${n(thinkingTokens)}`,
      ].join("\n"),
    );
    return;
  }

  const modelId = modelFromSettings ?? streaming.modelId ?? session.model;
  const provider = session.availableModels.find((m) => m.id === modelId)?.modelProvider;

  const inputTokens = streaming.inputTokens;
  const outputTokens = streaming.outputTokens;
  const cacheReadTokens = streaming.cacheReadInputTokens;
  const cacheCreationTokens = streaming.cacheCreationInputTokens;

  const total = inputTokens + outputTokens + cacheReadTokens;
  const n = (v: number) => v.toLocaleString();

  const maxTokens =
    provider === "anthropic"
      ? DROID_CONTEXT_INDICATOR_MAX_TOKENS_ANTHROPIC
      : DROID_CONTEXT_INDICATOR_MAX_TOKENS;
  const denom = Math.max(1, maxTokens - DROID_CONTEXT_INDICATOR_MIN_TOKENS);
  const numer = Math.max(0, total - DROID_CONTEXT_INDICATOR_MIN_TOKENS);
  const pctRounded = Math.min(100, Math.round((numer / denom) * 100));
  const contextPct = total > 0 && pctRounded === 0 ? "<1%" : `${pctRounded}%`;

  const timeLine = streaming.timestamp
    ? `- Time: ${formatTimestampForDisplay(streaming.timestamp)}`
    : null;

  await sendAgentMessage(
    ctx.client,
    session,
    [
      `**Context / Token Usage (last model call):**`,
      `- Model: ${modelId}`,
      `- Reasoning effort: ${reasoningEffort}`,
      timeLine,
      `- Context: ${contextPct} (total=${n(total)}, max=${n(maxTokens)})`,
      "",
      `**Breakdown (last call):**`,
      `- inputTokens: ${n(inputTokens)}`,
      `- outputTokens: ${n(outputTokens)}`,
      `- cacheReadTokens: ${n(cacheReadTokens)}`,
      `- cacheCreationTokens: ${n(cacheCreationTokens)} (not counted above)`,
    ]
      .filter((l): l is string => typeof l === "string")
      .join("\n"),
  );
}
