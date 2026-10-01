# ADR-0006: Passwords hashed with Node's built-in scrypt, not Argon2

**Date:** 2026-10-01
**Status:** accepted
**Forced by:** #1

## Decision
crypto.scryptSync with N = 2^17, r = 8, p = 1 and a 16-byte random salt per password, stored as a single string carrying the parameters, the salt and the hash. Verification re-derives with the stored parameters. Parameters are recorded in the hash string so they can be raised later without invalidating existing passwords.

## Why
OWASP's password storage guidance ranks Argon2id first and scrypt immediately behind it, with N = 2^17, r = 8, p = 1 as the minimum. Every Argon2 package for Node is a native addon, which is precisely the dependency class this CI cannot install with scripts disabled and which a Vercel function has to bundle. crypto.scrypt is the second-strongest approved algorithm with no dependency, no install step and identical behaviour on every runner.

## Consequences
Easy: no native binary anywhere in the dependency tree, one line of configuration, and the cost factor is legible. Hard: a hash at N = 2^17 takes about 128 MB and roughly a quarter second, so sign-in is deliberately the most expensive thing the app does and the rate limiter is not optional; and we are one algorithm behind the current OWASP preference, which should be revisited if a scriptless Argon2 binding becomes dependable.
