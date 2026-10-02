import { useSyncExternalStore } from "react";

/** >=1280 right dock | 768-1279 slide-over drawer | <768 bottom sheet */
export type LayoutMode = "dock" | "drawer" | "sheet";

export function layoutModeFor(width: number): LayoutMode {
  return width >= 1280 ? "dock" : width >= 768 ? "drawer" : "sheet";
}

function subscribe(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, () => layoutModeFor(window.innerWidth));
}
