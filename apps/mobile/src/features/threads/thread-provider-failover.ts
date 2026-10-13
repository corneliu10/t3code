import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describeRunProviderFailover } from "@t3tools/client-runtime/provider-failover-notice";
import type { EnvironmentId, MessageId, ServerProvider, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";

const NO_NOTICES: ReadonlyMap<MessageId, string> = new Map();
const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

// The same date and time the usage-limit row shows for a reset.
function formatResetTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function sameNotices(a: ReadonlyMap<MessageId, string>, b: ReadonlyMap<MessageId, string>) {
  if (a.size !== b.size) return false;
  for (const [messageId, notice] of a) {
    if (b.get(messageId) !== notice) return false;
  }
  return true;
}

function providerFailoverNoticesAtom(environmentId: EnvironmentId, threadId: ThreadId) {
  const ref = scopeThreadRef(environmentId, threadId);
  let previous = NO_NOTICES;
  return Atom.make((get) => {
    const runs = get(environmentThreadDetails.threadAtom(ref))?.projection.runs;
    const providers = get(serverEnvironment.configValueAtom(environmentId))?.providers;
    let next: Map<MessageId, string> | null = null;
    for (const run of runs ?? []) {
      if (run.providerFailover === undefined) continue;
      const notice = describeRunProviderFailover({
        run,
        providers: providers ?? NO_PROVIDERS,
        formatTime: formatResetTime,
      });
      if (notice !== null) (next ??= new Map()).set(run.userMessageId, notice);
    }
    // Run activity changes constantly and almost no run moved accounts, so
    // the feed only hears about a change in the notices themselves.
    const notices = next ?? NO_NOTICES;
    if (!sameNotices(previous, notices)) previous = notices;
    return previous;
  });
}

/**
 * The failover notice for each message that started a run the server moved to
 * another account, keyed by that message's id.
 */
export function useProviderFailoverNotices(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyMap<MessageId, string> {
  const atom = useMemo(
    () => providerFailoverNoticesAtom(environmentId, threadId),
    [environmentId, threadId],
  );
  return useAtomValue(atom);
}
