import {
  CommandId,
  MessageId,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { chooseFailoverTarget } from "./UsageLimitFailoverPolicy.ts";

/**
 * Continues a limited run on `target`. The run and target form the command's
 * identity, so a repeated sweep replays the stored receipt instead of starting
 * a second run, and a refused command is never re-evaluated.
 */
export function limitFailoverCommand(
  candidate: ProjectionStore.ProjectionLimitFailoverCandidate,
  target: ModelSelection,
): OrchestrationV2Command {
  const identity = `${candidate.threadId}:${candidate.runId}:${target.instanceId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-failover:${identity}`),
    messageId: MessageId.make(`limit-failover:${identity}`),
    threadId: candidate.threadId,
    modelSelection: target,
    usageLimitContinuationOfRunId: candidate.runId,
    providerFailover: {
      reason: "usage_limit",
      fromProviderInstanceId: candidate.runProviderInstanceId,
      ...(candidate.resetAt === null ? {} : { fromResetsAt: candidate.resetAt }),
    },
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  return Effect.fn("UsageLimitFailoverWorker.sweep")(function* () {
    const settings = yield* serverSettings.getSettings;
    const failover = settings.usageLimitFailover;
    // Off is the default, so most sweeps stop here without a query.
    if (!failover.enabled || failover.chain.length === 0) return;
    const candidates = yield* projections.getLimitFailoverCandidates();
    if (candidates.length === 0) return;
    const providers = yield* providerRegistry.getProviders;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    for (const candidate of candidates) {
      const choice = chooseFailoverTarget({
        // Thread management refuses an instance the project turned off, with an
        // error rather than a receipt, so such an entry would be retried every
        // sweep and hide the accounts below it.
        chain: failover.chain.filter((entry) =>
          resolveProjectProviderInstanceEnabled(settings, candidate.projectId, entry.instanceId),
        ),
        failedInstanceId: candidate.runProviderInstanceId,
        attempted: new Set(candidate.attemptedInstanceIds),
        providers,
        currentSelection: candidate.modelSelection,
        nowMs,
      });
      // No eligible account: the thread keeps the banner and auto-resume path.
      if (choice.type === "none") continue;
      yield* threads.dispatch(limitFailoverCommand(candidate, choice.modelSelection)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-failover.dispatch-failed", {
            threadId: candidate.threadId,
            cause,
          }),
        ),
      );
    }
  });
});

// Like limit recovery, due work is derived from persisted failures on each
// tick, so a restart needs nothing restored.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-failover", sweep());
  }),
);
