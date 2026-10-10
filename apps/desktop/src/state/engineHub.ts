import type { Engine } from '../engine/Engine';

/** The single on-screen engine, registered by the develop canvas. */
let engine: Engine | null = null;
const listeners = new Set<() => void>();

export function setEngine(e: Engine | null) {
  engine = e;
  listeners.forEach((l) => l());
}

export function getEngine(): Engine | null {
  return engine;
}

/** Ask the canvas to redraw on the next frame. */
let redraw: (() => void) | null = null;
export function setRedraw(f: (() => void) | null) {
  redraw = f;
}
export function requestRedraw() {
  redraw?.();
}
