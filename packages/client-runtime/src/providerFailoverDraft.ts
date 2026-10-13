import type { OrchestrationV2Run, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Whether a composer draft's account is stale because the server has since
 * moved the thread off it after a usage limit. The draft's account wins over
 * the thread's in both composers, so a stale one would send the next message
 * back to the limited account. An account picked again after the failover is
 * the user's own choice and stays. A draft with no pick time predates the
 * field and counts as older.
 */
export function isDraftAccountSupersededByFailover(input: {
  readonly draftInstanceId: ProviderInstanceId | null | undefined;
  /** Epoch milliseconds of the pick that set the draft's account. */
  readonly draftSelectedAt: number | null | undefined;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "requestedAt" | "providerFailover">>;
}): boolean {
  const { draftInstanceId, draftSelectedAt } = input;
  if (draftInstanceId === null || draftInstanceId === undefined) return false;
  return input.runs.some(
    (run) =>
      run.providerFailover?.fromProviderInstanceId === draftInstanceId &&
      (draftSelectedAt === null ||
        draftSelectedAt === undefined ||
        draftSelectedAt < DateTime.toEpochMillis(run.requestedAt)),
  );
}
