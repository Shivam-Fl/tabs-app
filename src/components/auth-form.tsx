'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { signIn, signUp } from '@/app/actions/auth';
import type { AuthResult } from '@/app/actions/auth';
import { Button, Card, Field } from '@/components/ui';

/**
 * The sign-in and sign-up forms.
 *
 * A Client Component because the busy state does. A Server Action's in-flight state is only
 * observable through useActionState, and docs/ui.md's "Signing in…" is the only busy state
 * any screen uses — without this file it had nowhere to live.
 *
 * The fields are controlled because React resets an uncontrolled form once its action runs,
 * and an expected failure must leave everything the person typed on screen.
 *
 * It imports from src/components/ui and nothing from src/db or src/lib/auth, as
 * conventions.md requires of a Client Component.
 */
export function AuthForm({ mode, next }: { mode: 'sign-in' | 'sign-up'; next?: string }) {
  const router = useRouter();
  // Carried across to the other form, encoded: somebody who lands on the wrong one of these
  // two should not lose the invite they were on their way to by clicking the cross-link. The
  // value is whatever arrived in the query string; the action decides if it is a destination
  // this app is allowed to honour, and this only ever puts it back in a query string.
  const otherMode = mode === 'sign-up' ? '/sign-in' : '/sign-up';
  const crossHref = next ? `${otherMode}?next=${encodeURIComponent(next)}` : otherMode;
  const action = mode === 'sign-up' ? signUp : signIn;
  const [state, formAction, pending] = useActionState<AuthResult | null, FormData>(action, null);

  const formRef = useRef<HTMLFormElement>(null);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (state?.ok && state.redirectTo) router.push(state.redirectTo);
  }, [state, router]);

  // docs/ui.md: focus moves to the first invalid field. The server decides which fields are
  // invalid, so the search is by the aria-invalid the Field already sets.
  useEffect(() => {
    if (!state) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const busyLabel = mode === 'sign-up' ? 'Creating account…' : 'Signing in…';

  return (
    <Card className="w-full max-w-[360px]">
      <h1 className="text-2xl">{mode === 'sign-up' ? 'Create your account' : 'Sign in'}</h1>
      <form ref={formRef} action={formAction} className="mt-space-4 flex flex-col gap-space-3" noValidate>
        {/* Where to land once this succeeds. Travels in the body so the no-JS submit carries it
            too, and non-submitters do not need it: the action falls back to the home screen. */}
        {next ? <input type="hidden" name="next" value={next} /> : null}

        {mode === 'sign-up' ? (
          <Field
            name="displayName"
            label="Your name"
            autoComplete="name"
            required
            value={displayName}
            onChange={setDisplayName}
            error={state?.fieldErrors?.displayName}
          />
        ) : null}

        <Field
          name="email"
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          onChange={setEmail}
          error={state?.fieldErrors?.email}
        />

        <Field
          name="password"
          label="Password"
          type="password"
          autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
          required
          value={password}
          onChange={setPassword}
          error={state?.fieldErrors?.password}
        />

        {/* A form-level message, for failures with no field — a rate limit, a conflict. It is
            the identical string whether the email is unknown or the password is wrong. */}
        {state?.formError ? (
          <p role="alert" className="text-sm text-negative">
            {state.formError}
          </p>
        ) : null}

        <Button type="submit" size="lg" disabled={pending} busyLabel={busyLabel}>
          {mode === 'sign-up' ? 'Create account' : 'Sign in'}
        </Button>
      </form>
      {/* The cross-links are bare anchors inside this paragraph, and the 44px minimum on both
          axes does not apply to an inline box — inline-flex is what makes it apply. */}
      <p className="mt-space-4 text-sm text-text-muted">
        {mode === 'sign-up' ? (
          <>
            Already have an account?{' '}
            <a href={crossHref} className="inline-flex min-h-[44px] min-w-[44px] items-center text-primary underline">
              Sign in
            </a>
          </>
        ) : (
          <>
            New here?{' '}
            <a href={crossHref} className="inline-flex min-h-[44px] min-w-[44px] items-center text-primary underline">
              Create an account
            </a>
          </>
        )}
      </p>
    </Card>
  );
}