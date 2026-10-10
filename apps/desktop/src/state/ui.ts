import { create } from 'zustand';

export type Module = 'library' | 'develop';

const AI_OPEN_KEY = 'darkroom.ai.open';
const AI_TAB_KEY = 'darkroom.ai.tab';

export type AiTab = 'chat' | 'guided';

function loadAiTab(): AiTab {
  try {
    return localStorage.getItem(AI_TAB_KEY) === 'guided' ? 'guided' : 'chat';
  } catch {
    return 'chat';
  }
}

function loadAiOpen(): boolean {
  try {
    return localStorage.getItem(AI_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

interface UiState {
  module: Module;
  leftOpen: boolean;
  rightOpen: boolean;
  filmstripOpen: boolean;
  /** AI Edit chat dock in the Develop right column */
  aiOpen: boolean;
  /** Active tab of the AI Edit dock */
  aiTab: AiTab;
  setModule(m: Module): void;
  toggle(panel: 'leftOpen' | 'rightOpen' | 'filmstripOpen'): void;
  toggleAi(open?: boolean): void;
  setAiTab(tab: AiTab): void;
}

export const useUi = create<UiState>((set, get) => ({
  module: 'library',
  leftOpen: true,
  rightOpen: true,
  filmstripOpen: true,
  aiOpen: loadAiOpen(),
  aiTab: loadAiTab(),
  setModule: (module) => set({ module }),
  toggle: (panel) => set({ [panel]: !get()[panel] } as Partial<UiState>),
  toggleAi: (open) => {
    const aiOpen = open ?? !get().aiOpen;
    set({ aiOpen });
    try {
      localStorage.setItem(AI_OPEN_KEY, aiOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  },
  setAiTab: (aiTab) => {
    set({ aiTab });
    try {
      localStorage.setItem(AI_TAB_KEY, aiTab);
    } catch {
      /* ignore */
    }
  },
}));
