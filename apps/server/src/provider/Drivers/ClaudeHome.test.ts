import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeSharedCredentialWarning,
  claudeSharedSettingsCredentialKeys,
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeAccountHomePath,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

const writeSharedSettings = Effect.fn("ClaudeHome.test.writeSharedSettings")(function* (
  contents: string | undefined,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sharedHomePath = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-claude-shared-settings-",
  });
  if (contents !== undefined) {
    yield* fileSystem.writeFileString(path.join(sharedHomePath, "settings.json"), contents);
  }
  return sharedHomePath;
});

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);

        const key = `claude:home:${resolved}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("runs an account in its shadow home but continues on the shared home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const shared = path.resolve("/synthetic/claude-shared");
        const shadow = path.resolve("/synthetic/claude-accounts/work");
        const config = { binaryPath: "claude", homePath: shared, shadowHomePath: shadow };

        expect((yield* makeClaudeEnvironment(config, {})).CLAUDE_CONFIG_DIR).toBe(shadow);
        expect(yield* makeClaudeContinuationGroupKey(config)).toBe(`claude:home:${shared}`);
        expect(yield* makeClaudeCapabilitiesCacheKey(config)).toBe(`claude\0${shadow}\0`);
        expect(yield* resolveClaudeAccountHomePath(config)).toBe(shadow);
        expect(yield* resolveClaudeHomePath(config)).toBe(shared);
      }),
    );

    it.effect("exports the shadow home even when the shared home is inherited", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/synthetic/claude-inherited");
        const shadow = path.resolve("/synthetic/claude-accounts/personal");
        const config = { homePath: "", shadowHomePath: shadow };
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect((yield* makeClaudeEnvironment(config, environment)).CLAUDE_CONFIG_DIR).toBe(shadow);
        expect(yield* makeClaudeContinuationGroupKey(config, environment)).toBe(
          `claude:home:${inherited}`,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  describe("shared settings credentials", () => {
    it.effect("names the credential keys a shared settings.json sets", () =>
      Effect.gen(function* () {
        const sharedHomePath = yield* writeSharedSettings(
          JSON.stringify({ apiKeyHelper: "x", env: { ANTHROPIC_API_KEY: "y", OTHER: "z" } }),
        );
        expect(yield* claudeSharedSettingsCredentialKeys(sharedHomePath)).toEqual([
          "apiKeyHelper",
          "env.ANTHROPIC_API_KEY",
        ]);
      }),
    );

    it.effect("finds every credential key it checks for", () =>
      Effect.gen(function* () {
        const sharedHomePath = yield* writeSharedSettings(
          JSON.stringify({
            forceLoginOrgUUID: "org",
            env: { ANTHROPIC_AUTH_TOKEN: "token" },
          }),
        );
        expect(yield* claudeSharedSettingsCredentialKeys(sharedHomePath)).toEqual([
          "forceLoginOrgUUID",
          "env.ANTHROPIC_AUTH_TOKEN",
        ]);
      }),
    );

    it.effect("reads malformed or missing settings as setting nothing", () =>
      Effect.gen(function* () {
        const malformed = yield* writeSharedSettings('{"apiKeyHelper": "x",');
        expect(yield* claudeSharedSettingsCredentialKeys(malformed)).toEqual([]);
        const missing = yield* writeSharedSettings(undefined);
        expect(yield* claudeSharedSettingsCredentialKeys(missing)).toEqual([]);
      }),
    );

    it.effect("warns an overlay account by key name, never by value", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const helperValue = "helper-command-value-7f3a";
        const keyValue = "sk-ant-secret-value-91c2";
        const sharedHomePath = yield* writeSharedSettings(
          JSON.stringify({ apiKeyHelper: helperValue, env: { ANTHROPIC_API_KEY: keyValue } }),
        );
        const shadowHomePath = path.join(path.dirname(sharedHomePath), "t3-claude-shadow-unused");

        const warning = yield* claudeSharedCredentialWarning({
          homePath: sharedHomePath,
          shadowHomePath,
        });
        expect(warning).toBe(
          "Shared settings.json sets apiKeyHelper, env.ANTHROPIC_API_KEY, so every account using this shared home authenticates with it.",
        );
        expect(warning).not.toContain(helperValue);
        expect(warning).not.toContain(keyValue);
      }),
    );

    it.effect("does not warn a direct-mode instance about its own settings", () =>
      Effect.gen(function* () {
        const sharedHomePath = yield* writeSharedSettings(JSON.stringify({ apiKeyHelper: "x" }));
        expect(
          yield* claudeSharedCredentialWarning({ homePath: sharedHomePath, shadowHomePath: "" }),
        ).toBeUndefined();
      }),
    );
  });
});
