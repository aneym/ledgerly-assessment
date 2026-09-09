import path from "node:path";

export function productionCheckOptions(args) {
  const [artifact, sha, output, ...flags] = args;
  if (!path.isAbsolute(artifact ?? "") || !path.isAbsolute(output ?? "") || !/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Expected absolute artifact/output paths and exact source SHA");
  if (flags.length % 2) throw new Error("Production check options require values");
  const values = new Map();
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index];
    if (!["--port", "--webhook-fixture"].includes(name) || values.has(name)) throw new Error("Unknown or duplicate production check option");
    values.set(name, flags[index + 1]);
  }
  if (!values.has("--port") || !values.has("--webhook-fixture")) throw new Error("Explicit --port and --webhook-fixture are required");
  const rawPort = values.get("--port");
  const port = Number(rawPort);
  const fixtureMode = values.get("--webhook-fixture");
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1024 || port > 65535 || !["0", "1"].includes(fixtureMode)) throw new Error("Invalid production check port or fixture mode");
  return { artifact, sha, output, port, fixtureMode, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
}
