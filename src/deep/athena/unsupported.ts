import type { QueryExecutionSnapshot } from './types';

/**
 * glaux's rule is "never silently wrong": an unsupported SQL construct fails
 * loudly with an error naming the construct. This module turns such a failure
 * into a first-class explanation instead of one more red box.
 *
 * What is modelled, and what is guessed:
 *
 * - **Modelled.** Where a failure arrives — `QueryExecutionStatus.State` is
 *   `FAILED`, with `StateChangeReason` and the optional `AthenaError`
 *   (`ErrorCategory` 1 System / 2 User / 3 Other, `ErrorType`, `ErrorMessage`) —
 *   is exactly the Athena service model, so it holds for any target.
 * - **Guessed.** The *wording* glaux uses. glaux's design spec promises "a clear
 *   error naming the construct" but does not fix a format, so recognition is a
 *   set of patterns over the message text. A message that matches nothing is
 *   still shown in full as an ordinary query error — recognition only ever adds
 *   an explanation, it never hides or rewrites what the target said.
 */

/** glaux's per-release SQL coverage table. */
export const SQL_COVERAGE_URL = 'https://github.com/liorknafo/glaux/blob/main/docs';

const UNSUPPORTED_SIGNALS = [
  /\bunsupported\b/i,
  /\bnot supported\b/i,
  /\bnot yet supported\b/i,
  /\bunimplemented\b/i,
  /\bNOT_SUPPORTED\b/,
  /\b(?:does not|doesn't|cannot|can't) support\b/i,
];

/**
 * Ordered most specific first: the first pattern that matches names the
 * construct. Each capture is a construct name, not a sentence.
 */
const CONSTRUCT_PATTERNS = [
  /unsupported (?:SQL )?(?:construct|expression|function|statement|feature|clause|syntax|type|operator)s?\s*[:-]\s*([^.;\n]+)/i,
  /(?:construct|expression|function|statement|feature|clause|syntax|operator)\s+[`'"]([^`'"]+)[`'"]\s+is not (?:yet )?supported/i,
  /[`'"]([^`'"]+)[`'"]\s+is not (?:yet )?supported/i,
  /\b([A-Z][A-Z0-9_ ]{1,40}[A-Z0-9])\b is not (?:yet )?supported/,
  /(?:does not|doesn't) support\s+[`'"]?([^.;\n`'"]+)[`'"]?/i,
  /unsupported\s*[:-]\s*([^.;\n]+)/i,
];

export interface QueryFailure {
  kind: 'unsupported-construct' | 'error';
  /** The construct glaux named, when the message named one. */
  construct?: string;
  message: string;
  /** "System" / "User" / "Other", from `AthenaError.ErrorCategory`. */
  category?: string;
  errorType?: number;
  retryable?: boolean;
}

const CATEGORIES: Record<number, string> = { 1: 'System', 2: 'User', 3: 'Other' };

export function errorCategoryLabel(category: number | undefined): string | undefined {
  return category === undefined ? undefined : (CATEGORIES[category] ?? `Category ${category}`);
}

function cleanConstruct(raw: string): string | undefined {
  const trimmed = raw
    .trim()
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > 80) return undefined;
  return trimmed;
}

/** Does this message read as "you used something the engine does not implement"? */
export function looksUnsupported(message: string): boolean {
  return UNSUPPORTED_SIGNALS.some(pattern => pattern.test(message));
}

export function namedConstruct(message: string): string | undefined {
  for (const pattern of CONSTRUCT_PATTERNS) {
    const match = pattern.exec(message);
    if (match?.[1]) {
      const construct = cleanConstruct(match[1]);
      if (construct) return construct;
    }
  }
  return undefined;
}

export function classifyMessage(message: string): Pick<QueryFailure, 'kind' | 'construct'> {
  if (!looksUnsupported(message)) return { kind: 'error' };
  return { kind: 'unsupported-construct', construct: namedConstruct(message) };
}

/**
 * The failure behind a terminal snapshot, or undefined when it did not fail.
 * `AthenaError.ErrorMessage` is preferred over `StateChangeReason` when both are
 * present, since the model describes it as the error's own description.
 */
export function classifyFailure(snapshot: QueryExecutionSnapshot): QueryFailure | undefined {
  if (snapshot.state !== 'FAILED') return undefined;
  const message =
    snapshot.athenaError?.message?.trim() ||
    snapshot.stateChangeReason?.trim() ||
    'The target reported the query as FAILED without giving a reason.';
  return {
    ...classifyMessage(message),
    message,
    category: errorCategoryLabel(snapshot.athenaError?.category),
    errorType: snapshot.athenaError?.type,
    retryable: snapshot.athenaError?.retryable,
  };
}
