import { index, pgTable, uuid, varchar, text, timestamp, boolean } from 'drizzle-orm/pg-core';

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

