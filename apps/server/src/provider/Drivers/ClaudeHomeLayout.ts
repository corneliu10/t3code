import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Where one Claude instance keeps its state. In `authOverlay` mode the CLI
 * runs with `CLAUDE_CONFIG_DIR` set to a private shadow home (its own login and
 * `.claude.json`) whose session and setup entries are links into the shared
 * home, so every account on that shared home resumes the same sessions.
 */
export interface ClaudeHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly continuationKey: string;
}

// Only these entries are shared. Claude often adds account- and org-bound
// files, and an allowlist means a new one is never shared by accident.
export const CLAUDE_SHARED_DIRECTORIES: readonly string[] = [
  "projects",
  "file-history",
  "tasks",
  "todos",
  "plans",
  "session-env",
  "shell-snapshots",
  "paste-cache",
  "agents",
  "commands",
  "skills",
  "plugins",
];
/** Created empty in the shared home when missing, then linked. */
export const CLAUDE_SHARED_CREATED_FILES: readonly string[] = ["history.jsonl"];
/** Linked only when they exist in the shared home. */
export const CLAUDE_SHARED_OPTIONAL_FILES: readonly string[] = ["settings.json", "CLAUDE.md"];

/**
 * The instance's `homePath`, then an inherited `CLAUDE_CONFIG_DIR`, then
 * Claude's default `~/.claude`. Inherited env vars are not shell-expanded, so
 * a literal `~` there stays literal.
 */
function resolveSharedHomePath(
  path: Path.Path,
  home: string,
  homePath: string,
  environment: NodeJS.ProcessEnv | undefined,
): string {
  const configured = homePath.trim();
  if (configured.length > 0) {
    return path.resolve(expandHomePath(configured, home));
  }
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
}

export const resolveClaudeHomeLayout = Effect.fn("resolveClaudeHomeLayout")(function* (
  config: Pick<ClaudeSettings, "homePath" | "shadowHomePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ClaudeHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const sharedHomePath = resolveSharedHomePath(path, home, config.homePath, environment);
  const continuationKey = `claude:home:${sharedHomePath}`;
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return { mode: "direct", sharedHomePath, effectiveHomePath: sharedHomePath, continuationKey };
  }
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath: path.resolve(expandHomePath(shadowHomePath, home)),
    continuationKey,
  };
});

