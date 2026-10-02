import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { createDatabase, setDatabase } from '@/db/client';
import { GET } from '@/app/api/health/route';
import * as env from '@/lib/env';

afterAll(async () => {
  vi.restoreAllMocks();
  await closeTestDatabase();
});

/** Everything a caller could learn from the body, checked the way AC-2 words it. */
function expectNoCredentials(body: string) {
  expect(body).not.toContain('postgres://');
  expect(body).not.toContain('postgresql://');
  expect(body).not.toMatch(/password/i);
  expect(body).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
}

describe('GET /api/health', () => {
  beforeEach(async () => {
    await useTestDatabase();
  });

  it('returns 200 with a real query and a positive latency', async () => {
    const response = await GET();
    const body = (await response.json()) as { status: string; database: string; latencyMs: number };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.database).toBe('ok');
    expect(body.latencyMs).toBeGreaterThan(0);
    expectNoCredentials(JSON.stringify(body));
  });

  it('returns 503 with the fixed database sentence against a closed client, and no driver text', async () => {
    // A client whose queries cannot work: the message the driver would have produced is the
    // thing that must not reach the body.
    setDatabase(
      createDatabase({
        query: () => Promise.reject(new Error('connect ECONNREFUSED postgres://db.internal:5432/tabs password=hunter2')),
      } as never),
    );

    const response = await GET();
    const raw = await response.text();
    const body = JSON.parse(raw) as { status: string; database: string; error: string };

    expect(response.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('error');
    expect(body.error).toBe('the database could not be reached');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('ECONNREFUSED');
    expectNoCredentials(raw);
  });

  it('returns 503 with a DIFFERENT fixed sentence when the process is not configured', async () => {
    vi.spyOn(env, 'config').mockImplementation(() => {
      throw new Error('tabs: cannot start — missing required environment variable: TABS_HMAC_KEY');
    });

    const response = await GET();
    const body = (await response.json()) as { database: string; error: string };

    expect(response.status).toBe(503);
    expect(body.database).toBe('unconfigured');
    // Different from the database sentence, because claiming a database fault when the process
    // was never configured is a lie an operator would chase in the wrong place.
    expect(body.error).not.toBe('the database could not be reached');
    expect(body.error).toMatch(/not configured/);
    vi.restoreAllMocks();
  });

  it('needs no session', async () => {
    // No cookie store is installed anywhere in this file: if GET touched one it would throw
    // `cookies() was called outside a request scope` rather than answering 200.
    await expect(useTestDatabase()).resolves.toBeDefined();
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it('reports a database whose tables are missing rather than a config fault', async () => {
    const db = await useTestDatabase();
    await db.execute(sql`DROP TABLE users CASCADE`);

    const response = await GET();
    // `select 1` still answers, which is the point: the health endpoint proves the database
    // is reachable, not that the schema is current.
    expect(response.status).toBe(200);
  });
});