import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveClaudeHomeLayout } from "./ClaudeHomeLayout.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * The home fields an instance's paths derive from. `shadowHomePath` is
 * optional so callers holding only a `homePath` keep working; absent or empty
 * means direct mode.
 */
export type ClaudeHomeConfig = Pick<ClaudeSettings, "homePath"> &
  Partial<Pick<ClaudeSettings, "shadowHomePath">>;

const resolveLayout = (config: ClaudeHomeConfig, environment?: NodeJS.ProcessEnv) =>
  resolveClaudeHomeLayout(
    { homePath: config.homePath, shadowHomePath: config.shadowHomePath ?? "" },
    environment,
  );

/**
 * Resolve the shared Claude home: the instance's `homePath`, then an
 * inherited `CLAUDE_CONFIG_DIR`, then Claude's default `~/.claude`. Session
 * history and the continuation group live here. Empty must not fall back to
 * bare `$HOME` — that leftover from the old HOME override produced a
 * different continuation group than an explicit `~/.claude`.
 */
export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  return (yield* resolveLayout({ homePath: config.homePath }, environment)).sharedHomePath;
});

/**
 * Resolve the directory the spawned CLI uses as `CLAUDE_CONFIG_DIR`: the
 * account's shadow home when one is set, otherwise the shared home. Login,
 * `.claude.json` and everything else bound to the account are read here.
 */
export const resolveClaudeAccountHomePath = Effect.fn("resolveClaudeAccountHomePath")(function* (
  config: ClaudeHomeConfig,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  return (yield* resolveLayout(config, environment)).effectiveHomePath;
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: ClaudeHomeConfig,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  const shadowHomePath = config.shadowHomePath?.trim() ?? "";
  if (homePath.length === 0 && shadowHomePath.length === 0) return resolvedBaseEnv;
  const accountHomePath = yield* resolveClaudeAccountHomePath(config, resolvedBaseEnv);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: accountHomePath,
  };
});

/** Accounts on one shared home resume each other's sessions natively. */
export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: ClaudeHomeConfig,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    return (yield* resolveLayout(config, environment)).continuationKey;
  },
);

/** Keyed on the account home: auth metadata differs per account. */
export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath"> & ClaudeHomeConfig,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const accountHomePath = yield* resolveClaudeAccountHomePath(config, environment);
    return `${config.binaryPath}\0${accountHomePath}\0${cwd ?? ""}`;
  },
);

const CLAUDE_SHARED_CREDENTIAL_KEYS = [
  "apiKeyHelper",
  "forceLoginOrgUUID",
  "env.ANTHROPIC_API_KEY",
  "env.ANTHROPIC_AUTH_TOKEN",
] as const;
type ClaudeSharedCredentialKey = (typeof CLAUDE_SHARED_CREDENTIAL_KEYS)[number];

const decodeSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSet = (record: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.hasOwn(record, key) && record[key] !== null && record[key] !== undefined;

/**
 * The credential settings a shared `settings.json` sets. Every account linked
 * to that shared home reads the same file, so any of these makes them all
 * authenticate the same way. Only key names leave this function: the values
 * are never returned, logged or put in an error. An unreadable or malformed
 * file sets nothing.
 */
export const claudeSharedSettingsCredentialKeys = Effect.fn("claudeSharedSettingsCredentialKeys")(
  function* (
    sharedHomePath: string,
  ): Effect.fn.Return<
    ReadonlyArray<ClaudeSharedCredentialKey>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settingsPath = path.join(sharedHomePath, "settings.json");
    const contents = yield* fileSystem.readFileString(settingsPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(undefined)
            : Effect.logDebug("Could not read the shared Claude settings.json.", {
                settingsPath,
                reason: cause.reason._tag,
              }).pipe(Effect.as(undefined)),
      }),
    );
    if (contents === undefined) return [];
    const settings = yield* decodeSettingsJson(contents).pipe(
      Effect.catchTags({
        SchemaError: () =>
          Effect.logDebug("The shared Claude settings.json is not valid JSON.", {
            settingsPath,
          }).pipe(Effect.as(undefined)),
      }),
    );
    if (!isRecord(settings)) return [];
    const env = isRecord(settings.env) ? settings.env : {};
    return CLAUDE_SHARED_CREDENTIAL_KEYS.filter((key) =>
      key.startsWith("env.") ? isSet(env, key.slice("env.".length)) : isSet(settings, key),
    );
  },
);

/**
 * The provider-status warning for an account whose shared `settings.json`
 * overrides its own login. Undefined in direct mode, where the settings are
 * the instance's own.
 */
export const claudeSharedCredentialWarning = Effect.fn("claudeSharedCredentialWarning")(function* (
  config: Pick<ClaudeSettings, "homePath" | "shadowHomePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const layout = yield* resolveClaudeHomeLayout(config, environment);
  if (layout.mode !== "authOverlay") return undefined;
  const keys = yield* claudeSharedSettingsCredentialKeys(layout.sharedHomePath);
  if (keys.length === 0) return undefined;
  return `Shared settings.json sets ${keys.join(", ")}, so every account using this shared home authenticates with it.`;
});

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
