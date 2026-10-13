import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addableInstances,
  addEntry,
  moveEntry,
  removeEntry,
  setEntryModel,
  type ChainEntry,
} from "./usageLimitFailoverChain";

const work = ProviderInstanceId.make("claudeAgent");
const personal = ProviderInstanceId.make("claude_personal");
const codex = ProviderInstanceId.make("codex");

const chain: ReadonlyArray<ChainEntry> = [
  { instanceId: work },
  { instanceId: personal, model: "claude-sonnet-4-5" },
  { instanceId: codex },
];

describe("moveEntry", () => {
  it("swaps an entry with its neighbour", () => {
    expect(moveEntry(chain, 1, -1).map((entry) => entry.instanceId)).toEqual([
      personal,
      work,
      codex,
    ]);
    expect(moveEntry(chain, 1, 1).map((entry) => entry.instanceId)).toEqual([
      work,
      codex,
      personal,
    ]);
  });

  it("keeps a pinned model with the entry that moved", () => {
    expect(moveEntry(chain, 1, -1)[0]).toEqual({
      instanceId: personal,
      model: "claude-sonnet-4-5",
    });
  });

  it("is a no-op at the edges", () => {
    expect(moveEntry(chain, 0, -1)).toEqual(chain);
    expect(moveEntry(chain, 2, 1)).toEqual(chain);
  });

  it("is a no-op for an index outside the chain", () => {
    expect(moveEntry(chain, -1, 1)).toEqual(chain);
    expect(moveEntry(chain, 3, -1)).toEqual(chain);
  });

  it("never mutates the chain it was given", () => {
    const before = structuredClone(chain);
    const moved = moveEntry(chain, 0, 1);
    expect(chain).toEqual(before);
    expect(moved).not.toBe(chain);
  });
});

describe("removeEntry", () => {
  it("drops the entry at the index and keeps the order of the rest", () => {
    expect(removeEntry(chain, 1).map((entry) => entry.instanceId)).toEqual([work, codex]);
  });

  it("is a no-op for an index outside the chain", () => {
    expect(removeEntry(chain, 3)).toEqual(chain);
    expect(removeEntry(chain, -1)).toEqual(chain);
  });
});

describe("addEntry", () => {
  it("appends the instance with no pinned model", () => {
    const added = addEntry([{ instanceId: work }], personal);
    expect(added).toEqual([{ instanceId: work }, { instanceId: personal }]);
    expect(Object.keys(added[1]!)).toEqual(["instanceId"]);
  });

  it("refuses a duplicate", () => {
    expect(addEntry(chain, personal)).toEqual(chain);
  });
});

describe("setEntryModel", () => {
  it("pins a model on one entry only", () => {
    expect(setEntryModel(chain, 0, "claude-opus-4-1")).toEqual([
      { instanceId: work, model: "claude-opus-4-1" },
      chain[1],
      chain[2],
    ]);
  });

  it("drops the model key when given undefined, so the entry keeps the thread's model", () => {
    const cleared = setEntryModel(chain, 1, undefined);
    expect(cleared[1]).toEqual({ instanceId: personal });
    expect("model" in cleared[1]!).toBe(false);
  });

  it("is a no-op for an index outside the chain", () => {
    expect(setEntryModel(chain, 5, "anything")).toEqual(chain);
  });
});

describe("addableInstances", () => {
  const providers = [
    { instanceId: work, enabled: true },
    { instanceId: personal, enabled: true },
    { instanceId: codex, enabled: false },
  ];

  it("lists enabled instances that are not already in the chain", () => {
    expect(addableInstances(providers, [{ instanceId: work }])).toEqual([
      { instanceId: personal, enabled: true },
    ]);
  });

  it("excludes disabled instances", () => {
    expect(addableInstances(providers, []).map((provider) => provider.instanceId)).toEqual([
      work,
      personal,
    ]);
  });

  it("is empty when every enabled instance is already chained", () => {
    expect(addableInstances(providers, [{ instanceId: work }, { instanceId: personal }])).toEqual(
      [],
    );
  });
});
