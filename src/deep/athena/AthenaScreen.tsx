import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Tabs from '@cloudscape-design/components/tabs';
import Textarea from '@cloudscape-design/components/textarea';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { useEndpoints } from '../../endpoints/context';
import { clearAthenaQuery, peekAthenaQuery } from '../handoff';
import { createQueryRunner, waitForTerminal } from './execution';
import { HistoryPanel, SavedQueriesPanel } from './HistoryPanel';
import { QueryFailurePanel } from './QueryFailurePanel';
import { QueryStatusLine, ResultsPanel } from './ResultsPanel';
import { loadGlueCatalog, selectStatement, type SchemaTable } from './schema';
import { SchemaTree } from './SchemaTree';
import { SqlEditor } from './SqlEditor';
import {
  appendHistory,
  clearHistory,
  deleteSavedQuery,
  loadHistory,
  loadQueryContext,
  loadSavedQueries,
  newLocalId,
  saveQuery,
  saveQueryContext,
  type HistoryEntry,
  type SavedQuery,
} from './store';
import { classifyFailure, classifyMessage, type QueryFailure } from './unsupported';
import type { QueryContext, QueryExecutionSnapshot, ResultPage } from './types';

const STARTER_QUERY = 'SELECT 1;';

/**
 * The Athena query editor — the flagship screen.
 *
 * It runs the service's real lifecycle: `StartQueryExecution`, poll
 * `GetQueryExecution` to a terminal state, page `GetQueryResults` with the
 * service's own token, `StopQueryExecution` to cancel. Nothing is simulated; a
 * target that answers Athena answers this screen.
 */
