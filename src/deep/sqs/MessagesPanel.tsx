import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { DestructiveConfirm } from '../../generic/DestructiveConfirm';
import { useEndpoints } from '../../endpoints/context';
import { formatDateTime } from '../format';
import {
  deleteMessage,
  peekMessages,
  purgeQueue,
  MAX_PEEK,
  type PeekedMessage,
  type QueueSummary,
} from './queues';

const COUNTS = [1, 5, MAX_PEEK].map(value => ({ value: String(value), label: String(value) }));

/**
 * Peeking at a queue.
 *
 * The panel is explicit about what a peek is: SQS only ever shows a message by
 * receiving it, so this receives with a zero visibility timeout and the message
 * stays available to real consumers. Nothing here hides that — a peek still
 * increments the message's receive count, and that count is a column.
 */
export function MessagesPanel({
  catalog,
  queue,
  onChanged,
}: {
  catalog: ServiceCatalog;
  queue: QueueSummary;
  onChanged(): void;
}) {
  const { active } = useEndpoints();
  const [count, setCount] = useState(String(MAX_PEEK));
  const [messages, setMessages] = useState<PeekedMessage[]>();
  const [selected, setSelected] = useState<PeekedMessage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ header: string; detail: string }>();
  const [notice, setNotice] = useState<string>();
  const [confirming, setConfirming] = useState<'delete' | 'purge'>();

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  const poll = () =>
    run(async () => {
      setNotice(undefined);
      const peeked = await peekMessages(active, catalog, queue.url, Number(count));
      setMessages(peeked);
      setSelected(undefined);
    });

  const removeSelected = () =>
    run(async () => {
      const handle = selected?.receiptHandle;
      if (!handle) throw new Error('The target returned no receipt handle for this message');
      await deleteMessage(active, catalog, queue.url, handle);
      setMessages(current => current?.filter(entry => entry.messageId !== selected?.messageId));
      setNotice(`Deleted message ${selected?.messageId}.`);
      setSelected(undefined);
      onChanged();
    });

  const purge = () =>
    run(async () => {
      await purgeQueue(active, catalog, queue.url);
      setMessages([]);
      setSelected(undefined);
      setNotice(
        `Purge requested for ${queue.name}. SQS may take up to 60 seconds to delete every message.`,
      );
      onChanged();
    });

  return (
    <SpaceBetween size="l">
      <Table
        data-testid="message-table"
        variant="embedded"
        trackBy="messageId"
        selectionType="single"
        selectedItems={(messages ?? []).filter(entry => entry.messageId === selected?.messageId)}
        ariaLabels={{
          selectionGroupLabel: 'Message selection',
          itemSelectionLabel: (_state, message: PeekedMessage) => `Select ${message.messageId}`,
        }}
        onSelectionChange={event => setSelected(event.detail.selectedItems[0])}
        columnDefinitions={[
          {
            id: 'body',
            header: 'Body',
            cell: (message: PeekedMessage) => (
              <Box variant="code" fontSize="body-s">
                {message.body.length > 120 ? `${message.body.slice(0, 120)}…` : message.body}
              </Box>
            ),
          },
          {
            id: 'sent',
            header: 'Sent',
            cell: (message: PeekedMessage) =>
              // `SentTimestamp` is epoch milliseconds, which is a thousand
              // times what the shared formatter reads as epoch seconds.
              message.attributes.SentTimestamp
                ? formatDateTime(Number(message.attributes.SentTimestamp) / 1000)
                : '—',
          },
          {
            id: 'receives',
            header: 'Receives',
            cell: (message: PeekedMessage) => message.attributes.ApproximateReceiveCount ?? '—',
          },
        ]}
        items={messages ?? []}
        loading={busy && messages === undefined}
        loadingText="Polling the queue"
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="m">
            {messages === undefined
              ? 'Poll the queue to see what is on it.'
              : 'The poll returned no messages. A queue with messages in flight can still answer empty.'}
          </Box>
        }
        header={
          <Header
            variant="h3"
            counter={messages ? `(${messages.length})` : undefined}
            description="Received with a zero visibility timeout, so the messages stay available to real consumers."
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Select
                  selectedOption={COUNTS.find(option => option.value === count) ?? COUNTS[2]}
                  options={COUNTS}
                  ariaLabel="Messages to poll for"
                  data-testid="peek-count"
                  onChange={event =>
                    setCount(event.detail.selectedOption.value ?? String(MAX_PEEK))
                  }
                />
                <Button data-testid="poll-messages" loading={busy} onClick={() => void poll()}>
                  Poll for messages
                </Button>
                <Button
                  data-testid="delete-message"
                  disabled={!selected}
                  onClick={() => setConfirming('delete')}
                >
                  Delete message
                </Button>
                <Button data-testid="purge-queue" onClick={() => setConfirming('purge')}>
                  Purge queue
                </Button>
              </SpaceBetween>
            }
          >
            Messages
          </Header>
        }
      />

      <Alert type="info" data-testid="peek-explanation">
        SQS has no read-only browse operation. This polls with <code>ReceiveMessage</code> and a
        visibility timeout of 0, which is the closest thing to a peek: the messages come back and
        stay visible immediately instead of disappearing for the queue&rsquo;s timeout. It still
        counts as a receive, so <em>Receives</em> goes up, and a message already in flight for
        another consumer will not appear.
      </Alert>

      {error && (
        <Alert type="error" header={error.header} data-testid="messages-error">
          {error.detail}
        </Alert>
      )}

      {notice && (
        <Alert
          type="success"
          dismissible
          data-testid="messages-notice"
          onDismiss={() => setNotice(undefined)}
        >
          {notice}
        </Alert>
      )}

      {selected && <MessageDetail message={selected} />}

      {confirming === 'delete' && selected && catalog.operations.DeleteMessage && (
        <DestructiveConfirm
          operation={catalog.operations.DeleteMessage}
          identifier={{ field: 'MessageId', value: selected.messageId }}
          onDismiss={() => setConfirming(undefined)}
          onConfirm={() => {
            setConfirming(undefined);
            void removeSelected();
          }}
        />
      )}

      {confirming === 'purge' && catalog.operations.PurgeQueue && (
        <DestructiveConfirm
          operation={catalog.operations.PurgeQueue}
          identifier={{ field: 'QueueName', value: queue.name }}
          onDismiss={() => setConfirming(undefined)}
          onConfirm={() => {
            setConfirming(undefined);
            void purge();
          }}
        />
      )}
    </SpaceBetween>
  );
}

