"use client";

import { useEffect, useState } from "react";
import { PillButton } from "@/components/pill";
import {
  type ApiFailure,
  apiRequest,
  isJsonObject,
  isNotLive,
  pickCorrelationId,
} from "@/lib/buyer/api";
import { NotLive } from "./NotLive";

type Phase = { kind: "idle" } | { kind: "pending" } | { kind: "failed"; failure: ApiFailure };

/** Ends the session through the app API, then reloads from the home page (or `next`). */
export function SignOut({ correlationId, next }: { correlationId: string; next?: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [mounted, setMounted] = useState(false);

  // Keep the button disabled until React has attached its click handler.
  useEffect(() => setMounted(true), []);

  async function signOut() {
    if (!mounted || phase.kind === "pending") return;
    setPhase({ kind: "pending" });
    // Better Auth answers { success: true }; anything else is not a sign-out.
    const result = await apiRequest<unknown>("/api/auth/sign-out", {
      method: "POST",
      body: {},
      correlationId: pickCorrelationId(correlationId),
      expect: (data) => isJsonObject(data) && (data as { success?: unknown }).success === true,
    });
    if (result.ok) {
      window.location.assign(next && /^\/(?![/\\])/.test(next) ? next : "/");
      return;
    }
    setPhase({ kind: "failed", failure: result });
  }

  const notLive = phase.kind === "failed" && isNotLive(phase.failure);

  return (
    <div className="by-signout">
      <PillButton
        tone="ghost"
        onClick={signOut}
        disabled={!mounted || phase.kind === "pending"}
        data-tour="account.signout"
      >
        {phase.kind === "pending" ? "Signing out" : "Sign out"}
      </PillButton>
      {phase.kind === "failed" ? (
        <div className="by-signout-result">
          <NotLive
            failure={phase.failure}
            title={notLive ? "Sign-out API is not live yet" : "Could not sign you out"}
            inline
            tone={notLive ? undefined : "bad"}
          />
        </div>
      ) : null}
    </div>
  );
}
