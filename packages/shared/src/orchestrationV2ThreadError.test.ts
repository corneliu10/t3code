import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderFailureClass,
  type OrchestrationV2Run,
  type OrchestrationV2RunStatus,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { usageLimitEpisodeAttemptedInstanceIds } from "./orchestrationV2ThreadError.ts";

const threadId = ThreadId.make("thread-1");
const base = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-13T10:00:00.000Z"));
const minutes = (count: number) => DateTime.makeUnsafe(base + count * 60_000);

function instance(id: string) {
  return ProviderInstanceId.make(id);
}

/** A run that finished at `endsAtMinute`, or is unfinished (queued/never started) when null. */
function makeRun(
  id: string,
  ordinal: number,
  status: OrchestrationV2RunStatus,
  providerInstanceId: string,
  options: { readonly endsAtMinute?: number | null; readonly started?: boolean } = {},
): OrchestrationV2Run {
  const started = options.started ?? status !== "queued";
  const endsAtMinute = options.endsAtMinute === undefined ? ordinal : options.endsAtMinute;
  return {
    id: RunId.make(id),
    threadId,
    ordinal,
    providerInstanceId: instance(providerInstanceId),
    modelSelection: { instanceId: instance(providerInstanceId), model: "model-1" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: NodeId.make(`root-${id}`),
    activeAttemptId: null,
    status,
    requestedAt: minutes(ordinal),
    startedAt: started ? minutes(ordinal) : null,
    completedAt: endsAtMinute === null ? null : minutes(endsAtMinute),
    checkpointId: null,
    contextHandoffId: null,
  };
}

/** The failed root error item `latestRootProviderFailure` reads. */
function rootError(
  run: OrchestrationV2Run,
  failureClass: OrchestrationV2ProviderFailureClass,
  nodeId: NodeId | null = run.rootNodeId,
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`error-${run.id}-${nodeId ?? "none"}`),
    threadId,
    runId: run.id,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    type: "error",
    status: "failed",
    title: "Provider failure",
    startedAt: minutes(run.ordinal),
    completedAt: minutes(run.ordinal),
    updatedAt: minutes(run.ordinal),
    failure: {
      class: failureClass,
      message: "Failure",
      code: null,
      retryable: null,
    },
  };
}

function attempted(runs: ReadonlyArray<OrchestrationV2Run>, items: OrchestrationV2TurnItem[]) {
  return [...usageLimitEpisodeAttemptedInstanceIds(runs, items)].toSorted();
}

describe("usageLimitEpisodeAttemptedInstanceIds", () => {
  it("is empty for a thread without runs", () => {
    expect(usageLimitEpisodeAttemptedInstanceIds([], []).size).toBe(0);
  });

  it("collects every instance whose limit ended a run after the last completed run", () => {
    const completed = makeRun("run-1", 1, "completed", "a");
    const limitedB = makeRun("run-2", 2, "failed", "b");
    const limitedC = makeRun("run-3", 3, "failed", "c");
    expect(
      attempted(
        [completed, limitedB, limitedC],
        [rootError(limitedB, "usage_limit"), rootError(limitedC, "usage_limit")],
      ),
    ).toEqual([instance("b"), instance("c")]);
  });

  it("starts a new episode after a completed run", () => {
    const limitedA = makeRun("run-1", 1, "failed", "a");
    const completed = makeRun("run-2", 2, "completed", "b");
    const limitedC = makeRun("run-3", 3, "failed", "c");
    expect(
      attempted(
        [limitedA, completed, limitedC],
        [rootError(limitedA, "usage_limit"), rootError(limitedC, "usage_limit")],
      ),
    ).toEqual([instance("c")]);
  });

  it("counts a thread whose runs never completed as one episode from the first run", () => {
    const limitedA = makeRun("run-1", 1, "failed", "a");
    const limitedB = makeRun("run-2", 2, "failed", "b");
    expect(
      attempted(
        [limitedA, limitedB],
        [rootError(limitedA, "usage_limit"), rootError(limitedB, "usage_limit")],
      ),
    ).toEqual([instance("a"), instance("b")]);
  });

  it("lists an instance once however many of its runs hit the limit", () => {
    const first = makeRun("run-1", 1, "failed", "a");
    const second = makeRun("run-2", 2, "failed", "a");
    expect(
      attempted(
        [first, second],
        [rootError(first, "usage_limit"), rootError(second, "usage_limit")],
      ),
    ).toEqual([instance("a")]);
  });

  it("leaves out failed runs whose root error is not a usage limit", () => {
    const providerError = makeRun("run-1", 1, "failed", "a");
    const limited = makeRun("run-2", 2, "failed", "b");
    const unclassified = makeRun("run-3", 3, "failed", "c");
    expect(
      attempted(
        [providerError, limited, unclassified],
        [rootError(providerError, "provider_error"), rootError(limited, "usage_limit")],
      ),
    ).toEqual([instance("b")]);
  });

  it("reads only the run's root node for the failure class", () => {
    const limitedInChild = makeRun("run-1", 1, "failed", "a");
    expect(
      attempted(
        [limitedInChild],
        [rootError(limitedInChild, "usage_limit", NodeId.make("child-node"))],
      ),
    ).toEqual([]);
  });

  it("ignores queued runs and runs cancelled before they started", () => {
    const limited = makeRun("run-1", 1, "failed", "a");
    const queued = makeRun("run-2", 2, "queued", "b", { endsAtMinute: null });
    const neverStarted = makeRun("run-3", 3, "cancelled", "c", { started: false });
    expect(
      attempted(
        [limited, queued, neverStarted],
        [
          rootError(limited, "usage_limit"),
          // A stale error on a run that never ran must not count either.
          rootError(queued, "usage_limit"),
          rootError(neverStarted, "usage_limit"),
        ],
      ),
    ).toEqual([instance("a")]);
  });

  it("keeps the episode open across a cancelled run that did start", () => {
    const limited = makeRun("run-1", 1, "failed", "a");
    const cancelled = makeRun("run-2", 2, "cancelled", "b");
    expect(attempted([limited, cancelled], [rootError(limited, "usage_limit")])).toEqual([
      instance("a"),
    ]);
  });

  it("orders runs by when they ran, not by ordinal or array position", () => {
    // Run 3 was submitted last but finished first; run 2 started from a held
    // queue after it. Run 2 ran after the completed run, so its limit counts.
    const completed = makeRun("run-3", 3, "completed", "a", { endsAtMinute: 10 });
    const limited = makeRun("run-2", 2, "failed", "b", { endsAtMinute: 20 });
    const earlierLimit = makeRun("run-1", 1, "failed", "c", { endsAtMinute: 5 });
    expect(
      attempted(
        [limited, completed, earlierLimit],
        [rootError(limited, "usage_limit"), rootError(earlierLimit, "usage_limit")],
      ),
    ).toEqual([instance("b")]);
  });
});
