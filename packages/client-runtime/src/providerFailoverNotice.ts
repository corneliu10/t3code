import type {
  OrchestrationV2ProviderFailover,
  OrchestrationV2Run,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "./state/providerInstanceDisplay.ts";

/**
 * The quiet line shown on a run the server moved to another account after a
 * usage limit. Web and mobile show the same words.
 */
export function describeProviderFailover(input: {
  readonly failover: OrchestrationV2ProviderFailover;
  readonly toLabel: string;
  readonly fromLabel: string;
  readonly formatTime: (iso: string) => string;
}): string {
  const { failover, toLabel, fromLabel } = input;
  if (failover.reason === "usage_limit")
    return `Usage limit on ${fromLabel}. Continued on ${toLabel}.`;
  return failover.fromResetsAt === undefined
    ? `${fromLabel} is out of quota. Started on ${toLabel}.`
    : `${fromLabel} is out of quota until ${input.formatTime(failover.fromResetsAt)}. Started on ${toLabel}.`;
}

/**
 * What a timeline needs of a run to show its failover notice: the run's own
 * first message carries it, so a later message in the same run (a steer) does
 * not repeat it.
 */
export type ProviderFailoverRun = Pick<
  OrchestrationV2Run,
  "userMessageId" | "providerInstanceId" | "providerFailover"
>;

function instanceLabel(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "displayName">>,
  instanceId: ProviderInstanceId,
): string {
  const snapshot = providers.find((provider) => provider.instanceId === instanceId);
  // An account removed since the failover has no snapshot; its id still says which one.
  return snapshot === undefined ? instanceId : resolveProviderInstanceDisplayName(snapshot);
}

/** The notice for a run, or null when it did not move accounts. */
export function describeRunProviderFailover(input: {
  readonly run: Pick<ProviderFailoverRun, "providerInstanceId" | "providerFailover">;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "displayName">>;
  readonly formatTime: (iso: string) => string;
}): string | null {
  const { run, providers } = input;
  const failover = run.providerFailover;
  if (failover === undefined) return null;
  return describeProviderFailover({
    failover,
    fromLabel: instanceLabel(providers, failover.fromProviderInstanceId),
    toLabel: instanceLabel(providers, run.providerInstanceId),
    formatTime: input.formatTime,
  });
}
