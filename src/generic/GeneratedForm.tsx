import { useState, type ReactNode } from 'react';
import AttributeEditor from '@cloudscape-design/components/attribute-editor';
import Box from '@cloudscape-design/components/box';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FileUpload from '@cloudscape-design/components/file-upload';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import Toggle from '@cloudscape-design/components/toggle';
import type { Operation, ServiceCatalog, Shape, ShapeRef } from '../catalog/types';
import { mergeRef, resolveShape } from '../catalog/types';
import { inputMembers } from '../protocol/serialize';
import { humanize } from './columns';

/**
 * The Actions tab's form generator.
 *
 * Every input member of an operation becomes a control chosen from its modelled
 * type: enums are selects, booleans toggles, blobs file pickers, lists and maps
 * repeatable rows, nested structures expandable sections. Recursive shapes stop
 * at `MAX_DEPTH` and fall back to a JSON editor rather than looping forever.
 */

const MAX_DEPTH = 4;
const LONG_TEXT_THRESHOLD = 512;

export interface GeneratedFormProps {
  catalog: ServiceCatalog;
  operation: Operation;
  value: Record<string, unknown>;
  onChange(next: Record<string, unknown>): void;
  disabled?: boolean;
}

export function GeneratedForm({
  catalog,
  operation,
  value,
  onChange,
  disabled,
}: GeneratedFormProps) {
  const members = inputMembers(catalog, operation);

  if (members.length === 0) {
    return (
      <Box color="text-body-secondary" data-testid="no-input-members">
        {operation.name} takes no input.
      </Box>
    );
  }

  const required = members.filter(member => member.required);
  const optional = members.filter(member => !member.required);

  return (
    <SpaceBetween size="l">
      {required.length > 0 && (
        <SpaceBetween size="m">
          {required.map(member => (
            <Field
              key={member.name}
              catalog={catalog}
              name={member.name}
              ref_={member.ref}
              shape={member.shape}
              required
              depth={0}
              disabled={disabled}
              value={value[member.name]}
              onChange={next => onChange({ ...value, [member.name]: next })}
            />
          ))}
        </SpaceBetween>
      )}
      {optional.length > 0 && (
        <LazySection
          headerText={`Optional parameters (${optional.length})`}
          variant="footer"
          defaultExpanded={required.length === 0}
        >
          <SpaceBetween size="m">
            {optional.map(member => (
              <Field
                key={member.name}
                catalog={catalog}
                name={member.name}
                ref_={member.ref}
                shape={member.shape}
                depth={0}
                disabled={disabled}
                value={value[member.name]}
                onChange={next => onChange({ ...value, [member.name]: next })}
              />
            ))}
          </SpaceBetween>
        </LazySection>
      )}
    </SpaceBetween>
  );
}

/**
 * Service models nest deeply — a Firehose delivery stream configuration is
 * hundreds of members across a dozen levels. Rendering a collapsed section's
 * contents anyway would build that entire tree on mount, so sections mount
 * their children only once opened.
 */
