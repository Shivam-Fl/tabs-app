import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgEnum,
  pgTable,
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

/**
 * The feed's kinds. Every mutation writes exactly one entry, in the same transaction as the
 * change (TR-17). The `group.*` kinds are lifecycle, not spending, which is why the overview's
 * recent-activity block excludes them: a brand-new group would otherwise show "you created
 * this group" where the criterion requires "Nothing here yet".
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

