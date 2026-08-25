import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';

/**
 * Testing Library's own wait budget, for the same reason vitest's `testTimeout`
 * is raised in `vite.config.ts`: the integration tests drive the whole shell
 * through jsdom, and a single `findBy*` can sit behind a Cloudscape render, a
 * stubbed round trip and a state update. The default one second is the assertion
 * racing the runner rather than the assertion being wrong — it fails under load
 * on a suite that passes on an idle machine. A genuinely stuck query still fails
 * here, well inside the per-test timeout.
 */
configure({ asyncUtilTimeout: 5_000 });

// jsdom does not implement these, and Cloudscape's responsive components use them.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!('ResizeObserver' in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!window.scrollTo) {
  window.scrollTo = () => {};
}
