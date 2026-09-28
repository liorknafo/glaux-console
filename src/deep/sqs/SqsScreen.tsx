import { useEffect, useState, type ReactNode } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import TextFilter from '@cloudscape-design/components/text-filter';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { useEndpoints } from '../../endpoints/context';
import { formatBytes, formatDateTime } from '../format';
import { MessagesPanel } from './MessagesPanel';
import { SendMessagePanel } from './SendMessagePanel';
import {
  fetchDeadLetterSourceQueues,
  fetchQueueAttributes,
  fetchQueues,
  queueNameFromArn,
  resolveDeadLetterQueue,
  type QueueAttributes,
  type QueueSummary,
} from './queues';

/**
 * The SQS screen: the queues on the target, one queue's attributes and
 * messages, and the dead-letter relationships in both directions.
 */
export function SqsScreen({ catalog }: { catalog: ServiceCatalog }) {
  const { active } = useEndpoints();
  const [selected, setSelected] = useState<QueueSummary>();
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);

  const listKey = `${active.url}|${active.region}|${reload}`;
  const [listed, setListed] = useState<{
    key: string;
    queues?: QueueSummary[];
    error?: { header: string; detail: string };
  }>();
  const currentList = listed?.key === listKey ? listed : undefined;

  useEffect(() => {
    const controller = new AbortController();
    fetchQueues(active, catalog, controller.signal).then(
      queues => !controller.signal.aborted && setListed({ key: listKey, queues }),
      caught =>
        !controller.signal.aborted && setListed({ key: listKey, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [active, catalog, listKey]);

  // Switching targets must not leave a queue from the previous one selected.
  const [scopedTo, setScopedTo] = useState(active.url);
  if (scopedTo !== active.url) {
    setScopedTo(active.url);
    setSelected(undefined);
  }

  const queues = currentList?.queues ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = queues.filter(queue => !needle || queue.name.toLowerCase().includes(needle));

  return (
    <SpaceBetween size="l">
      {currentList?.error && (
        <Alert type="error" header={currentList.error.header} data-testid="sqs-error">
          {currentList.error.detail}
        </Alert>
      )}

      <Grid
        gridDefinition={[{ colspan: { default: 12, m: 4 } }, { colspan: { default: 12, m: 8 } }]}
      >
        <Table
          data-testid="queue-table"
          variant="container"
          loading={!currentList}
          loadingText="Listing queues"
          trackBy="url"
          selectionType="single"
          selectedItems={visible.filter(queue => queue.url === selected?.url)}
          ariaLabels={{
            selectionGroupLabel: 'Queue selection',
            itemSelectionLabel: (_state, queue: QueueSummary) => `Select ${queue.name}`,
          }}
          onSelectionChange={event => setSelected(event.detail.selectedItems[0])}
          columnDefinitions={[
            {
              id: 'name',
              header: 'Queue',
              cell: (queue: QueueSummary) => (
                <Link
                  href={`#${queue.name}`}
                  data-testid={`open-queue-${queue.name}`}
                  onFollow={event => {
                    event.preventDefault();
                    setSelected(queue);
                  }}
                >
                  {queue.name}
                </Link>
              ),
            },
          ]}
          items={visible}
          empty={
            <Box textAlign="center" color="text-body-secondary" padding="m">
              {needle ? 'No queue matches that filter.' : 'This target has no queues.'}
            </Box>
          }
          filter={
            <TextFilter
              filteringText={filter}
              filteringPlaceholder="Find a queue"
              filteringAriaLabel="Find a queue"
              onChange={event => setFilter(event.detail.filteringText)}
            />
          }
          header={
            <Header
              variant="h2"
              counter={currentList?.queues ? `(${currentList.queues.length})` : undefined}
              actions={
                <Button
                  iconName="refresh"
                  ariaLabel="Reload the queue list"
                  loading={!currentList}
                  onClick={() => setReload(count => count + 1)}
                />
              }
            >
              Queues
            </Header>
          }
        />

        {selected ? (
          <QueueDetail
            key={`${active.url}|${selected.url}`}
            catalog={catalog}
            queue={selected}
            queues={queues}
            onOpenQueue={setSelected}
          />
        ) : (
          <Container>
            <Box color="text-body-secondary" padding="s" data-testid="no-queue-selected">
              Select a queue to see its attributes, peek at its messages, and send to it.
            </Box>
          </Container>
        )}
      </Grid>
    </SpaceBetween>
  );
}

function QueueDetail({
  catalog,
  queue,
  queues,
  onOpenQueue,
}: {
  catalog: ServiceCatalog;
  queue: QueueSummary;
  queues: QueueSummary[];
  onOpenQueue(queue: QueueSummary): void;
}) {
  const { active } = useEndpoints();
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    attributes?: QueueAttributes;
    error?: { header: string; detail: string };
  }>();

  const key = `${active.url}|${queue.url}|${reload}`;
  const current = loaded?.key === key ? loaded : undefined;

  useEffect(() => {
    const controller = new AbortController();
    fetchQueueAttributes(active, catalog, queue.url, controller.signal).then(
      attributes => !controller.signal.aborted && setLoaded({ key, attributes }),
      caught => !controller.signal.aborted && setLoaded({ key, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [active, catalog, queue.url, key]);

  const attributes = current?.attributes ?? loaded?.attributes;

  return (
    <SpaceBetween size="l">
      {current?.error && (
        <Alert type="error" header={current.error.header} data-testid="queue-error">
          {current.error.detail}
        </Alert>
      )}

      <Container
        data-testid="queue-detail"
        header={
          <Header
            variant="h2"
            description={attributes?.arn ?? queue.url}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {attributes?.fifo && <Badge color="blue">FIFO</Badge>}
                <Button
                  iconName="refresh"
                  ariaLabel="Reload this queue"
                  loading={!current}
                  onClick={() => setReload(count => count + 1)}
                />
              </SpaceBetween>
            }
          >
            {queue.name}
          </Header>
        }
      >
        <SpaceBetween size="l">
          <ColumnLayout columns={4} variant="text-grid">
            <Field label="Messages available">
              <span data-testid="messages-available">{attributes?.visible ?? '—'}</span>
            </Field>
            <Field label="Messages in flight">
              <span data-testid="messages-in-flight">{attributes?.notVisible ?? '—'}</span>
            </Field>
            <Field label="Messages delayed">{attributes?.delayed ?? '—'}</Field>
            <Field label="Visibility timeout">
              {attributes?.visibilityTimeout === undefined
                ? '—'
                : `${attributes.visibilityTimeout} s`}
            </Field>
            <Field label="Retention period">
              {attributes?.messageRetentionPeriod === undefined
                ? '—'
                : `${attributes.messageRetentionPeriod} s`}
            </Field>
            <Field label="Maximum message size">
              {formatBytes(attributes?.maximumMessageSize)}
            </Field>
            <Field label="Delivery delay">
              {attributes?.delaySeconds === undefined ? '—' : `${attributes.delaySeconds} s`}
            </Field>
            <Field label="Receive wait time">
              {attributes?.receiveWaitTime === undefined ? '—' : `${attributes.receiveWaitTime} s`}
            </Field>
            <Field label="Created">{formatDateTime(attributes?.createdTimestamp)}</Field>
            <Field label="Last modified">{formatDateTime(attributes?.lastModifiedTimestamp)}</Field>
            <Field label="Encryption">
              {attributes?.kmsMasterKeyId ??
                (attributes?.sqsManagedSseEnabled ? 'SQS-managed (SSE-SQS)' : 'None')}
            </Field>
            <Field label="Content-based deduplication">
              {attributes?.fifo ? (attributes.contentBasedDeduplication ? 'On' : 'Off') : '—'}
            </Field>
          </ColumnLayout>

          <Tabs
            tabs={[
              {
                id: 'messages',
                label: 'Messages',
                content: (
                  <MessagesPanel
                    catalog={catalog}
                    queue={queue}
                    onChanged={() => setReload(count => count + 1)}
                  />
                ),
              },
              {
                id: 'send',
                label: 'Send message',
                content: (
                  <SendMessagePanel
                    catalog={catalog}
                    queue={queue}
                    fifo={attributes?.fifo ?? false}
                    onSent={() => setReload(count => count + 1)}
                  />
                ),
              },
              {
                id: 'dead-letter',
                label: 'Dead-letter queue',
                content: (
                  <DeadLetterPanel
                    catalog={catalog}
                    queue={queue}
                    queues={queues}
                    attributes={attributes}
                    onOpenQueue={onOpenQueue}
                  />
                ),
              },
              {
                id: 'attributes',
                label: 'All attributes',
                content: <AttributesTable attributes={attributes} />,
              },
            ]}
          />
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

/**
 * Both directions of the redrive relationship: where this queue's failures go,
 * and which queues send their failures here.
 */
function DeadLetterPanel({
  catalog,
  queue,
  queues,
  attributes,
  onOpenQueue,
}: {
  catalog: ServiceCatalog;
  queue: QueueSummary;
  queues: QueueSummary[];
  attributes: QueueAttributes | undefined;
  onOpenQueue(queue: QueueSummary): void;
}) {
  const { active } = useEndpoints();
  const [sources, setSources] = useState<QueueSummary[]>();
  const [error, setError] = useState<{ header: string; detail: string }>();

  useEffect(() => {
    const controller = new AbortController();
    fetchDeadLetterSourceQueues(active, catalog, queue.url, controller.signal).then(
      listed => {
        if (controller.signal.aborted) return;
        setSources(listed);
        setError(undefined);
      },
      caught => {
        if (controller.signal.aborted) return;
        // A target that has not implemented this operation should not blank the
        // tab — the redrive policy above is still worth showing.
        setSources([]);
        setError(describeError(caught));
      },
    );
    return () => controller.abort();
  }, [active, catalog, queue.url]);

  const redrive = attributes?.redrive;
  const target = resolveDeadLetterQueue(redrive, queues);

  return (
    <SpaceBetween size="l">
      <ColumnLayout columns={2} variant="text-grid">
        <Field label="Dead-letter queue">
          {redrive?.deadLetterTargetArn ? (
            target ? (
              <Link
                href={`#${target.name}`}
                data-testid="open-dead-letter-target"
                onFollow={event => {
                  event.preventDefault();
                  onOpenQueue(target);
                }}
              >
                {target.name}
              </Link>
            ) : (
              <span data-testid="dead-letter-arn">
                {queueNameFromArn(redrive.deadLetterTargetArn) ?? redrive.deadLetterTargetArn}
              </span>
            )
          ) : (
            <span data-testid="no-dead-letter">Not configured</span>
          )}
        </Field>
        <Field label="Maximum receives">
          <span data-testid="max-receive-count">{redrive?.maxReceiveCount ?? '—'}</span>
        </Field>
      </ColumnLayout>

      {error && (
        <Alert type="warning" header={error.header} data-testid="dlq-sources-error">
          {error.detail}
        </Alert>
      )}

      <Table
        data-testid="dlq-source-table"
        variant="embedded"
        loading={sources === undefined}
        loadingText="Listing source queues"
        columnDefinitions={[
          {
            id: 'name',
            header: 'Queue',
            cell: (source: QueueSummary) => (
              <Link
                href={`#${source.name}`}
                data-testid={`open-source-${source.name}`}
                onFollow={event => {
                  event.preventDefault();
                  onOpenQueue(queues.find(entry => entry.url === source.url) ?? source);
                }}
              >
                {source.name}
              </Link>
            ),
          },
        ]}
        items={sources ?? []}
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="m">
            No queue on this target uses {queue.name} as its dead-letter queue.
          </Box>
        }
        header={
          <Header
            variant="h3"
            description="Queues whose redrive policy points at this one, from ListDeadLetterSourceQueues."
          >
            Source queues
          </Header>
        }
      />
    </SpaceBetween>
  );
}

function AttributesTable({ attributes }: { attributes: QueueAttributes | undefined }) {
  const rows = Object.entries(attributes?.raw ?? {})
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Table
      data-testid="queue-attributes"
      variant="embedded"
      columnDefinitions={[
        {
          id: 'name',
          header: 'Attribute',
          cell: (row: { name: string; value: string }) => row.name,
        },
        {
          id: 'value',
          header: 'Value',
          cell: (row: { name: string; value: string }) => (
            <Box variant="code" fontSize="body-s">
              {row.value}
            </Box>
          ),
        },
      ]}
      items={rows}
      empty={
        <Box textAlign="center" color="text-body-secondary" padding="m">
          The target returned no attributes for this queue.
        </Box>
      }
      header={
        <Header variant="h3" description="Every attribute GetQueueAttributes returned, unmodified.">
          Attributes
        </Header>
      }
    />
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box>{children}</Box>
    </div>
  );
}
