import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Select from '@cloudscape-design/components/select';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { useEndpoints } from '../../endpoints/context';
import { ItemEditor } from './ItemEditor';
import { cellText, columnsFor, describeKey, type Item } from './items';
import {
  keyAttributesOf,
  readItems,
  type ItemPage,
  type ReadMode,
  type ReadRequest,
  type TableDescription,
} from './tables';

/**
 * Reading a table: a scan across everything, or a query against a key
 * condition, with the expression inputs DynamoDB actually takes.
 *
 * The form and the read are deliberately separate. Editing a field changes
 * nothing until you run it, and a page is fetched with exactly the request that
 * produced the page before it — paging a scan with a filter you have since
 * edited would return items from a different read and page them as if they were
 * one.
 *
 * Paging follows DynamoDB's own cursor: "Next page" sends the previous page's
 * `LastEvaluatedKey`, and the button stops being offered when the service stops
 * returning one — the only reliable end-of-read signal, since a page can come
 * back empty and still have more behind it.
 */

/** A read that has been asked for: the form as it stood, plus where in the paging. */
interface ReadPlan {
  request: Omit<ReadRequest, 'exclusiveStartKey'>;
  startKey?: Item;
  pageIndex: number;
  /** Distinguishes two runs of the same request, so re-running re-reads. */
  attempt: number;
}

