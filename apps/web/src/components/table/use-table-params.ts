"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useTransition } from "react";
import type { SortState } from "./types";

/**
 * Filter, sort, page and selection in the URL. Call inside Suspense. `replace`
 * for typing, sort, page and selection; `push` for a business or currency change.
 * `isPending` drives aria-busy and the "Reading" announcement.
 */
export function useTableParams(): {
  get: (key: string) => string | null;
  set: (next: Record<string, string | null>, mode?: "replace" | "push") => void;
  entry: string | null;
  sort: SortState | null;
  page: number;
  isPending: boolean;
} {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const get = useCallback((key: string) => params.get(key), [params]);

  const set = useCallback(
    (next: Record<string, string | null>, mode: "replace" | "push" = "replace") => {
      const search = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value === "") search.delete(key);
        else search.set(key, value);
      }
      const query = search.toString();
      const url = query ? `${pathname}?${query}` : pathname;
      startTransition(() => {
        if (mode === "push") router.push(url, { scroll: false });
        else router.replace(url, { scroll: false });
      });
    },
    [params, pathname, router],
  );

  const sort = useMemo<SortState | null>(() => {
    const key = params.get("sort");
    if (!key) return null;
    return { key, dir: params.get("dir") === "asc" ? "asc" : "desc" };
  }, [params]);

  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);

  return { get, set, entry: params.get("entry"), sort, page, isPending };
}
