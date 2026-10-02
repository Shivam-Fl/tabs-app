import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { database } from '@/db/client';
import { readMembership, resolveGroupByToken } from '@/lib/access';
import { currentUser } from '@/lib/auth';
import { JoinScreen } from '@/components/join-screen';
import { Card } from '@/components/ui';

export const metadata: Metadata = { title: 'Join · Tabs' };

/**
 * The page an invite link opens. It sits OUTSIDE the (app) route group, and for the same reason
 * sign-in does: the whole point of a shared link is that a signed-out person can open it, and
 * anything under (app) would run the shell and bounce them through a redirect that loses the
 * destination on the way.
 *
 * There is no write on this route at all. That is what makes the link safe to prefetch, to
 * paste into a chat client that unfurls it, or to open twice — a GET renders a question and
 * the answer is a POST, so nothing joins anybody by being looked at. The confirm is
 * joinWithToken, a Server Action, and the page merely decides what to offer.
 *
 * The token shape is checked BEFORE any read, so a malformed one costs nothing and is answered
 * with the same not-found page as a well-formed one that resolves to nothing. Rotation,
 * disabling, archiving and mere wrongness are deliberately indistinguishable from out here:
 * the page says nothing about a group whose token is not live.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TOKEN_PATTERN.test(token)) notFound();

  const user = await currentUser();
  // The destination survives the detour: sign-in and sign-up both carry a validated ?next
  // through to here, so somebody who had to create an account first still lands on the invite
  // rather than on an empty home screen.
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/join/${token}`)}`);

  const db = await database();
  const group = await resolveGroupByToken(db, token);
  if (!group) notFound();

  const membership = await readMembership(db, group.id, user.id);

  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-bg p-space-6">
      <Card className="w-full max-w-[360px]">
        {/* Both states come out of one Client Component: the confirm's action revalidates this
            route, and a re-render that swapped the form for a server-rendered notice would
            unmount it before it could navigate. See src/components/join-screen.tsx. */}
        <JoinScreen
          token={token}
          groupId={group.id}
          groupName={group.name}
          isMember={membership !== null}
        />
        <p className="mt-space-4 text-sm text-text-muted">
          Not the right link?{' '}
          <Link
            href="/"
            className="inline-flex min-h-[44px] min-w-[44px] items-center text-primary underline"
          >
            Go home
          </Link>
        </p>
      </Card>
    </main>
  );
}
