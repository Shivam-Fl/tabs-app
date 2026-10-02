'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { database } from '@/db/client';
import { groupTypes } from '@/db/schema';
import { recordActivity } from '@/lib/activity';
import { archiveGroupAsOwner, createGroupWithOwner, renameGroupAsOwner } from '@/lib/access';
import { requireUser } from '@/lib/auth';

/**
 * Creating, renaming and archiving a group.
 *
 * The shape is profile.ts's: a typed result the form renders, never a throw for an expected
 * failure. `{ ok: false }` with no data is what a caller who is not the group's owner gets —
 * the same answer whether the group does not exist or they are not in it, so a refusal names
 * nothing.
 *
 * Navigation is the client's: createGroup returns the id it wrote and the form pushes to it.
 * Nothing here calls redirect(), and nothing here may call it from inside a transaction body —
 * redirect() throws NEXT_REDIRECT, which unwinds the transaction and rolls back to zero rows.
 */

export interface GroupResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string;
  /** Set on success by createGroup: the group the caller may now open. */
  groupId?: string;
}

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name for this group.')
  .max(80, 'That name is too long.');

/** Rejected rather than truncated, for the reason profile.ts gives: 'EURO' is not a currency. */
const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value), 'Use a three-letter currency code, like EUR.');

const createGroupSchema = z.object({
  name: nameSchema,
  // Empty means "the currency in my settings", which the action resolves against the caller.
  currency: z.union([currencySchema, z.literal('')]).optional(),
  type: z.enum(groupTypes).optional(),
});

const groupIdSchema = z.string().uuid();

const renameGroupSchema = z.object({ groupId: groupIdSchema, name: nameSchema });
const archiveGroupSchema = z.object({ groupId: groupIdSchema });

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? 'form');
    fieldErrors[field] ??= issue.message;
  }
  return fieldErrors;
}

export async function createGroup(_previous: GroupResult | null, formData: FormData): Promise<GroupResult> {
  const parsed = createGroupSchema.safeParse({
    name: formData.get('name'),
    currency: formData.get('currency'),
    type: formData.get('type') ?? undefined,
  });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const user = await requireUser();
  const db = await database();

  const currency = parsed.data.currency ? parsed.data.currency : user.defaultCurrency;
  const type = parsed.data.type ?? 'other';

  // The group, its owner membership and its first feed entry are one atomic unit: a group
  // nobody owns, or one whose creation is not in its own feed, is not a state this product has.
  const groupId = await db.transaction(async (tx) => {
    const created = await createGroupWithOwner(tx, { name: parsed.data.name, currency, type, ownerId: user.id });
    await recordActivity(tx, { groupId: created, actorId: user.id, kind: 'group.created' });
    return created;
  });

  // The home list, and the top bar's shell, both change.
  revalidatePath('/', 'layout');
  return { ok: true, groupId };
}

export async function renameGroup(_previous: GroupResult | null, formData: FormData): Promise<GroupResult> {
  const parsed = renameGroupSchema.safeParse({
    groupId: formData.get('groupId'),
    name: formData.get('name'),
  });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const user = await requireUser();
  const db = await database();

  const renamed = await db.transaction(async (tx) => {
    const changed = await renameGroupAsOwner(tx, parsed.data.groupId, parsed.data.name, user.id);
    if (!changed) return false;
    await recordActivity(tx, { groupId: parsed.data.groupId, actorId: user.id, kind: 'group.renamed' });
    return true;
  });

  if (!renamed) return { ok: false, formError: "Only the group's owner can rename it." };

  revalidatePath('/', 'layout');
  return { ok: true, groupId: parsed.data.groupId };
}

export async function archiveGroup(_previous: GroupResult | null, formData: FormData): Promise<GroupResult> {
  const parsed = archiveGroupSchema.safeParse({ groupId: formData.get('groupId') });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const user = await requireUser();
  const db = await database();

  const archived = await db.transaction(async (tx) => {
    const changed = await archiveGroupAsOwner(tx, parsed.data.groupId, user.id);
    if (!changed) return false;
    await recordActivity(tx, { groupId: parsed.data.groupId, actorId: user.id, kind: 'group.archived' });
    return true;
  });

  if (!archived) return { ok: false, formError: "Only the group's owner can archive it." };

  revalidatePath('/', 'layout');
  return { ok: true, groupId: parsed.data.groupId };
}