export function AthenaScreen({ catalog }: { catalog: ServiceCatalog }) {
  const { active } = useEndpoints();
  const endpointKey = active.url;

  // Another screen may have opened this one with a statement ready — Glue's
  // "Query this table" does exactly that.
  const [handoff] = useState(() => peekAthenaQuery());
  const [sql, setSql] = useState(handoff?.sql ?? STARTER_QUERY);
  const [context, setContext] = useState<QueryContext>(() => ({
    ...loadQueryContext(endpointKey),
    ...(handoff?.database ? { database: handoff.database } : {}),
    ...(handoff?.catalog ? { catalog: handoff.catalog } : {}),
  }));
  const [snapshot, setSnapshot] = useState<QueryExecutionSnapshot>();
  const [failure, setFailure] = useState<QueryFailure>();
  const [callError, setCallError] = useState<{ header: string; detail: string }>();
  const [running, setRunning] = useState(false);
  const [pages, setPages] = useState<ResultPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory(endpointKey));
  const [saved, setSaved] = useState<SavedQuery[]>(() => loadSavedQueries(endpointKey));
  const [glue, setGlue] = useState<ServiceCatalog>();
  const [glueError, setGlueError] = useState<string>();
  const [saveName, setSaveName] = useState<string>();

  const runControl = useRef<AbortController>(undefined);
  const runningQueryId = useRef<string>(undefined);

  // Endpoint-scoped state: switching targets swaps history, saved queries and
  // the execution context rather than carrying one target's over to another.
  // Adjusting during render rather than in an effect means the new endpoint's
  // state is on screen in the same commit, with no frame showing the old one.
  const [scopedTo, setScopedTo] = useState(endpointKey);
  if (scopedTo !== endpointKey) {
    setScopedTo(endpointKey);
    setContext(loadQueryContext(endpointKey));
    setHistory(loadHistory(endpointKey));
    setSaved(loadSavedQueries(endpointKey));
    setSnapshot(undefined);
    setFailure(undefined);
    setCallError(undefined);
    setPages([]);
    setPageIndex(0);
  }

  useEffect(() => {
    let cancelled = false;
    loadGlueCatalog().then(
      loaded => !cancelled && setGlue(loaded),
      caught => !cancelled && setGlueError((caught as Error).message),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => runControl.current?.abort(), []);

  useEffect(() => {
    clearAthenaQuery();
  }, []);

  const runner = useMemo(() => createQueryRunner(active, catalog), [active, catalog]);

  const updateContext = useCallback(
    (patch: Partial<QueryContext>) => {
      setContext(current => {
        const next = { ...current, ...patch };
        saveQueryContext(endpointKey, next);
        return next;
      });
    },
    [endpointKey],
  );

  const record = useCallback(
    (entry: HistoryEntry) => setHistory(appendHistory(endpointKey, entry)),
    [endpointKey],
  );

  async function run() {
    const statement = sql.trim();
    if (statement === '' || running) return;

    runControl.current?.abort();
    const controller = new AbortController();
    runControl.current = controller;
    runningQueryId.current = undefined;

    setRunning(true);
    setSnapshot(undefined);
    setFailure(undefined);
    setCallError(undefined);
    setPages([]);
    setPageIndex(0);

    const historyId = newLocalId('run');
    const ranAt = new Date().toISOString();

    try {
      const queryExecutionId = await runner.start(statement, context, controller.signal);
      if (controller.signal.aborted) return;
      runningQueryId.current = queryExecutionId;
      setSnapshot({ id: queryExecutionId, state: 'QUEUED' });

      const final = await waitForTerminal(runner, queryExecutionId, {
        signal: controller.signal,
        onUpdate: latest => {
          if (!controller.signal.aborted) setSnapshot(latest);
        },
      });
      if (controller.signal.aborted) return;
      setSnapshot(final);

      const queryFailure = classifyFailure(final);
      setFailure(queryFailure);

      if (final.state === 'SUCCEEDED') {
        await fetchResults(queryExecutionId, undefined, controller.signal);
      }

      record({
        id: historyId,
        queryExecutionId,
        sql: statement,
        state: final.state,
        ranAt,
        database: context.database,
        catalog: context.catalog,
        dataScannedInBytes: final.statistics?.dataScannedInBytes,
        engineExecutionTimeInMillis: final.statistics?.engineExecutionTimeInMillis,
        failure: queryFailure?.message,
        unsupportedConstruct:
          queryFailure?.kind === 'unsupported-construct'
            ? (queryFailure.construct ?? 'unnamed construct')
            : undefined,
      });
    } catch (caught) {
      if (controller.signal.aborted) return;
      const described = describeError(caught);
      // A target may refuse the statement synchronously rather than failing the
      // execution; an unsupported construct deserves the same explanation
      // either way.
      const classified = classifyMessage(described.detail);
      if (classified.kind === 'unsupported-construct') {
        setFailure({ ...classified, message: described.detail });
      } else {
        setCallError(described);
      }
      record({
        id: historyId,
        sql: statement,
        state: 'FAILED',
        ranAt,
        database: context.database,
        catalog: context.catalog,
        failure: described.detail,
        unsupportedConstruct:
          classified.kind === 'unsupported-construct'
            ? (classified.construct ?? 'unnamed construct')
            : undefined,
      });
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  async function fetchResults(
    queryExecutionId: string,
    token: string | undefined,
    signal?: AbortSignal,
  ) {
    setResultsLoading(true);
    try {
      const page = await runner.results(queryExecutionId, token, signal);
      if (signal?.aborted) return;
      setPages(current => (token === undefined ? [page] : [...current, page]));
      setPageIndex(current => (token === undefined ? 0 : current + 1));
    } catch (caught) {
      if (!signal?.aborted) setCallError(describeError(caught));
    } finally {
      if (!signal?.aborted) setResultsLoading(false);
    }
  }

  async function cancel() {
    const queryExecutionId = runningQueryId.current;
    if (!queryExecutionId) {
      runControl.current?.abort();
      setRunning(false);
      return;
    }
    try {
      await runner.stop(queryExecutionId);
    } catch (caught) {
      setCallError(describeError(caught));
    } finally {
      // Stop polling only after the stop request, so the screen keeps showing
      // the query's state until the target has actually been told to stop.
      runControl.current?.abort();
      setRunning(false);
    }
  }

  function loadIntoEditor(statement: string, entryContext?: Partial<QueryContext>) {
    setSql(statement);
    if (entryContext?.database || entryContext?.catalog) updateContext(entryContext);
  }

  function confirmSave() {
    const name = saveName?.trim();
    if (!name) return;
    setSaved(
      saveQuery(endpointKey, {
        id: newLocalId('saved'),
        name,
        sql,
        savedAt: new Date().toISOString(),
      }),
    );
    setSaveName(undefined);
  }

  return (
    <SpaceBetween size="l">
      {glueError && (
        <Alert type="warning" header="The schema tree is unavailable" data-testid="glue-error">
          {glueError}
        </Alert>
      )}

      <Grid
        gridDefinition={[
          { colspan: { default: 12, m: 4, l: 3 } },
          { colspan: { default: 12, m: 8, l: 9 } },
        ]}
      >
        <SchemaTree
          endpoint={active}
          glue={glue}
          onUseDatabase={databaseName => updateContext({ database: databaseName })}
          onQueryTable={(databaseName, table: SchemaTable) => {
            updateContext({ database: databaseName });
            setSql(selectStatement(databaseName, table));
          }}
        />

        <SpaceBetween size="l">
          <Container
            header={
              <Header
                variant="h2"
                description="Runs against the target's Athena API — StartQueryExecution, GetQueryExecution, GetQueryResults."
                actions={
                  <SpaceBetween size="xs" direction="horizontal">
                    <Button onClick={() => setSaveName('')} disabled={sql.trim() === ''}>
                      Save query
                    </Button>
                    <Button
                      onClick={cancel}
                      disabled={!running}
                      data-testid="cancel-query"
                      iconName="close"
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      loading={running}
                      disabled={sql.trim() === ''}
                      data-testid="run-query"
                      onClick={run}
                    >
                      Run
                    </Button>
                  </SpaceBetween>
                }
              >
                Query editor
              </Header>
            }
          >
            <SpaceBetween size="m">
              <ColumnLayout columns={4}>
                <FormField label="Data catalog" description="QueryExecutionContext.Catalog" stretch>
                  <Input
                    value={context.catalog ?? ''}
                    placeholder="awsdatacatalog"
                    onChange={event => updateContext({ catalog: event.detail.value })}
                  />
                </FormField>
                <FormField label="Database" description="QueryExecutionContext.Database" stretch>
                  <Input
                    value={context.database ?? ''}
                    placeholder="default"
                    data-testid="database-input"
                    onChange={event => updateContext({ database: event.detail.value })}
                  />
                </FormField>
                <FormField label="Workgroup" description="WorkGroup" stretch>
                  <Input
                    value={context.workGroup ?? ''}
                    placeholder="primary"
                    onChange={event => updateContext({ workGroup: event.detail.value })}
                  />
                </FormField>
                <FormField
                  label="Result location"
                  description="ResultConfiguration.OutputLocation"
                  stretch
                >
                  <Input
                    value={context.outputLocation ?? ''}
                    placeholder="s3://bucket/prefix/"
                    onChange={event => updateContext({ outputLocation: event.detail.value })}
                  />
                </FormField>
              </ColumnLayout>

              <SqlEditor value={sql} onChange={setSql} onRun={run} disabled={running} />
              <Box variant="small" color="text-body-secondary">
                Empty context fields are left out of the request, so a target that takes its result
                location from the workgroup is not sent an empty one.
              </Box>
            </SpaceBetween>
          </Container>

          {callError && (
            <Alert type="error" header={callError.header} data-testid="athena-error">
              {callError.detail}
            </Alert>
          )}

          {failure && <QueryFailurePanel failure={failure} />}

          {snapshot && <QueryStatusLine snapshot={snapshot} />}

          {(pages.length > 0 || pages[0]?.updateCount !== undefined) && (
            <ResultsPanel
              pages={pages}
              pageIndex={pageIndex}
              loading={resultsLoading}
              updateCount={pages[0]?.updateCount}
              onPageChange={setPageIndex}
              onFetchNext={token => {
                if (snapshot) void fetchResults(snapshot.id, token);
              }}
            />
          )}

          <Container header={<Header variant="h2">Query library</Header>}>
            <Tabs
              tabs={[
                {
                  id: 'history',
                  label: 'Recent queries',
                  content: (
                    <HistoryPanel
                      entries={history}
                      onLoad={entry =>
                        loadIntoEditor(entry.sql, {
                          database: entry.database,
                          catalog: entry.catalog,
                        })
                      }
                      onClear={() => setHistory(clearHistory(endpointKey))}
                    />
                  ),
                },
                {
                  id: 'saved',
                  label: 'Saved queries',
                  content: (
                    <SavedQueriesPanel
                      queries={saved}
                      onLoad={query => loadIntoEditor(query.sql)}
                      onDelete={query => setSaved(deleteSavedQuery(endpointKey, query.id))}
                    />
                  ),
                },
              ]}
            />
          </Container>
        </SpaceBetween>
      </Grid>

      <Modal
        visible={saveName !== undefined}
        header="Save query"
        onDismiss={() => setSaveName(undefined)}
        footer={
          <Box float="right">
            <SpaceBetween size="xs" direction="horizontal">
              <Button variant="link" onClick={() => setSaveName(undefined)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!saveName?.trim()}
                data-testid="confirm-save-query"
                onClick={confirmSave}
              >
                Save
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Form>
          <SpaceBetween size="m">
            <FormField
              label="Name"
              description="Saving under an existing name replaces it."
              stretch
            >
              <Input
                value={saveName ?? ''}
                data-testid="save-query-name"
                onChange={event => setSaveName(event.detail.value)}
              />
            </FormField>
            <FormField label="Query" stretch>
              <Textarea value={sql} readOnly rows={6} />
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>
    </SpaceBetween>
  );
}
