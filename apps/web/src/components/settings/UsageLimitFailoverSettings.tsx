import type { UnifiedSettings } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  addableInstances,
  addEntry,
  type ChainEntry,
  moveEntry,
  removeEntry,
  setEntryModel,
} from "./usageLimitFailoverChain";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * `Select` values are strings, so "no pinned model" needs one. It cannot be
 * empty: Base UI treats an empty value as no selection and shows the placeholder.
 */
const KEEP_THREAD_MODEL = "__keep_thread_model__";

type ModelItem = { readonly value: string; readonly label: string };

/** The Keep option, then the account's models, then a pinned model the account no longer lists. */
function modelItemsFor(provider: ProviderInstanceEntry | undefined, pinned: string | undefined) {
  const models = (provider?.models ?? []).filter(
    (model) => !model.isLegacy || model.slug === pinned,
  );
  const items: ModelItem[] = [
    { value: KEEP_THREAD_MODEL, label: "Keep thread's model" },
    ...models.map((model) => ({ value: model.slug, label: model.name })),
  ];
  if (pinned !== undefined && !items.some((item) => item.value === pinned)) {
    items.push({ value: pinned, label: pinned });
  }
  return items;
}

function ChainRow({
  position,
  count,
  entry,
  provider,
  disabled,
  onMove,
  onRemove,
  onModelChange,
}: {
  readonly position: number;
  readonly count: number;
  readonly entry: ChainEntry;
  /** Undefined when the account was deleted: only removing it still works. */
  readonly provider: ProviderInstanceEntry | undefined;
  readonly disabled: boolean;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onRemove: () => void;
  readonly onModelChange: (model: string | undefined) => void;
}) {
  const missing = provider === undefined;
  const label = missing ? "Missing account" : provider.displayName;
  const items = modelItemsFor(provider, entry.model);
  const locked = disabled || missing;

  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1.5 py-2">
      <span aria-hidden className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">
        {position + 1}
      </span>
      <span className="flex min-w-32 flex-1 items-baseline gap-1.5">
        <span
          className={cn(
            "truncate text-sm font-medium",
            missing ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {label}
        </span>
        {missing ? (
          <span className="truncate text-xs text-muted-foreground">{entry.instanceId}</span>
        ) : provider.enabled ? null : (
          <span className="shrink-0 text-xs text-muted-foreground">Disabled</span>
        )}
      </span>
      <Select
        items={items}
        value={entry.model ?? KEEP_THREAD_MODEL}
        disabled={locked}
        onValueChange={(value) => {
          if (value === null) return;
          onModelChange(value === KEEP_THREAD_MODEL ? undefined : value);
        }}
      >
        <SelectTrigger size="xs" className="w-44" aria-label={`Model for ${label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {items.map((item) => (
            <SelectItem hideIndicator key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <span className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={locked || position === 0}
                aria-label={`Move ${label} up`}
                onClick={() => onMove(-1)}
              />
            }
          >
            <ArrowUpIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">Move up</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={locked || position === count - 1}
                aria-label={`Move ${label} down`}
                onClick={() => onMove(1)}
              />
            }
          >
            <ArrowDownIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">Move down</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={disabled}
                aria-label={`Remove ${label}`}
                onClick={onRemove}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">Remove</TooltipPopup>
        </Tooltip>
      </span>
    </li>
  );
}

/** The ordered account list under the switch. Every edit hands back the whole next chain. */
function FailoverChain({
  chain,
  instances,
  disabled,
  onChange,
}: {
  readonly chain: ReadonlyArray<ChainEntry>;
  readonly instances: ReadonlyArray<ProviderInstanceEntry>;
  readonly disabled: boolean;
  readonly onChange: (chain: ChainEntry[]) => void;
}) {
  const addable = addableInstances(instances, chain);
  return (
    <div className="space-y-2 pt-3 pb-2">
      {chain.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {addable.length === 0
            ? "No enabled accounts to add."
            : "Add the accounts to continue on, in order."}
        </p>
      ) : (
        <ol className="divide-y divide-border/50">
          {chain.map((entry, index) => {
            const repeats = chain
              .slice(0, index)
              .filter((earlier) => earlier.instanceId === entry.instanceId).length;
            return (
              <ChainRow
                // An account is in the chain once, but a hand-edited settings file can repeat it.
                key={`${entry.instanceId}:${repeats}`}
                position={index}
                count={chain.length}
                entry={entry}
                provider={instances.find((instance) => instance.instanceId === entry.instanceId)}
                disabled={disabled}
                onMove={(delta) => onChange(moveEntry(chain, index, delta))}
                onRemove={() => onChange(removeEntry(chain, index))}
                onModelChange={(model) => onChange(setEntryModel(chain, index, model))}
              />
            );
          })}
        </ol>
      )}
      {addable.length > 0 ? (
        <Select
          value={null}
          disabled={disabled}
          onValueChange={(value) => {
            const picked = addable.find((instance) => instance.instanceId === value);
            if (picked) onChange(addEntry(chain, picked.instanceId));
          }}
        >
          <SelectTrigger size="xs" className="w-44" aria-label="Add account">
            <SelectValue placeholder="Add account" />
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {addable.map((instance) => (
              <SelectItem hideIndicator key={instance.instanceId} value={instance.instanceId}>
                {instance.displayName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </div>
  );
}

type UsageLimitFailover = UnifiedSettings["usageLimitFailover"];

/**
 * "Continue on another account": the switch and, under it, the ordered list of
 * accounts a usage-limited thread continues on.
 *
 * The chain names instance ids that belong to one environment, so it is only
 * editable with exactly one environment selected. At "All environments" a write
 * would copy this environment's chain onto every other one.
 */
export function UsageLimitFailoverSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, environment, connectedEnvironments } = useSettingsScope();

  const failover = settings.usageLimitFailover;
  const singleEnvironment = connectedEnvironments.length === 1;
  const editable = singleEnvironment && (scope.kind === "all" || scope.kind === "environment");
  // Always the whole object: a patch with only `enabled` decodes the chain as
  // empty on the server and wipes it.
  const save = (next: UsageLimitFailover) => updateSettings({ usageLimitFailover: next });

  const instances = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(environment?.serverConfig?.providers ?? []),
      settings,
      null,
    ),
  );

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("usage-limit-failover")}
      description="When a usage limit stops a thread, continue it on the next account in this list. New threads skip an account that is out of quota."
      settingKeys={["usageLimitFailover"]}
      status={
        connectedEnvironments.length > 0 && !editable
          ? "Accounts belong to one environment. Select an environment to change this."
          : undefined
      }
      control={
        <ScopedSwitch
          settingKeys={["usageLimitFailover"]}
          checked={failover.enabled}
          disabled={!editable}
          onCheckedChange={(checked) => save({ enabled: Boolean(checked), chain: failover.chain })}
          aria-label="Continue on another account"
        />
      }
    >
      {failover.enabled && singleEnvironment ? (
        <FailoverChain
          chain={failover.chain}
          instances={instances}
          disabled={!editable}
          onChange={(chain) => save({ enabled: failover.enabled, chain })}
        />
      ) : null}
    </SettingsRow>
  );
}
