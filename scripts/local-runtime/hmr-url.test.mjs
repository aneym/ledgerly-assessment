import { test } from "node:test";
import assert from "node:assert/strict";
import { isHmrUrl } from "./hmr-url.mjs";

test("detects Next 16 HMR and older development endpoints", () => {
  for (const url of ["ws://127.0.0.1:4507/_next/hmr?id=123", "ws://127.0.0.1:4507/_next/webpack-hmr", "wss://localhost:4507/turbopack", "ws://localhost:4507/hot-reload"]) assert.equal(isHmrUrl(url), true, url);
  assert.equal(isHmrUrl("ws://127.0.0.1:4507/events?id=hmr"), false);
  assert.equal(isHmrUrl("ws://127.0.0.1:4507/_next/hmr-other"), false);
});
