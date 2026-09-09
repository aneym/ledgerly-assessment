/** Detect the actual Next HMR endpoint and retained development variants. */
export function isHmrUrl(value) {
  const url = new URL(value);
  return url.pathname === "/_next/hmr" || /webpack-hmr|turbopack|hot-reload/i.test(url.pathname);
}
