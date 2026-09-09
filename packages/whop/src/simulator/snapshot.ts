// Internal snapshots contain only state from the explicit mock provider, never credentials.
export function restoreCollections(
  target: Record<string, Map<unknown, unknown> | unknown[]>,
  source: unknown,
) {
  if (!source || typeof source !== "object") throw new Error("Invalid mock snapshot");
  const record = source as Record<string, unknown>;
  if (Object.keys(target).length !== Object.keys(record).length)
    throw new Error("Mock snapshot version mismatch");
  for (const [key, collection] of Object.entries(target)) {
    const saved = record[key];
    if (collection instanceof Map) {
      if (!(saved instanceof Map)) throw new Error("Invalid mock snapshot collection");
      collection.clear();
      for (const [id, value] of saved) collection.set(id, structuredClone(value));
    } else {
      if (!Array.isArray(saved)) throw new Error("Invalid mock snapshot list");
      collection.splice(0, collection.length, ...structuredClone(saved));
    }
  }
}
export function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid mock snapshot counter");
  return value;
}
