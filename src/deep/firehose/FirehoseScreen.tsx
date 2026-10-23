import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator, {
  type StatusIndicatorProps,
} from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import Textarea from '@cloudscape-design/components/textarea';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { useEndpoints } from '../../endpoints/context';
import { formatBytes, formatDateTime } from '../format';
import { stashS3Location } from '../handoff';
import { bucketFromLocation } from '../s3/objects';
import { DeliveryActivity } from './DeliveryActivity';
import {
  describeStream,
  fetchStreamNames,
  putRecords,
  splitRecords,
  staticPrefixOf,
  type DeliveryStream,
  type PutResult,
  type StreamDestination,
} from './streams';

const STATUS_TYPE: Record<string, StatusIndicatorProps.Type> = {
  ACTIVE: 'success',
  CREATING: 'in-progress',
  CREATING_FAILED: 'error',
  DELETING: 'in-progress',
  DELETING_FAILED: 'error',
};

const SAMPLE_RECORDS = '{"order_id":"A-1","total":19.5}\n{"order_id":"A-2","total":4.25}';

/**
 * The Firehose delivery monitor: streams, their buffering and destination
 * configuration, what they have actually delivered, and a way to put test
 * records through them.
 */
export function FirehoseScreen({ catalog }: { catalog: ServiceCatalog }) {
  const { active } = useEndpoints();
  const navigate = useNavigate();

  const [selected, setSelected] = useState<string>();
  const [reload, setReload] = useState(0);
  // The stream list and the stream in view refresh independently: putting
  // records or pressing refresh on the detail should not re-list every stream.
  const [detailReload, setDetailReload] = useState(0);

  const listKey = `${active.url}|${active.region}|${reload}`;
  const [listed, setListed] = useState<{
    key: string;
    names?: string[];
    error?: { header: string; detail: string };
  }>();
  const currentList = listed?.key === listKey ? listed : undefined;

  useEffect(() => {
    const controller = new AbortController();
    fetchStreamNames(active, catalog, controller.signal).then(
      names => !controller.signal.aborted && setListed({ key: listKey, names }),
      caught =>
        !controller.signal.aborted && setListed({ key: listKey, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [active, catalog, listKey]);

  const detailKey = selected ? `${active.url}|${selected}|${detailReload}` : undefined;
  const [described, setDescribed] = useState<{
    key: string;
    name: string;
    stream?: DeliveryStream;
    error?: { header: string; detail: string };
  }>();
  // Matched on the stream's name rather than the request key, so a refresh
  // updates the panel in place instead of tearing it down and losing what the
  // "put test records" tab has on screen.
  const currentDetail = selected && described?.name === selected ? described : undefined;

  useEffect(() => {
    if (!selected || !detailKey) return;
    const controller = new AbortController();
    describeStream(active, catalog, selected, controller.signal).then(
      stream =>
        !controller.signal.aborted && setDescribed({ key: detailKey, name: selected, stream }),
      caught =>
        !controller.signal.aborted &&
        setDescribed({ key: detailKey, name: selected, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [active, catalog, selected, detailKey]);

  // Switching targets must not leave a stream from the previous one selected.
  const [scopedTo, setScopedTo] = useState(active.url);
  if (scopedTo !== active.url) {
    setScopedTo(active.url);
    setSelected(undefined);
  }

  function browseInS3(bucket: string, prefix: string) {
    stashS3Location({ bucket, prefix });
    navigate('/service/s3');
  }

  const rows = (currentList?.names ?? []).map(name => ({ name }));

  return (
    <SpaceBetween size="l">
      {currentList?.error && (
        <Alert type="error" header={currentList.error.header} data-testid="firehose-error">
          {currentList.error.detail}
        </Alert>
      )}

      <Grid
        gridDefinition={[{ colspan: { default: 12, m: 4 } }, { colspan: { default: 12, m: 8 } }]}
      >
        <Table
          data-testid="stream-table"
          variant="container"
          loading={!currentList}
          loadingText="Listing delivery streams"
          trackBy="name"
          selectionType="single"
          selectedItems={rows.filter(row => row.name === selected)}
          ariaLabels={{
            selectionGroupLabel: 'Delivery stream selection',
            itemSelectionLabel: (_state, row: { name: string }) => `Select ${row.name}`,
          }}
          onSelectionChange={event => setSelected(event.detail.selectedItems[0]?.name)}
          columnDefinitions={[
            {
              id: 'name',
              header: 'Delivery stream',
              cell: (row: { name: string }) => (
                <Link
                  href={`#${row.name}`}
                  data-testid={`open-stream-${row.name}`}
                  onFollow={event => {
                    event.preventDefault();
                    setSelected(row.name);
                  }}
                >
                  {row.name}
                </Link>
              ),
            },
          ]}
          items={rows}
          empty={
            <Box textAlign="center" color="text-body-secondary" padding="m">
              This target has no delivery streams.
            </Box>
          }
          header={
            <Header
              variant="h2"
              counter={currentList?.names ? `(${currentList.names.length})` : undefined}
              actions={
                <Button
                  iconName="refresh"
                  ariaLabel="Reload the delivery streams"
                  loading={!currentList}
                  onClick={() => setReload(count => count + 1)}
                />
              }
            >
              Delivery streams
            </Header>
          }
        />

        <SpaceBetween size="l">
          {currentDetail?.error && (
            <Alert type="error" header={currentDetail.error.header} data-testid="stream-error">
              {currentDetail.error.detail}
            </Alert>
          )}

          {!selected && (
            <Container>
              <Box color="text-body-secondary" padding="s" data-testid="no-stream-selected">
                Select a delivery stream to see its configuration and what it has delivered.
              </Box>
            </Container>
          )}

          {currentDetail?.stream && (
            <StreamDetail
              stream={currentDetail.stream}
              catalog={catalog}
              reloadCount={detailReload}
              onReload={() => setDetailReload(count => count + 1)}
              onBrowse={browseInS3}
            />
          )}
        </SpaceBetween>
      </Grid>
    </SpaceBetween>
  );
}

function StreamDetail({
  stream,
  catalog,
  reloadCount,
  onReload,
  onBrowse,
}: {
  stream: DeliveryStream;
  catalog: ServiceCatalog;
  reloadCount: number;
  onReload(): void;
  onBrowse(bucket: string, prefix: string): void;
}) {
  const { active } = useEndpoints();
  const destination = stream.destinations[0];

  return (
    <Container
      data-testid="stream-detail"
      header={
        <Header
          variant="h2"
          description={stream.arn}
          actions={
            <SpaceBetween size="xs" direction="horizontal">
              <StatusIndicator
                type={STATUS_TYPE[stream.status ?? ''] ?? 'info'}
                data-testid="stream-status"
              >
                {stream.status ?? 'UNKNOWN'}
              </StatusIndicator>
              <Button iconName="refresh" ariaLabel="Reload this stream" onClick={onReload} />
            </SpaceBetween>
          }
        >
          {stream.name}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {stream.failureDescription && (
          <Alert type="error" header="The target reports this stream as failed">
            {stream.failureDescription}
          </Alert>
        )}

        <ColumnLayout columns={4} variant="text-grid">
          <Field label="Type">{stream.type ?? '—'}</Field>
          <Field label="Created">{formatDateTime(stream.createTimestamp)}</Field>
          <Field label="Version">{stream.versionId ?? '—'}</Field>
          <Field label="Source">
            {stream.sourceKinesisStreamArn ?? (stream.type === 'DirectPut' ? 'Direct PUT' : '—')}
          </Field>
        </ColumnLayout>

        <Tabs
          tabs={[
            {
              id: 'activity',
              label: 'Delivery activity',
              content: destination ? (
                <DeliveryActivity
                  endpoint={active}
                  destination={destination}
                  reloadCount={reloadCount}
                  onBrowse={onBrowse}
                />
              ) : (
                <Box color="text-body-secondary" padding="s" data-testid="no-destination">
                  The target reports no destination for this stream.
                </Box>
              ),
            },
            {
              id: 'destination',
              label: 'Destination',
              content: destination ? (
                <DestinationPanel destination={destination} onBrowse={onBrowse} />
              ) : (
                <Box color="text-body-secondary" padding="s">
                  The target reports no destination for this stream.
                </Box>
              ),
            },
            {
              id: 'put',
              label: 'Put test records',
              content: <PutRecordsPanel stream={stream} catalog={catalog} onSent={onReload} />,
            },
          ]}
        />
      </SpaceBetween>
    </Container>
  );
}

function DestinationPanel({
  destination,
  onBrowse,
}: {
  destination: StreamDestination;
  onBrowse(bucket: string, prefix: string): void;
}) {
  const bucket = bucketFromLocation(destination.bucketArn);
  const { sizeInMBs, intervalInSeconds } = destination.bufferingHints;

  return (
    <SpaceBetween size="l">
      <ColumnLayout columns={4} variant="text-grid">
        <Field label="Destination">{destination.kind}</Field>
        <Field label="Bucket">
          {bucket ? (
            <Link
              href="#/service/s3"
              data-testid="browse-bucket"
              onFollow={event => {
                event.preventDefault();
                onBrowse(bucket, staticPrefixOf(destination.prefix));
              }}
            >
              {bucket}
            </Link>
          ) : (
            (destination.bucketArn ?? '—')
          )}
        </Field>
        <Field label="Prefix">
          <span data-testid="destination-prefix">{destination.prefix ?? '—'}</span>
        </Field>
        <Field label="Error output prefix">
          <span data-testid="error-output-prefix">{destination.errorOutputPrefix ?? '—'}</span>
        </Field>
        <Field label="Buffer size">
          <span data-testid="buffer-size">
            {sizeInMBs === undefined ? '—' : formatBytes(sizeInMBs * 1024 * 1024)}
          </span>
        </Field>
        <Field label="Buffer interval">
          <span data-testid="buffer-interval">
            {intervalInSeconds === undefined ? '—' : `${intervalInSeconds} s`}
          </span>
        </Field>
        <Field label="Compression">{destination.compressionFormat ?? '—'}</Field>
        <Field label="File extension">{destination.fileExtension ?? '—'}</Field>
        <Field label="S3 backup mode">{destination.s3BackupMode ?? '—'}</Field>
        <Field label="Encryption key">{destination.encryption ?? 'None'}</Field>
        <Field label="CloudWatch log group">
          {destination.cloudWatchLogGroup ?? 'Not logging'}
        </Field>
        <Field label="Role">{destination.roleArn ?? '—'}</Field>
      </ColumnLayout>

      <Box variant="small" color="text-body-secondary">
        A buffer fills up to its size or its interval, whichever comes first; the objects the stream
        writes are the buffers it flushed.
      </Box>
    </SpaceBetween>
  );
}

function PutRecordsPanel({
  stream,
  catalog,
  onSent,
}: {
  stream: DeliveryStream;
  catalog: ServiceCatalog;
  onSent(): void;
}) {
  const { active } = useEndpoints();
  const [text, setText] = useState(SAMPLE_RECORDS);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<PutResult>();
  const [error, setError] = useState<{ header: string; detail: string }>();

  const records = splitRecords(text);

  async function send() {
    setSending(true);
    setError(undefined);
    setResult(undefined);
    try {
      const sent = await putRecords(active, catalog, stream.name, records);
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
          disabled={records.length === 0}
          data-testid="put-records"
          onClick={() => void send()}
        >
          {records.length === 1 ? 'Put 1 record' : `Put ${records.length} records`}
        </Button>
      }
    >
      <SpaceBetween size="m">
        <FormField
          label="Records"
          description="One record per line. Each line is sent as its own record, with a trailing newline so a JSON-lines destination stays readable."
          stretch
        >
          <Textarea
            value={text}
            rows={8}
            data-testid="records-input"
            onChange={event => setText(event.detail.value)}
          />
        </FormField>

        <Box variant="small" color="text-body-secondary">
          {records.length === 1
            ? 'Sent with PutRecord.'
            : `Sent with PutRecordBatch, ${records.length} records in one request.`}
        </Box>

        {error && (
          <Alert type="error" header={error.header} data-testid="put-error">
            {error.detail}
          </Alert>
        )}

        {result && (
          <Alert
            type={result.failed > 0 ? 'warning' : 'success'}
            data-testid="put-result"
            header={
              result.failed > 0
                ? `${result.failed} of ${result.requested} records failed`
                : `${result.requested} ${result.requested === 1 ? 'record' : 'records'} accepted`
            }
          >
            <SpaceBetween size="xs">
              {result.firstError && <Box>{result.firstError}</Box>}
              {result.recordIds.length > 0 && (
                <Box variant="small">Record IDs: {result.recordIds.join(', ')}</Box>
              )}
              <Box variant="small">
                Delivery is buffered, so the objects appear under the destination prefix once the
                buffer flushes.
              </Box>
            </SpaceBetween>
          </Alert>
        )}
      </SpaceBetween>
    </Form>
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
