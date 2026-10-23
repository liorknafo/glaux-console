import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import Textarea from '@cloudscape-design/components/textarea';
import Input from '@cloudscape-design/components/input';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { useEndpoints } from '../../endpoints/context';
import { PatternTester } from './PatternTester';
import {
  DEFAULT_BUS,
  envelopeEvent,
  fetchBuses,
  fetchRules,
  fetchTargets,
  putEvent,
  seedEventFromPattern,
  setRuleState,
  type EventBus,
  type EventRule,
  type PutEventOutcome,
  type RuleTarget,
} from './buses';

/**
 * The EventBridge screen: the buses on the target, the rules on the bus in
 * hand, what each rule fans out to, and a tester that answers whether a given
 * event would match a rule's pattern.
 */
export function EventBridgeScreen({ catalog }: { catalog: ServiceCatalog }) {
  const { active } = useEndpoints();
  const [busName, setBusName] = useState(DEFAULT_BUS);
  const [selected, setSelected] = useState<string>();
  const [reload, setReload] = useState(0);

  const [buses, setBuses] = useState<EventBus[]>();
  const [busError, setBusError] = useState<{ header: string; detail: string }>();

  useEffect(() => {
    const controller = new AbortController();
    fetchBuses(active, catalog, controller.signal).then(
      listed => {
        if (controller.signal.aborted) return;
        setBuses(listed);
        setBusError(undefined);
      },
      caught => {
        if (controller.signal.aborted) return;
        // A target with no ListEventBuses can still have rules on the default
        // bus, so the bus selector degrades to that rather than blanking.
        setBuses([]);
        setBusError(describeError(caught));
      },
    );
    return () => controller.abort();
  }, [active, catalog]);

  const rulesKey = `${active.url}|${active.region}|${busName}|${reload}`;
  const [listed, setListed] = useState<{
    key: string;
    rules?: EventRule[];
    error?: { header: string; detail: string };
  }>();
  const currentList = listed?.key === rulesKey ? listed : undefined;

  useEffect(() => {
    const controller = new AbortController();
    fetchRules(active, catalog, busName, controller.signal).then(
      rules => !controller.signal.aborted && setListed({ key: rulesKey, rules }),
      caught =>
        !controller.signal.aborted && setListed({ key: rulesKey, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [active, catalog, busName, rulesKey]);

  // Switching targets must not leave a rule from the previous one selected.
  const [scopedTo, setScopedTo] = useState(active.url);
  if (scopedTo !== active.url) {
    setScopedTo(active.url);
    setSelected(undefined);
    setBusName(DEFAULT_BUS);
  }

  const rules = currentList?.rules ?? [];
  const rule = rules.find(entry => entry.name === selected);
  const busOptions = (buses ?? []).map(bus => ({ value: bus.name, label: bus.name }));
  if (!busOptions.some(option => option.value === DEFAULT_BUS)) {
    busOptions.unshift({ value: DEFAULT_BUS, label: DEFAULT_BUS });
  }

  return (
    <SpaceBetween size="l">
      {busError && (
        <Alert type="warning" header={busError.header} data-testid="bus-error">
          {busError.detail} Showing the default bus only.
        </Alert>
      )}
      {currentList?.error && (
        <Alert type="error" header={currentList.error.header} data-testid="eventbridge-error">
          {currentList.error.detail}
        </Alert>
      )}

      <Table
        data-testid="rule-table"
        variant="container"
        loading={!currentList}
        loadingText="Listing rules"
        trackBy="name"
        columnDefinitions={[
          {
            id: 'name',
            header: 'Rule',
            cell: (entry: EventRule) => (
              <Link
                href={`#${entry.name}`}
                data-testid={`open-rule-${entry.name}`}
                onFollow={event => {
                  event.preventDefault();
                  setSelected(entry.name);
                }}
              >
                {entry.name}
              </Link>
            ),
          },
          {
            id: 'state',
            header: 'State',
            cell: (entry: EventRule) => (
              <StatusIndicator type={entry.state === 'ENABLED' ? 'success' : 'stopped'}>
                {entry.state ?? 'UNKNOWN'}
              </StatusIndicator>
            ),
          },
          {
            id: 'kind',
            header: 'Trigger',
            cell: (entry: EventRule) =>
              entry.scheduleExpression ? (
                <Badge>Schedule</Badge>
              ) : entry.eventPattern ? (
                <Badge color="blue">Event pattern</Badge>
              ) : (
                '—'
              ),
          },
          {
            id: 'description',
            header: 'Description',
            cell: (entry: EventRule) => entry.description ?? '—',
          },
        ]}
        items={rules}
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="m">
            No rules on the {busName} bus.
          </Box>
        }
        header={
          <Header
            variant="h2"
            counter={currentList?.rules ? `(${rules.length})` : undefined}
            description="Rules on the selected bus, from ListRules."
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Select
                  selectedOption={
                    busOptions.find(option => option.value === busName) ?? busOptions[0]
                  }
                  options={busOptions}
                  ariaLabel="Event bus"
                  data-testid="bus-select"
                  onChange={event => {
                    setBusName(event.detail.selectedOption.value ?? DEFAULT_BUS);
                    setSelected(undefined);
                  }}
                />
                <Button
                  iconName="refresh"
                  ariaLabel="Reload the rules"
                  loading={!currentList}
                  onClick={() => setReload(count => count + 1)}
                />
              </SpaceBetween>
            }
          >
            Rules
          </Header>
        }
      />

      {rule ? (
        <RuleDetail
          key={`${active.url}|${busName}|${rule.name}`}
          catalog={catalog}
          busName={busName}
          rule={rule}
          onChanged={() => setReload(count => count + 1)}
        />
      ) : (
        <Container>
          <Box color="text-body-secondary" padding="s" data-testid="no-rule-selected">
            Select a rule to see its targets and to test its event pattern.
          </Box>
        </Container>
      )}
    </SpaceBetween>
  );
}

function RuleDetail({
  catalog,
  busName,
  rule,
  onChanged,
}: {
  catalog: ServiceCatalog;
  busName: string;
  rule: EventRule;
  onChanged(): void;
}) {
  const { active } = useEndpoints();
  const patternText = useMemo(
    () => (rule.eventPattern ? formatJson(rule.eventPattern) : '{}'),
    [rule.eventPattern],
  );
  const seededEvent = useMemo(
    () => JSON.stringify(seedEventFromPattern(rule.eventPattern, active.region), null, 2),
    [rule.eventPattern, active.region],
  );

  const [pattern, setPattern] = useState(patternText);
  const [event, setEvent] = useState(seededEvent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ header: string; detail: string }>();

  async function toggleState() {
    setBusy(true);
    setError(undefined);
    try {
      await setRuleState(active, catalog, busName, rule.name, rule.state !== 'ENABLED');
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Container
      data-testid="rule-detail"
      header={
        <Header
          variant="h2"
          description={rule.arn ?? `On the ${busName} bus`}
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <StatusIndicator type={rule.state === 'ENABLED' ? 'success' : 'stopped'}>
                {rule.state ?? 'UNKNOWN'}
              </StatusIndicator>
              <Button
                data-testid="toggle-rule-state"
                loading={busy}
                disabled={Boolean(rule.managedBy)}
                onClick={() => void toggleState()}
              >
                {rule.state === 'ENABLED' ? 'Disable' : 'Enable'}
              </Button>
            </SpaceBetween>
          }
        >
          {rule.name}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" header={error.header} data-testid="rule-error">
            {error.detail}
          </Alert>
        )}

        {rule.managedBy && (
          <Alert type="info" data-testid="managed-rule">
            This rule is managed by {rule.managedBy}, so its state is not the console&rsquo;s to
            change.
          </Alert>
        )}

        <ColumnLayout columns={3} variant="text-grid">
          <Field label="Bus">{rule.eventBusName ?? busName}</Field>
          <Field label="Schedule">
            <span data-testid="rule-schedule">{rule.scheduleExpression ?? '—'}</span>
          </Field>
          <Field label="Role">{rule.roleArn ?? '—'}</Field>
        </ColumnLayout>

        <Tabs
          tabs={[
            {
              id: 'tester',
              label: 'Pattern tester',
              content: rule.eventPattern ? (
                <PatternTester
                  pattern={pattern}
                  event={event}
                  onPatternChange={setPattern}
                  onEventChange={setEvent}
                  onReset={() => {
                    setPattern(patternText);
                    setEvent(seededEvent);
                  }}
                />
              ) : (
                <Box color="text-body-secondary" padding="s" data-testid="no-pattern">
                  This rule has no event pattern
                  {rule.scheduleExpression ? ' — it runs on a schedule.' : '.'}
                </Box>
              ),
            },
            {
              id: 'targets',
              label: 'Targets',
              content: <TargetsPanel catalog={catalog} busName={busName} ruleName={rule.name} />,
            },
            {
              id: 'put',
              label: 'Put a test event',
              content: <PutEventPanel catalog={catalog} busName={busName} />,
            },
          ]}
        />
      </SpaceBetween>
    </Container>
  );
}

function TargetsPanel({
  catalog,
  busName,
  ruleName,
}: {
  catalog: ServiceCatalog;
  busName: string;
  ruleName: string;
}) {
  const { active } = useEndpoints();
  const [targets, setTargets] = useState<RuleTarget[]>();
  const [error, setError] = useState<{ header: string; detail: string }>();

  useEffect(() => {
    const controller = new AbortController();
    fetchTargets(active, catalog, busName, ruleName, controller.signal).then(
      listed => {
        if (controller.signal.aborted) return;
        setTargets(listed);
        setError(undefined);
      },
      caught => {
        if (controller.signal.aborted) return;
        setTargets([]);
        setError(describeError(caught));
      },
    );
    return () => controller.abort();
  }, [active, catalog, busName, ruleName]);

  return (
    <SpaceBetween size="m">
      {error && (
        <Alert type="error" header={error.header} data-testid="targets-error">
          {error.detail}
        </Alert>
      )}
      <Table
        data-testid="target-table"
        variant="embedded"
        loading={targets === undefined}
        loadingText="Listing targets"
        columnDefinitions={[
          { id: 'id', header: 'ID', cell: (target: RuleTarget) => target.id },
          { id: 'arn', header: 'Target', cell: (target: RuleTarget) => target.arn ?? '—' },
          {
            id: 'input',
            header: 'Input',
            cell: (target: RuleTarget) =>
              target.input
                ? 'Constant'
                : target.inputPath
                  ? `Path: ${target.inputPath}`
                  : target.transformed
                    ? 'Transformer'
                    : 'Matched event',
          },
          {
            id: 'retry',
            header: 'Retries',
            cell: (target: RuleTarget) =>
              target.retryAttempts === undefined ? '—' : String(target.retryAttempts),
          },
          {
            id: 'dlq',
            header: 'Dead-letter queue',
            cell: (target: RuleTarget) => target.deadLetterArn ?? '—',
          },
        ]}
        items={targets ?? []}
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="m">
            This rule has no targets, so a matching event goes nowhere.
          </Box>
        }
        header={
          <Header variant="h3" counter={targets ? `(${targets.length})` : undefined}>
            Targets
          </Header>
        }
      />
    </SpaceBetween>
  );
}