export function ItemBrowser({
  catalog,
  table,
  onChanged,
}: {
  catalog: ServiceCatalog;
  table: TableDescription;
  onChanged(): void;
}) {
  const { active } = useEndpoints();
  const [mode, setMode] = useState<ReadMode>('scan');
  const [indexName, setIndexName] = useState('');
  const [keyCondition, setKeyCondition] = useState('');
  const [filter, setFilter] = useState('');
  const [projection, setProjection] = useState('');
  const [namesText, setNamesText] = useState('');
  const [valuesText, setValuesText] = useState('');
  const [consistent, setConsistent] = useState(false);

  const index = table.indexes.find(entry => entry.name === indexName);
  const keyAttributes = keyAttributesOf(table, indexName || undefined);

  const parsedNames = parseJsonObject(namesText, 'expression attribute names');
  const parsedValues = parseJsonObject(valuesText, 'expression attribute values');
  const inputError = parsedNames.error ?? parsedValues.error;
  const queryNeedsCondition = mode === 'query' && keyCondition.trim() === '';

  function currentRequest(): Omit<ReadRequest, 'exclusiveStartKey'> {
    return {
      mode,
      tableName: table.name,
      indexName: indexName || undefined,
      globalIndex: index?.kind === 'global',
      keyConditionExpression: keyCondition.trim() || undefined,
      filterExpression: filter.trim() || undefined,
      projectionExpression: projection.trim() || undefined,
      expressionAttributeNames: parsedNames.value as Record<string, string> | undefined,
      expressionAttributeValues: parsedValues.value as Item | undefined,
      consistentRead: consistent,
    };
  }

  // A table opens on a scan of itself: the browser is remounted per table and
  // per endpoint (the detail screen keys it), so the first read happens here
  // rather than through a guard.
  const [plan, setPlan] = useState<ReadPlan>(() => ({
    request: { mode: 'scan', tableName: table.name },
    pageIndex: 0,
    attempt: 0,
  }));

  const [cursors, setCursors] = useState<(Item | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<Item>();
  const [editing, setEditing] = useState<{ item?: Item }>();
  // The read in hand is stored against the plan that asked for it, so "still
  // reading" is a comparison rather than a second piece of state to keep in step.
  const [loaded, setLoaded] = useState<{
    plan: ReadPlan;
    page?: ItemPage;
    error?: { header: string; detail: string };
  }>();
  const busy = loaded?.plan !== plan;
  const page = loaded?.page;
  const error = loaded?.error;

  useEffect(() => {
    const controller = new AbortController();
    readItems(
      active,
      catalog,
      { ...plan.request, exclusiveStartKey: plan.startKey },
      controller.signal,
    ).then(
      result => {
        if (controller.signal.aborted) return;
        setLoaded({ plan, page: result });
        setSelected(undefined);
        // The cursor for the page after this one is only known now.
        setCursors(current => {
          const next = current.slice(0, plan.pageIndex + 1);
          if (result.lastEvaluatedKey) next.push(result.lastEvaluatedKey);
          return next;
        });
      },
      caught => {
        if (controller.signal.aborted) return;
        setLoaded({ plan, error: describeError(caught) });
      },
    );
    return () => controller.abort();
  }, [active, catalog, plan]);

  const items = page?.items ?? [];
  const columns = columnsFor(items, keyAttributes);
  const hasNextPage = cursors.length > plan.pageIndex + 1;

  return (
    <SpaceBetween size="l">
      <SpaceBetween size="m">
        <SegmentedControl
          selectedId={mode}
          label="Read mode"
          options={[
            { id: 'scan', text: 'Scan' },
            { id: 'query', text: 'Query' },
          ]}
          onChange={event => setMode(event.detail.selectedId as ReadMode)}
        />

        <ColumnLayout columns={2}>
          <FormField
            label="Index"
            description="Read the table itself, or one of its secondary indexes."
          >
            <Select
              selectedOption={{ value: indexName, label: indexName === '' ? 'Table' : indexName }}
              options={[
                { value: '', label: 'Table' },
                ...table.indexes.map(entry => ({
                  value: entry.name,
                  label: `${entry.name} (${entry.kind === 'global' ? 'GSI' : 'LSI'})`,
                })),
              ]}
              ariaLabel="Index"
              data-testid="index-select"
              onChange={event => setIndexName(event.detail.selectedOption.value ?? '')}
            />
          </FormField>

          <FormField
            label="Consistent read"
            description={
              index?.kind === 'global'
                ? 'A global secondary index cannot be read consistently, so this is not sent.'
                : 'Reads the latest write rather than a possibly stale replica.'
            }
          >
            <Checkbox
              checked={consistent}
              disabled={index?.kind === 'global'}
              data-testid="consistent-read"
              onChange={event => setConsistent(event.detail.checked)}
            >
              Consistent
            </Checkbox>
          </FormField>
        </ColumnLayout>

        {mode === 'query' && (
          <FormField
            label="Key condition expression"
            description="Required for a query — for example #pk = :pk AND begins_with(sk, :prefix)."
            errorText={queryNeedsCondition ? 'A query needs a key condition.' : undefined}
            stretch
          >
            <Input
              value={keyCondition}
              data-testid="key-condition"
              onChange={event => setKeyCondition(event.detail.value)}
            />
          </FormField>
        )}

        <ColumnLayout columns={2}>
          <FormField label="Filter expression" description="Applied after the read, not before it.">
            <Input
              value={filter}
              data-testid="filter-expression"
              onChange={event => setFilter(event.detail.value)}
            />
          </FormField>
          <FormField label="Projection expression" description="The attributes to return.">
            <Input
              value={projection}
              data-testid="projection-expression"
              onChange={event => setProjection(event.detail.value)}
            />
          </FormField>
        </ColumnLayout>

        <ExpandableSection headerText="Expression attribute names and values">
          <ColumnLayout columns={2}>
            <FormField
              label="Expression attribute names"
              description='Placeholders for reserved words, as JSON: {"#pk": "partition_key"}'
              errorText={parsedNames.error}
              stretch
            >
              <Textarea
                value={namesText}
                rows={4}
                spellcheck={false}
                data-testid="attribute-names"
                onChange={event => setNamesText(event.detail.value)}
              />
            </FormField>
            <FormField
              label="Expression attribute values"
              description='Values in DynamoDB form, as JSON: {":pk": {"S": "a"}}'
              errorText={parsedValues.error}
              stretch
            >
              <Textarea
                value={valuesText}
                rows={4}
                spellcheck={false}
                data-testid="attribute-values"
                onChange={event => setValuesText(event.detail.value)}
              />
            </FormField>
          </ColumnLayout>
        </ExpandableSection>

        <SpaceBetween direction="horizontal" size="xs">
          <Button
            variant="primary"
            loading={busy}
            disabled={Boolean(inputError) || queryNeedsCondition}
            data-testid="run-read"
            onClick={() =>
              setPlan(current => ({
                request: currentRequest(),
                pageIndex: 0,
                attempt: current.attempt + 1,
              }))
            }
          >
            {mode === 'query' ? 'Run query' : 'Run scan'}
          </Button>
          <Button data-testid="create-item" onClick={() => setEditing({})}>
            Create item
          </Button>
        </SpaceBetween>
      </SpaceBetween>

      {error && (
        <Alert type="error" header={error.header} data-testid="items-error">
          {error.detail}
        </Alert>
      )}

      <Table
        data-testid="item-table"
        variant="embedded"
        loading={busy}
        loadingText="Reading items"
        trackBy={item => describeKey(item, keyAttributes)}
        selectionType="single"
        selectedItems={selected ? [selected] : []}
        ariaLabels={{
          selectionGroupLabel: 'Item selection',
          itemSelectionLabel: (_state, item) => `Select ${describeKey(item, keyAttributes)}`,
        }}
        onSelectionChange={event => setSelected(event.detail.selectedItems[0])}
        columnDefinitions={columns.map(name => ({
          id: name,
          header: keyAttributes.includes(name) ? `${name} (key)` : name,
          cell: (item: Item) => cellText(item[name]),
        }))}
        items={items}
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="m">
            No items came back. A page can be empty and still have more behind it — follow “Next
            page” while it is offered.
          </Box>
        }
        header={
          <Header
            variant="h3"
            counter={page ? `(${items.length})` : undefined}
            description={
              page
                ? `Returned ${page.count ?? items.length}, examined ${page.scannedCount ?? '—'}.`
                : undefined
            }
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  data-testid="previous-page"
                  disabled={plan.pageIndex === 0 || busy}
                  onClick={() =>
                    setPlan(current => ({
                      ...current,
                      startKey: cursors[current.pageIndex - 1],
                      pageIndex: current.pageIndex - 1,
                      attempt: current.attempt + 1,
                    }))
                  }
                >
                  Previous page
                </Button>
                <Button
                  data-testid="next-page"
                  disabled={!hasNextPage || busy}
                  onClick={() =>
                    setPlan(current => ({
                      ...current,
                      startKey: cursors[current.pageIndex + 1],
                      pageIndex: current.pageIndex + 1,
                      attempt: current.attempt + 1,
                    }))
                  }
                >
                  Next page
                </Button>
                <Button
                  data-testid="edit-item"
                  disabled={!selected}
                  onClick={() => setEditing({ item: selected })}
                >
                  Edit item
                </Button>
              </SpaceBetween>
            }
          >
            Items
          </Header>
        }
      />

      {editing && (
        <ItemEditor
          catalog={catalog}
          table={table}
          item={editing.item}
          onDismiss={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            onChanged();
            // Re-read the page in view so the table shows the write.
            setPlan(current => ({ ...current, attempt: current.attempt + 1 }));
          }}
        />
      )}
    </SpaceBetween>
  );
}

/** A JSON object typed into one of the expression fields, or the parse error. */
function parseJsonObject(
  text: string,
  what: string,
): { value?: Record<string, unknown>; error?: string } {
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: `The ${what} must be a JSON object.` };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (caught) {
    return { error: (caught as Error).message };
  }
}
