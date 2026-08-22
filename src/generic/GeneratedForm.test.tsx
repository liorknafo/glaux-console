import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadServiceCatalog } from '../catalog/loader';
import type { Operation, ServiceCatalog } from '../catalog/types';
import { GeneratedForm } from './GeneratedForm';
import { destructiveIdentifier } from './DestructiveConfirm';

/**
 * The generated form is the floor for every service, so these tests pin the
 * mapping from modelled type to control: enum -> select, boolean -> toggle,
 * structure -> section, list/map -> repeatable rows.
 */

function Harness({ catalog, operation }: { catalog: ServiceCatalog; operation: Operation }) {
  const [value, setValue] = useState<Record<string, unknown>>({});
  return (
    <>
      <GeneratedForm catalog={catalog} operation={operation} value={value} onChange={setValue} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

describe('GeneratedForm', () => {
  it('renders required members up front and optional ones behind a section', async () => {
    const athena = await loadServiceCatalog('athena');
    render(<Harness catalog={athena} operation={athena.operations.StartQueryExecution} />);

    expect(screen.getByLabelText('Query string')).toBeInTheDocument();
    expect(screen.getByText(/Optional parameters \(\d+\)/)).toBeInTheDocument();
  });

  it('writes typed values into the request object', async () => {
    const user = userEvent.setup();
    const sqs = await loadServiceCatalog('sqs');
    render(<Harness catalog={sqs} operation={sqs.operations.CreateQueue} />);

    await user.type(screen.getByLabelText('Queue name'), 'orders');
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('value').textContent!)).toEqual({ QueueName: 'orders' }),
    );
  });

  it('renders enum members as a select of the modelled values', async () => {
    const user = userEvent.setup();
    const athena = await loadServiceCatalog('athena');
    render(<Harness catalog={athena} operation={athena.operations.UpdateWorkGroup} />);

    await user.click(screen.getByText(/Optional parameters/));
    const select = await screen.findByLabelText('State');
    await user.click(select);

    expect((await screen.findAllByText('ENABLED')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('DISABLED').length).toBeGreaterThan(0);
  });

  it('renders nested structures as sections that mount only when opened', async () => {
    const user = userEvent.setup();
    const firehose = await loadServiceCatalog('firehose');
    render(<Harness catalog={firehose} operation={firehose.operations.CreateDeliveryStream} />);

    expect(screen.getByLabelText('Delivery stream name')).toBeInTheDocument();
    // Firehose's nested destination configurations are hundreds of members
    // deep; they must not be in the DOM until the section is opened.
    expect(screen.queryByLabelText('Role arn')).not.toBeInTheDocument();

    await user.click(screen.getByText(/Optional parameters/));
    await user.click(await screen.findByText('S3 destination configuration'));
    expect(await screen.findByLabelText('Role arn')).toBeInTheDocument();
  });

  it('offers a file picker for blob members', async () => {
    const lambda = await loadServiceCatalog('lambda');
    render(<Harness catalog={lambda} operation={lambda.operations.Invoke} />);
    const user = userEvent.setup();
    await user.click(screen.getByText(/Optional parameters/));
    expect((await screen.findAllByText('Choose file')).length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText('…or paste base64 directly')).toBeInTheDocument();
  });

  it('says so plainly when an operation takes no input', async () => {
    const sts = await loadServiceCatalog('sts');
    render(<Harness catalog={sts} operation={sts.operations.GetCallerIdentity} />);
    expect(screen.getByTestId('no-input-members')).toHaveTextContent('takes no input');
  });
});

describe('destructive identifier', () => {
  it('picks the name-shaped required member to confirm against', async () => {
    const sqs = await loadServiceCatalog('sqs');
    expect(
      destructiveIdentifier(sqs, sqs.operations.DeleteQueue, { QueueUrl: 'http://localhost/q/a' }),
    ).toEqual({ field: 'QueueUrl', value: 'http://localhost/q/a' });
  });

  it('returns nothing when the form has no identifier typed yet', async () => {
    const sqs = await loadServiceCatalog('sqs');
    expect(destructiveIdentifier(sqs, sqs.operations.DeleteQueue, {})).toBeUndefined();
  });
});