function PutEventPanel({ catalog, busName }: { catalog: ServiceCatalog; busName: string }) {
  const { active } = useEndpoints();
  const envelope = envelopeEvent(active.region);
  const [source, setSource] = useState(String(envelope.source));
  const [detailType, setDetailType] = useState(String(envelope['detail-type']));
  const [detail, setDetail] = useState(JSON.stringify(envelope.detail, null, 2));
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<PutEventOutcome>();
  const [error, setError] = useState<{ header: string; detail: string }>();

  let detailError: string | undefined;
  try {
    JSON.parse(detail);
  } catch (caught) {
    detailError = (caught as Error).message;
  }

  async function send() {
    setSending(true);
    setError(undefined);
    setOutcome(undefined);
    try {
      setOutcome(await putEvent(active, catalog, { busName, source, detailType, detail }));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSending(false);
    }
  }

  return (
    <SpaceBetween size="m">
      <ColumnLayout columns={2}>
        <FormField
          label="Source"
          description="The event's source, which a pattern often matches on."
        >
          <Input
            value={source}
            data-testid="event-source"
            onChange={event => setSource(event.detail.value)}
          />
        </FormField>
        <FormField label="Detail type">
          <Input
            value={detailType}
            data-testid="event-detail-type"
            onChange={event => setDetailType(event.detail.value)}
          />
        </FormField>
      </ColumnLayout>

      <FormField
        label="Detail"
        description="Sent as the event's Detail. EventBridge requires it to be a JSON object."
        errorText={detailError}
        stretch
      >
        <Textarea
          value={detail}
          rows={8}
          spellcheck={false}
          data-testid="event-detail"
          onChange={event => setDetail(event.detail.value)}
        />
      </FormField>

      <Box>
        <Button
          variant="primary"
          loading={sending}
          disabled={Boolean(detailError) || source === '' || detailType === ''}
          data-testid="put-event"
          onClick={() => void send()}
        >
          Put event on {busName}
        </Button>
      </Box>

      {error && (
        <Alert type="error" header={error.header} data-testid="put-event-error">
          {error.detail}
        </Alert>
      )}

      {outcome && (
        <Alert
          type={outcome.failedEntryCount > 0 || outcome.errorCode ? 'error' : 'success'}
          data-testid="put-event-result"
          header={
            outcome.errorCode
              ? `The bus rejected the event: ${outcome.errorCode}`
              : 'Event accepted'
          }
        >
          <SpaceBetween size="xs">
            {outcome.errorMessage && <Box>{outcome.errorMessage}</Box>}
            {outcome.eventId && <Box>Event ID: {outcome.eventId}</Box>}
            <Box variant="small">
              PutEvents reports a rejected entry inside a successful response, so a failure here is
              the bus&rsquo;s answer rather than a transport error.
            </Box>
          </SpaceBetween>
        </Alert>
      )}
    </SpaceBetween>
  );
}

/** A rule's pattern, indented — targets store it as one long line. */
function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box>{children}</Box>
    </div>
  );
}