const ClaudeShadowHomeContext = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class ClaudeShadowHomeFileSystemError extends Schema.TaggedError<ClaudeShadowHomeFileSystemError>()(
  "ClaudeShadowHomeFileSystemError",
  {
    ...ClaudeShadowHomeContext,
    operation: Schema.Literals([
      "exists",
      "makeDirectory",
      "readDirectory",
      "readLink",
      "realPath",
      "remove",
      "stat",
      "symlink",
      "writeFile",
    ]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Claude shadow home filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class ClaudeShadowHomePathConflictError extends Schema.TaggedError<ClaudeShadowHomePathConflictError>()(
  "ClaudeShadowHomePathConflictError",
  {
    ...ClaudeShadowHomeContext,
    /** Set when only the real paths (after symlinks and letter case) collide. */
    resolvedSharedHomePath: Schema.optional(Schema.String),
    resolvedEffectiveHomePath: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const resolved =
      this.resolvedSharedHomePath === undefined || this.resolvedEffectiveHomePath === undefined
        ? ""
        : ` They resolve to '${this.resolvedEffectiveHomePath}' and '${this.resolvedSharedHomePath}'.`;
    return `Claude shadow home path '${this.effectiveHomePath}' and shared home path '${this.sharedHomePath}' must be separate directories, neither inside the other.${resolved}`;
  }
}

/**
 * How a conflicting entry is folded into the shared home: a directory's
 * contents move, `history.jsonl` is appended, and a setup file is one or the
 * other.
 */
const ClaudeShadowHomeEntryKind = Schema.Literals(["directory", "appendFile", "chooseFile"]);
type ClaudeShadowHomeEntryKind = typeof ClaudeShadowHomeEntryKind.Type;

const ClaudeShadowHomeConflictingEntry = Schema.Struct({
  entryName: Schema.String,
  linkPath: Schema.String,
  targetPath: Schema.String,
  kind: ClaudeShadowHomeEntryKind,
});
type ClaudeShadowHomeConflictingEntry = typeof ClaudeShadowHomeConflictingEntry.Type;

function conflictInstruction(entry: ClaudeShadowHomeConflictingEntry): string {
  const { linkPath, targetPath } = entry;
  switch (entry.kind) {
    case "directory":
      return `Move the contents of '${linkPath}' into '${targetPath}', then delete '${linkPath}'.`;
    case "appendFile":
      return `Append '${linkPath}' to '${targetPath}', then delete '${linkPath}'.`;
    case "chooseFile":
      return `Keep one of '${linkPath}' and '${targetPath}' as '${targetPath}' (merge them by hand if needed), then delete '${linkPath}'.`;
  }
}

export class ClaudeShadowHomeEntryConflictError extends Schema.TaggedError<ClaudeShadowHomeEntryConflictError>()(
  "ClaudeShadowHomeEntryConflictError",
  {
    ...ClaudeShadowHomeContext,
    /** Every allowlisted entry in the way, in allowlist order. */
    entries: Schema.Array(ClaudeShadowHomeConflictingEntry),
  },
) {
  override get message(): string {
    const count =
      this.entries.length === 1
        ? "1 already exists as a real file or non-empty directory."
        : `${this.entries.length} already exist as real files or non-empty directories.`;
    return [
      `Cannot link the Claude shadow home's shared entries: ${count}`,
      ...this.entries.map(conflictInstruction),
      "Then restart T3 Code.",
    ].join(" ");
  }
}

export const ClaudeShadowHomeError = Schema.Union([
  ClaudeShadowHomeFileSystemError,
  ClaudeShadowHomePathConflictError,
  ClaudeShadowHomeEntryConflictError,
]);
export type ClaudeShadowHomeError = typeof ClaudeShadowHomeError.Type;

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

/** True when `child` is `parent` or lies below it, compared on resolved paths. */
function isSameOrInside(path: Path.Path, parent: string, child: string): boolean {
  if (parent === child) return true;
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(prefix);
}

interface EntryInput {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}

// `readLink` never follows the entry, so a link is judged by itself, never by
// what it points at.
const readLinkState = Effect.fn("ClaudeHomeLayout.readLinkState")(function* (
  input: EntryInput & { readonly linkPath: string },
): Effect.fn.Return<LinkState, ClaudeShadowHomeError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed<LinkState>({ _tag: "Missing" });
        }
        if (isNotSymlinkError(cause)) {
          return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        }
        return new ClaudeShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

/** Whether a real (non-symlink) entry is a directory with nothing in it. */
const isEmptyRealDirectory = Effect.fn("ClaudeHomeLayout.isEmptyRealDirectory")(function* (
  input: EntryInput & { readonly linkPath: string },
): Effect.fn.Return<boolean, ClaudeShadowHomeError> {
  const fail = (operation: "stat" | "readDirectory", cause: PlatformError.PlatformError) =>
    new ClaudeShadowHomeFileSystemError({
      sharedHomePath: input.sharedHomePath,
      effectiveHomePath: input.effectiveHomePath,
      operation,
      path: input.linkPath,
      entryName: input.entryName,
      cause,
    });
  const info = yield* input.fileSystem
    .stat(input.linkPath)
    .pipe(Effect.catchTags({ PlatformError: (cause) => fail("stat", cause) }));
  if (info.type !== "Directory") return false;
  const entries = yield* input.fileSystem
    .readDirectory(input.linkPath)
    .pipe(Effect.catchTags({ PlatformError: (cause) => fail("readDirectory", cause) }));
  return entries.length === 0;
});

/** What one allowlisted entry needs, decided before anything is changed. */
type EntryPlan =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "Create" }
  | { readonly _tag: "ReplaceEmptyDirectory" }
  | { readonly _tag: "Relink" }
  | { readonly _tag: "Conflict"; readonly entry: ClaudeShadowHomeConflictingEntry };

interface PlannedEntry extends EntryInput {
  readonly linkPath: string;
  readonly targetPath: string;
  readonly plan: EntryPlan;
}

const planEntry = Effect.fn("ClaudeHomeLayout.planEntry")(function* (
  input: EntryInput & { readonly kind: ClaudeShadowHomeEntryKind },
): Effect.fn.Return<PlannedEntry, ClaudeShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const targetPath = path.join(input.sharedHomePath, input.entryName);
  const linkPath = path.join(input.effectiveHomePath, input.entryName);
  const planned = (plan: EntryPlan): PlannedEntry => ({ ...input, linkPath, targetPath, plan });
  const state = yield* readLinkState({ ...input, linkPath });

  switch (state._tag) {
    case "Missing":
      return planned({ _tag: "Create" });
    case "NotSymlink":
      // The CLI creates empty `plugins/` and `skills/` on a fresh home. Those
      // hold nothing, so they give way to the link; anything with data does not.
      return (yield* isEmptyRealDirectory({ ...input, linkPath }))
        ? planned({ _tag: "ReplaceEmptyDirectory" })
        : planned({
            _tag: "Conflict",
            entry: { entryName: input.entryName, linkPath, targetPath, kind: input.kind },
          });
    case "Symlink":
      return path.resolve(path.dirname(linkPath), state.target) === targetPath
        ? planned({ _tag: "Keep" })
        : planned({ _tag: "Relink" });
  }
});

const applyEntryPlan = Effect.fn("ClaudeHomeLayout.applyEntryPlan")(function* (
  entry: PlannedEntry,
): Effect.fn.Return<void, ClaudeShadowHomeError> {
  const removeExisting = (options?: { readonly recursive: boolean }) =>
    entry.fileSystem.remove(entry.linkPath, options).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new ClaudeShadowHomeFileSystemError({
            sharedHomePath: entry.sharedHomePath,
            effectiveHomePath: entry.effectiveHomePath,
            operation: "remove",
            path: entry.linkPath,
            entryName: entry.entryName,
            cause,
          }),
      }),
    );
  const createLink = entry.fileSystem.symlink(entry.targetPath, entry.linkPath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new ClaudeShadowHomeFileSystemError({
          sharedHomePath: entry.sharedHomePath,
          effectiveHomePath: entry.effectiveHomePath,
          operation: "symlink",
          path: entry.linkPath,
          targetPath: entry.targetPath,
          entryName: entry.entryName,
          cause,
        }),
    }),
  );

  switch (entry.plan._tag) {
    case "Keep":
    case "Conflict":
      return;
    case "Create":
      return yield* createLink;
    case "ReplaceEmptyDirectory":
      // Node's `rm` refuses any directory without `recursive`; it was empty a moment ago.
      yield* removeExisting({ recursive: true });
      return yield* createLink;
    case "Relink":
      yield* removeExisting();
      return yield* createLink;
  }
});

