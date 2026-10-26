import { useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Textarea from '@cloudscape-design/components/textarea';
import { matchEventPattern, validateEventPattern } from './pattern';

/**
 * The event-pattern tester.
 *
 * Both sides are editable, and the verdict updates as you type: the pattern
 * starts as the rule's own, so the useful question — "would this event still
 * reach my targets?" — is one edit away. A mismatch names the member that
 * rejected the event rather than only reporting false.
 */
export function PatternTester({
  pattern,
  event,
  onPatternChange,
  onEventChange,
  onReset,
}: {
  pattern: string;
  event: string;
  onPatternChange(value: string): void;
  onEventChange(value: string): void;
  onReset(): void;
}) {
  const [showRawEvent, setShowRawEvent] = useState(false);

  const parsedPattern = useMemo(() => parseJson(pattern), [pattern]);
  const parsedEvent = useMemo(() => parseJson(event), [event]);

  const problems = useMemo(
    () => (parsedPattern.ok ? validateEventPattern(parsedPattern.value) : []),
    [parsedPattern],
  );

  const verdict = useMemo(() => {
    if (!parsedPattern.ok || !parsedEvent.ok || problems.length > 0) return undefined;
    return matchEventPattern(parsedPattern.value, parsedEvent.value);
  }, [parsedPattern, parsedEvent, problems]);

  return (
    <SpaceBetween size="l">
      <ColumnLayout columns={2}>
        <FormField
          label="Event pattern"
          description="The rule's pattern. Edit it to try a change before you make it."
          errorText={parsedPattern.ok ? undefined : parsedPattern.error}
          stretch
        >
          <Textarea
            value={pattern}
            rows={14}
            spellcheck={false}
            data-testid="pattern-input"
            onChange={changeEvent => onPatternChange(changeEvent.detail.value)}
          />
        </FormField>

        <FormField
          label="Sample event"
          description="A whole event, envelope included — a pattern can match on source, detail-type or region as well as on detail."
          errorText={parsedEvent.ok ? undefined : parsedEvent.error}
          stretch
        >
          <Textarea
            value={event}
            rows={14}
            spellcheck={false}
            data-testid="event-input"
            onChange={changeEvent => onEventChange(changeEvent.detail.value)}
          />
        </FormField>
      </ColumnLayout>

      <SpaceBetween direction="horizontal" size="xs">
        <Button data-testid="reset-tester" onClick={onReset}>
          Reset from the rule
        </Button>
        <Button
          data-testid="toggle-raw"
          onClick={() => setShowRawEvent(current => !current)}
          disabled={!parsedEvent.ok}
        >
          {showRawEvent ? 'Hide formatted event' : 'Show formatted event'}
        </Button>
      </SpaceBetween>

      {problems.length > 0 && (
        <Alert
          type="error"
          header="This pattern is not valid EventBridge content filtering"
          data-testid="pattern-problems"
        >
          <SpaceBetween size="xs">
            {problems.map(problem => (
              <Box key={`${problem.path}:${problem.message}`}>
                <strong>{problem.path === '' ? '(root)' : problem.path}</strong> — {problem.message}
              </Box>
            ))}
          </SpaceBetween>
        </Alert>
      )}

      {verdict && (
        <Alert
          type={verdict.matched ? 'success' : 'info'}
          data-testid="match-verdict"
          header={
            <StatusIndicator type={verdict.matched ? 'success' : 'stopped'}>
              {verdict.matched ? 'This event matches the pattern' : 'This event does not match'}
            </StatusIndicator>
          }
        >
          {verdict.matched ? (
            <Box>
              Every member of the pattern is satisfied, so a rule with this pattern would send this
              event to its targets.
            </Box>
          ) : (
            <SpaceBetween size="xs">
              <Box data-testid="mismatch-reason">{verdict.reason}</Box>
              <Box variant="small">
                Matching stops at the first member that fails, so fixing this one may reveal
                another.
              </Box>
            </SpaceBetween>
          )}
        </Alert>
      )}

      {showRawEvent && parsedEvent.ok && (
        <Box variant="code" data-testid="formatted-event">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(parsedEvent.value, null, 2)}
          </pre>
        </Box>
      )}

      <Box variant="small" color="text-body-secondary">
        <Header variant="h3">How this is evaluated</Header>
        Matching runs in the browser against AWS&rsquo;s documented content-filtering grammar —
        exact values, nested objects, <code>$or</code>, and the <code>prefix</code>,{' '}
        <code>suffix</code>, <code>anything-but</code>, <code>numeric</code>, <code>exists</code>,{' '}
        <code>cidr</code>, <code>equals-ignore-case</code> and <code>wildcard</code> operators. The
        target endpoint is not consulted, so the verdict is the same whatever your emulator
        implements — and anything outside that grammar is reported as unsupported rather than
        silently answered.
      </Box>
    </SpaceBetween>
  );
}

type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

function parseJson(text: string): Parsed {
  if (text.trim() === '') return { ok: false, error: 'Enter some JSON.' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (caught) {
    return { ok: false, error: (caught as Error).message };
  }
}
