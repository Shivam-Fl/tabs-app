// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { GroupOverview } from '@/components/group-overview';
import type { ActivityRow, GroupRow, MemberRow } from '@/lib/access';

afterEach(cleanup);

/**
 * Both of this screen's designed strings, read out of docs/ui.md rather than retyped here.
 *
 * Two plans for this issue were rejected for pinning a string that had been typed from memory,
 * so these assertions compare against the design document itself: an em dash that became a
 * hyphen, or an apostrophe an editor "helpfully" curled, fails CI instead of passing the suite
 * and failing the criterion in QA.
 */
const UI_MD = readFileSync(join(process.cwd(), 'docs', 'ui.md'), 'utf8').split('\n');

/** docs/ui.md line 123: the overview's empty recent-activity block. */
const EMPTY_ACTIVITY = /recent activity says "(.+)"/.exec(UI_MD[122] ?? '')?.[1] ?? '';
/** docs/ui.md line 165: the settled message that replaces the transfer list. */
const SETTLED = /the settled message — "(.+)"/.exec(UI_MD[164] ?? '')?.[1] ?? '';

const group: GroupRow = {
  id: '6b1f2f9c-0f1a-4a4f-9d1f-2f0a6c7b8d90',
  name: 'Lisbon',
  currency: 'EUR',
  type: 'trip',
  archivedAt: null,
};

const member: MemberRow = {
  memberId: 'm-1',
  displayName: 'Priya',
  isOwner: true,
  isPlaceholder: false,
  balanceMinor: 0n,
};

const entry: ActivityRow = {
  id: 'a-1',
  kind: 'member.joined',
  actorId: 'u-1',
  actorName: 'Priya',
  memberId: 'm-1',
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
};

describe('the overview’s empty-state strings', () => {
  it('reads the design document’s words, so a retyped one would not be what is asserted', () => {
    // Guards the extraction itself: if docs/ui.md is reworded, these fail here rather than
    // silently comparing two empty strings.
    expect(EMPTY_ACTIVITY).toBe('Nothing here yet — add the first expense.');
    expect(SETTLED).toBe("Everyone's square in this group.");
  });

  it('renders the empty-activity sentence with the EM DASH at offset 17', () => {
    render(<GroupOverview group={group} members={[member]} entries={[]} />);

    const rendered = screen.getByText(/^Nothing here yet/).textContent ?? '';
    expect(rendered).toBe(EMPTY_ACTIVITY);
    expect(rendered.codePointAt(17)).toBe(0x2014);

    // The regression: an ASCII hyphen sits at the same offset and reads as the same sentence.
    expect('Nothing here yet - add the first expense.'.codePointAt(17)).toBe(0x002d);
  });

  it('renders the settled sentence with the ASCII apostrophe U+0027', () => {
    render(<GroupOverview group={group} members={[member]} entries={[]} />);

    const rendered = screen.getByText(/square in this group/).textContent ?? '';
    expect(rendered).toBe(SETTLED);
    expect(rendered.codePointAt(8)).toBe(0x0027);

    // The regression: U+2019 is what an editor produces, and it is a different string.
    expect('Everyone’s square in this group.'.codePointAt(8)).toBe(0x2019);
  });

  it('renders whatever entries it is handed, because excluding the lifecycle kinds is the query’s job', () => {
    /**
     * The exclusion of group.created, group.renamed and group.archived lives in
     * readRecentActivity's WHERE clause — tests/integration/groups.test.ts asserts it against
     * the database, which is the only place it can be asserted, because a presentational
     * component has no query to run.
     *
     * What IS this component's business is not filtering a second time. If it did, the two
     * would be able to disagree, and a kind excluded in one place and not the other would show
     * a lifecycle entry the design document says is not there.
     */
    const renamed: ActivityRow = { ...entry, id: 'a-2', kind: 'group.renamed' };
    const archived: ActivityRow = { ...entry, id: 'a-3', kind: 'group.archived' };

    render(<GroupOverview group={group} members={[member]} entries={[renamed, archived]} />);

    expect(screen.getByText(/renamed the group/)).toBeInTheDocument();
    expect(screen.getByText(/archived the group/)).toBeInTheDocument();
    expect(screen.queryByText(/^Nothing here yet/)).not.toBeInTheDocument();
  });

  it('shows the empty block only while there is nothing to show', () => {
    const { unmount } = render(<GroupOverview group={group} members={[member]} entries={[]} />);
    expect(screen.getByText(/^Nothing here yet/)).toBeInTheDocument();
    unmount();

    render(<GroupOverview group={group} members={[member]} entries={[entry]} />);
    expect(screen.queryByText(/^Nothing here yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/joined the group/)).toBeInTheDocument();
  });
});
