import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { assertLocalRuntimeEnvironment } from "@ledgerly/db";
import type { SimulatorAdapter } from "../../../../packages/whop/src/simulator/adapter";

// A snapshot follows every completed provider call. A crash during any call leaves a
// marker and refuses reopening, because its delivery may have reached the durable inbox.
// This is a local mock provider store, never a replacement for a provider readback.
export function persistLocalProvider(
  provider: SimulatorAdapter,
  env: NodeJS.ProcessEnv,
  allowInitialize = false,
): SimulatorAdapter {
  assertLocalRuntimeEnvironment(env);
  const directory = realpathSync(env.LEDGERLY_LOCAL_DB_DIR as string);
  const snapshot = join(directory, "mock-provider.bin");
  const pending = join(directory, "mock-provider.pending");
  if (existsSync(pending))
    throw new Error(
      "Interrupted local mock provider call; preserve this database for inspection and use a new disposable directory",
    );
  if (existsSync(snapshot)) provider.restoreState(deserialize(readFileSync(snapshot)));
  else if (!allowInitialize)
    throw new Error("Existing local database is missing its mock provider snapshot");
  let active = 0;
  let uncertain = false;
  function begin() {
    if (uncertain)
      throw new Error("Local mock provider requires inspection after an interrupted call");
    if (active === 0) {
      const fd = openSync(pending, "wx", 0o600);
      writeFileSync(fd, "local mock call in progress\n");
      fsyncSync(fd);
      closeSync(fd);
    }
    active++;
  }
  function finish() {
    active--;
    if (active !== 0 || uncertain) return;
    const temporary = `${snapshot}.next`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, serialize(provider.snapshotState()));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, snapshot);
    unlinkSync(pending);
  }
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(provider, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver);
      if (typeof method !== "function" || key === "snapshotState" || key === "restoreState")
        return method;
      if (!wrappers.has(key))
        wrappers.set(key, (...args: unknown[]) => {
          begin();
          try {
            const result: unknown = method.apply(target, args);
            if (result instanceof Promise)
              return result.then(
                (value) => {
                  finish();
                  return value;
                },
                (error) => {
                  uncertain = true;
                  active--;
                  throw error;
                },
              );
            finish();
            return result;
          } catch (error) {
            uncertain = true;
            active--;
            throw error;
          }
        });
      return wrappers.get(key);
    },
  });
}
