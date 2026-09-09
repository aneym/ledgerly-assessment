"use client";

import { useSyncExternalStore } from "react";

export type InspectorMode = "pane" | "drawer" | "sheet";

const PANE = "(min-width: 1024px)";
const DRAWER = "(min-width: 768px)";

function subscribe(onChange: () => void) {
  const pane = window.matchMedia(PANE);
  const drawer = window.matchMedia(DRAWER);
  pane.addEventListener("change", onChange);
  drawer.addEventListener("change", onChange);
  return () => {
    pane.removeEventListener("change", onChange);
    drawer.removeEventListener("change", onChange);
  };
}

function read(): InspectorMode {
  if (window.matchMedia(PANE).matches) return "pane";
  if (window.matchMedia(DRAWER).matches) return "drawer";
  return "sheet";
}

/** Pane at 1024 and up, a right drawer from 768, a bottom sheet below. The server says pane. */
export function useInspectorMode(): InspectorMode {
  return useSyncExternalStore(subscribe, read, () => "pane");
}
