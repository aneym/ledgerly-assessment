// The deck, same origin as the app: /present/<path> serves docs/presentation/<path> read-only
// (D12: one canonical URL, no cross-site auth). The deck's relative ../journey.json and
// ../stats.json resolve inside the mount. Directory URLs serve index.html. Only an
// allowlisted set of static extensions is served, never anything above the mount.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** The local launcher binds its checkout explicitly; ordinary Next runs from apps/web. */
export function resolvePresentRoot(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (env.LEDGERLY_LOCAL_RUNTIME !== "1") {
    return path.resolve(cwd, "../../docs/presentation");
  }
  const repositoryRoot = env.LEDGERLY_REPOSITORY_ROOT;
  // Never search ancestors or accept an arbitrary asset directory from the environment.
  if (
    !repositoryRoot ||
    !path.isAbsolute(repositoryRoot) ||
    path.resolve(repositoryRoot) !== path.resolve(cwd)
  ) {
    throw new Error("Local presentation root must match the launcher's repository cwd");
  }
  return path.join(repositoryRoot, "docs/presentation");
}

/** Resolves a request path inside the mount, or null when it escapes or is not allowlisted. */
export function resolvePresentPath(
  root: string,
  segments: readonly string[],
  directory = false,
): string | null {
  const parts = segments.filter((s, i) => !(s === "" && i === segments.length - 1));
  if (
    parts.some((s) => s === "" || s === "." || s === ".." || s.includes("\\") || s.includes("\0"))
  )
    return null;
  const rel =
    directory || parts.length === 0 ? [...parts, "index.html"].join("/") : parts.join("/");
  const file = path.resolve(root, rel);
  const base = path.resolve(root);
  if (!file.startsWith(`${base}${path.sep}`)) return null;
  if (!(path.extname(file).toLowerCase() in TYPES)) return null;
  return file;
}

export async function servePresent(
  root: string,
  segments: readonly string[],
  requestPath: string,
): Promise<Response> {
  // A directory URL without the trailing slash gets it, so relative links inside resolve.
  const last = segments[segments.length - 1] ?? "";
  if (segments.length > 0 && !requestPath.endsWith("/") && !path.extname(last)) {
    return new Response(null, { status: 308, headers: { location: `${requestPath}/` } });
  }
  const file = resolvePresentPath(root, segments, requestPath.endsWith("/"));
  if (!file) return new Response("Not found", { status: 404 });
  try {
    const s = await stat(/* turbopackIgnore: true */ file);
    if (!s.isFile()) return new Response("Not found", { status: 404 });
    const body = await readFile(/* turbopackIgnore: true */ file);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-ledgerly-present-root": "docs/presentation",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
