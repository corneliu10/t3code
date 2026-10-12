import { assert, describe, it } from "@effect/vitest";
import {
  type ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitFailoverSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  chooseFailoverTarget,
  providerQuotaState,
  type FailoverChoice,
} from "./UsageLimitFailoverPolicy.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

const NOW_ISO = "2026-10-13T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const FUTURE = "2026-10-13T15:00:00.000Z";
const LATER_FUTURE = "2026-10-20T00:00:00.000Z";
const PAST = "2026-10-13T11:00:00.000Z";

const id = (value: string) => ProviderInstanceId.make(value);

const model = (slug: string, isDefault?: boolean) => ({
  slug,
  name: slug,
  isCustom: false,
  ...(isDefault === undefined ? {} : { isDefault }),
  capabilities: null,
});

interface ProviderFixture {
  readonly instanceId: string;
  readonly driver?: string;
  readonly enabled?: boolean;
  readonly status?: "ready" | "warning" | "error" | "disabled";
  readonly availability?: "available" | "unavailable";
  readonly models?: ReadonlyArray<ReturnType<typeof model> & { aliases?: ReadonlyArray<string> }>;
  readonly windows?: ReadonlyArray<ServerProviderUsageWindow>;
  readonly usageLimits?: unknown;
}

function makeProvider(fixture: ProviderFixture): ServerProvider {
  const usageLimits =
    fixture.usageLimits !== undefined
      ? fixture.usageLimits
      : fixture.windows !== undefined
        ? { checkedAt: "2026-10-13T11:59:00.000Z", windows: fixture.windows }
        : undefined;
  return decodeServerProvider({
    instanceId: fixture.instanceId,
    driver: fixture.driver ?? "claudeAgent",
    enabled: fixture.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: fixture.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-13T11:59:00.000Z",
    models: fixture.models ?? [model("sonnet", true), model("opus")],
    slashCommands: [],
    skills: [],
    ...(fixture.availability === undefined ? {} : { availability: fixture.availability }),
    ...(usageLimits === undefined ? {} : { usageLimits }),
  });
}

function usageWindow(
  usedPercent: number,
  resetsAt?: string,
  windowId = "five_hour",
): ServerProviderUsageWindow {
  return {
    id: windowId,
    kind: "session",
    label: windowId,
    usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

describe("providerQuotaState", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly provider: ServerProvider | undefined;
    readonly expected: ReturnType<typeof providerQuotaState>;
  }> = [
    { name: "an unknown provider", provider: undefined, expected: { type: "unknown" } },
    {
      name: "a provider with no usage limits",
      provider: makeProvider({ instanceId: "claude-a" }),
      expected: { type: "unknown" },
    },
    {
      name: "usage limits that are unavailable",
      provider: makeProvider({
        instanceId: "claude-a",
        usageLimits: {
          checkedAt: "2026-10-13T11:59:00.000Z",
          windows: [usageWindow(100, FUTURE)],
          unavailable: { reason: "unsupported" },
        },
      }),
      expected: { type: "unknown" },
    },
    {
      name: "usage limits with no windows",
      provider: makeProvider({ instanceId: "claude-a", windows: [] }),
      expected: { type: "unknown" },
    },
    {
      name: "every window below 100",
      provider: makeProvider({
        instanceId: "claude-a",
        windows: [usageWindow(99.9, FUTURE), usageWindow(0, FUTURE, "seven_day")],
      }),
      expected: { type: "available" },
    },
    {
      name: "a full window with a future reset",
      provider: makeProvider({
        instanceId: "claude-a",
        windows: [usageWindow(100, FUTURE), usageWindow(10, LATER_FUTURE, "seven_day")],
      }),
      expected: { type: "exhausted", resetsAt: FUTURE },
    },
    {
      name: "the later reset of two full windows",
      provider: makeProvider({
        instanceId: "claude-a",
        windows: [usageWindow(100, FUTURE), usageWindow(100, LATER_FUTURE, "seven_day")],
      }),
      expected: { type: "exhausted", resetsAt: LATER_FUTURE },
    },
    {
      name: "the later reset of two full windows, listed the other way round",
      provider: makeProvider({
        instanceId: "claude-a",
        windows: [usageWindow(100, LATER_FUTURE, "seven_day"), usageWindow(100, FUTURE)],
      }),
      expected: { type: "exhausted", resetsAt: LATER_FUTURE },
    },
    {
      name: "a full window whose reset has passed",
      provider: makeProvider({ instanceId: "claude-a", windows: [usageWindow(100, PAST)] }),
      expected: { type: "available" },
    },
    {
      name: "a full window with a reset exactly now",
      provider: makeProvider({
        instanceId: "claude-a",
        windows: [usageWindow(100, NOW_ISO)],
      }),
      expected: { type: "available" },
    },
    {
      name: "a passed full window beside a live full window",
      provider: makeProvider({
        instanceId: "claude-a",
        windows: [usageWindow(100, PAST), usageWindow(100, FUTURE, "seven_day")],
      }),
      expected: { type: "exhausted", resetsAt: FUTURE },
    },
    {
      name: "a full window with no reset",
      provider: makeProvider({ instanceId: "claude-a", windows: [usageWindow(100)] }),
      expected: { type: "exhausted" },
    },
    {
      name: "a full window with no reset beside one with a reset",
      provider: makeProvider({
        instanceId: "claude-a",
        windows: [usageWindow(100), usageWindow(100, FUTURE, "seven_day")],
      }),
      expected: { type: "exhausted", resetsAt: FUTURE },
    },
  ];

  it.each(cases)("reports $name", ({ provider, expected }) => {
    assert.deepStrictEqual(providerQuotaState(provider, NOW), expected);
  });

  it("leaves resetsAt off an exhausted state without one rather than setting it undefined", () => {
    const state = providerQuotaState(
      makeProvider({ instanceId: "claude-a", windows: [usageWindow(100)] }),
      NOW,
    );
    assert.isFalse("resetsAt" in state);
  });
});

