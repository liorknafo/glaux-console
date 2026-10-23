import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileNameFor, saveBlob, toBlob } from './download';

describe('toBlob', () => {
  it('keeps text bytes as they arrived', async () => {
    const blob = toBlob('{"a":1}', 'utf8', 'application/json');
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe('{"a":1}');
  });

  it('decodes a base64 body back to its bytes', async () => {
    const blob = toBlob(btoa('PAR1'), 'base64', 'application/octet-stream');
    expect(await blob.text()).toBe('PAR1');
  });

  it('falls back to a generic type when the target sent none', () => {
    expect(toBlob('x', 'utf8').type).toBe('application/octet-stream');
  });
});

describe('fileNameFor', () => {
  it('names a download after the last segment of the key', () => {
    expect(fileNameFor('orders/dt=1/part-0.parquet')).toBe('part-0.parquet');
    expect(fileNameFor('top.json')).toBe('top.json');
  });
});

describe('saveBlob', () => {
  const original = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  afterEach(() => {
    URL.createObjectURL = original;
    URL.revokeObjectURL = originalRevoke;
  });

  it('offers the blob under the requested file name', () => {
    URL.createObjectURL = vi.fn(() => 'blob:stub');
    URL.revokeObjectURL = vi.fn();
    const clicked: { download: string; href: string }[] = [];
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(tag => {
      const element = createElement(tag);
      if (tag === 'a') {
        (element as HTMLAnchorElement).click = () =>
          clicked.push({
            download: (element as HTMLAnchorElement).download,
            href: (element as HTMLAnchorElement).href,
          });
      }
      return element;
    });

    expect(saveBlob(new Blob(['x']), 'part-0.parquet')).toBe(true);
    expect(clicked).toEqual([{ download: 'part-0.parquet', href: 'blob:stub' }]);
    vi.restoreAllMocks();
  });

  it('reports that it could not save rather than throwing where object URLs are absent', () => {
    // The click handler must survive an environment without them — jsdom is one.
    (URL as { createObjectURL?: unknown }).createObjectURL = undefined;
    expect(saveBlob(new Blob(['x']), 'x.txt')).toBe(false);
  });
});
