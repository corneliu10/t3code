import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import {
  CLAUDE_SHARED_CREATED_FILES,
  CLAUDE_SHARED_DIRECTORIES,
  CLAUDE_SHARED_OPTIONAL_FILES,
  ClaudeShadowHomeEntryConflictError,
  ClaudeShadowHomePathConflictError,
  materializeClaudeShadowHome,
  resolveClaudeHomeLayout,
} from "./ClaudeHomeLayout.ts";

const makeTempDir = Effect.fn("ClaudeHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("ClaudeHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

const makeHomes = Effect.fn("ClaudeHomeLayout.test.makeHomes")(function* () {
  const path = yield* Path.Path;
  const sharedHome = yield* makeTempDir("t3code-claude-shared-");
  const shadowRoot = yield* makeTempDir("t3code-claude-shadow-root-");
  const shadowHome = path.join(shadowRoot, "shadow");
  const layout = yield* resolveClaudeHomeLayout({
    homePath: sharedHome,
    shadowHomePath: shadowHome,
  });
  return { sharedHome, shadowHome, layout };
});

const isSymlink = Effect.fn("ClaudeHomeLayout.test.isSymlink")(function* (linkPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const result = yield* fileSystem.readLink(linkPath).pipe(Effect.result);
  return result._tag === "Success";
});

it.layer(NodeServices.layer)("ClaudeHomeLayout", (it) => {
  describe("shared entry allowlists", () => {
    // The allowlist is what keeps logins and org-bound files private. Any
    // change to it must be deliberate, so the exact lists are pinned here.
    it("shares exactly the allowlisted directories and files", () => {
      expect(CLAUDE_SHARED_DIRECTORIES).toEqual([
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
      ]);
      expect(CLAUDE_SHARED_CREATED_FILES).toEqual(["history.jsonl"]);
      expect(CLAUDE_SHARED_OPTIONAL_FILES).toEqual(["settings.json", "CLAUDE.md"]);
    });
  });

  describe("resolveClaudeHomeLayout", () => {
    it.effect("uses the configured home directly when no shadow home is set", () =>
      Effect.gen(function* () {
        const homePath = yield* makeTempDir("t3code-claude-home-");

        const layout = yield* resolveClaudeHomeLayout({ homePath, shadowHomePath: "" });

        expect(layout).toEqual({
          mode: "direct",
          sharedHomePath: homePath,
          effectiveHomePath: homePath,
          continuationKey: `claude:home:${homePath}`,
        });
      }),
    );

    it.effect("falls back to the inherited CLAUDE_CONFIG_DIR, then ~/.claude", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/x");
        const defaultHome = path.resolve(NodeOS.homedir(), ".claude");

        const fromEnvironment = yield* resolveClaudeHomeLayout(
          { homePath: "", shadowHomePath: "" },
          { CLAUDE_CONFIG_DIR: "/x" },
        );
        const fromEmptyEnvironment = yield* resolveClaudeHomeLayout(
          { homePath: "", shadowHomePath: "" },
          {},
        );
        const withoutEnvironment = yield* resolveClaudeHomeLayout({
          homePath: "",
          shadowHomePath: "",
        });

        expect(fromEnvironment.sharedHomePath).toBe(inherited);
        expect(fromEnvironment.effectiveHomePath).toBe(inherited);
        expect(fromEmptyEnvironment.sharedHomePath).toBe(defaultHome);
        expect(withoutEnvironment.sharedHomePath).toBe(defaultHome);
        expect(withoutEnvironment.continuationKey).toBe(`claude:home:${defaultHome}`);
      }),
    );

    it.effect("keys continuation on the shared home and runs from the shadow home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-claude-shared-");
        const shadowRoot = yield* makeTempDir("t3code-claude-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        const layout = yield* resolveClaudeHomeLayout({
          homePath: sharedHome,
          shadowHomePath: shadowHome,
        });

        expect(layout).toEqual({
          mode: "authOverlay",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          continuationKey: `claude:home:${sharedHome}`,
        });
      }),
    );
  });

  describe("materializeClaudeShadowHome", () => {
    it.effect("does nothing in direct mode", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* makeTempDir("t3code-claude-home-");
        const layout = yield* resolveClaudeHomeLayout({ homePath, shadowHomePath: "" });

        yield* materializeClaudeShadowHome(layout);

        expect(yield* fileSystem.readDirectory(homePath)).toEqual([]);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "links every shared directory and history.jsonl into a fresh shadow home",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeHomes();

          yield* materializeClaudeShadowHome(layout);

          for (const directory of CLAUDE_SHARED_DIRECTORIES) {
            expect(yield* fileSystem.readLink(path.join(shadowHome, directory))).toBe(
              path.join(sharedHome, directory),
            );
            const info = yield* fileSystem.stat(path.join(sharedHome, directory));
            expect(info.type).toBe("Directory");
          }
          expect(yield* fileSystem.readFileString(path.join(sharedHome, "history.jsonl"))).toBe("");
          expect(yield* fileSystem.readLink(path.join(shadowHome, "history.jsonl"))).toBe(
            path.join(sharedHome, "history.jsonl"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "links optional files only when they exist in the shared home",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeHomes();
          yield* writeTextFile(path.join(sharedHome, "settings.json"), "{}\n");

          yield* materializeClaudeShadowHome(layout);

          expect(yield* fileSystem.readLink(path.join(shadowHome, "settings.json"))).toBe(
            path.join(sharedHome, "settings.json"),
          );
          expect(yield* fileSystem.exists(path.join(shadowHome, "CLAUDE.md"))).toBe(false);
          expect(yield* isSymlink(path.join(shadowHome, "CLAUDE.md"))).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "leaves the shadow's own optional file alone when the shared home has none",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { shadowHome, layout } = yield* makeHomes();
          yield* writeTextFile(path.join(shadowHome, "CLAUDE.md"), "# shadow\n");

          yield* materializeClaudeShadowHome(layout);

          expect(yield* isSymlink(path.join(shadowHome, "CLAUDE.md"))).toBe(false);
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "CLAUDE.md"))).toBe(
            "# shadow\n",
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces the empty plugins and skills directories the CLI creates with links",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeHomes();
          yield* fileSystem.makeDirectory(path.join(shadowHome, "plugins"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "skills"), { recursive: true });

          yield* materializeClaudeShadowHome(layout);

          expect(yield* fileSystem.readLink(path.join(shadowHome, "plugins"))).toBe(
            path.join(sharedHome, "plugins"),
          );
          expect(yield* fileSystem.readLink(path.join(shadowHome, "skills"))).toBe(
            path.join(sharedHome, "skills"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a non-empty real directory where a link belongs and keeps its data",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeHomes();
          const transcript = path.join(shadowHome, "projects", "a", "b.jsonl");
          yield* writeTextFile(transcript, '{"turn":1}\n');

          const error = yield* materializeClaudeShadowHome(layout).pipe(Effect.flip);

          const linkPath = path.join(shadowHome, "projects");
          const targetPath = path.join(sharedHome, "projects");
          expect(error).toBeInstanceOf(ClaudeShadowHomeEntryConflictError);
          expect(error).toMatchObject({
            sharedHomePath: sharedHome,
            effectiveHomePath: shadowHome,
            entries: [{ entryName: "projects", linkPath, targetPath, kind: "directory" }],
          });
          expect(error.message).toBe(
            `Cannot link the Claude shadow home's shared entries: 1 already exists as a real file or non-empty directory. Move the contents of '${linkPath}' into '${targetPath}', then delete '${linkPath}'. Then restart T3 Code.`,
          );
          expect(yield* fileSystem.readFileString(transcript)).toBe('{"turn":1}\n');
          expect(yield* isSymlink(linkPath)).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)("refuses a real file where a link belongs", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { shadowHome, layout } = yield* makeHomes();
        yield* writeTextFile(path.join(shadowHome, "history.jsonl"), '{"local":true}\n');

        const error = yield* materializeClaudeShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ClaudeShadowHomeEntryConflictError);
        expect(error).toMatchObject({
          entries: [{ entryName: "history.jsonl", kind: "appendFile" }],
        });
        expect(yield* fileSystem.readFileString(path.join(shadowHome, "history.jsonl"))).toBe(
          '{"local":true}\n',
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reports every conflicting entry at once and changes nothing in the shadow home",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeHomes();
          yield* writeTextFile(path.join(sharedHome, "settings.json"), '{"shared":true}\n');
          yield* writeTextFile(path.join(shadowHome, "projects", "a", "b.jsonl"), "{}\n");
          yield* writeTextFile(path.join(shadowHome, "todos", "t.json"), "[]\n");
          yield* writeTextFile(path.join(shadowHome, "history.jsonl"), '{"local":true}\n');
          yield* writeTextFile(path.join(shadowHome, "settings.json"), '{"shadow":true}\n');
          // Entries that would be fixed up without a conflict stay as they are.
          yield* fileSystem.makeDirectory(path.join(shadowHome, "plugins"));
          yield* fileSystem.symlink("/somewhere-else", path.join(shadowHome, "plans"));

          const error = yield* materializeClaudeShadowHome(layout).pipe(Effect.flip);

          const entry = (entryName: string) => ({
            linkPath: path.join(shadowHome, entryName),
            targetPath: path.join(sharedHome, entryName),
          });
          const projects = entry("projects");
          const todos = entry("todos");
          const history = entry("history.jsonl");
          const settings = entry("settings.json");
          expect(error).toBeInstanceOf(ClaudeShadowHomeEntryConflictError);
          if (error._tag !== "ClaudeShadowHomeEntryConflictError") {
            return expect.fail("Expected ClaudeShadowHomeEntryConflictError");
          }
          expect(error.entries).toEqual([
            { entryName: "projects", ...projects, kind: "directory" },
            { entryName: "todos", ...todos, kind: "directory" },
            { entryName: "history.jsonl", ...history, kind: "appendFile" },
            { entryName: "settings.json", ...settings, kind: "chooseFile" },
          ]);
          expect(error.message).toBe(
            [
              "Cannot link the Claude shadow home's shared entries: 4 already exist as real files or non-empty directories.",
              `Move the contents of '${projects.linkPath}' into '${projects.targetPath}', then delete '${projects.linkPath}'.`,
              `Move the contents of '${todos.linkPath}' into '${todos.targetPath}', then delete '${todos.linkPath}'.`,
              `Append '${history.linkPath}' to '${history.targetPath}', then delete '${history.linkPath}'.`,
              `Keep one of '${settings.linkPath}' and '${settings.targetPath}' as '${settings.targetPath}' (merge them by hand if needed), then delete '${settings.linkPath}'.`,
              "Then restart T3 Code.",
            ].join(" "),
          );
          expect(yield* isSymlink(path.join(shadowHome, "plugins"))).toBe(false);
          expect(yield* fileSystem.readDirectory(path.join(shadowHome, "plugins"))).toEqual([]);
          expect(yield* fileSystem.readLink(path.join(shadowHome, "plans"))).toBe(
            "/somewhere-else",
          );
          expect(yield* fileSystem.exists(path.join(shadowHome, "skills"))).toBe(false);
          expect(yield* isSymlink(path.join(shadowHome, "skills"))).toBe(false);
          expect(yield* fileSystem.readFileString(settings.linkPath)).toBe('{"shadow":true}\n');
          expect(yield* fileSystem.readFileString(settings.targetPath)).toBe('{"shared":true}\n');
        }),
    );

    it.effect.skipIf(!symlinksSupported)("replaces a symlink that points elsewhere", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { sharedHome, shadowHome, layout } = yield* makeHomes();
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
        yield* fileSystem.symlink("/somewhere-else", path.join(shadowHome, "plans"));

        yield* materializeClaudeShadowHome(layout);

        expect(yield* fileSystem.readLink(path.join(shadowHome, "plans"))).toBe(
          path.join(sharedHome, "plans"),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "never touches the shadow's private entries or links private shared files",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeHomes();
          yield* writeTextFile(path.join(sharedHome, ".claude.json"), '{"shared":true}\n');
          yield* writeTextFile(path.join(sharedHome, ".credentials.json"), '{"shared":true}\n');
          yield* writeTextFile(path.join(shadowHome, ".claude.json"), '{"shadow":true}\n');
          yield* writeTextFile(path.join(shadowHome, "sessions", "1.json"), "{}\n");
          yield* writeTextFile(path.join(shadowHome, "policy-limits.json"), "{}\n");

          yield* materializeClaudeShadowHome(layout);

          for (const entry of [".claude.json", "sessions", "policy-limits.json"]) {
            expect(yield* fileSystem.exists(path.join(shadowHome, entry))).toBe(true);
            expect(yield* isSymlink(path.join(shadowHome, entry))).toBe(false);
          }
          expect(yield* fileSystem.exists(path.join(shadowHome, "sessions", "1.json"))).toBe(true);
          expect(yield* fileSystem.readFileString(path.join(shadowHome, ".claude.json"))).toBe(
            '{"shadow":true}\n',
          );
          expect(yield* isSymlink(path.join(shadowHome, ".credentials.json"))).toBe(false);
          expect(yield* fileSystem.exists(path.join(shadowHome, ".credentials.json"))).toBe(false);
        }),
    );

    it.effect("rejects shadow homes equal to, inside, or containing the shared home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeTempDir("t3code-claude-nested-");
        const sharedHome = path.join(root, "shared");
        const cases = [
          { homePath: sharedHome, shadowHomePath: sharedHome },
          { homePath: sharedHome, shadowHomePath: path.join(sharedHome, "accounts", "work") },
          {
            homePath: path.join(root, "outer", "shared"),
            shadowHomePath: path.join(root, "outer"),
          },
        ];

        for (const config of cases) {
          const layout = yield* resolveClaudeHomeLayout(config);
          const error = yield* materializeClaudeShadowHome(layout).pipe(Effect.flip);
          expect(error).toBeInstanceOf(ClaudeShadowHomePathConflictError);
          expect(error).toMatchObject({
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath: layout.effectiveHomePath,
          });
          expect(error.message).toBe(
            `Claude shadow home path '${layout.effectiveHomePath}' and shared home path '${layout.sharedHomePath}' must be separate directories, neither inside the other.`,
          );
        }
      }),
    );

    const expectSharedHomeUntouched = Effect.fn("ClaudeHomeLayout.test.expectSharedHomeUntouched")(
      function* (sharedHome: string) {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (const directory of ["plugins", "skills"]) {
          expect(yield* isSymlink(path.join(sharedHome, directory))).toBe(false);
          expect(yield* fileSystem.readDirectory(path.join(sharedHome, directory))).toEqual([]);
        }
        expect(yield* isSymlink(path.join(sharedHome, "projects"))).toBe(false);
        expect(
          yield* fileSystem.readFileString(path.join(sharedHome, "projects", "a", "b.jsonl")),
        ).toBe("{}\n");
      },
    );

    const makeUsedSharedHome = Effect.fn("ClaudeHomeLayout.test.makeUsedSharedHome")(function* (
      root: string,
    ) {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = path.join(root, "claude");
      // A fresh home's empty folders, which a self-referencing shadow would
      // replace with links to themselves, and one with a session in it.
      yield* fileSystem.makeDirectory(path.join(sharedHome, "plugins"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(sharedHome, "skills"), { recursive: true });
      yield* writeTextFile(path.join(sharedHome, "projects", "a", "b.jsonl"), "{}\n");
      return sharedHome;
    });

    it.effect.skipIf(!symlinksSupported)(
      "rejects a shadow home that is a symlink to the shared home and touches nothing",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.realPath(yield* makeTempDir("t3code-claude-alias-"));
          const sharedHome = yield* makeUsedSharedHome(root);
          const shadowHome = path.join(root, "claude-work");
          yield* fileSystem.symlink(sharedHome, shadowHome);
          const layout = yield* resolveClaudeHomeLayout({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          });

          const error = yield* materializeClaudeShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(ClaudeShadowHomePathConflictError);
          expect(error).toMatchObject({
            sharedHomePath: sharedHome,
            effectiveHomePath: shadowHome,
          });
          expect(error.message).toBe(
            `Claude shadow home path '${shadowHome}' and shared home path '${sharedHome}' must be separate directories, neither inside the other. They resolve to '${sharedHome}' and '${sharedHome}'.`,
          );
          yield* expectSharedHomeUntouched(sharedHome);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects a shadow home under a symlinked parent that points into the shared home",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.realPath(yield* makeTempDir("t3code-claude-alias-"));
          const sharedHome = yield* makeUsedSharedHome(root);
          yield* fileSystem.symlink(sharedHome, path.join(root, "accounts"));
          const shadowHome = path.join(root, "accounts", "work");
          const layout = yield* resolveClaudeHomeLayout({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          });

          const error = yield* materializeClaudeShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(ClaudeShadowHomePathConflictError);
          yield* expectSharedHomeUntouched(sharedHome);
        }),
    );

    it.effect("rejects a shadow home that names the shared home in another letter case", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(yield* makeTempDir("t3code-claude-case-"));
        const sharedHome = yield* makeUsedSharedHome(root);
        const shadowHome = path.join(root, "CLAUDE");
        // Only a case-insensitive filesystem (macOS and Windows by default)
        // makes the two names one directory.
        if (!(yield* fileSystem.exists(shadowHome))) return;
        const layout = yield* resolveClaudeHomeLayout({
          homePath: sharedHome,
          shadowHomePath: shadowHome,
        });

        const error = yield* materializeClaudeShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ClaudeShadowHomePathConflictError);
        yield* expectSharedHomeUntouched(sharedHome);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "accepts sibling paths that only share a name prefix",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeTempDir("t3code-claude-siblings-");
          const sharedHome = path.join(root, "claude");
          const shadowHome = path.join(root, "claude-work");
          const layout = yield* resolveClaudeHomeLayout({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          });

          yield* materializeClaudeShadowHome(layout);

          expect(yield* fileSystem.readLink(path.join(shadowHome, "projects"))).toBe(
            path.join(sharedHome, "projects"),
          );
        }),
    );

    it.effect("preserves filesystem operation, paths, and cause", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedRoot = yield* makeTempDir("t3code-claude-shared-root-");
        const sharedHome = path.join(sharedRoot, "shared-home");
        const shadowRoot = yield* makeTempDir("t3code-claude-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        yield* writeTextFile(sharedHome, "not a directory\n");
        const layout = yield* resolveClaudeHomeLayout({
          homePath: sharedHome,
          shadowHomePath: shadowHome,
        });

        const error = yield* materializeClaudeShadowHome(layout).pipe(Effect.flip);

        expect(error._tag).toBe("ClaudeShadowHomeFileSystemError");
        if (error._tag !== "ClaudeShadowHomeFileSystemError") {
          return expect.fail("Expected ClaudeShadowHomeFileSystemError");
        }
        expect(error).toMatchObject({
          operation: "makeDirectory",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
        });
        expect(error.path.startsWith(sharedHome)).toBe(true);
        expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
        expect(error.message).toBe(
          `Claude shadow home filesystem operation 'makeDirectory' failed for '${error.path}'.`,
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "is idempotent and never truncates the shared history",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeHomes();
          yield* writeTextFile(path.join(sharedHome, "history.jsonl"), '{"display":"hi"}\n');
          yield* writeTextFile(path.join(sharedHome, "CLAUDE.md"), "# shared\n");

          const snapshot = Effect.gen(function* () {
            const entries = (yield* fileSystem.readDirectory(shadowHome)).toSorted();
            const links: Array<readonly [string, string]> = [];
            for (const entry of entries) {
              links.push([entry, yield* fileSystem.readLink(path.join(shadowHome, entry))]);
            }
            const sharedEntries = (yield* fileSystem.readDirectory(sharedHome)).toSorted();
            return { links, sharedEntries };
          });

          yield* materializeClaudeShadowHome(layout);
          const first = yield* snapshot;
          yield* materializeClaudeShadowHome(layout);
          const second = yield* snapshot;

          expect(second).toEqual(first);
          expect(first.links.map(([entry]) => entry)).toEqual(
            [...CLAUDE_SHARED_DIRECTORIES, "history.jsonl", "CLAUDE.md"].toSorted(),
          );
          expect(yield* fileSystem.readFileString(path.join(sharedHome, "history.jsonl"))).toBe(
            '{"display":"hi"}\n',
          );
        }),
    );
  });
});
