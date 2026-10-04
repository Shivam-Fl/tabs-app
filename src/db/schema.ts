import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * The single description of the data model. Every table, column, constraint and index.
 *
 * This file does NOT create the migrator's applied-migrations bookkeeping table: that is
 * migrate.ts's own state, created by migrate.ts, because a first boot on an empty database
 * has to create it before it can read it.
 */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Stored lowercased and trimmed by the sign-up action, so `unique` here and the local
  // guarantee agree. Not citext: that would make the local guarantee and the production one
  // differ on an extension PGlite may not carry.
  email: text('email').notNull().unique(),
  // The salted scrypt hash and its parameters. Never the password.
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  // A currency code, not money. A group's column will copy this at creation.
  defaultCurrency: varchar('default_currency', { length: 3 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // $onUpdate rather than a column the action has to remember: defaultNow() alone writes it
  // once at insert and never again, so every profile edit would leave it at the creation time.
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Only the SHA-256 of the 32-byte random token. One-way because the input has 2^256
    // entropy. Unique is what makes resolving a session one indexed read.
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_token_hash_idx').on(table.tokenHash), index('sessions_user_id_idx').on(table.userId)],
);

/** What kind of thing a group is. 'other' is the default, so the column is never empty. */
export const groupTypes = ['trip', 'home', 'couple', 'other'] as const;

export type GroupType = (typeof groupTypes)[number];

export const groupType = pgEnum('group_type', groupTypes);

export const groups = pgTable('groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // A copy of its creator's default currency, not a reference: changing the default later
  // must not restate what a group's amounts were recorded in.
  currency: varchar('currency', { length: 3 }).notNull(),
  // Defaulted rather than nullable so every screen that shows a type has one to show.
  type: groupType('type').notNull().default('other'),
  // Piece 5's invite link: base64url of 32 random bytes, unique so a link resolves one group.
  // Written from creation onward because the token is a property of the group row, not of the
  // invite screen that will copy it.
  inviteToken: text('invite_token').notNull().unique(),
  inviteEnabled: boolean('invite_enabled').notNull().default(true),
  // Archiving is reversible and does not write an activity kind of its own beyond group.archived;
  // an archived group leaves the home list and stays readable by direct URL.
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    // Null while the member is a placeholder and set when one is claimed. A claimed row keeps
    // the name it was created with — the name written here is for the placeholder that has no
    // account to take one from, and every read prefers the live profile where there is one.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The name a placeholder was given before its owner had an account. Null for every member
     * who has one, and never the column a read presents: readMembers coalesces
     * users.display_name ?? members.display_name, so a claimed placeholder shows the claimer's
     * live profile name while the stored one stays as the record of what was typed.
     */
    displayName: text('display_name'),
    isOwner: boolean('is_owner').notNull().default(false),
    // Removal sets this; the row is NEVER deleted, because a stored share or payer record
    // points at it and discarding it would restate every other member's balance (TR-16).
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One active membership per person per group. The `removed_at IS NULL` clause is
     * load-bearing: without it a second row for the same person is rejected even after the
     * first was removed, so rejoining a group you left would fail with a duplicate key.
     */
    uniqueIndex('members_group_user_active_idx')
      .on(table.groupId, table.userId)
      .where(sql`${table.userId} is not null and ${table.removedAt} is null`),
    /**
     * Exactly one owner per group, as a database constraint rather than a convention. The
     * predicate is `is_owner` alone, so an owner row that was removed still holds the slot —
     * the owner can never leave, and a group can never be left ownerless.
     */
    uniqueIndex('members_group_owner_idx')
      .on(table.groupId)
      .where(sql`${table.isOwner}`),
    index('members_user_id_idx').on(table.userId),
  ],
);

/** How an expense's total is divided. The entered rule, kept beside the amounts it produced. */
export const expenseSplitTypes = ['equal', 'exact', 'percentage', 'shares'] as const;

export type ExpenseSplitType = (typeof expenseSplitTypes)[number];

export const expenseSplitType = pgEnum('expense_split_type', expenseSplitTypes);

