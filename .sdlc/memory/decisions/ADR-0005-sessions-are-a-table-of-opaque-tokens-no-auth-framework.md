# ADR-0005: Sessions are a table of opaque tokens; no auth framework

**Date:** 2026-10-01
**Status:** accepted
**Forced by:** #1

## Decision
Sign-in generates 32 random bytes, stores only their SHA-256 in a sessions row with an expiry, and sets the raw token in an httpOnly, Secure, SameSite=Lax cookie. Every page and action resolves the cookie to a user through one requireUser() helper. Signing out deletes the row and clears the cookie. Failed sign-ins are counted in a login_attempts table keyed by a hash of the email and the source address.

## Why
The requirement is a secure httpOnly cookie and a session that ends on the server, and that is a table and a helper. A framework would add provider and callback configuration, its own session storage decisions and a version history that moves, all of which the pipeline's agents would have to learn before writing a line of product code. A database-backed rate limiter is also the only kind that works on Vercel, where a per-instance memory counter resets on every cold start and is trivially bypassed.

## Consequences
Easy: the security properties are visible in one file a reviewer can read; rate limiting survives a cold start and works across every function instance. Hard: we own the details — cookie rotation, expiry, CSRF posture on Server Actions and the exact failure message — and password reset and account deletion, which are non-goals here, are more work than they would be under a framework that ships them.
