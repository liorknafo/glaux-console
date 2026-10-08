import { useMemo, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Pagination from '@cloudscape-design/components/pagination';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import type { Operation, ServiceCatalog } from '../catalog/types';
import { callOperation, describeError } from '../api/client';
import { useEndpoints } from '../endpoints/context';
import { GeneratedForm } from './GeneratedForm';
import { inferResultShape, readCollection, renderCell, type ResultShape } from './columns';
import { OperationResult } from './OperationResult';
import { preferredColumns, profileFor, rendersRawResult } from './profiles';
import { ViewAsCli } from './ViewAsCli';

/**
 * The Resources tab: list and describe operations rendered as console tables.
 *
 * Columns are inferred from the operation's output shape and pagination is
 * wired to the operation's own token fields, so paging is the service's real
 * pagination rather than client-side slicing.
 *
 * A service with a profile (`./profiles.ts`) opens on that profile's first
 * resource view and gets its curated columns; a service without one behaves
 * exactly as before, which is what keeps the catalog layer the floor for all
 * ~56 catalogued services rather than only the curated few.
 */

interface Page {
  items: unknown[];
  token?: string;
}

export function ResourcesTab({ catalog }: { catalog: ServiceCatalog }) {
  const { active } = useEndpoints();
  const profile = profileFor(catalog.id);
  // The picker opens on the profile's first view rather than empty. Nothing is
  // requested until the user runs it — preselecting chooses what to show, not
  // what to send.
  const [selectedName, setSelectedName] = useState<string | undefined>(
    () => profile?.resources.find(view => catalog.operations[view.operation])?.operation,
  );
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [pages, setPages] = useState<Page[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ header: string; detail: string }>();
  const [lastRaw, setLastRaw] = useState<{ output: unknown; status: number; durationMs: number }>();

  const readOperations = useMemo(
    () =>
      Object.values(catalog.operations)
        .filter(operation => ['list', 'describe'].includes(operation.classification))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [catalog],
  );

  const options = useMemo<SelectProps.Options>(() => {
    const toOption = (candidate: Operation) => ({
      label: candidate.name,
      value: candidate.name,
      description: candidate.doc,
    });
    const featured = (profile?.resources ?? [])
      .map(view => catalog.operations[view.operation])
      .filter((candidate): candidate is Operation => candidate !== undefined);
    const featuredNames = new Set(featured.map(candidate => candidate.name));
    const rest = readOperations.filter(candidate => !featuredNames.has(candidate.name));
    if (featured.length === 0) return rest.map(toOption);
    return [
      { label: 'Common', options: featured.map(toOption) },
      { label: 'All read operations', options: rest.map(toOption) },
    ];
  }, [catalog, profile, readOperations]);

  const operation = selectedName ? catalog.operations[selectedName] : undefined;
  const resultShape: ResultShape | undefined = useMemo(
    () =>
      operation && !rendersRawResult(catalog.id, operation.name)
        ? inferResultShape(
            catalog,
            operation.output,
            operation.pagination?.resultKey,
            preferredColumns(catalog.id, operation.name),
          )
        : undefined,
    [catalog, operation],
  );

  // Selecting another operation clears the result but cannot cancel a request
  // already in flight; without this guard its late response would land on the
  // newly-selected operation's screen.
  const requestSequence = useRef(0);

  function selectOperation(name: string) {
    requestSequence.current += 1;
    setSelectedName(name);
    setInput({});
    setPages([]);
    setPageIndex(0);
    setError(undefined);
    setLastRaw(undefined);
    setLoading(false);
  }

  async function fetchPage(token: string | undefined, replace: boolean) {
    if (!operation) return;
    requestSequence.current += 1;
    const sequence = requestSequence.current;
    const current = () => requestSequence.current === sequence;
    setLoading(true);
    setError(undefined);
    const pagination = operation.pagination;
    const request = { ...input };
    if (token && pagination?.inputToken) request[pagination.inputToken] = token;

    try {
      const result = await callOperation(active, catalog, operation, request);
      if (!current()) return;
      setLastRaw({ output: result.output, status: result.status, durationMs: result.durationMs });
      const items = resultShape ? readCollection(result.output, resultShape.path) : [];
      const nextToken = pagination?.outputToken
        ? readToken(result.output, pagination.outputToken)
        : undefined;
      const page: Page = { items, token: nextToken };
      setPages(existing => (replace ? [page] : [...existing, page]));
      setPageIndex(existing => (replace ? 0 : existing + 1));
    } catch (caught) {
      if (!current()) return;
      setError(describeError(caught));
    } finally {
      if (current()) setLoading(false);
    }
  }

  const currentPage = pages[pageIndex];
  const canGoNext = Boolean(currentPage?.token) || pageIndex < pages.length - 1;

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description={
              profile?.summary ?? `${readOperations.length} read operations in the model.`
            }
          >
            Resource view
          </Header>
        }
      >
        <SpaceBetween size="m">
          <FormField
            label="Read operation"
            description={
              profile ? `${readOperations.length} read operations in the model.` : undefined
            }
            stretch
          >
            <Select
              selectedOption={selectedName ? { label: selectedName, value: selectedName } : null}
              options={options}
              filteringType="auto"
              placeholder="Choose a list or describe operation"
              onChange={event => selectOperation(String(event.detail.selectedOption.value))}
            />
          </FormField>

          {operation && (
            <>
              <ExpandableSection
                headerText="Parameters"
                variant="footer"
                defaultExpanded={hasRequiredInput(catalog, operation)}
              >
                <GeneratedForm
                  catalog={catalog}
                  operation={operation}
                  value={input}
                  onChange={setInput}
                  disabled={loading}
                />
              </ExpandableSection>
              <ViewAsCli
                catalog={catalog}
                operation={operation}
                input={input}
                endpointUrl={active.url}
              />
              <Button
                variant="primary"
                loading={loading}
                data-testid="run-read-operation"
                onClick={() => fetchPage(undefined, true)}
              >
                Run {operation.name}
              </Button>
            </>
          )}
        </SpaceBetween>
      </Container>

      {error && (
        <Alert type="error" header={error.header} data-testid="resources-error">
          {error.detail}
        </Alert>
      )}

      {operation && pages.length > 0 && resultShape && (
        <Table
          data-testid="resources-table"
          loading={loading}
          loadingText="Loading resources"
          variant="container"
          columnDefinitions={resultShape.columns.map(column => ({
            id: column.id,
            header: column.header,
            cell: (item: unknown) => renderCell(readField(item, column.id)),
          }))}
          items={currentPage?.items ?? []}
          empty={
            <Box textAlign="center" color="text-body-secondary" padding="m">
              The target returned no items for this operation.
            </Box>
          }
          header={
            <Header
              variant="h2"
              counter={`(${currentPage?.items.length ?? 0})`}
              actions={
                <Button
                  iconName="refresh"
                  onClick={() => fetchPage(undefined, true)}
                  loading={loading}
                >
                  Refresh
                </Button>
              }
            >
              {operation.name}
            </Header>
          }
          pagination={
            operation.pagination ? (
              <Pagination
                currentPageIndex={pageIndex + 1}
                pagesCount={pages.length}
                openEnd={Boolean(currentPage?.token)}
                disabled={loading}
                ariaLabels={{
                  nextPageLabel: 'Next page',
                  previousPageLabel: 'Previous page',
                  pageLabel: pageNumber => `Page ${pageNumber}`,
                }}
                onChange={event => {
                  const requested = event.detail.currentPageIndex - 1;
                  if (requested < pages.length) setPageIndex(requested);
                }}
                onNextPageClick={() => {
                  if (pageIndex === pages.length - 1 && currentPage?.token) {
                    fetchPage(currentPage.token, false);
                  } else if (canGoNext) {
                    setPageIndex(pageIndex + 1);
                  }
                }}
                onPreviousPageClick={() => setPageIndex(Math.max(0, pageIndex - 1))}
              />
            ) : undefined
          }
        />
      )}

      {operation && !resultShape && lastRaw && (
        <OperationResult
          output={lastRaw.output}
          status={lastRaw.status}
          durationMs={lastRaw.durationMs}
        />
      )}

      {operation && resultShape && lastRaw && (
        <ExpandableSection headerText="Raw response" variant="footer">
          <OperationResult
            output={lastRaw.output}
            status={lastRaw.status}
            durationMs={lastRaw.durationMs}
          />
        </ExpandableSection>
      )}
    </SpaceBetween>
  );
}

function hasRequiredInput(catalog: ServiceCatalog, operation: Operation): boolean {
  const shape = operation.input ? catalog.shapes[operation.input] : undefined;
  return Boolean(shape?.required?.length);
}

function readField(item: unknown, field: string): unknown {
  if (field === '$value') return item;
  if (typeof item !== 'object' || item === null) return undefined;
  return (item as Record<string, unknown>)[field];
}

function readToken(output: unknown, tokenPath: string): string | undefined {
  let current: unknown = output;
  for (const segment of tokenPath.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' && current !== '' ? current : undefined;
}