function MessageDetail({ message }: { message: PeekedMessage }) {
  return (
    <SpaceBetween size="m">
      <Header variant="h3">{message.messageId}</Header>

      <Box variant="code" data-testid="message-body">
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {message.body}
        </pre>
      </Box>

      <ColumnLayout columns={2} variant="text-grid">
        <div>
          <Box variant="awsui-key-label">Body MD5</Box>
          <Box>{message.md5OfBody ?? '—'}</Box>
        </div>
        <div>
          <Box variant="awsui-key-label">Receipt handle</Box>
          <Box variant="small" data-testid="receipt-handle">
            {message.receiptHandle ?? '—'}
          </Box>
        </div>
      </ColumnLayout>

      <Table
        data-testid="message-attributes"
        variant="embedded"
        columnDefinitions={[
          {
            id: 'name',
            header: 'Name',
            cell: (row: { name: string; value: string }) => row.name,
          },
          {
            id: 'value',
            header: 'Value',
            cell: (row: { name: string; value: string }) => row.value,
          },
        ]}
        items={[
          ...Object.entries(message.attributes).map(([name, value]) => ({ name, value })),
          ...message.messageAttributes.map(attribute => ({
            name: attribute.name,
            value: `${attribute.value ?? ''}${attribute.dataType ? ` (${attribute.dataType})` : ''}`,
          })),
        ]}
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="m">
            This message carries no attributes.
          </Box>
        }
        header={<Header variant="h3">Attributes</Header>}
      />
    </SpaceBetween>
  );
}
