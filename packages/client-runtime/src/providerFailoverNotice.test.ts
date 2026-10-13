import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  describeProviderFailover,
  describeRunProviderFailover,
  type ProviderFailoverRun,
} from "./providerFailoverNotice.ts";

const formatTime = (iso: string) => `at ${iso}`;
const personal = ProviderInstanceId.make("claude_personal");
const work = ProviderInstanceId.make("claude_work");
const claude = ProviderDriverKind.make("claudeAgent");

describe("describeProviderFailover", () => {
  it("names both accounts when a running thread moved on a usage limit", () => {
    expect(
      describeProviderFailover({
        failover: { reason: "usage_limit", fromProviderInstanceId: personal },
        fromLabel: "Personal",
        toLabel: "Work",
        formatTime,
      }),
    ).toBe("Usage limit on Personal. Continued on Work.");
  });

  it("says when the account that was out of quota resets", () => {
    expect(
      describeProviderFailover({
        failover: {
          reason: "usage_limit_at_start",
          fromProviderInstanceId: personal,
          fromResetsAt: "2026-10-14T15:40:00.000Z",
        },
        fromLabel: "Personal",
        toLabel: "Work",
        formatTime,
      }),
    ).toBe("Personal is out of quota until at 2026-10-14T15:40:00.000Z. Started on Work.");
  });

  it("leaves the time out when the provider reported none", () => {
    expect(
      describeProviderFailover({
        failover: { reason: "usage_limit_at_start", fromProviderInstanceId: personal },
        fromLabel: "Personal",
        toLabel: "Work",
        formatTime,
      }),
    ).toBe("Personal is out of quota. Started on Work.");
  });
});

describe("describeRunProviderFailover", () => {
  const providers = [
    { instanceId: personal, driver: claude, displayName: "Personal" },
    { instanceId: work, driver: claude, displayName: "Work" },
  ];
  const run = (failover: OrchestrationV2Run["providerFailover"]): ProviderFailoverRun => ({
    userMessageId: "message-1" as ProviderFailoverRun["userMessageId"],
    providerInstanceId: work,
    ...(failover === undefined ? {} : { providerFailover: failover }),
  });

  it("labels both accounts the way the model picker does", () => {
    expect(
      describeRunProviderFailover({
        run: run({ reason: "usage_limit", fromProviderInstanceId: personal }),
        providers,
        formatTime,
      }),
    ).toBe("Usage limit on Personal. Continued on Work.");
  });

  it("falls back to the instance id for an account that is no longer configured", () => {
    expect(
      describeRunProviderFailover({
        run: run({ reason: "usage_limit", fromProviderInstanceId: personal }),
        providers: [providers[1]!],
        formatTime,
      }),
    ).toBe("Usage limit on claude_personal. Continued on Work.");
  });

  it("is silent for a run that did not move accounts", () => {
    expect(describeRunProviderFailover({ run: run(undefined), providers, formatTime })).toBeNull();
  });
});
