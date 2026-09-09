import { randomUUID } from "node:crypto";

// A structural subset of the Fetch API's Headers, so this stays independent of the DOM
// lib and of any framework's request type.
export interface HeaderLike {
  get(name: string): string | null;
}

const correlationHeader = "x-ledgerly-correlation-id";

export function correlationFromHeaders(headers: HeaderLike): string {
  return headers.get(correlationHeader) ?? randomUUID();
}
