import type { ReactNode } from "react";
import { Ledger, LedgerLine } from "@/components/ledger-line"; // file import: NotLive also renders inside client components
import type { ApiFailure } from "@/lib/buyer/api";
import { Chip } from "./primitives";

/**
 * The honest state for a screen whose API route answered with an error, or is
 * not there yet. Shows the method, the path and the status as a ledger line so
 * a reader sees exactly which request did not happen.
 */
export function NotLive({
  failure,
  title,
  children,
  actions,
  inline = false,
  tone,
}: {
  failure: ApiFailure;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** Compact variant for error slots inside forms and cards. */
  inline?: boolean;
  tone?: "bad";
}) {
  const unreachable = failure.kind === "network";
  const statusLabel = unreachable ? "not reached" : String(failure.status);
  const chipTone =
    failure.status === 404 || unreachable
      ? "plain"
      : failure.kind === "unexpected" || (failure.status ?? 0) >= 500
        ? "bad"
        : "warn";
  return (
    <div
      className={["by-notlive", inline ? "by-inline" : "", tone ?? ""].filter(Boolean).join(" ")}
      role={inline ? "alert" : undefined}
    >
      <h2 className="by-h3">{title}</h2>
      <Ledger>
        <LedgerLine
          label={<span className="by-req">{`${failure.method} ${failure.path}`}</span>}
          value={
            <Chip tone={chipTone} code>
              {statusLabel}
            </Chip>
          }
        />
        {failure.apiMessage ? (
          <LedgerLine label="Server said" value={failure.apiMessage} quiet wrap />
        ) : null}
        {unreachable ? (
          <LedgerLine label="Reason" value="could not reach the app API" quiet wrap />
        ) : null}
        {failure.kind === "unexpected" ? (
          <LedgerLine
            label="Reason"
            value="unexpected response: not the JSON shape this screen expects"
            quiet
            wrap
          />
        ) : null}
      </Ledger>
      {children}
      {actions ? <div className="act">{actions}</div> : null}
    </div>
  );
}
