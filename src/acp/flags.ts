import { isEnvEnabled } from "../utils.ts";

export function isExperimentSessionsEnabled(): boolean {
  return isEnvEnabled(process.env.DROID_ACP_EXPERIMENT_SESSIONS);
}

export function isDebugEnabled(): boolean {
  return isEnvEnabled(process.env.DROID_DEBUG);
}