describe("chooseFailoverTarget", () => {
  const A = id("claude-a");
  const B = id("claude-b");
  const C = id("claude-c");
  const current: ModelSelection = { instanceId: A, model: "sonnet" };

  const choose = (
    overrides: Partial<Parameters<typeof chooseFailoverTarget>[0]> & {
      readonly providers: ReadonlyArray<ServerProvider>;
    },
  ): FailoverChoice =>
    chooseFailoverTarget({
      chain: [{ instanceId: A }, { instanceId: B }, { instanceId: C }],
      failedInstanceId: A,
      attempted: new Set(),
      currentSelection: current,
      nowMs: NOW,
      ...overrides,
    });

  const claude = (instanceId: string, extra: Omit<ProviderFixture, "instanceId"> = {}) =>
    makeProvider({ instanceId, ...extra });

  const targetOf = (choice: FailoverChoice): ModelSelection => {
    assert.strictEqual(choice.type, "target");
    if (choice.type !== "target") throw new Error("expected a target");
    return choice.modelSelection;
  };

  it("reports an empty chain", () => {
    assert.deepStrictEqual(choose({ chain: [], providers: [claude("claude-a")] }), {
      type: "none",
      reason: "empty_chain",
    });
  });

  it("takes the chain exactly as the failover setting stores it", () => {
    const chain: UsageLimitFailoverSettings["chain"] = [
      { instanceId: A },
      { instanceId: B, model: "opus" },
    ];
    const choice = choose({ chain, providers: [claude("claude-a"), claude("claude-b")] });
    assert.deepStrictEqual(targetOf(choice), { instanceId: B, model: "opus" });
  });

  it("walks the chain top-down", () => {
    const choice = choose({
      providers: [claude("claude-a"), claude("claude-b"), claude("claude-c")],
    });
    assert.strictEqual(targetOf(choice).instanceId, B);
  });

  it("follows chain order rather than provider order", () => {
    const choice = choose({
      chain: [{ instanceId: A }, { instanceId: C }, { instanceId: B }],
      providers: [claude("claude-a"), claude("claude-b"), claude("claude-c")],
    });
    assert.strictEqual(targetOf(choice).instanceId, C);
  });

  it("does not pick the failed instance even when it is the only other entry", () => {
    const choice = choose({
      chain: [{ instanceId: A }],
      providers: [claude("claude-a")],
    });
    assert.deepStrictEqual(choice, { type: "none", reason: "no_eligible_account" });
  });

  it("skips the failed instance wherever it sits in the chain", () => {
    const choice = choose({
      chain: [{ instanceId: B }, { instanceId: A }, { instanceId: C }],
      failedInstanceId: B,
      providers: [claude("claude-a"), claude("claude-b"), claude("claude-c")],
    });
    assert.strictEqual(targetOf(choice).instanceId, A);
  });

  it("skips attempted instances", () => {
    const choice = choose({
      attempted: new Set([B]),
      providers: [claude("claude-a"), claude("claude-b"), claude("claude-c")],
    });
    assert.strictEqual(targetOf(choice).instanceId, C);
  });

  it("skips an instance in the chain that no longer exists", () => {
    const choice = choose({ providers: [claude("claude-a"), claude("claude-c")] });
    assert.strictEqual(targetOf(choice).instanceId, C);
  });

  it("skips a disabled instance", () => {
    const choice = choose({
      providers: [claude("claude-a"), claude("claude-b", { enabled: false }), claude("claude-c")],
    });
    assert.strictEqual(targetOf(choice).instanceId, C);
  });

  it("skips an instance whose status is error", () => {
    const choice = choose({
      providers: [claude("claude-a"), claude("claude-b", { status: "error" }), claude("claude-c")],
    });
    assert.strictEqual(targetOf(choice).instanceId, C);
  });

  it("skips an instance whose status is disabled", () => {
    const choice = choose({
      providers: [
        claude("claude-a"),
        claude("claude-b", { status: "disabled" }),
        claude("claude-c"),
      ],
    });
    assert.strictEqual(targetOf(choice).instanceId, C);
  });

  it("skips an unavailable instance", () => {
    const choice = choose({
      providers: [
        claude("claude-a"),
        claude("claude-b", { availability: "unavailable" }),
        claude("claude-c"),
      ],
    });
    assert.strictEqual(targetOf(choice).instanceId, C);
  });

  it("accepts a warning status and an explicitly available instance", () => {
    const choice = choose({
      providers: [
        claude("claude-a"),
        claude("claude-b", { status: "warning", availability: "available" }),
        claude("claude-c"),
      ],
    });
    assert.strictEqual(targetOf(choice).instanceId, B);
  });

  it("skips an exhausted instance", () => {
    const choice = choose({
      providers: [
        claude("claude-a"),
        claude("claude-b", { windows: [usageWindow(100, FUTURE)] }),
        claude("claude-c"),
      ],
    });
    assert.strictEqual(targetOf(choice).instanceId, C);
  });

  it("skips an exhausted instance that reports no reset", () => {
    const choice = choose({
      providers: [
        claude("claude-a"),
        claude("claude-b", { windows: [usageWindow(100)] }),
        claude("claude-c"),
      ],
    });
    assert.strictEqual(targetOf(choice).instanceId, C);
  });

  it("treats a window whose reset has passed as available", () => {
    const choice = choose({
      providers: [
        claude("claude-a"),
        claude("claude-b", { windows: [usageWindow(100, PAST)] }),
        claude("claude-c"),
      ],
    });
    assert.strictEqual(targetOf(choice).instanceId, B);
  });

  it("treats unknown quota as eligible", () => {
    const choice = choose({
      providers: [
        claude("claude-a"),
        claude("claude-b", {
          usageLimits: {
            checkedAt: "2026-10-13T11:59:00.000Z",
            windows: [],
            unavailable: { reason: "probeFailed" },
          },
        }),
        claude("claude-c"),
      ],
    });
    assert.strictEqual(targetOf(choice).instanceId, B);
  });

  it("treats a known available quota as eligible", () => {
    const choice = choose({
      providers: [
        claude("claude-a"),
        claude("claude-b", { windows: [usageWindow(40, FUTURE)] }),
        claude("claude-c"),
      ],
    });
    assert.strictEqual(targetOf(choice).instanceId, B);
  });

  it("reports no eligible account when every candidate is ineligible", () => {
    const choice = choose({
      chain: [{ instanceId: A }, { instanceId: B }, { instanceId: C }, { instanceId: id("gone") }],
      attempted: new Set([B]),
      providers: [claude("claude-a"), claude("claude-b"), claude("claude-c", { enabled: false })],
    });
    assert.deepStrictEqual(choice, { type: "none", reason: "no_eligible_account" });
  });

  it("reports no eligible account when every other account is exhausted", () => {
    const choice = choose({
      providers: [
        claude("claude-a"),
        claude("claude-b", { windows: [usageWindow(100, FUTURE)] }),
        claude("claude-c", { windows: [usageWindow(100)] }),
      ],
    });
    assert.deepStrictEqual(choice, { type: "none", reason: "no_eligible_account" });
  });

  it("reports no eligible account when no provider is known", () => {
    assert.deepStrictEqual(choose({ providers: [] }), {
      type: "none",
      reason: "no_eligible_account",
    });
  });

  describe("model selection", () => {
    const options = [{ id: "effort", value: "high" }] as const;

    it("uses a pinned model and drops the current options", () => {
      const choice = choose({
        chain: [{ instanceId: A }, { instanceId: B, model: "opus" }],
        currentSelection: { ...current, options },
        providers: [claude("claude-a"), claude("claude-b")],
      });
      assert.deepStrictEqual(targetOf(choice), { instanceId: B, model: "opus" });
    });

    it("uses a pinned model even when the account does not list it", () => {
      const choice = choose({
        chain: [{ instanceId: A }, { instanceId: B, model: "pinned-elsewhere" }],
        providers: [claude("claude-a"), claude("claude-b")],
      });
      assert.deepStrictEqual(targetOf(choice), { instanceId: B, model: "pinned-elsewhere" });
    });

    it("keeps the model and options on the same driver when the account has the model", () => {
      const choice = choose({
        currentSelection: { ...current, model: "opus", options },
        providers: [claude("claude-a"), claude("claude-b"), claude("claude-c")],
      });
      assert.deepStrictEqual(targetOf(choice), { instanceId: B, model: "opus", options });
    });

    it("keeps the model without an options key when the current selection has none", () => {
      const choice = choose({
        currentSelection: { ...current, model: "opus" },
        providers: [claude("claude-a"), claude("claude-b")],
      });
      const selection = targetOf(choice);
      assert.deepStrictEqual(selection, { instanceId: B, model: "opus" });
      assert.isFalse("options" in selection);
    });

    it("keeps the model when the account lists it as an alias", () => {
      const choice = choose({
        currentSelection: { ...current, model: "opus-latest", options },
        providers: [
          claude("claude-a"),
          claude("claude-b", {
            models: [model("sonnet", true), { ...model("opus"), aliases: ["opus-latest"] }],
          }),
        ],
      });
      assert.deepStrictEqual(targetOf(choice), {
        instanceId: B,
        model: "opus-latest",
        options,
      });
    });

    it("falls back to the default model, with no options, when the account lacks the model", () => {
      const choice = choose({
        currentSelection: { ...current, model: "opus", options },
        providers: [
          claude("claude-a"),
          claude("claude-b", { models: [model("haiku"), model("sonnet", true)] }),
        ],
      });
      assert.deepStrictEqual(targetOf(choice), { instanceId: B, model: "sonnet" });
    });

    it("falls back to the first model when none is marked default", () => {
      const choice = choose({
        currentSelection: { ...current, model: "opus", options },
        providers: [
          claude("claude-a"),
          claude("claude-b", { models: [model("haiku"), model("sonnet")] }),
        ],
      });
      assert.deepStrictEqual(targetOf(choice), { instanceId: B, model: "haiku" });
    });

    it("uses the target's default model across drivers and drops the options", () => {
      const choice = choose({
        chain: [{ instanceId: A }, { instanceId: id("codex-a") }],
        currentSelection: { ...current, options },
        providers: [
          claude("claude-a"),
          makeProvider({
            instanceId: "codex-a",
            driver: "codex",
            models: [model("gpt-5"), model("gpt-5-codex", true)],
          }),
        ],
      });
      assert.deepStrictEqual(targetOf(choice), {
        instanceId: id("codex-a"),
        model: "gpt-5-codex",
      });
    });

    it("does not carry a same-named model across drivers", () => {
      const choice = choose({
        chain: [{ instanceId: A }, { instanceId: id("codex-a") }],
        currentSelection: { ...current, model: "shared-name", options },
        providers: [
          claude("claude-a", { models: [model("shared-name", true)] }),
          makeProvider({
            instanceId: "codex-a",
            driver: "codex",
            models: [model("shared-name"), model("gpt-5-codex", true)],
          }),
        ],
      });
      assert.deepStrictEqual(targetOf(choice), {
        instanceId: id("codex-a"),
        model: "gpt-5-codex",
      });
    });

    it("falls back to the default when the current instance is no longer known", () => {
      const choice = choose({
        currentSelection: { ...current, model: "opus", options },
        providers: [claude("claude-b", { models: [model("sonnet", true), model("opus")] })],
      });
      assert.deepStrictEqual(targetOf(choice), { instanceId: B, model: "sonnet" });
    });

    it("skips a provider with no models", () => {
      const choice = choose({
        providers: [claude("claude-a"), claude("claude-b", { models: [] }), claude("claude-c")],
      });
      assert.strictEqual(targetOf(choice).instanceId, C);
    });

    it("reports no eligible account when the only candidate has no models", () => {
      const choice = choose({
        chain: [{ instanceId: A }, { instanceId: B }],
        providers: [claude("claude-a"), claude("claude-b", { models: [] })],
      });
      assert.deepStrictEqual(choice, { type: "none", reason: "no_eligible_account" });
    });

    it("honours a pinned model on an account that lists no models", () => {
      // The pin is the first rule and never reads the model list, so only an
      // entry that needs the list (rules 2 and 3) is skipped for lacking one.
      const choice = choose({
        chain: [{ instanceId: A }, { instanceId: B, model: "opus" }],
        providers: [claude("claude-a"), claude("claude-b", { models: [] })],
      });
      assert.deepStrictEqual(targetOf(choice), { instanceId: B, model: "opus" });
    });
  });
});
