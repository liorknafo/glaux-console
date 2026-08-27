import { useEffect, useState, type ReactNode } from 'react';
import Alert from '@cloudscape-design/components/alert';
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
import { formatBytes, formatEpochMillis } from '../format';
import { StreamsPanel } from './StreamsPanel';
import { TailPanel } from './TailPanel';
import { fetchLogGroups, type LogGroupSummary } from './events';

/**
 * The CloudWatch Logs screen: the log groups on the target, one group's
 * streams, and a tail over the group or over a single stream.
 *
 * The generated Resources tab already lists groups and streams as tables. What
 * it cannot do is read a group forward as it is written — `FilterLogEvents` is
 * classified as neither list nor describe, so it never appears in the read
 * picker, and following it needs a moving window that a one-shot form has no
 * way to keep. That is this screen.
 */
export function LogsScreen({ catalog }: { catalog: ServiceCatalog }) {
  const { active } = useEndpoints();
  const [selected, setSelected] = useState<LogGroupSummary>();
  const [stream, setStream] = useState<string>();
  const [tab, setTab] = useState('tail');
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);

  const listKey = `${active.url}|${active.region}|${reload}`;
  const [listed, setListed] = useState<{
    key: string;
    groups?: LogGroupSummary[];
    error?: { header: string; detail: string };
  }>();
  const current = listed?.key === listKey ? listed : undefined;

  useEffect(() => {
    const controller = new AbortController();
    fetchLogGroups(active, catalog, controller.signal).then(
      groups => !controller.signal.aborted && setListed({ key: listKey, groups }),
      caught =>
        !controller.signal.aborted && setListed({ key: listKey, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [active, catalog, listKey]);

  // Switching targets must not leave a group from the previous one selected.
  const [scopedTo, setScopedTo] = useState(active.url);
  if (scopedTo !== active.url) {
    setScopedTo(active.url);
    setSelected(undefined);
    setStream(undefined);
  }

  const groups = current?.groups ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = groups.filter(group => !needle || group.name.toLowerCase().includes(needle));

  function openGroup(group: LogGroupSummary) {
    setSelected(group);
    setStream(undefined);
    setTab('tail');
  }

  return (
    <SpaceBetween size="l">
      {current?.error && (
        <Alert type="error" header={current.error.header} data-testid="logs-error">
          {current.error.detail}
        </Alert>
      )}

      <Grid
        gridDefinition={[{ colspan: { default: 12, m: 4 } }, { colspan: { default: 12, m: 8 } }]}
      >
        <Table
          data-testid="log-group-table"
          variant="container"
          loading={!current}
          loadingText="Listing log groups"
          trackBy="name"
          selectionType="single"
          selectedItems={visible.filter(group => group.name === selected?.name)}
          ariaLabels={{
            selectionGroupLabel: 'Log group selection',
            itemSelectionLabel: (_state, group: LogGroupSummary) => `Select ${group.name}`,
          }}
          onSelectionChange={event => {
            const group = event.detail.selectedItems[0];
            if (group) openGroup(group);
          }}
          columnDefinitions={[
            {
              id: 'name',
              header: 'Log group',
              cell: (group: LogGroupSummary) => (
                <Link
                  href={`#${group.name}`}
                  data-testid={`open-log-group-${group.name}`}
                  onFollow={event => {
                    event.preventDefault();
                    openGroup(group);
                  }}
                >
                  {group.name}
                </Link>
              ),
            },
          ]}
          items={visible}
          empty={
            <Box textAlign="center" color="text-body-secondary" padding="m">
              {needle ? 'No log group matches that filter.' : 'This target has no log groups.'}
            </Box>
          }
          filter={
            <TextFilter
              filteringText={filter}
              filteringPlaceholder="Find a log group"
              filteringAriaLabel="Find a log group"
              onChange={event => setFilter(event.detail.filteringText)}
            />
          }
          header={
            <Header
              variant="h2"
              counter={current?.groups ? `(${current.groups.length})` : undefined}
              actions={
                <Button
                  iconName="refresh"
                  ariaLabel="Reload the log group list"
                  loading={!current}
                  onClick={() => setReload(count => count + 1)}
                />
              }
            >
              Log groups
            </Header>
          }
        />

        {selected ? (
          <Container
            data-testid="log-group-detail"
            header={
              <Header variant="h2" description={selected.arn}>
                {selected.name}
              </Header>
            }
          >
            <SpaceBetween size="l">
              <ColumnLayout columns={4} variant="text-grid">
                <Field label="Retention">
                  <span data-testid="group-retention">
                    {selected.retentionInDays === undefined
                      ? 'Never expire'
                      : `${selected.retentionInDays} days`}
                  </span>
                </Field>
                <Field label="Stored">{formatBytes(selected.storedBytes)}</Field>
                <Field label="Class">{selected.logGroupClass ?? '—'}</Field>
                <Field label="Created">{formatEpochMillis(selected.creationTime)}</Field>
              </ColumnLayout>

              <Tabs
                activeTabId={tab}
                onChange={event => setTab(event.detail.activeTabId)}
                tabs={[
                  {
                    id: 'tail',
                    label: 'Tail',
                    content: (
                      <TailPanel
                        key={`${active.url}|${selected.name}`}
                        catalog={catalog}
                        logGroupName={selected.name}
                        logStreamName={stream}
                        onClearStream={() => setStream(undefined)}
                      />
                    ),
                  },
                  {
                    id: 'streams',
                    label: 'Streams',
                    content: (
                      <StreamsPanel
                        catalog={catalog}
                        logGroupName={selected.name}
                        onTailStream={name => {
                          setStream(name);
                          setTab('tail');
                        }}
                      />
                    ),
                  },
                ]}
              />
            </SpaceBetween>
          </Container>
        ) : (
          <Container>
            <Box color="text-body-secondary" padding="s" data-testid="no-log-group-selected">
              Select a log group to list its streams and tail it.
            </Box>
          </Container>
        )}
      </Grid>
    </SpaceBetween>
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
