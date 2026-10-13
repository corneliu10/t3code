import {
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ProviderFailover,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { isDraftAccountSupersededByFailover } from "./providerFailoverDraft.ts";

const personal = ProviderInstanceId.make("claude_personal");
const work = ProviderInstanceId.make("claude_work");
const failoverAt = Date.parse("2026-10-13T12:00:00.000Z");

const run = (
  ordinal: number,
  providerFailover?: OrchestrationV2ProviderFailover,
  requestedAtMs = failoverAt,
) => ({
  id: RunId.make(`run-${ordinal}`),
  ordinal,
  requestedAt: DateTime.makeUnsafe(requestedAtMs),
  ...(providerFailover === undefined ? {} : { providerFailover }),
});

const movedOffPersonal = { reason: "usage_limit", fromProviderInstanceId: personal } as const;

describe("isDraftAccountSupersededByFailover", () => {
  it("gives way when the draft picked the account the server moved the thread off", () => {
    expect(
      isDraftAccountSupersededByFailover({
        draftInstanceId: personal,
        draftSelectedAt: failoverAt - 60_000,
        runs: [run(1), run(2, movedOffPersonal)],
      }),
    ).toBe(true);
  });

  it("gives way for an at-start substitution too", () => {
    expect(
      isDraftAccountSupersededByFailover({
        draftInstanceId: personal,
        draftSelectedAt: failoverAt - 60_000,
        runs: [run(1, { reason: "usage_limit_at_start", fromProviderInstanceId: personal })],
      }),
    ).toBe(true);
  });

  it("treats a draft with no pick time as older than the failover", () => {
    expect(
      isDraftAccountSupersededByFailover({
        draftInstanceId: personal,
        draftSelectedAt: undefined,
        runs: [run(1, movedOffPersonal)],
      }),
    ).toBe(true);
  });

  it("keeps an account the user picked again after the failover", () => {
    expect(
      isDraftAccountSupersededByFailover({
        draftInstanceId: personal,
        draftSelectedAt: failoverAt + 1,
        runs: [run(1), run(2, movedOffPersonal)],
      }),
    ).toBe(false);
  });

  it("keeps a draft on another account, or with no account", () => {
    for (const draftInstanceId of [work, null, undefined]) {
      expect(
        isDraftAccountSupersededByFailover({
          draftInstanceId,
          draftSelectedAt: failoverAt - 60_000,
          runs: [run(1, movedOffPersonal)],
        }),
      ).toBe(false);
    }
  });

  it("counts any failover off the draft's account since the draft picked it", () => {
    // The thread moved on again since, and runs arrive in any order.
    expect(
      isDraftAccountSupersededByFailover({
        draftInstanceId: personal,
        draftSelectedAt: failoverAt - 60_000,
        runs: [
          run(3, { reason: "usage_limit", fromProviderInstanceId: work }, failoverAt + 60_000),
          run(1),
          run(2, movedOffPersonal),
        ],
      }),
    ).toBe(true);
    // A failover off the account before the draft picked it is history.
    expect(
      isDraftAccountSupersededByFailover({
        draftInstanceId: personal,
        draftSelectedAt: failoverAt + 30_000,
        runs: [
          run(3, { reason: "usage_limit", fromProviderInstanceId: work }, failoverAt + 60_000),
          run(2, movedOffPersonal),
        ],
      }),
    ).toBe(false);
  });

  it("does nothing for a thread that never moved accounts", () => {
    expect(
      isDraftAccountSupersededByFailover({
        draftInstanceId: personal,
        draftSelectedAt: undefined,
        runs: [run(1), run(2)],
      }),
    ).toBe(false);
  });
});
