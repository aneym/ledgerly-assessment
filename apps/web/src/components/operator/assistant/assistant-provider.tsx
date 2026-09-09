"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { AssistantContext } from "@/lib/operator/assistant";

type Value = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  context: AssistantContext;
  setSelection: (selection: Omit<AssistantContext, "route"> | null) => void;
};

const AssistantCtx = createContext<Value | null>(null);

/** Holds the sidebar's open state and the record the page has selected. */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Omit<AssistantContext, "route"> | null>(null);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  // "?" opens and closes the panel unless the operator is typing.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const value = useMemo<Value>(
    () => ({
      open,
      setOpen,
      toggle,
      context: {
        kind: selection?.kind ?? null,
        id: selection?.id ?? null,
        route: pathname,
        label: selection?.label,
        href: selection?.href,
      },
      setSelection,
    }),
    [open, toggle, selection, pathname],
  );

  return <AssistantCtx.Provider value={value}>{children}</AssistantCtx.Provider>;
}

export function useAssistant(): Value {
  const value = useContext(AssistantCtx);
  if (!value) throw new Error("useAssistant needs an AssistantProvider above it");
  return value;
}

/** Pages call this with whatever they have open. Null clears it; unmount clears it too. */
export function useAssistantSelection(selection: Omit<AssistantContext, "route"> | null) {
  const { setSelection } = useAssistant();
  const kind = selection?.kind ?? null;
  const id = selection?.id ?? null;
  const label = selection?.label;
  const href = selection?.href;
  useEffect(() => {
    setSelection(kind && id ? { kind, id, label, href } : null);
    return () => setSelection(null);
  }, [setSelection, kind, id, label, href]);
}
