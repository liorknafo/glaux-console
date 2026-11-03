import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import FormField from '@cloudscape-design/components/form-field';
import Modal from '@cloudscape-design/components/modal';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { DestructiveConfirm } from '../../generic/DestructiveConfirm';
import { useEndpoints } from '../../endpoints/context';
import { describeKey, itemProblems, keyOf, plainItem, toItem, type Item } from './items';
import { deleteItem, keyAttributesOf, putItem, type TableDescription } from './tables';

const NEW_ITEM = '{\n  \n}';

/**
 * Creating, editing and deleting one item.
 *
 * The editor's own form is DynamoDB's tagged JSON, because that form is exact:
 * `{"tags": {"SS": ["a"]}}` is a string set and `{"tags": {"L": [...]}}` is a
 * list, and nothing in plain JSON tells the two apart. The plain view is
 * offered alongside it for reading and for quick edits, with the conversion's
 * two lossy cases stated rather than left to be discovered.
 */
export function ItemEditor({
  catalog,
  table,
  item,
  onDismiss,
  onSaved,
}: {
  catalog: ServiceCatalog;
  table: TableDescription;
  item?: Item;
  onDismiss(): void;
  onSaved(): void;
}) {
  const { active } = useEndpoints();
  const keyAttributes = keyAttributesOf(table);
  const [form, setForm] = useState<'dynamodb' | 'plain'>('dynamodb');
  const [text, setText] = useState(() => (item ? JSON.stringify(item, null, 2) : NEW_ITEM));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ header: string; detail: string }>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const parsed = parse(text, form);

  function switchForm(next: 'dynamodb' | 'plain') {
    if (next === form) return;
    // Only convert what parses; otherwise the half-typed text is kept so the
    // switch cannot silently discard an edit in progress.
    if (parsed.item) {
      setText(JSON.stringify(next === 'plain' ? plainItem(parsed.item) : parsed.item, null, 2));
    }
    setForm(next);
  }

  async function save() {
    if (!parsed.item) return;
    setSaving(true);
    setError(undefined);
    try {
      await putItem(active, catalog, table.name, parsed.item);
      onSaved();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!item) return;
    setSaving(true);
    setError(undefined);
    try {
      await deleteItem(active, catalog, table.name, keyOf(item, keyAttributes));
      onSaved();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  }

  if (confirmingDelete && item && catalog.operations.DeleteItem) {
    return (
      <DestructiveConfirm
        operation={catalog.operations.DeleteItem}
        identifier={{ field: 'Key', value: describeKey(item, keyAttributes) }}
        onDismiss={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false);
          void remove();
        }}
      />
    );
  }

  return (
    <Modal
      visible
      size="large"
      onDismiss={onDismiss}
      data-testid="item-editor"
      header={item ? `Edit ${describeKey(item, keyAttributes)}` : `New item in ${table.name}`}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            {item && (
              <Button data-testid="delete-item" onClick={() => setConfirmingDelete(true)}>
                Delete item
              </Button>
            )}
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!parsed.item}
              data-testid="save-item"
              onClick={() => void save()}
            >
              Save item
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <SegmentedControl
          selectedId={form}
          label="Item form"
          options={[
            { id: 'dynamodb', text: 'DynamoDB JSON' },
            { id: 'plain', text: 'Plain JSON' },
          ]}
          onChange={event => switchForm(event.detail.selectedId as 'dynamodb' | 'plain')}
        />

        <FormField
          label={form === 'dynamodb' ? 'Item, with type tags' : 'Item, as plain JSON'}
          description={
            form === 'dynamodb'
              ? 'Exactly what PutItem stores, for example {"pk": {"S": "a"}, "total": {"N": "19.5"}}.'
              : 'Converted to type tags on save. A JSON list becomes an L, never a set, and binary stays base64.'
          }
          errorText={parsed.problems[0]}
          stretch
        >
          <Textarea
            value={text}
            rows={16}
            spellcheck={false}
            data-testid="item-json"
            onChange={event => setText(event.detail.value)}
          />
        </FormField>

        {parsed.problems.length > 1 && (
          <Alert type="error" header="This item is not one DynamoDB can store">
            <SpaceBetween size="xs">
              {parsed.problems.slice(1).map(problem => (
                <Box key={problem}>{problem}</Box>
              ))}
            </SpaceBetween>
          </Alert>
        )}

        {item && parsed.item && keyChanged(item, parsed.item, keyAttributes) && (
          <Alert type="warning" data-testid="key-changed">
            The key differs from the item you opened, so saving writes a new item and leaves{' '}
            {describeKey(item, keyAttributes)} where it is. PutItem replaces an item, it does not
            rename one.
          </Alert>
        )}

        {error && (
          <Alert type="error" header={error.header} data-testid="save-error">
            {error.detail}
          </Alert>
        )}
      </SpaceBetween>
    </Modal>
  );
}

function parse(text: string, form: 'dynamodb' | 'plain'): { item?: Item; problems: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (caught) {
    return { problems: [(caught as Error).message] };
  }
  if (form === 'plain') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { problems: ['An item must be a JSON object of attribute names to values.'] };
    }
    try {
      return { item: toItem(value as Record<string, unknown>), problems: [] };
    } catch (caught) {
      return { problems: [(caught as Error).message] };
    }
  }
  const problems = itemProblems(value);
  if (problems.length > 0) return { problems };
  return { item: value as Item, problems: [] };
}

function keyChanged(original: Item, edited: Item, keyAttributes: string[]): boolean {
  return (
    JSON.stringify(keyOf(original, keyAttributes)) !== JSON.stringify(keyOf(edited, keyAttributes))
  );
}
