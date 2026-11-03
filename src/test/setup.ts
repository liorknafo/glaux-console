import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';

/**
 * `findBy*` waits on the runner's speed, not on the assertion.
 *
 * The integration tests mount the whole shell and let a screen load its own
 * service catalog, which arrives as a lazy chunk — `glue.json` is 829 kB and
 * `ec2.json` larger still. The first import of one in jsdom costs well over
 * testing-library's 1 s default, so a `findBy*` on a cold module cache fails
 * for want of time while the element it wants is on its way. That made the
 * Glue catalog-failure test pass only when an earlier test in its file had
 * already warmed the cache, and fail on a loaded CI runner. This branch's own
 * screens load the same chunks through the same shell, so they race the same
 * way; 5 s was this file's earlier answer to it and was not enough cold.
 *
 * This is the same call vitest's own `testTimeout` already makes in
 * `vite.config.ts`, for the same reason: the budget matches the runner, and a
 * genuinely absent element still fails well inside the per-test timeout, with
 * the same error naming what it looked for.
 */
configure({ asyncUtilTimeout: 10_000 });

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
