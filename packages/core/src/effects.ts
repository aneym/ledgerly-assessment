import { type EffectKey, parseEffectKey } from "./ids";
export const eventAliases: Readonly<Record<string, string>> = {
  "withdrawal.updated": "payout.updated",
  "withdrawal.created": "payout.created",
};
export const canonicalEventType = (eventType: string): string =>
  Object.hasOwn(eventAliases, eventType) ? (eventAliases[eventType] ?? eventType) : eventType;
export function effectKey(resourceType: string, resourceId: string, transition: string): EffectKey {
  if ([resourceType, resourceId, transition].some((part) => !part || part.includes(":")))
    throw new Error("Effect key components must be nonempty and contain no colon");
  const canonical = canonicalEventType(`${resourceType}.${transition}`);
  const separator = canonical.lastIndexOf(".");
  const result = parseEffectKey(
    `${canonical.slice(0, separator)}:${resourceId}:${canonical.slice(separator + 1)}`,
  );
  if (!result.ok) throw new Error("Invalid effect key");
  return result.value;
}
