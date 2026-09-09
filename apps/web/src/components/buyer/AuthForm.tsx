"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useId, useState } from "react";
import { PillButton } from "@/components/pill";
import { type ApiFailure, apiRequest, isNotLive, pickCorrelationId } from "@/lib/buyer/api";
import { NotLive } from "./NotLive";

type Mode = "signup" | "signin";

// Better Auth's catch-all at /api/auth/[...all]. Bodies are { email, password, name? };
// a 4xx comes back as { code, message } and the message is shown as "Server said".
const ROUTE: Record<
  Mode,
  { path: string; verb: string; busy: string; notLive: string; failed: string }
> = {
  signup: {
    path: "/api/auth/sign-up/email",
    verb: "Create account",
    busy: "Creating your account",
    notLive: "Sign-up API is not live yet",
    failed: "Could not create your account",
  },
  signin: {
    path: "/api/auth/sign-in/email",
    verb: "Sign in",
    busy: "Signing you in",
    notLive: "Sign-in API is not live yet",
    failed: "Could not sign you in",
  },
};

/** Only same-origin paths are allowed as a post-auth destination. */
export function safeNext(candidate: string | null | undefined, fallback = "/library"): string {
  if (!candidate) return fallback;
  return /^\/(?![/\\])/.test(candidate) ? candidate : fallback;
}

type Phase =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "failed"; failure: ApiFailure }
  | { kind: "done" };

export function AuthForm({
  mode,
  next,
  correlationId,
}: {
  mode: Mode;
  next: string | null;
  /** From the `correlationId` search param when the demo runtime supplied one. */
  correlationId: string | null;
}) {
  const route = ROUTE[mode];
  const anchor = mode === "signup" ? "signup" : "signin";
  const ids = { name: useId(), email: useId(), password: useId() };
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [mounted, setMounted] = useState(false);

  // Keep native controls disabled until React has attached the form handlers.
  useEffect(() => setMounted(true), []);
  const [showPassword, setShowPassword] = useState(false);
  const destination = safeNext(next);
  const nextQuery = next ? `?next=${encodeURIComponent(destination)}` : "";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mounted || phase.kind === "pending" || phase.kind === "done") return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();
    const body = mode === "signup" ? { email, password, name } : { email, password };

    setPhase({ kind: "pending" });
    // Better Auth answers { token, user: { id, ... } }; without a user id nothing signed in.
    const result = await apiRequest<unknown>(route.path, {
      method: "POST",
      body,
      correlationId: pickCorrelationId(correlationId),
      expect: (data) => {
        const user = (data as { user?: { id?: unknown } } | null)?.user;
        return typeof user?.id === "string" && user.id !== "";
      },
    });
    if (result.ok) {
      setPhase({ kind: "done" });
      // A full navigation, so server components re-read the new session cookie.
      window.location.assign(destination);
      return;
    }
    setPhase({ kind: "failed", failure: result });
  }

  const pending = phase.kind === "pending" || phase.kind === "done";
  const failed = phase.kind === "failed" ? phase.failure : null;
  const notLive = failed !== null && isNotLive(failed);

  return (
    // Better Auth takes JSON only. Native controls stay disabled until the JSON handler
    // is ready; POST also keeps credentials out of a fallback navigation query string.
    <form method="post" onSubmit={onSubmit}>
      <fieldset className="by-form min-w-0 border-0 p-0" disabled={!mounted || pending}>
        {mode === "signup" ? (
          <label className="field" htmlFor={ids.name}>
            Name
            <input
              id={ids.name}
              name="name"
              type="text"
              autoComplete="name"
              required
              maxLength={120}
              placeholder="Shown on your receipts"
              data-tour="signup.name"
            />
          </label>
        ) : null}

        <label className="field" htmlFor={ids.email}>
          Email
          <input
            id={ids.email}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            placeholder="you@example.com"
            data-tour={`${anchor}.email`}
          />
        </label>

        <div className="field">
          <label htmlFor={ids.password}>Password</label>
          <div className="by-input-wrap">
            <input
              id={ids.password}
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              minLength={mode === "signup" ? 8 : 1}
              placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
              data-tour={`${anchor}.password`}
            />
            <button
              type="button"
              className="by-input-tail"
              onClick={() => setShowPassword((value) => !value)}
              aria-pressed={showPassword}
              aria-controls={ids.password}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        <div className="by-error-slot" data-tour={`${anchor}.error`} aria-live="polite">
          {failed ? (
            <NotLive
              failure={failed}
              title={notLive ? route.notLive : route.failed}
              inline
              tone={notLive ? undefined : "bad"}
            >
              {notLive ? <p>The API is unavailable. This request was not confirmed.</p> : null}
            </NotLive>
          ) : null}
        </div>

        <PillButton
          type="submit"
          tone="buy"
          size="lg"
          wide
          disabled={!mounted || pending}
          data-tour={`${anchor}.submit`}
        >
          {pending ? route.busy : route.verb}
        </PillButton>

        <p className="by-auth-foot">
          {mode === "signup" ? (
            <>
              Already have an account?{" "}
              <Link className="by-link" href={`/signin${nextQuery}`}>
                Sign in
              </Link>
            </>
          ) : (
            <>
              New to Ledgerly?{" "}
              <Link className="by-link" href={`/signup${nextQuery}`}>
                Create an account
              </Link>
            </>
          )}
        </p>
      </fieldset>
    </form>
  );
}
