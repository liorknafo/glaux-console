/**
 * Handing a fetched object to the browser as a file.
 *
 * The object's bytes arrive through the console backend as text or base64, so
 * they are turned back into a `Blob` here rather than re-fetched from the
 * target — a second request could see a different object, and the page has no
 * direct route to the endpoint anyway.
 */

export function toBlob(body: string, encoding: 'utf8' | 'base64', contentType?: string): Blob {
  const type = contentType ?? 'application/octet-stream';
  if (encoding !== 'base64') return new Blob([body], { type });
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new Blob([bytes], { type });
}

/** The last segment of a key, which is the name a download should carry. */
export function fileNameFor(key: string): string {
  const segments = key.split('/').filter(segment => segment !== '');
  return segments[segments.length - 1] ?? key;
}

/**
 * Saves a blob under a file name.
 *
 * Object URLs are not available in every environment the components run in
 * (jsdom has no `createObjectURL`), so an environment without them is a no-op
 * that reports it rather than throwing out of a click handler.
 */
export function saveBlob(blob: Blob, fileName: string): boolean {
  if (typeof URL.createObjectURL !== 'function') return false;
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can race the download in some browsers; a tick is
  // enough for the click to have been handled.
  setTimeout(() => URL.revokeObjectURL(href), 0);
  return true;
}
