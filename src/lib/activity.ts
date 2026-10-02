import type { Database } from '@/db/client';
import { activity, type ActivityKind, type ActivitySubjectType } from '@/db/schema';

/**
 * The feed's only writer.
 *
 * TR-17 is a two-way rule — no state change without a feed entry, and no feed entry without
 * the state change — and the only way to hold both halves is for the entry to be written on
 * the same transaction as the change. So this module does not open one: it takes a `Tx`, the
 * session a caller's `db.transaction()` handed it, which is a type no code outside a
 * transaction body has. A caller that cannot produce a `Tx` cannot record activity, and the
 * type is what says so rather than a comment.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ActivityEntry {
  groupId: string;
  /** Who did it. Null for something the product did on its own, which nothing does yet. */
  actorId: string | null;
  kind: ActivityKind;
  /** The membership row the entry is about, for the member.* kinds. */
  memberId?: string | null;
  /**
   * The row the entry is about, for the kinds that name one instead of a membership. An
   * expense.added names its expense, which is what lets piece 8's feed link to it.
   */
  subjectType?: ActivitySubjectType | null;
  subjectId?: string | null;
  /**
   * What changed, as it was entered. Money inside this must be a STRING of minor units —
   * jsonb numbers are floats, which is the one thing a money value may never become.
   */
  detail?: Record<string, unknown> | null;
}

/**
 * Writes one entry. Called inside the caller's transaction, so a failure here — or anywhere
 * after it — leaves neither the change nor the entry.
 */
export async function recordActivity(tx: Tx, entry: ActivityEntry): Promise<void> {
  await tx.insert(activity).values({
    groupId: entry.groupId,
    actorId: entry.actorId,
    memberId: entry.memberId ?? null,
    kind: entry.kind,
    subjectType: entry.subjectType ?? null,
    subjectId: entry.subjectId ?? null,
    detail: entry.detail ?? null,
  });
}
