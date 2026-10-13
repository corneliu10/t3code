import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  settings: null as unknown as UnifiedSettings,
  providers: [] as ServerProvider[],
  scopeKind: "all" as "all" | "environment" | "project",
  connectedEnvironmentCount: 1,
  canWriteSettings: true,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useUpdateScopedSettings: () => state.updateSettings,
  useScopedSettingsWriteAllowed: () => state.canWriteSettings,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: state.scopeKind },
    environment: { serverConfig: { providers: state.providers } },
    connectedEnvironments: Array.from({ length: state.connectedEnvironmentCount }),
  }),
}));
vi.mock("./settingsSearch", () => ({ searchableSetting: (id: string) => ({ id, title: id }) }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    control,
    status,
    children,
  }: {
    control: ReactNode;
    status?: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      {control}
      <p data-status="">{status}</p>
      {children}
    </div>
  ),
}));
vi.mock("./ScopedSwitch", () => ({
  ScopedSwitch: ({
    checked,
    disabled,
    onCheckedChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      aria-label="Continue on another account"
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));
vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => children,
  SelectItem: "span",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "span",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", async () => {
  const { cloneElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => children,
    TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
      cloneElement(render, undefined, children),
    TooltipPopup: () => null,
  };
});

import { Select } from "../ui/select";
import { UsageLimitFailoverSettings } from "./UsageLimitFailoverSettings";

const claudeWork = ProviderInstanceId.make("claudeAgent");
const claudePersonal = ProviderInstanceId.make("claude_personal");
const codex = ProviderInstanceId.make("codex");
const ghost = ProviderInstanceId.make("deleted_account");

function provider(
  instanceId: ProviderInstanceId,
  driver: string,
  models: string[],
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((slug) => ({
      slug,
      name: `${slug} name`,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

function givenSettings(
  failover: UnifiedSettings["usageLimitFailover"],
  providerInstances: UnifiedSettings["providerInstances"] = {
    [claudePersonal]: { driver: ProviderDriverKind.make("claudeAgent") },
  },
) {
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, usageLimitFailover: failover, providerInstances };
}

let renderer: ReactTestRenderer | null;

function render() {
  act(() => {
    renderer = create(<UsageLimitFailoverSettings />);
  });
}

const root = () => renderer!.root;
const buttons = () => root().findAllByType("button");
const button = (label: string) => buttons().find((item) => item.props["aria-label"] === label);
const hasText = (text: string) => root().findAll((node) => node.children.includes(text)).length > 0;
const selects = () => root().findAllByType(Select);
/** The Select that adds an account: the only one with no value. */
const addSelect = () => selects().find((select) => select.props.value === null);

function lastWrite() {
  return state.updateSettings.mock.calls.at(-1)?.[0];
}

function click(item: ReactTestInstance | undefined) {
  act(() => item!.props.onClick());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.providers = [
    provider(claudeWork, "claudeAgent", ["opus", "sonnet"]),
    provider(claudePersonal, "claudeAgent", ["opus", "sonnet"]),
    provider(codex, "codex", ["gpt"]),
  ];
  state.scopeKind = "all";
  state.connectedEnvironmentCount = 1;
  state.canWriteSettings = true;
  state.updateSettings.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("UsageLimitFailoverSettings", () => {
  it("writes the whole setting when it is switched on, so the chain survives", () => {
    givenSettings({ enabled: false, chain: [{ instanceId: claudePersonal, model: "opus" }] });
    render();

    click(button("Continue on another account"));

    expect(lastWrite()).toEqual({
      usageLimitFailover: {
        enabled: true,
        chain: [{ instanceId: claudePersonal, model: "opus" }],
      },
    });
  });

  it("shows the account list only while the setting is on", () => {
    givenSettings({ enabled: false, chain: [{ instanceId: claudePersonal }] });
    render();
    expect(button("Remove Claude Personal")).toBeUndefined();

    act(() => renderer!.unmount());
    givenSettings({ enabled: true, chain: [{ instanceId: claudePersonal }] });
    render();
    expect(button("Remove Claude Personal")).toBeDefined();
  });

  it("writes the whole setting for every edit to the list", () => {
    givenSettings({
      enabled: true,
      chain: [{ instanceId: claudePersonal }, { instanceId: codex }],
    });
    render();

    click(button("Move Claude Personal down"));
    expect(lastWrite()).toEqual({
      usageLimitFailover: {
        enabled: true,
        chain: [{ instanceId: codex }, { instanceId: claudePersonal }],
      },
    });

    click(button("Remove Claude Personal"));
    expect(lastWrite()).toEqual({
      usageLimitFailover: { enabled: true, chain: [{ instanceId: codex }] },
    });

    act(() => selects()[0]!.props.onValueChange("sonnet"));
    expect(lastWrite()).toEqual({
      usageLimitFailover: {
        enabled: true,
        chain: [{ instanceId: claudePersonal, model: "sonnet" }, { instanceId: codex }],
      },
    });
  });

  it("drops the pinned model when the thread's model is chosen again", () => {
    givenSettings({ enabled: true, chain: [{ instanceId: claudePersonal, model: "opus" }] });
    render();

    const modelSelect = selects()[0]!;
    // The first option is the one that keeps the thread's model.
    act(() => modelSelect.props.onValueChange(modelSelect.props.items[0].value));

    expect(lastWrite()).toEqual({
      usageLimitFailover: { enabled: true, chain: [{ instanceId: claudePersonal }] },
    });
  });

  it("offers only enabled accounts that are not in the list yet", () => {
    givenSettings(
      { enabled: true, chain: [{ instanceId: claudePersonal }] },
      {
        [claudePersonal]: { driver: ProviderDriverKind.make("claudeAgent") },
        [codex]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
    );
    render();

    const offered = addSelect()!
      .findAllByType("span")
      .map((item) => item.children.join(""));
    expect(offered).toContain("Claude");
    expect(offered).not.toContain("Claude Personal");
    expect(offered).not.toContain("Codex");

    act(() => addSelect()!.props.onValueChange(claudeWork));
    expect(lastWrite()).toEqual({
      usageLimitFailover: {
        enabled: true,
        chain: [{ instanceId: claudePersonal }, { instanceId: claudeWork }],
      },
    });
  });

  it("shows an account that no longer exists as missing, and only lets you remove it", () => {
    givenSettings({ enabled: true, chain: [{ instanceId: ghost }, { instanceId: codex }] });
    render();

    expect(hasText("Missing account")).toBe(true);
    expect(button("Remove Missing account")?.props.disabled).toBe(false);
    expect(button("Move Missing account up")?.props.disabled).toBe(true);
    expect(button("Move Missing account down")?.props.disabled).toBe(true);
    expect(selects()[0]!.props.disabled).toBe(true);

    click(button("Remove Missing account"));
    expect(lastWrite()).toEqual({
      usageLimitFailover: { enabled: true, chain: [{ instanceId: codex }] },
    });
  });

  it("names a disabled account and keeps it editable", () => {
    givenSettings(
      { enabled: true, chain: [{ instanceId: codex }, { instanceId: claudePersonal }] },
      {
        [claudePersonal]: { driver: ProviderDriverKind.make("claudeAgent") },
        [codex]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
    );
    render();

    expect(hasText("Missing account")).toBe(false);
    expect(hasText("Codex")).toBe(true);
    expect(hasText("Disabled")).toBe(true);
    expect(button("Remove Codex")?.props.disabled).toBe(false);
    expect(button("Move Codex down")?.props.disabled).toBe(false);
  });

  it("does not let one environment's list be written to several", () => {
    state.connectedEnvironmentCount = 2;
    givenSettings({ enabled: true, chain: [{ instanceId: claudePersonal }] });
    render();

    expect(button("Continue on another account")?.props.disabled).toBe(true);
    expect(button("Remove Claude Personal")).toBeUndefined();
    expect(root().findByProps({ "data-status": "" }).children.join("")).toContain(
      "Select an environment",
    );
  });

  it("is read-only without permission to change the environment's settings", () => {
    state.canWriteSettings = false;
    givenSettings({ enabled: true, chain: [{ instanceId: claudePersonal }] });
    render();

    expect(button("Continue on another account")?.props.disabled).toBe(true);
    expect(button("Remove Claude Personal")?.props.disabled).toBe(true);
    expect(button("Move Claude Personal up")?.props.disabled).toBe(true);
    expect(selects().every((select) => select.props.disabled)).toBe(true);
  });

  it("is read-only at a project scope", () => {
    state.scopeKind = "project";
    givenSettings({ enabled: true, chain: [{ instanceId: claudePersonal }] });
    render();

    expect(button("Continue on another account")?.props.disabled).toBe(true);
    expect(button("Remove Claude Personal")?.props.disabled).toBe(true);
    expect(selects().every((select) => select.props.disabled)).toBe(true);
  });
});
