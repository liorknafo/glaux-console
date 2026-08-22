import { useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import Toggle from '@cloudscape-design/components/toggle';
import type { Operation, ServiceCatalog } from '../catalog/types';
import { callOperation, describeError, type CallResult } from '../api/client';
import { useEndpoints } from '../endpoints/EndpointContext';
import { DestructiveConfirm, destructiveIdentifier } from './DestructiveConfirm';
import { GeneratedForm } from './GeneratedForm';
import { OperationResult } from './OperationResult';
import { ViewAsCli } from './ViewAsCli';

/**
 * The Actions tab: every operation that is not a plain read, rendered as a
 * generated form with a raw-JSON escape hatch, the equivalent CLI command, and
 * a typed-name confirmation for destructive operations.
 */

const ACTION_GROUPS: { label: string; classifications: Operation['classification'][] }[] = [
  { label: 'Create', classifications: ['create'] },
  { label: 'Update', classifications: ['update'] },
  { label: 'Delete', classifications: ['delete'] },
  { label: 'Other', classifications: ['other'] },
];

export function ActionsTab({ catalog }: { catalog: ServiceCatalog }) {
  const { active } = useEndpoints();
  const [showReads, setShowReads] = useState(false);
  const [rawJson, setRawJson] = useState(false);
  const [rawText, setRawText] = useState('{}');
  const [rawError, setRawError] = useState<string>();
  const [selectedName, setSelectedName] = useState<string>();
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CallResult>();
  const [error, setError] = useState<{ header: string; detail: string }>();
  const [confirming, setConfirming] = useState(false);

  const options = useMemo<SelectProps.Options>(() => {
    const groups = ACTION_GROUPS.map(group => ({
      label: group.label,
      options: Object.values(catalog.operations)
        .filter(operation => group.classifications.includes(operation.classification))
        .map(operation => ({
          label: operation.name,
          value: operation.name,
          description: operation.doc,
        })),
    })).filter(group => group.options.length > 0);

    if (!showReads) return groups;
    const reads = Object.values(catalog.operations).filter(operation =>
      ['list', 'describe'].includes(operation.classification),
    );
    return [
      ...groups,
      {
        label: 'Read',
        options: reads.map(operation => ({
          label: operation.name,
          value: operation.name,
          description: operation.doc,
        })),
      },
    ];
  }, [catalog, showReads]);

  const operation = selectedName ? catalog.operations[selectedName] : undefined;
  const destructive = operation?.classification === 'delete';

  function selectOperation(name: string) {
    setSelectedName(name);
    setInput({});
    setRawText('{}');
    setRawError(undefined);
    setResult(undefined);
    setError(undefined);
  }

  async function run() {
    if (!operation) return;
    setConfirming(false);
    setRunning(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await callOperation(active, catalog, operation, input));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setRunning(false);
    }
  }

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description={`${Object.keys(catalog.operations).length} operations in the ${catalog.label} model.`}
            actions={
              <Toggle checked={showReads} onChange={event => setShowReads(event.detail.checked)}>
                Include read operations
              </Toggle>
            }
          >
            Action
          </Header>
        }
      >
        <FormField label="Operation" stretch>
          <Select
            selectedOption={selectedName ? { label: selectedName, value: selectedName } : null}
            options={options}
            filteringType="auto"
            placeholder="Choose an operation"
            onChange={event => selectOperation(String(event.detail.selectedOption.value))}
          />
        </FormField>
      </Container>

      {operation && (
        <Form
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="primary"
                loading={running}
                data-testid="run-operation"
                onClick={() => (destructive ? setConfirming(true) : run())}
              >
                {destructive ? `${operation.name}…` : operation.name}
              </Button>
            </SpaceBetween>
          }
        >
          <SpaceBetween size="l">
            <Container
              header={
                <Header
                  variant="h2"
                  description={operation.doc}
                  actions={
                    <Toggle
                      checked={rawJson}
                      onChange={event => {
                        if (event.detail.checked) setRawText(JSON.stringify(input, null, 2));
                        setRawJson(event.detail.checked);
                      }}
                      data-testid="raw-json-toggle"
                    >
                      Edit as JSON
                    </Toggle>
                  }
                >
                  {operation.name}
                </Header>
              }
            >
              {rawJson ? (
                <FormField
                  label="Request payload"
                  description="The escape hatch: whatever the generated form cannot express, type here."
                  errorText={rawError}
                  stretch
                >
                  <Textarea
                    value={rawText}
                    rows={16}
                    onChange={event => {
                      setRawText(event.detail.value);
                      try {
                        setInput(JSON.parse(event.detail.value || '{}'));
                        setRawError(undefined);
                      } catch (parseError) {
                        setRawError((parseError as Error).message);
                      }
                    }}
                  />
                </FormField>
              ) : (
                <GeneratedForm
                  catalog={catalog}
                  operation={operation}
                  value={input}
                  onChange={setInput}
                  disabled={running}
                />
              )}
            </Container>

            <ViewAsCli
              catalog={catalog}
              operation={operation}
              input={input}
              endpointUrl={active.url}
            />

            {error && (
              <Alert type="error" header={error.header} data-testid="operation-error">
                {error.detail}
              </Alert>
            )}
            {result && (
              <OperationResult
                output={result.output}
                status={result.status}
                durationMs={result.durationMs}
              />
            )}
          </SpaceBetween>
        </Form>
      )}

      {!operation && (
        <Box color="text-body-secondary">
          Choose an operation to generate its form. Forms are generated from the service model, so
          every operation the target implements is reachable.
        </Box>
      )}

      {confirming && operation && (
        <DestructiveConfirm
          operation={operation}
          identifier={destructiveIdentifier(catalog, operation, input)}
          onConfirm={run}
          onDismiss={() => setConfirming(false)}
        />
      )}
    </SpaceBetween>
  );
}
