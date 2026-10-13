import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ServerProvider,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type UsageLimitFailoverSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitFailoverWorker from "./UsageLimitFailoverWorker.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

const failedInstance = ProviderInstanceId.make("claude_a");
const nextInstance = ProviderInstanceId.make("claude_b");
const thirdInstance = ProviderInstanceId.make("claude_c");
const configuredInstances = Object.fromEntries(
  [failedInstance, nextInstance, thirdInstance].map((instanceId) => [
    instanceId,
    { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
  ]),
);
const projectId = ProjectId.make("project:failover-worker");

const provider = (instanceId: ProviderInstanceId, enabled = true): ServerProvider =>
  decodeServerProvider({
    instanceId,
    driver: "claudeAgent",
    enabled,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-13T11:59:00.000Z",
    models: [
      { slug: "sonnet", name: "sonnet", isCustom: false, isDefault: true, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  });

const candidate = (key: string): ProjectionStore.ProjectionLimitFailoverCandidate => ({
  threadId: ThreadId.make(`thread:failover-worker:${key}`),
  projectId,
  runId: RunId.make(`run:failover-worker:${key}`),
  runProviderInstanceId: failedInstance,
  modelSelection: { instanceId: failedInstance, model: "sonnet" },
  resetAt: null,
  attemptedInstanceIds: [failedInstance],
});

const chain: UsageLimitFailoverSettings = {
  enabled: true,
  chain: [{ instanceId: failedInstance }, { instanceId: nextInstance }],
};

/**
 * Builds the worker on stubs, takes the sweep it registers on the scheduler
 * and runs it once, so no test waits on the scheduler's clock.
 */
const sweepOnce = Effect.fn("sweepOnce")(function* (input: {
  readonly failover: UsageLimitFailoverSettings;
  readonly candidates: ReadonlyArray<ProjectionStore.ProjectionLimitFailoverCandidate>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly settings?: Partial<typeof DEFAULT_SERVER_SETTINGS>;
  readonly failDispatchFor?: ThreadId;
}) {
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const reads = yield* Ref.make({ candidates: 0, providers: 0 });
  const registered = yield* Ref.make<
    ReadonlyArray<{ readonly name: string; readonly run: Effect.Effect<void> }>
  >([]);
  const warnings: Array<ReadonlyArray<unknown>> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(Array.isArray(message) ? message : [message]);
  });
  const layerWorker = UsageLimitFailoverWorker.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getLimitFailoverCandidates: () =>
            Ref.update(reads, (count) => ({ ...count, candidates: count.candidates + 1 })).pipe(
              Effect.as(input.candidates),
            ),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            "threadId" in command && command.threadId === input.failDispatchFor
              ? Effect.die("fixture dispatch failure")
              : Ref.update(dispatched, (all) => [...all, command]).pipe(
                  Effect.as({ sequence: 1, storedEvents: [] }),
                ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: configuredInstances,
            ...input.settings,
            usageLimitFailover: input.failover,
          }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Ref.update(reads, (count) => ({
            ...count,
            providers: count.providers + 1,
          })).pipe(
            Effect.as(input.providers ?? [provider(failedInstance), provider(nextInstance)]),
          ),
        }),
        Layer.succeed(
          Scheduler.Scheduler,
          Scheduler.Scheduler.of({
            register: <E, R>(name: string, runDueWork: Effect.Effect<void, E, R>) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<R>();
                yield* Ref.update(registered, (all) => [
                  ...all,
                  { name, run: runDueWork.pipe(Effect.provideContext(context), Effect.orDie) },
                ]);
              }),
          }),
        ),
      ),
    ),
  );
  yield* Effect.gen(function* () {
    const sources = yield* Ref.get(registered);
    assert.deepEqual(
      sources.map((source) => source.name),
      ["usage-limit-failover"],
    );
    yield* sources[0]!.run;
  }).pipe(
    // The sweep runs in the context the worker registered it with, so the
    // logger must reach the layer's construction.
    Effect.provide(
      layerWorker.pipe(Layer.provide(Logger.layer([logger], { mergeWithExisting: false }))),
    ),
  );
  return {
    dispatched: yield* Ref.get(dispatched),
    reads: yield* Ref.get(reads),
    warnings,
  };
});

it.effect("does nothing while failover is off", () =>
  Effect.gen(function* () {
    const result = yield* sweepOnce({
      failover: { ...chain, enabled: false },
      candidates: [candidate("off")],
    });
    assert.deepEqual(result.dispatched, []);
    assert.deepEqual(result.reads, { candidates: 0, providers: 0 });
  }),
);

