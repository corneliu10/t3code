import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

/**
 * What the published usage snapshot says about an account's quota.
 *
 * `unknown` covers an account that reports no windows at all (no snapshot, an
 * API-key or Bedrock account, a failed probe). It is not a reason to avoid the
 * account, only a lack of evidence either way.
 */
export type ProviderQuotaState =
  | { readonly type: "available" }
  | { readonly type: "exhausted"; readonly resetsAt?: string }
  | { readonly type: "unknown" };

/**
 * An account is exhausted when any window is full and either has no reset time
 * or resets in the future. The reported `resetsAt` is the latest of those, the
 * moment every full window has cleared.
 */
export function providerQuotaState(
  provider: ServerProvider | undefined,
  nowMs: number,
): ProviderQuotaState {
  const limits = provider?.usageLimits;
  if (limits === undefined || limits.unavailable !== undefined || limits.windows.length === 0) {
    return { type: "unknown" };
  }
  let exhausted = false;
  let resetsAt: string | undefined;
  for (const window of limits.windows) {
    if (window.usedPercent < 100) continue;
    if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= nowMs) continue;
    exhausted = true;
    if (
      window.resetsAt !== undefined &&
      (resetsAt === undefined || Date.parse(window.resetsAt) > Date.parse(resetsAt))
    ) {
      resetsAt = window.resetsAt;
    }
  }
  if (!exhausted) return { type: "available" };
  return resetsAt === undefined ? { type: "exhausted" } : { type: "exhausted", resetsAt };
}

export type FailoverChoice =
  | { readonly type: "target"; readonly modelSelection: ModelSelection }
  | { readonly type: "none"; readonly reason: "empty_chain" | "no_eligible_account" };

/**
 * Picks the account a thread continues on after a usage limit. The chain is
 * walked top-down, because its order is the user's preference. An entry is
 * skipped when it is the failed account, was already attempted in this
 * episode, names an instance that is missing, disabled or unavailable, has no
 * model to run, or is out of quota. Unknown quota stays eligible.
 *
 * Pick-at-start reuses this with the exhausted selected instance as
 * `failedInstanceId` and nothing attempted.
 */
export function chooseFailoverTarget(input: {
  readonly chain: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string;
  }>;
  readonly failedInstanceId: ProviderInstanceId;
  readonly attempted: ReadonlySet<ProviderInstanceId>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentSelection: ModelSelection;
  readonly nowMs: number;
}): FailoverChoice {
  if (input.chain.length === 0) return { type: "none", reason: "empty_chain" };
  const byId = new Map(input.providers.map((provider) => [provider.instanceId, provider]));
  const currentDriver = byId.get(input.currentSelection.instanceId)?.driver;
  for (const entry of input.chain) {
    if (entry.instanceId === input.failedInstanceId || input.attempted.has(entry.instanceId)) {
      continue;
    }
    const provider = byId.get(entry.instanceId);
    if (!isUsableProvider(provider)) continue;
    if (providerQuotaState(provider, input.nowMs).type === "exhausted") continue;
    const modelSelection = failoverModelSelection(
      entry,
      provider,
      input.currentSelection,
      currentDriver,
    );
    if (modelSelection !== null) return { type: "target", modelSelection };
  }
  return { type: "none", reason: "no_eligible_account" };
}

function isUsableProvider(provider: ServerProvider | undefined): provider is ServerProvider {
  return (
    provider !== undefined &&
    provider.enabled &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.availability !== "unavailable"
  );
}

/**
 * The model a continued run uses on `provider`, in order:
 * 1. the entry's pinned model, with no options;
 * 2. the failing run's model and options, when the account runs the same
 *    driver and lists that model (by slug or alias);
 * 3. the account's default model, else its first, with no options.
 * An account with no models cannot run anything, so it yields `null` and the
 * entry is skipped.
 */
function failoverModelSelection(
  entry: { readonly instanceId: ProviderInstanceId; readonly model?: string },
  provider: ServerProvider,
  current: ModelSelection,
  currentDriver: ProviderDriverKind | undefined,
): ModelSelection | null {
  if (entry.model !== undefined) return { instanceId: entry.instanceId, model: entry.model };
  if (
    provider.driver === currentDriver &&
    provider.models.some(
      (candidate) => candidate.slug === current.model || candidate.aliases?.includes(current.model),
    )
  ) {
    return {
      instanceId: entry.instanceId,
      model: current.model,
      ...(current.options ? { options: current.options } : {}),
    };
  }
  const fallback =
    provider.models.find((candidate) => candidate.isDefault === true) ?? provider.models[0];
  return fallback === undefined ? null : { instanceId: entry.instanceId, model: fallback.slug };
}
