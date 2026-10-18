import { create } from 'zustand';

/** A request to open a panel section (and select the tab/mode holding `control`), sent by the command palette. */
export interface RevealRequest {
  seq: number;
  section: string;
  control?: string;
}

interface RevealState {
  req: RevealRequest | null;
  request(section: string, control?: string): void;
}

let seq = 0;
export const useReveal = create<RevealState>((set) => ({
  req: null,
  request: (section, control) => set({ req: { seq: ++seq, section, control } }),
}));

/** Calls `fn` for every reveal request aimed at `section`; returns the unsubscribe function. */
export function onReveal(section: string, fn: (control: string | undefined) => void): () => void {
  return useReveal.subscribe((s, prev) => {
    if (s.req && s.req !== prev.req && s.req.section === section) fn(s.req.control);
  });
}
