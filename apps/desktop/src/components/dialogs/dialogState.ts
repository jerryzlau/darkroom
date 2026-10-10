import type { EditParams, SectionName } from '@darkroom/core';
import { create } from 'zustand';

export type DialogName = 'export' | 'copySettings' | 'savePreset' | 'collection' | 'shortcuts' | 'settings' | 'confirm' | 'filterLibrary';

export interface ConfirmProps {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  /** called when dismissed without confirming */
  onCancel?: () => void;
}

/** Props for the 'filterLibrary' dialog. */
export interface FilterLibraryProps {
  /** photos "Apply" targets (default: the library selection at apply time) */
  ids?: number[];
  /** user preset to select initially */
  editId?: number;
}

/** Optional props for the 'savePreset' dialog. */
export interface SavePresetProps {
  name?: string;
  group?: string;
  description?: string;
  sections?: SectionName[];
  /** params to save from (default: the current develop params) */
  fromParams?: EditParams;
  source?: 'user' | 'ai';
  /** start with "Include exposure" unchecked */
  excludeExposure?: boolean;
}

interface DialogState {
  name: DialogName | null;
  props: Record<string, unknown>;
  open(name: DialogName, props?: Record<string, unknown>): void;
  close(): void;
}

export const useDialogs = create<DialogState>((set) => ({
  name: null,
  props: {},
  open: (name, props = {}) => set({ name, props }),
  close: () => set({ name: null, props: {} }),
}));

export function confirmDialog(p: ConfirmProps) {
  useDialogs.getState().open('confirm', p as unknown as Record<string, unknown>);
}
