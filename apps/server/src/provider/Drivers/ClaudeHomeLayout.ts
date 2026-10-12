import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
  ClaudeShadowHomeContext,
) {
  override get message(): string {
    return `Claude shadow home path '${this.effectiveHomePath}' and shared home path '${this.sharedHomePath}' must be separate directories, neither inside the other.`;
  }
}

export class ClaudeShadowHomeEntryConflictError extends Schema.TaggedError<ClaudeShadowHomeEntryConflictError>()(
  "ClaudeShadowHomeEntryConflictError",
  {
    ...ClaudeShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot link Claude shadow home entry '${this.entryName}': '${this.linkPath}' already exists and is not a symlink or an empty directory. Move its contents into '${this.targetPath}', then delete '${this.linkPath}'.`;
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

const ensureSymlink = Effect.fn("ClaudeHomeLayout.ensureSymlink")(function* (
  input: EntryInput,
): Effect.fn.Return<void, ClaudeShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({ ...input, linkPath: link });

  const removeExisting = (options?: { readonly recursive: boolean }) =>
    input.fileSystem.remove(link, options).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new ClaudeShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
  const createLink = input.fileSystem.symlink(target, link).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new ClaudeShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "symlink",
          path: link,
          targetPath: target,
          entryName: input.entryName,
          cause,
        }),
    }),
  );

  if (state._tag === "Missing") {
    return yield* createLink;
  }

  if (state._tag === "NotSymlink") {
    // The CLI creates empty `plugins/` and `skills/` on a fresh home. Those
    // hold nothing, so they give way to the link; anything with data does not.
    if (!(yield* isEmptyRealDirectory({ ...input, linkPath: link }))) {
      return yield* new ClaudeShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: link,
        targetPath: target,
      });
    }
    // Node's `rm` refuses any directory without `recursive`; it was empty a moment ago.
    yield* removeExisting({ recursive: true });
    return yield* createLink;
  }

  if (path.resolve(path.dirname(link), state.target) !== target) {
    yield* removeExisting();
    yield* createLink;
  }
});

/**
 * Link the shared session and setup entries into the shadow home. A no-op in
 * direct mode. Only allowlisted entries are touched; data in the shadow is
 * never moved, merged or deleted.
 */
export const materializeClaudeShadowHome = Effect.fn("materializeClaudeShadowHome")(function* (
  layout: ClaudeHomeLayout,
): Effect.fn.Return<void, ClaudeShadowHomeError, FileSystem.FileSystem | Path.Path> {
  if (layout.mode !== "authOverlay") return;
  const { sharedHomePath, effectiveHomePath } = layout;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (
    isSameOrInside(path, sharedHomePath, effectiveHomePath) ||
    isSameOrInside(path, effectiveHomePath, sharedHomePath)
  ) {
    return yield* new ClaudeShadowHomePathConflictError({ sharedHomePath, effectiveHomePath });
  }

  const fileSystemError = (
    operation: "exists" | "makeDirectory" | "writeFile",
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

  yield* Effect.all(
    [
      makeDirectory(sharedHomePath),
      makeDirectory(effectiveHomePath),
      ...CLAUDE_SHARED_DIRECTORIES.map((directory) =>
        makeDirectory(path.join(sharedHomePath, directory)),
      ),
    ],
    { concurrency: "unbounded" },
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

  yield* Effect.forEach(
    [...CLAUDE_SHARED_DIRECTORIES, ...CLAUDE_SHARED_CREATED_FILES, ...optionalFiles],
    (entryName) => ensureSymlink({ fileSystem, sharedHomePath, effectiveHomePath, entryName }),
    { discard: true },
  );
});
