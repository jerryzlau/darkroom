import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Engine } from './engine/Engine';
import { backend, initBackend } from './ipc/backend';
import './styles.css';
import { useDevelop } from './state/develop';
import { useLibrary } from './state/library';
import { useUi } from './state/ui';
import { getEngine } from './state/engineHub';

async function boot() {
  await initBackend();
  const caps = Engine.capabilities();
  if (!caps.ok) backend().log('error', `GPU capabilities: ${caps.reason}`);
  window.addEventListener('error', (e) => backend().log('error', `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => backend().log('error', `unhandled rejection: ${e.reason}`));
  // prevent the webview from navigating when files are dropped on it
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  if (import.meta.env.DEV) {
    // debugging handle for development builds only
    (window as unknown as Record<string, unknown>).__darkroom = { useDevelop, useLibrary, useUi, getEngine, backend, background: await import('./lib/background'), useAiChat: (await import('./state/aiChat')).useAiChat, guided: (await import('./state/guided')).useGuided };
  }
  // No StrictMode: its double-mounted effects would create and destroy the WebGL context twice.
  createRoot(document.getElementById('root')!).render(<App />);
  if (backend().kind === 'tauri') {
    const { maybeRunSelftest } = await import('./lib/selftest');
    void maybeRunSelftest();
  }
}

void boot();
