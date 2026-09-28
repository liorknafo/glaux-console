import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { useEndpoints } from '../../endpoints/context';
import { sendMessage, type QueueSummary, type SendResult } from './queues';

const SAMPLE = '{"order_id":"A-1","total":19.5}';

/**
 * Sending one message to the queue in view.
 *
 * A FIFO queue requires a message group, and requires a deduplication id unless
 * the queue deduplicates on content — so those two fields only appear for a
 * FIFO queue, and the group is required there rather than silently omitted.
 */
export function SendMessagePanel({
  catalog,
  queue,
  fifo,
  onSent,
}: {
  catalog: ServiceCatalog;
  queue: QueueSummary;
  fifo: boolean;
  onSent(): void;
}) {
  const { active } = useEndpoints();
  const [body, setBody] = useState(SAMPLE);
  const [delay, setDelay] = useState('');
  const [groupId, setGroupId] = useState(fifo ? 'console' : '');
  const [dedupId, setDedupId] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult>();
  const [error, setError] = useState<{ header: string; detail: string }>();

  const delaySeconds = delay.trim() === '' ? undefined : Number(delay);
  const delayInvalid =
    delaySeconds !== undefined &&
    (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 900);
  const groupMissing = fifo && groupId.trim() === '';
  const canSend = body !== '' && !delayInvalid && !groupMissing;

  async function send() {
    setSending(true);
    setError(undefined);
    setResult(undefined);
    try {
      const sent = await sendMessage(active, catalog, {
        queueUrl: queue.url,
        body,
        delaySeconds,
        messageGroupId: fifo ? groupId.trim() : undefined,
        messageDeduplicationId: fifo && dedupId.trim() !== '' ? dedupId.trim() : undefined,
      });
      setResult(sent);
      onSent();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSending(false);
    }
  }

  return (
    <Form
      actions={
        <Button
          variant="primary"
          loading={sending}
          disabled={!canSend}
          data-testid="send-message"
          onClick={() => void send()}
        >
          Send message
        </Button>
      }
    >
      <SpaceBetween size="m">
        <FormField
          label="Message body"
          description="Sent verbatim as MessageBody. SQS does not interpret it."
          stretch
        >
          <Textarea
            value={body}
            rows={6}
            data-testid="message-body-input"
            onChange={event => setBody(event.detail.value)}
          />
        </FormField>

        <ColumnLayout columns={fifo ? 3 : 1}>
          <FormField
            label="Delivery delay"
            description="Seconds, 0–900. Left empty, the queue's own delay applies."
            errorText={delayInvalid ? 'Enter a whole number of seconds from 0 to 900.' : undefined}
          >
            <Input
              value={delay}
              type="number"
              placeholder="Queue default"
              data-testid="delay-input"
              onChange={event => setDelay(event.detail.value)}
            />
          </FormField>

          {fifo && (
            <FormField
              label="Message group ID"
              description="Required on a FIFO queue. Messages in one group are delivered in order."
              errorText={groupMissing ? 'A FIFO queue requires a message group ID.' : undefined}
            >
              <Input
                value={groupId}
                data-testid="group-id-input"
                onChange={event => setGroupId(event.detail.value)}
              />
            </FormField>
          )}

          {fifo && (
            <FormField
              label="Deduplication ID"
              description="Optional when the queue deduplicates on content."
            >
              <Input
                value={dedupId}
                data-testid="dedup-id-input"
                onChange={event => setDedupId(event.detail.value)}
              />
            </FormField>
          )}
        </ColumnLayout>

        {error && (
          <Alert type="error" header={error.header} data-testid="send-error">
            {error.detail}
          </Alert>
        )}

        {result && (
          <Alert type="success" header="Message sent" data-testid="send-result">
            <SpaceBetween size="xs">
              <Box>Message ID: {result.messageId ?? 'not reported'}</Box>
              {result.sequenceNumber && <Box>Sequence number: {result.sequenceNumber}</Box>}
              <Box variant="small">
                A message sent with a delivery delay is not returned by a poll until the delay has
                passed.
              </Box>
            </SpaceBetween>
          </Alert>
        )}
      </SpaceBetween>
    </Form>
  );
}
