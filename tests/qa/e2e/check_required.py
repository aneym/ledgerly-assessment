#!/usr/bin/env python3
"""Require successful, actually executed Playwright journeys, not expected failures.

Usage: check_required.py RESULTS MANIFEST [--group hybrid|fixture|local]
A skipped, flaky, expected-to-fail, absent or interrupted required test fails closed.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def tests(results: dict):
    def walk(suites, prefix):
        for suite in suites:
            here = prefix + [suite.get("title") or Path(suite.get("file", "")).name]
            for spec in suite.get("specs", []):
                for test in spec.get("tests", []):
                    yield " > ".join([p for p in here if p] + [spec["title"]]), test
            yield from walk(suite.get("suites", []), here)
    yield from walk(results.get("suites", []), [])


def verify(results: dict, manifest: dict, group: str = "hybrid") -> list[str]:
    required = manifest["required"] if group == "hybrid" else manifest[f"{group}_required"]
    if not isinstance(required, list) or not required:
        raise ValueError("required list must not be empty")
    patterns = [row["pattern"] for row in required]
    if any(not isinstance(p, str) or not p.strip() for p in patterns):
        raise ValueError("required patterns must be nonempty strings")
    if len(set(patterns)) != len(patterns):
        raise ValueError("required patterns must be unique")
    failures = ["report has top-level errors"] if results.get("errors") else []
    rows = list(tests(results))
    print("required journey | status")
    for pattern in patterns:
        matched = [(title, test) for title, test in rows if pattern in title]
        if not matched:
            failures.append(f"{pattern}: MISSING")
        for title, test in matched:
            runs = test.get("results", [])
            passed = (
                test.get("status") in ("expected", "passed")
                and test.get("expectedStatus") == "passed"
                and bool(runs)
                and all(run.get("status") == "passed" for run in runs)
                and not any(a.get("type") in ("skip", "fixme", "fail") for a in test.get("annotations", []))
            )
            print(f"{title} | {'passed' if passed else 'NOT PASSED'}")
            if not passed:
                failures.append(f"{title}: {test.get('status', 'unknown')}, expected={test.get('expectedStatus', 'unknown')}, attempts={[r.get('status') for r in runs]}")
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--group", choices=("hybrid", "fixture", "local"), default="hybrid")
    args = parser.parse_args(argv)
    try:
        failures = verify(json.loads(args.results.read_text()), json.loads(args.manifest.read_text()), args.group)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"ACCEPTANCE WITHHELD: invalid input ({type(error).__name__}).")
        return 1
    if failures:
        print("\nACCEPTANCE WITHHELD. Required journeys not passed:")
        for failure in failures:
            print(" -", failure)
        return 1
    print("\nAll required journeys executed and passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
