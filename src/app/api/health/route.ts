import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { database } from '@/db/client';
import { config } from '@/lib/env';

/**
 * GET /api/health — what sdlc:ready polls and what any uptime check uses.
 *
 * A 200 here has to mean the database answered, or every later ticket's readiness check is
 * theatre. Every failure is a 503 and never a throw: curl -f treats 503 as failure, which is
 * the whole tripwire this route carries.
 *
 * The config and the client are both reached through the same accessors the rest of the
 * application uses, which is what lets a test install its own PGlite and its own resolved
 * config and drive this handler directly.
 */

export const dynamic = 'force-dynamic';

/**
 * Two fixed sentences, and the body never carries anything else — so it can never carry the
 * driver's own text, a connection string or a host with credentials. They differ because
 * claiming a database fault when the process was never configured is a lie an operator would
 * go and chase in the wrong place.
 */
export const DATABASE_ERROR = 'the database could not be reached';
export const UNCONFIGURED_ERROR = 'the application is not configured';

export async function GET(): Promise<NextResponse> {
  try {
    config();
  } catch {
    return NextResponse.json({ status: 'degraded', database: 'unconfigured', error: UNCONFIGURED_ERROR }, { status: 503 });
  }

  const started = performance.now();
  try {
    const db = await database();
    await db.execute(sql`SELECT 1`);
    // At least 1ms: a round trip below a millisecond still took real time, and "latencyMs: 0"
    // would read as "this did not actually query anything".
    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    return NextResponse.json({ status: 'ok', database: 'ok', latencyMs }, { status: 200 });
  } catch {
    return NextResponse.json({ status: 'degraded', database: 'error', error: DATABASE_ERROR }, { status: 503 });
  }
}