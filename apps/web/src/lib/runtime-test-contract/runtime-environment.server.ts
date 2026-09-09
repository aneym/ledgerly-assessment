import { getBuiltinModule } from "node:process";

/** Node-only admission read. Bundlers must retain this builtin call at runtime;
 * injected test configuration must never replace the actual production check. */
export function actualNodeEnvironment(): string {
  if (typeof getBuiltinModule !== "function")
    throw new Error("Local runtime requires the Node builtin module accessor");
  const runtime = getBuiltinModule("process");
  if (
    !runtime?.env ||
    typeof runtime.env.NODE_ENV !== "string" ||
    runtime.env.NODE_ENV.length === 0
  )
    throw new Error("Local runtime requires an actual Node environment");
  return runtime.env.NODE_ENV;
}
