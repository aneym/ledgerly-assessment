import { assert, test } from "vitest";
import {
  buildReturnUrl,
  endJourney,
  type KeyValueStorage,
  loadJourney,
  outcomeOf,
  parseReturnTarget,
  saveJourney,
  startJourney,
} from "../src/journey";
import { reduceTour } from "../src/tour";

const mem = (): KeyValueStorage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
};

test("only allowlisted internal paths are accepted as return targets", () => {
  assert.equal(parseReturnTarget("/deck"), "/deck");
  assert.equal(parseReturnTarget("/deck/intro?slide=3"), "/deck/intro?slide=3");
  assert.equal(parseReturnTarget("/present/"), "/present/");
  const rejected = [
    "https://evil.example/",
    "//evil.example/deck",
    "/\\evil.example",
    "/deck/../admin",
    "/decks",
    "/",
    "/javascript:alert(1)",
    "%2Fdeck",
    "/deck%2F..%2Fx",
    "/deck%0d%0aSet-Cookie:x",
    "",
    null,
    undefined,
    "/deck/..",
    "/other",
  ];
  for (const bad of rejected) assert.equal(parseReturnTarget(bad), null, String(bad));
  assert.equal(parseReturnTarget("/slides/1", ["/slides"]), "/slides/1");
});

test("start records the validated target and slide; a bad target yields null", () => {
  const rec = startJourney(
    new URLSearchParams("return=%2Fdeck&from=intro-2"),
    "run_a",
    () => new Date("2026-09-08T18:00:00Z"),
  );
  assert.deepEqual(rec, {
    run_id: "run_a",
    return_to: "/deck",
    from_slide: "intro-2",
    started_at: "2026-09-08T18:00:00.000Z",
    outcome: null,
    ended_at: null,
  });
  assert.equal(startJourney(new URLSearchParams("return=https://evil.example"), "run_a"), null);
  assert.equal(
    startJourney(new URLSearchParams("return=/deck&from=<script>"), "run_a")?.from_slide,
    null,
  );
});

test("outcome is completed only when every step passed; interrupted in-progress is skipped; blocked stays blocked", () => {
  const fresh = reduceTour([]);
  assert.equal(outcomeOf(fresh, false), "partial");
  assert.equal(outcomeOf(fresh, true), "skipped");
  assert.equal(outcomeOf(null), "unavailable");
  assert.equal(outcomeOf({ ...fresh, outcome: "completed", active_index: -1 }), "completed");
  assert.equal(outcomeOf({ ...fresh, outcome: "blocked", active_index: -1 }, true), "blocked");
});

test("the return URL carries outcome, run and origin slide and lands on the matching closing anchor", () => {
  const rec = {
    run_id: "run_a",
    return_to: "/deck?x=1#old",
    from_slide: "intro-2",
    started_at: "t",
    outcome: null,
    ended_at: null,
  };
  assert.equal(
    buildReturnUrl(rec, "completed"),
    "/deck?demo=completed&run=run_a&from=intro-2#closing-completed",
  );
  const ended = endJourney(rec, reduceTour([]), true, () => new Date("2026-09-08T18:30:00Z"));
  assert.equal(ended.record.outcome, "skipped");
  assert.equal(ended.url, "/deck?demo=skipped&run=run_a&step=C01&from=intro-2#closing-skipped");
});

test("the journey record survives a round trip through storage and rejects garbage", () => {
  const s = mem();
  const rec = startJourney(new URLSearchParams("return=/deck&from=s1"), "run_b");
  if (!rec) throw new Error("expected a record");
  saveJourney(s, rec);
  assert.deepEqual(loadJourney(s), rec);
  s.setItem("ledgerly.demo.journey", "{not json");
  assert.equal(loadJourney(s), null);
  s.setItem("ledgerly.demo.journey", JSON.stringify({ nope: 1 }));
  assert.equal(loadJourney(s), null);
});

test("absolute deck URLs are accepted only on allowed origins with a page path, and the return carries the step", () => {
  const policy = { paths: ["/deck"], origins: ["http://127.0.0.1:4412"] };
  assert.equal(
    parseReturnTarget("http://127.0.0.1:4412/#after-demo", policy),
    "http://127.0.0.1:4412/#after-demo",
  );
  assert.equal(
    parseReturnTarget("http://127.0.0.1:4412/index.html?x=1", policy),
    "http://127.0.0.1:4412/index.html?x=1",
  );
  for (const bad of [
    "http://evil.example/",
    "http://127.0.0.1:4413/",
    "http://127.0.0.1:4412/admin",
    "http://user:pw@127.0.0.1:4412/",
    "https://127.0.0.1:4412/",
  ])
    assert.equal(parseReturnTarget(bad, policy), null, bad);
  assert.equal(parseReturnTarget("/deck", policy), "/deck", "paths still work beside origins");
  const rec = startJourney(
    new URLSearchParams("return=http%3A%2F%2F127.0.0.1%3A4412%2F%23after-demo&from=%23launch"),
    "run_z",
    () => new Date("2026-09-08T20:00:00Z"),
    policy,
  );
  assert.equal(rec?.return_to, "http://127.0.0.1:4412/#after-demo");
  assert.equal(rec?.from_slide, "#launch");
  if (!rec) throw new Error("expected a record");
  const ended = endJourney(rec, reduceTour([]), true);
  assert.equal(
    ended.url,
    "http://127.0.0.1:4412/?demo=skipped&run=run_z&step=C01&from=%23launch#closing-skipped",
  );
});