/** What an expense was for. Optional on the row: a category is a filter, never a requirement. */
export const expenseCategories = [
  'food',
  'travel',
  'rent',
  'utilities',
  'shopping',
  'entertainment',
  'other',
] as const;

export type ExpenseCategory = (typeof expenseCategories)[number];

export const expenseCategory = pgEnum('expense_category', expenseCategories);

/**
 * Something that was paid for. The amounts the entered rule produced live in expense_payer,
 * expense_share and expense_split_input, and only the first two are ever read to compute a
 * balance (TR-4): the rule rows exist so an edit can reopen the form exactly as it was saved.
 */
export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    // The group's currency, copied onto the row rather than joined: it is what this amount was
    // recorded in, and a group whose currency ever changed must not restate its history.
    currency: varchar('currency', { length: 3 }).notNull(),
    splitType: expenseSplitType('split_type').notNull(),
    category: expenseCategory('category'),
    note: text('note'),
    // A CALENDAR date, not a timestamp: a timestamptz would shift by the server's zone and
    // reorder the newest-first list for anyone whose day starts earlier than the server's.
    date: date('date').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // Piece 5 deletes by setting this; every read here filters on it so the column is already
    // load-bearing rather than a flag somebody has to remember to add a filter for.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // The list's own order, newest first by the date it happened on.
    index('expenses_group_date_idx').on(table.groupId, table.date.desc()),
    // TR-18's search half arrives in piece 8; the index is generated here because it belongs
    // to the table's shape rather than to the screen that first reads it.
    index('expenses_description_idx').on(table.description),
  ],
);

/** One member's part of an expense's total. The parts sum exactly to the expense (TR-5). */
export const expensePayer = pgTable(
  'expense_payer',
  {
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  },
  // Composite primary key, exactly as the TRD's key list specifies: a member appears once per
  // expense as a payer, and a second row is a duplicate rather than a second contribution.
  (table) => [primaryKey({ columns: [table.expenseId, table.memberId] })],
);

/**
 * One member's resulting share of an expense, computed once when it is written. Together with
 * expense_payer this is the whole ledger: a balance is a sum over these rows and never a
 * re-evaluation of the stored rule (TR-4).
 */
export const expenseShare = pgTable(
  'expense_share',
  {
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.expenseId, table.memberId] })],
);

/**
 * One member's place in the split, with the number that member was given. The row's existence
 * is the record that this member was included — a member removed from the split has their row
 * deleted rather than zeroed.
 *
 * The unit is fixed by the expense's split_type: minor units for `exact`, hundredths of a
 * percent for `percentage`, a plain count for `shares`, and null for `equal`, where the only
 * stored input is membership. Never read to compute a balance.
 */
export const expenseSplitInput = pgTable(
  'expense_split_input',
  {
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    inputValue: bigint('input_value', { mode: 'bigint' }),
  },
  (table) => [primaryKey({ columns: [table.expenseId, table.memberId] })],
);

/**
 * A recorded settlement: the money one member actually handed another. TR-7's first-class record
 * and the second half of the ledger a balance is summed from — a payment moves both balances by
 * its amount, so it is written here rather than derived from the transfer list, which is an
 * answer about stored rows and never a row itself.
 *
 * There is no currency column. A payment settles a debt the group recorded in the group's own
 * currency, and that currency is fixed when the group is created, so a copy here could only
 * disagree with it.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    // Membership rows rather than users, like every other member reference in the ledger: a
    // placeholder can be paid, and a departed member's rows keep their names (TR-16).
    fromMemberId: uuid('from_member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    toMemberId: uuid('to_member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    note: text('note'),
    // Who recorded it. Nullable for the reason an expense's created_by is: a person can be
    // deleted while their group's history stays.
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Deleting a payment sets this rather than removing the row: the payment.recorded entry that
    // named it outlives it, and every read of a balance or a list filters on this column.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // The list's own order, newest first, with created_at leading the group's payments into an
    // index scan rather than a sort of every payment the group has ever had.
    index('payments_group_created_idx').on(table.groupId, table.createdAt.desc()),
  ],
);

/**
 * What an activity entry is about, for the entries that name a subject rather than a membership.
 * A union rather than a free string so a new subject has to be named here — and so the row a
 * reader cannot interpret is a compile error rather than a null.
 */
