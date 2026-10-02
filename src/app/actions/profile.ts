'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { database } from '@/db/client';
import { users } from '@/db/schema';
import { requireUser } from '@/lib/auth';

/**
 * The signed-in person's own display name and default currency. A write, so a Server Action
 * and not a route.
 */

export interface ProfileResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string;
}

/**
 * Rejected rather than truncated. 'usd' normalises to 'USD'; 'EURO' and 'US$' are refused,
 * because silently shortening a currency code stores a currency nobody meant and the mistake
 * surfaces later as a wrong amount.
 */
const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value), 'Use a three-letter currency code, like USD or EUR.');

const profileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, 'Enter a name to show to your groups.')
    .max(80, 'That name is too long.'),
  defaultCurrency: currencySchema,
});

export async function updateProfile(_previous: ProfileResult | null, formData: FormData): Promise<ProfileResult> {
  const parsed = profileSchema.safeParse({
    displayName: formData.get('displayName'),
    defaultCurrency: formData.get('defaultCurrency'),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'form');
      fieldErrors[field] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }

  // Authorisation before the write: the row is the caller's own, never one named by input.
  const user = await requireUser();
  const db = await database();

  await db
    .update(users)
    .set({ displayName: parsed.data.displayName, defaultCurrency: parsed.data.defaultCurrency })
    .where(eq(users.id, user.id));

  // The top bar shows the name on every signed-in screen.
  revalidatePath('/', 'layout');
  return { ok: true };
}