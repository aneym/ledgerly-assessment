import type { SafeIds } from "./types";

// A value starting with one of these prefixes is a credential shape, not an identifier.
// Finding one in safe_ids means a caller passed a secret where an id belongs — that is a
// bug in the caller, so this throws instead of silently dropping or masking the value.
const secretPrefixes = ["apik_", "ws_", "Bearer", "npg_"];

export function redactSafeIds(safeIds: SafeIds): SafeIds {
  for (const [key, value] of Object.entries(safeIds)) {
    if (secretPrefixes.some((prefix) => value.startsWith(prefix)))
      throw new Error(`safe_ids.${key} looks like a secret, not an identifier`);
  }
  return safeIds;
}