export const activitySubjectTypes = ['expense', 'payment'] as const;

export type ActivitySubjectType = (typeof activitySubjectTypes)[number];

/**
 * The feed's kinds. Every mutation writes exactly one entry, in the same transaction as the
 * change (TR-17). The `group.*` kinds are lifecycle, not spending, which is why the overview's
 * recent-activity block excludes them: a brand-new group would otherwise show "you created
 * this group" where the criterion requires "Nothing here yet".
 *
 * `expense.edited`'s detail names only the fields that MOVED, each as `{ from, to }` — so a save
 * that changed the amount and nothing else says so, and an untouched save carries an empty
 * object rather than a claim that something happened that did not:
 *
 *   { description: { from, to }, amountMinor: { from: '1000', to: '2000' }, date, category,
 *     note, splitType, payers: { from: [{ memberId, amountMinor }], to: [...] },
 *     participants: { from: [{ memberId, inputValue }], to: [...] } }
 *
 * Every money value inside is a STRING of minor units, for the reason the `detail` column gives
 * below. `payers` and `participants` are lists in the group's canonical member order, so a
 * reordered submission is not a change.
 *
 * `expense.deleted` carries the expense as it was — description, amountMinor, currency — because
 * the entry outlives the thing it names: the parent row is soft-deleted and every read filters
 * it out, so the feed could not otherwise say what was removed.
 *
 * `payment.recorded` and `payment.deleted` carry the payment both ways round — who paid whom and
 * how much — in one shape, because a deleted payment is soft-deleted exactly as an expense is and
 * the entry is the only thing left that can say what it moved:
 *
 *   { fromMemberId, toMemberId, amountMinor: '400', note }
 *
 * `amountMinor` is a STRING of minor units, again for the reason the `detail` column gives.
 */
export const activityKinds = [
  'group.created',
  'group.renamed',
  'group.archived',
  'group.invite_rotated',
  'group.invite_disabled',
  'member.joined',
  'member.left',
  'member.removed',
  'member.placeholder_added',
  'member.claimed',
  'expense.added',
  'expense.edited',
  'expense.deleted',
  'payment.recorded',
  'payment.deleted',
] as const;

export type ActivityKind = (typeof activityKinds)[number];

export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    // Who did it. Nullable because a person can be deleted while their group's history stays.
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    // The membership row the entry is about — the member who joined, left or was removed.
    // This is what makes "is the last thing that happened to this membership a leave by its
    // own member?" a single indexed read.
    memberId: uuid('member_id').references(() => members.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ActivityKind>().notNull(),
    /**
     * What the entry is about, for the kinds that name a subject rather than a membership: an
     * expense, or a payment. Both are null for the membership and lifecycle kinds, which name a
     * member_id instead.
     */
    subjectType: text('subject_type').$type<ActivitySubjectType>(),
    subjectId: uuid('subject_id'),
    /**
     * What changed, for the kinds that carry it. jsonb rather than columns because the shape is
     * per-kind: an expense.added records the expense as it was entered, and an expense.edited
     * (piece 5) records each field that moved. Money is stored here as a STRING of minor units,
     * because jsonb numbers are floats and 0.1 is exactly the value this product must not have.
     */
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('activity_group_created_idx').on(table.groupId, table.createdAt),
    index('activity_member_created_idx').on(table.memberId, table.createdAt),
  ],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // HMAC-SHA-256 of the trimmed-lowercased email, keyed. Not a plain digest: an email is
    // low-entropy and any wordlist reverses it.
    keyHash: text('key_hash').notNull(),
    // The same for the source address, which an IPv4 space exhausts in minutes.
    sourceHash: text('source_hash').notNull(),
    succeeded: boolean('succeeded').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('login_attempts_key_created_idx').on(table.keyHash, table.createdAt),
    index('login_attempts_source_created_idx').on(table.sourceHash, table.createdAt),
  ],
);

