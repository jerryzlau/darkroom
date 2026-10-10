import { create } from 'zustand';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'error';
}

interface ToastState {
  toasts: Toast[];
  push(text: string, kind?: Toast['kind']): void;
  dismiss(id: number): void;
}

let n = 0;
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(text, kind = 'info') {
    const id = ++n;
    set({ toasts: [...get().toasts.slice(-4), { id, text, kind }] });
    setTimeout(() => get().dismiss(id), kind === 'error' ? 8000 : 4000);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export function toast(text: string, kind: Toast['kind'] = 'info') {
  useToasts.getState().push(text, kind);
}