/** Same directory by device and inode, which sees through letter case. */
function isSameFile(left: FileSystem.File.Info, right: FileSystem.File.Info): boolean {
  return (
    left.dev === right.dev &&
    Option.isSome(left.ino) &&
    Option.isSome(right.ino) &&
    left.ino.value === right.ino.value
  );
}

/**
 * Link the shared session and setup entries into the shadow home. A no-op in
 * direct mode. Only allowlisted entries are touched; data in the shadow is
 * never moved, merged or deleted. Every entry is checked before any is
 * changed, so a conflict leaves the shadow home exactly as it was.
 */
export const materializeClaudeShadowHome = Effect.fn("materializeClaudeShadowHome")(function* (
  layout: ClaudeHomeLayout,
): Effect.fn.Return<void, ClaudeShadowHomeError, FileSystem.FileSystem | Path.Path> {
  if (layout.mode !== "authOverlay") return;
  const { sharedHomePath, effectiveHomePath } = layout;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const isNested = (left: string, right: string) =>
    isSameOrInside(path, left, right) || isSameOrInside(path, right, left);
  if (isNested(sharedHomePath, effectiveHomePath)) {
    return yield* new ClaudeShadowHomePathConflictError({ sharedHomePath, effectiveHomePath });
  }

  const fileSystemError = (
    operation: "exists" | "makeDirectory" | "realPath" | "stat" | "writeFile",
    errorPath: string,
    cause: PlatformError.PlatformError,
  ) =>
    new ClaudeShadowHomeFileSystemError({
      sharedHomePath,
      effectiveHomePath,
      operation,
      path: errorPath,
      cause,
    });
  const sharedExists = (entryName: string) => {
    const entryPath = path.join(sharedHomePath, entryName);
    return fileSystem
      .exists(entryPath)
      .pipe(
        Effect.catchTags({ PlatformError: (cause) => fileSystemError("exists", entryPath, cause) }),
      );
  };
  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) => fileSystemError("makeDirectory", directoryPath, cause),
      }),
    );
  const realPath = (directoryPath: string) =>
    fileSystem.realPath(directoryPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) => fileSystemError("realPath", directoryPath, cause),
      }),
    );
  const stat = (filePath: string) =>
    fileSystem
      .stat(filePath)
      .pipe(
        Effect.catchTags({ PlatformError: (cause) => fileSystemError("stat", filePath, cause) }),
      );
  /** Whether `child`, or any directory above it, is `parent` itself. */
  const isInsideByIdentity = Effect.fnUntraced(function* (parent: string, child: string) {
    const parentInfo = yield* stat(parent);
    let current = child;
    while (true) {
      if (isSameFile(parentInfo, yield* stat(current))) return true;
      const above = path.dirname(current);
      if (above === current) return false;
      current = above;
    }
  });

  yield* Effect.all([makeDirectory(sharedHomePath), makeDirectory(effectiveHomePath)], {
    concurrency: "unbounded",
  });

  // The textual check above misses a symlinked path and a letter-case variant
  // on a case-insensitive disk. Either would make each shared entry a link to
  // itself, so the real directories are compared before anything is linked.
  const [resolvedSharedHomePath, resolvedEffectiveHomePath] = yield* Effect.all([
    realPath(sharedHomePath),
    realPath(effectiveHomePath),
  ]);
  if (
    isNested(resolvedSharedHomePath, resolvedEffectiveHomePath) ||
    (yield* isInsideByIdentity(resolvedSharedHomePath, resolvedEffectiveHomePath)) ||
    (yield* isInsideByIdentity(resolvedEffectiveHomePath, resolvedSharedHomePath))
  ) {
    return yield* new ClaudeShadowHomePathConflictError({
      sharedHomePath,
      effectiveHomePath,
      resolvedSharedHomePath,
      resolvedEffectiveHomePath,
    });
  }

  yield* Effect.forEach(
    CLAUDE_SHARED_DIRECTORIES,
    (directory) => makeDirectory(path.join(sharedHomePath, directory)),
    { concurrency: "unbounded", discard: true },
  );

  yield* Effect.forEach(
    CLAUDE_SHARED_CREATED_FILES,
    Effect.fnUntraced(function* (entryName) {
      if (yield* sharedExists(entryName)) return;
      const filePath = path.join(sharedHomePath, entryName);
      // `wx` fails rather than truncates if another process created it meanwhile.
      yield* fileSystem.writeFileString(filePath, "", { flag: "wx" }).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "AlreadyExists"
              ? Effect.void
              : fileSystemError("writeFile", filePath, cause),
        }),
      );
    }),
    { discard: true },
  );

  const optionalFiles = yield* Effect.filter(CLAUDE_SHARED_OPTIONAL_FILES, sharedExists);
  const entries: ReadonlyArray<readonly [string, ClaudeShadowHomeEntryKind]> = [
    ...CLAUDE_SHARED_DIRECTORIES.map((name) => [name, "directory"] as const),
    ...CLAUDE_SHARED_CREATED_FILES.map((name) => [name, "appendFile"] as const),
    ...optionalFiles.map((name) => [name, "chooseFile"] as const),
  ];

  const plans = yield* Effect.forEach(entries, ([entryName, kind]) =>
    planEntry({ fileSystem, sharedHomePath, effectiveHomePath, entryName, kind }),
  );
  const conflicts = plans.flatMap((planned) =>
    planned.plan._tag === "Conflict" ? [planned.plan.entry] : [],
  );
  if (conflicts.length > 0) {
    return yield* new ClaudeShadowHomeEntryConflictError({
      sharedHomePath,
      effectiveHomePath,
      entries: conflicts,
    });
  }

  yield* Effect.forEach(plans, applyEntryPlan, { discard: true });
});
