import type { ProviderInstanceId } from "@t3tools/contracts";

/**
 * One account in the usage-limit failover chain. `model` pins the model a
 * continued run uses on that account; absent, the run keeps the thread's model.
 */
export type ChainEntry = { readonly instanceId: ProviderInstanceId; readonly model?: string };

/**
 * The list operations behind the chain editor. Each returns a new array and
 * leaves its input alone; an index or move that does not apply returns an
 * unchanged copy, so callers can pass a click straight through.
 */

/** Move the entry at `index` one place up (-1) or down (1). A no-op at either edge. */
export function moveEntry(
  chain: ReadonlyArray<ChainEntry>,
  index: number,
  delta: -1 | 1,
): ChainEntry[] {
  const next = [...chain];
  const target = index + delta;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function removeEntry(chain: ReadonlyArray<ChainEntry>, index: number): ChainEntry[] {
  return chain.filter((_, position) => position !== index);
}

/** Append an account that is not chained yet. An account already in the chain is not added twice. */
export function addEntry(
  chain: ReadonlyArray<ChainEntry>,
  instanceId: ProviderInstanceId,
): ChainEntry[] {
  return chain.some((entry) => entry.instanceId === instanceId)
    ? [...chain]
    : [...chain, { instanceId }];
}

/** Pin `model` on the entry at `index`, or with `undefined` drop the key so it keeps the thread's model. */
export function setEntryModel(
  chain: ReadonlyArray<ChainEntry>,
  index: number,
  model: string | undefined,
): ChainEntry[] {
  return chain.map((entry, position) => {
    if (position !== index) return entry;
    return model === undefined ? { instanceId: entry.instanceId } : { ...entry, model };
  });
}

/** The accounts the "Add account" picker offers: enabled and not already in the chain. */
export function addableInstances<T extends { instanceId: ProviderInstanceId; enabled: boolean }>(
  providers: ReadonlyArray<T>,
  chain: ReadonlyArray<ChainEntry>,
): T[] {
  const chained = new Set(chain.map((entry) => entry.instanceId));
  return providers.filter((provider) => provider.enabled && !chained.has(provider.instanceId));
}
