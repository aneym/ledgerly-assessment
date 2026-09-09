import { randomBytes } from "node:crypto";

/** Short, prefix-typed local ids. Prefixes are on the redaction allowlist. */
export function newId(prefix: "run" | "evt" | "step" | "ev" | "fx" | "req"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