function LazySection({
  headerText,
  headerDescription,
  variant,
  defaultExpanded,
  children,
}: {
  headerText: string;
  headerDescription?: string;
  variant: 'container' | 'footer';
  defaultExpanded?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(Boolean(defaultExpanded));
  return (
    <ExpandableSection
      headerText={headerText}
      headerDescription={headerDescription}
      variant={variant}
      expanded={expanded}
      onChange={event => setExpanded(event.detail.expanded)}
    >
      {expanded ? children : null}
    </ExpandableSection>
  );
}

interface FieldProps {
  catalog: ServiceCatalog;
  name: string;
  ref_: ShapeRef;
  shape: Shape;
  value: unknown;
  onChange(next: unknown): void;
  required?: boolean;
  depth: number;
  disabled?: boolean;
  hideLabel?: boolean;
}

function Field(props: FieldProps) {
  const { name, shape, required, hideLabel } = props;
  const label = hideLabel ? undefined : humanize(name);
  const description = shape.doc;

  if (props.depth >= MAX_DEPTH && ['structure', 'list', 'map'].includes(shape.type)) {
    return (
      <FormField label={label} description="Deeply nested — edit as JSON." stretch>
        <JsonField {...props} />
      </FormField>
    );
  }

  switch (shape.type) {
    case 'structure':
      return (
        <LazySection
          headerText={`${label ?? name}${required ? ' (required)' : ''}`}
          headerDescription={description}
          variant="container"
          defaultExpanded={required && props.depth === 0}
        >
          <StructureField {...props} />
        </LazySection>
      );
    case 'list':
      return (
        <FormField label={label} description={description} stretch>
          <ListField {...props} />
        </FormField>
      );
    case 'map':
      return (
        <FormField label={label} description={description} stretch>
          <MapField {...props} />
        </FormField>
      );
    case 'blob':
      return (
        <FormField label={label} description={description} stretch>
          <BlobField {...props} />
        </FormField>
      );
    case 'boolean':
      return (
        <FormField label={label} description={description}>
          <Toggle
            checked={props.value === true}
            disabled={props.disabled}
            onChange={event => props.onChange(event.detail.checked)}
          >
            {props.value === true ? 'true' : 'false'}
          </Toggle>
        </FormField>
      );
    default:
      return (
        <FormField
          label={label}
          description={description}
          constraintText={constraintText(shape)}
          stretch={isLongText(shape)}
        >
          <ScalarField {...props} />
        </FormField>
      );
  }
}

function StructureField({ catalog, shape, value, onChange, depth, disabled }: FieldProps) {
  const record = (value ?? {}) as Record<string, unknown>;
  const required = new Set(shape.required ?? []);
  return (
    <SpaceBetween size="m">
      {Object.entries(shape.members ?? {}).map(([memberName, memberRef]) => (
        <Field
          key={memberName}
          catalog={catalog}
          name={memberName}
          ref_={memberRef}
          shape={mergeRef(memberRef, resolveShape(catalog, memberRef))}
          required={required.has(memberName)}
          depth={depth + 1}
          disabled={disabled}
          value={record[memberName]}
          onChange={next => onChange({ ...record, [memberName]: next })}
        />
      ))}
    </SpaceBetween>
  );
}

function ListField({ catalog, name, shape, value, onChange, depth, disabled }: FieldProps) {
  const items = Array.isArray(value) ? value : [];
  const memberRef = shape.member ?? {};
  const memberShape = mergeRef(memberRef, resolveShape(catalog, memberRef));

  return (
    <AttributeEditor
      items={items.map((item, index) => ({ item, index }))}
      addButtonText={`Add ${humanize(name).toLowerCase()} item`}
      removeButtonText="Remove"
      empty="No items"
      disableAddButton={disabled}
      definition={[
        {
          label: 'Value',
          control: (row: { item: unknown; index: number }) => (
            <Field
              catalog={catalog}
              name={`${name} ${row.index + 1}`}
              ref_={memberRef}
              shape={memberShape}
              depth={depth + 1}
              disabled={disabled}
              hideLabel
              value={row.item}
              onChange={next => onChange(items.map((item, i) => (i === row.index ? next : item)))}
            />
          ),
        },
      ]}
      onAddButtonClick={() => onChange([...items, defaultValueFor(memberShape)])}
      onRemoveButtonClick={event => onChange(items.filter((_, i) => i !== event.detail.itemIndex))}
    />
  );
}

function MapField({ catalog, shape, value, onChange, depth, disabled }: FieldProps) {
  const record = (value ?? {}) as Record<string, unknown>;
  const entries = Object.entries(record);
  const valueRef = shape.value ?? {};
  const valueShape = mergeRef(valueRef, resolveShape(catalog, valueRef));

  const replace = (index: number, key: string, entryValue: unknown) => {
    const next: Record<string, unknown> = {};
    entries.forEach(([existingKey, existingValue], i) => {
      if (i === index) next[key] = entryValue;
      else next[existingKey] = existingValue;
    });
    onChange(next);
  };

  return (
    <AttributeEditor
      items={entries.map(([key, entryValue], index) => ({ key, entryValue, index }))}
      addButtonText="Add entry"
      removeButtonText="Remove"
      empty="No entries"
      disableAddButton={disabled}
      definition={[
        {
          label: 'Key',
          control: (row: { key: string; entryValue: unknown; index: number }) => (
            <Input
              value={row.key}
              disabled={disabled}
              onChange={event => replace(row.index, event.detail.value, row.entryValue)}
            />
          ),
        },
        {
          label: 'Value',
          control: (row: { key: string; entryValue: unknown; index: number }) => (
            <Field
              catalog={catalog}
              name="value"
              ref_={valueRef}
              shape={valueShape}
              depth={depth + 1}
              disabled={disabled}
              hideLabel
              value={row.entryValue}
              onChange={next => replace(row.index, row.key, next)}
            />
          ),
        },
      ]}
      onAddButtonClick={() => onChange({ ...record, '': defaultValueFor(valueShape) })}
      onRemoveButtonClick={event =>
        onChange(Object.fromEntries(entries.filter((_, i) => i !== event.detail.itemIndex)))
      }
    />
  );
}

function BlobField({ value, onChange, disabled }: FieldProps) {
  const [files, setFiles] = useState<File[]>([]);
  return (
    <SpaceBetween size="xs">
      <FileUpload
        value={files}
        onChange={async event => {
          setFiles(event.detail.value);
          const file = event.detail.value[0];
          onChange(file ? await fileToBase64(file) : undefined);
        }}
        i18nStrings={{
          uploadButtonText: multiple => (multiple ? 'Choose files' : 'Choose file'),
          dropzoneText: multiple => (multiple ? 'Drop files to upload' : 'Drop file to upload'),
          removeFileAriaLabel: index => `Remove file ${index + 1}`,
          limitShowFewer: 'Show fewer files',
          limitShowMore: 'Show more files',
          errorIconAriaLabel: 'Error',
        }}
        showFileSize
        constraintText="Sent base64-encoded."
      />
      <Textarea
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        rows={2}
        placeholder="…or paste base64 directly"
        onChange={event => onChange(event.detail.value)}
      />
    </SpaceBetween>
  );
}

function ScalarField({ shape, value, onChange, disabled, name, hideLabel }: FieldProps) {
  // FormField already labels the control; an ariaLabel on top would duplicate it.
  const ariaLabel = hideLabel ? humanize(name) : undefined;
  if (shape.enum?.length) {
    const options = shape.enum.map(option => ({ label: option, value: option }));
    return (
      <Select
        selectedOption={value ? { label: String(value), value: String(value) } : null}
        options={options}
        disabled={disabled}
        placeholder="Choose a value"
        filteringType={options.length > 10 ? 'auto' : 'none'}
        onChange={event => onChange(event.detail.selectedOption.value)}
        ariaLabel={ariaLabel}
      />
    );
  }

  if (isLongText(shape)) {
    return (
      <Textarea
        value={value === undefined || value === null ? '' : String(value)}
        disabled={disabled}
        rows={6}
        onChange={event => onChange(event.detail.value)}
      />
    );
  }

  const numeric = ['integer', 'long', 'float', 'double'].includes(shape.type);
  return (
    <Input
      type={numeric ? 'number' : 'text'}
      inputMode={numeric ? 'numeric' : 'text'}
      value={value === undefined || value === null ? '' : String(value)}
      disabled={disabled}
      placeholder={shape.type === 'timestamp' ? '2026-08-22T09:00:00Z' : undefined}
      onChange={event => onChange(numeric ? toNumber(event.detail.value) : event.detail.value)}
      ariaLabel={ariaLabel}
    />
  );
}

function JsonField({ value, onChange, disabled }: FieldProps) {
  const [text, setText] = useState(() =>
    value === undefined ? '' : JSON.stringify(value, null, 2),
  );
  const [error, setError] = useState<string>();
  return (
    <SpaceBetween size="xxs">
      <Textarea
        value={text}
        rows={5}
        disabled={disabled}
        invalid={Boolean(error)}
        onChange={event => {
          setText(event.detail.value);
          if (!event.detail.value.trim()) {
            setError(undefined);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(event.detail.value));
            setError(undefined);
          } catch (parseError) {
            setError((parseError as Error).message);
          }
        }}
      />
      {error && (
        <Box color="text-status-error" fontSize="body-s">
          {error}
        </Box>
      )}
    </SpaceBetween>
  );
}

function isLongText(shape: Shape): boolean {
  return (
    shape.type === 'string' &&
    !shape.enum &&
    ((shape.max ?? 0) > LONG_TEXT_THRESHOLD || Boolean(shape.document) || Boolean(shape.jsonvalue))
  );
}

function constraintText(shape: Shape): string | undefined {
  const parts: string[] = [];
  if (shape.type !== 'string') parts.push(shape.type);
  if (shape.min !== undefined || shape.max !== undefined) {
    parts.push(`length ${shape.min ?? 0}–${shape.max ?? '∞'}`);
  }
  return parts.length ? parts.join(' · ') : undefined;
}

function defaultValueFor(shape: Shape): unknown {
  switch (shape.type) {
    case 'structure':
      return {};
    case 'list':
      return [];
    case 'map':
      return {};
    case 'boolean':
      return false;
    default:
      return '';
  }
}

function toNumber(value: string): number | string {
  if (value.trim() === '') return '';
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
