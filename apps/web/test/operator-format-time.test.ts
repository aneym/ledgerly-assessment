import { describe, expect, it } from "vitest";
import { dayOf, longDate, relative, shortDate, stamp, timeOf } from "../src/lib/operator/format";

// The operator pages format timestamps that do not always arrive as a clean ISO string:
// a field the API left out (""), a field that has not happened yet (null/undefined), or a
// Whop-style epoch given in seconds. Before this fix, new Date(...) on any of those threw
// RangeError: Invalid time value the moment Intl.DateTimeFormat tried to format it. Every
// formatter must return the TIME_PENDING placeholder instead of throwing.

const INVALID_INPUTS: Array<string | number | Date | null | undefined> = [
  "",
  "  ",
  "not-a-date",
  null,
  undefined,
  NaN,
  Infinity,
  new Date(NaN),
  1e30,
];

describe("operator time formatters, invalid input", () => {
  for (const input of INVALID_INPUTS) {
    it(`stamp(${JSON.stringify(input)}) does not throw and reads "pending"`, () => {
      expect(() => stamp(input)).not.toThrow();
      expect(stamp(input)).toBe("pending");
    });

    it(`dayOf/timeOf(${JSON.stringify(input)}) do not throw and read "pending"`, () => {
      expect(dayOf(input)).toBe("pending");
      expect(timeOf(input)).toBe("pending");
    });

    it(`longDate/shortDate(${JSON.stringify(input)}) do not throw and read "pending"`, () => {
      expect(longDate(input)).toBe("pending");
      expect(shortDate(input)).toBe("pending");
    });

    it(`relative(${JSON.stringify(input)}, now) does not throw and reads "pending"`, () => {
      expect(() => relative(input, Date.now())).not.toThrow();
      expect(relative(input, Date.now())).toBe("pending");
    });
  }
});

describe("operator time formatters, a Whop-style epoch in seconds", () => {
  // 2026-09-08T02:00:00Z as seconds since epoch, the shape a Whop timestamp field sends.
  const seconds = "1788832800";

  it("stamp reads it as seconds, not milliseconds", () => {
    expect(stamp(seconds)).toBe("Sep 08 02:00");
  });

  it("dayOf/timeOf agree with stamp's two halves", () => {
    expect(dayOf(seconds)).toBe("Sep 08");
    expect(timeOf(seconds)).toBe("02:00");
  });

  it("a numeric epoch given as a JS number is read the same way", () => {
    expect(stamp(1788832800)).toBe("Sep 08 02:00");
  });
});

describe("operator time formatters, a valid ISO timestamp", () => {
  const iso = "2026-09-08T14:32:00Z";

  it("stamp renders the UTC day and time", () => {
    expect(stamp(iso)).toBe("Sep 08 14:32");
  });

  it("longDate renders the full day, time and UTC label", () => {
    expect(longDate(iso)).toBe("Sep 08, 2026, 14:32 UTC");
  });

  it("shortDate renders just the day", () => {
    expect(shortDate(iso)).toBe("Sep 08");
  });
});

describe("operator timestamps at API boundaries", () => {
  it("accepts millisecond epochs and Date objects without changing UTC output", () => {
    for (const input of [1788832800000, "1788832800000", new Date("2026-09-08T02:00:00Z")]) {
      expect(stamp(input)).toBe("Sep 08 02:00");
    }
  });

  it("keeps zero as an actual epoch, not a missing value", () => {
    expect(stamp(0)).toBe("Jan 01 00:00");
  });

  it("formats relative times through the same seconds parser", () => {
    expect(relative(1788832800, 1788840000000)).toBe("2 hours ago");
    expect(relative("2026-09-08T02:00:00Z", NaN)).toBe("pending");
  });
});
