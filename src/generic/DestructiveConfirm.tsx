import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { Operation } from '../catalog/types';
import { humanize } from './columns';

/**
 * Destructive-action guard: delete and reset operations require typing the
 * resource's name, the way the console does. When the operation has no obvious
 * name-shaped input, the confirmation phrase is the operation name itself.
 */

export function DestructiveConfirm({
  operation,
  identifier,
  onConfirm,
  onDismiss,
}: {
  operation: Operation;
  identifier?: { field: string; value: string };
  onConfirm(): void;
  onDismiss(): void;
}) {
  const phrase = identifier?.value ?? operation.name;
  const [typed, setTyped] = useState('');
  const matches = typed === phrase;

  return (
    <Modal
      visible
      onDismiss={onDismiss}
      header={`${operation.name}`}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!matches}
              onClick={onConfirm}
              data-testid="confirm-destructive"
            >
              {operation.name}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Alert type="warning" statusIconAriaLabel="Warning">
          This operation is classified as destructive by its service model. It runs against the
          selected target endpoint and cannot be undone from here.
        </Alert>
        <FormField
          label={
            identifier
              ? `To confirm, type the ${humanize(identifier.field).toLowerCase()}: ${phrase}`
              : `To confirm, type: ${phrase}`
          }
        >
          <Input
            value={typed}
            onChange={event => setTyped(event.detail.value)}
            ariaLabel="Confirmation phrase"
            data-testid="destructive-phrase"
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