it.effect("does nothing with an empty chain", () =>
  Effect.gen(function* () {
    const result = yield* sweepOnce({
      failover: { enabled: true, chain: [] },
      candidates: [candidate("empty-chain")],
    });
    assert.deepEqual(result.dispatched, []);
    assert.deepEqual(result.reads, { candidates: 0, providers: 0 });
  }),
);

it.effect("reads no providers when no thread is limited", () =>
  Effect.gen(function* () {
    const result = yield* sweepOnce({ failover: chain, candidates: [] });
    assert.deepEqual(result.dispatched, []);
    assert.deepEqual(result.reads, { candidates: 1, providers: 0 });
  }),
);

it.effect("continues a limited thread on the next account in the chain", () =>
  Effect.gen(function* () {
    const limited = candidate("next");
    const result = yield* sweepOnce({ failover: chain, candidates: [limited] });
    assert.deepEqual(result.dispatched, [
      UsageLimitFailoverWorker.limitFailoverCommand(limited, {
        instanceId: nextInstance,
        model: "sonnet",
      }),
    ]);
    assert.deepEqual(result.reads, { candidates: 1, providers: 1 });
  }),
);

it.effect("builds the continuation the failover gate expects", () =>
  Effect.sync(() => {
    const limited = { ...candidate("command"), resetAt: "2026-10-13T15:00:00.000Z" };
    const command = UsageLimitFailoverWorker.limitFailoverCommand(limited, {
      instanceId: nextInstance,
      model: "sonnet",
    });
    const identity = `${limited.threadId}:${limited.runId}:${nextInstance}`;
    const expected: OrchestrationV2Command = {
      type: "message.dispatch",
      commandId: CommandId.make(`limit-failover:${identity}`),
      messageId: MessageId.make(`limit-failover:${identity}`),
      threadId: limited.threadId,
      modelSelection: { instanceId: nextInstance, model: "sonnet" },
      usageLimitContinuationOfRunId: limited.runId,
      providerFailover: {
        reason: "usage_limit",
        fromProviderInstanceId: failedInstance,
        fromResetsAt: "2026-10-13T15:00:00.000Z",
      },
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    };
    assert.deepEqual(command, expected);
    const withoutReset = UsageLimitFailoverWorker.limitFailoverCommand(candidate("command"), {
      instanceId: nextInstance,
      model: "sonnet",
    });
    assert.deepEqual(
      withoutReset.type === "message.dispatch" ? withoutReset.providerFailover : undefined,
      { reason: "usage_limit", fromProviderInstanceId: failedInstance },
    );
  }),
);

it.effect("dispatches nothing when every account is ineligible", () =>
  Effect.gen(function* () {
    const result = yield* sweepOnce({
      failover: chain,
      candidates: [
        candidate("exhausted"),
        // The next account already hit its limit in this episode.
        { ...candidate("attempted"), attemptedInstanceIds: [failedInstance, nextInstance] },
      ],
      providers: [provider(failedInstance), provider(nextInstance, false)],
    });
    assert.deepEqual(result.dispatched, []);
  }),
);

it.effect("skips an account the thread's project turned off", () =>
  Effect.gen(function* () {
    const limited = candidate("project-off");
    const result = yield* sweepOnce({
      failover: { enabled: true, chain: [...chain.chain, { instanceId: thirdInstance }] },
      candidates: [limited],
      providers: [provider(failedInstance), provider(nextInstance), provider(thirdInstance)],
      settings: {
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [nextInstance]: { enabled: false } } },
        },
      },
    });
    assert.deepEqual(result.dispatched, [
      UsageLimitFailoverWorker.limitFailoverCommand(limited, {
        instanceId: thirdInstance,
        model: "sonnet",
      }),
    ]);
  }),
);

it.effect("logs a failed dispatch and moves on to the next thread", () =>
  Effect.gen(function* () {
    const broken = candidate("broken");
    const healthy = candidate("healthy");
    const result = yield* sweepOnce({
      failover: chain,
      candidates: [broken, healthy],
      failDispatchFor: broken.threadId,
    });
    assert.deepEqual(result.dispatched, [
      UsageLimitFailoverWorker.limitFailoverCommand(healthy, {
        instanceId: nextInstance,
        model: "sonnet",
      }),
    ]);
    assert.deepEqual(
      result.warnings.map((parts) => parts[0]),
      ["orchestration-v2.limit-failover.dispatch-failed"],
    );
  }),
);
