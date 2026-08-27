import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';

/**
 * Smoke coverage for the profiled services: lambda, stepfunctions, kinesis,
 * secretsmanager and ssm from the 2026-08-26 run, and iam, sns, logs and kms
 * from this one.
 *
 * These services have no hand-built screen — they are the generated Resources
 * and Actions tabs plus a profile. (CloudWatch Logs also has a Tail tab, which
 * `src/deep/logs/logs-screen.test.tsx` covers; what is asserted here is that its
 * generated tabs still behave like every other profiled service's.) What is
 * worth asserting is therefore not bespoke behaviour but that each service's
 * screen opens on its profile's view, renders the curated columns, and sends
 * the right operation to the target.
 *
 * Every response body below is shaped by the service's own botocore model
 * (`src/catalog/generated/*.json`), not by an assumption about how any
 * particular emulator answers. No live target was available to this run.
 */

const REPORTED_SERVICES = [
  'lambda',
  'states',
  'kinesis',
  'secretsmanager',
  'ssm',
  'iam',
  'sns',
  'logs',
  'kms',
];

function stubTarget(respond: (envelope: Envelope) => Exchange) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body ?? '{}')) as Envelope;
    if (envelope.path === '/_fakecloud/health') {
      return jsonResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok', version: 'test', services: REPORTED_SERVICES }),
        bodyEncoding: 'utf8',
        durationMs: 1,
      });
    }
    const exchange = respond(envelope);
    return jsonResponse({
      status: exchange.status ?? 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(exchange.body),
      bodyEncoding: 'utf8',
      durationMs: 4,
    });
  });
}

/**
 * The same stub for a `query` service (IAM, SNS), which answers in XML rather
 * than JSON. The console parses the response according to the service's
 * modelled protocol, so answering IAM in JSON would test nothing the real
 * request path does.
 */
function stubXmlTarget(respond: (envelope: Envelope) => XmlExchange) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body ?? '{}')) as Envelope;
    if (envelope.path === '/_fakecloud/health') {
      return jsonResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok', version: 'test', services: REPORTED_SERVICES }),
        bodyEncoding: 'utf8',
        durationMs: 1,
      });
    }
    const exchange = respond(envelope);
    return jsonResponse({
      status: exchange.status ?? 200,
      headers: { 'content-type': 'text/xml' },
      body: exchange.body,
      bodyEncoding: 'utf8',
      durationMs: 4,
    });
  });
}

interface Envelope {
  path: string;
  body: string;
  headers?: Record<string, string>;
}

interface Exchange {
  body: unknown;
  status?: number;
}

interface XmlExchange {
  body: string;
  status?: number;
}

type TargetStub = ReturnType<typeof stubTarget> | ReturnType<typeof stubXmlTarget>;

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload } as Response;
}

/** The operation names the console actually sent, in order. */
function operationsSent(stub: TargetStub): string[] {
  return stub.mock.calls
    .map(call => JSON.parse(String((call[1] as RequestInit).body)) as Envelope)
    .filter(envelope => envelope.path !== '/_fakecloud/health')
    .map(envelope => {
      const target = envelope.headers?.['x-amz-target'] ?? envelope.headers?.['X-Amz-Target'];
      // `json` services carry the operation in x-amz-target; `query` ones (IAM,
      // SNS) carry it as the form-encoded `Action`; rest-json ones (Lambda)
      // carry it in the request URI instead.
      if (target) return target.split('.').pop() ?? '';
      const action = new URLSearchParams(envelope.body ?? '').get('Action');
      return action ?? envelope.path;
    });
}

async function openService(id: string, tab: 'Resources' | 'Actions') {
  const user = userEvent.setup();
  window.location.hash = `#/service/${id}`;
  render(<App />);
  // Resources is the first tab for a service with no hand-built screen, and the
  // second for CloudWatch Logs, which has a Tail tab in front of it. Clicking it
  // by name works either way, and proves the generated tabs are still there.
  await user.click(await screen.findByRole('tab', { name: tab }));
  return user;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Lambda', () => {
  it('opens on ListFunctions with the profile’s columns', async () => {
    const fetchStub = stubTarget(() => ({
      body: {
        Functions: [
          {
            FunctionName: 'ingest',
            FunctionArn: 'arn:aws:lambda:us-east-1:000000000000:function:ingest',
            Runtime: 'python3.12',
            Role: 'arn:aws:iam::000000000000:role/lambda',
            Handler: 'app.handler',
            CodeSize: 4096,
            MemorySize: 512,
            Timeout: 30,
            State: 'Active',
            PackageType: 'Zip',
            Version: '$LATEST',
            LastModified: '2026-08-26T04:00:00.000+0000',
          },
        ],
      },
    }));
    vi.stubGlobal('fetch', fetchStub);

    const user = await openService('lambda', 'Resources');
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() => expect(within(table).getByText('ingest')).toBeInTheDocument());

    // Curated order, and nothing inference would have led with instead.
    const headers = within(table)
      .getAllByRole('columnheader')
      .map(header => header.textContent);
    expect(headers).toEqual([
      'Function name',
      'Runtime',
      'Package type',
      'Memory size',
      'Timeout',
      'State',
      'Last modified',
      'Version',
      'Function arn',
    ]);
    expect(within(table).queryByText('Handler')).not.toBeInTheDocument();
    expect(within(table).getByText('Active')).toBeInTheDocument();

    expect(operationsSent(fetchStub)).toEqual(['/2015-03-31/functions']);
  });

  it('offers Invoke in the Actions picker’s Common group', async () => {
    vi.stubGlobal(
      'fetch',
      stubTarget(() => ({ body: {} })),
    );

    const user = await openService('lambda', 'Actions');
    await user.click(await screen.findByLabelText('Operation'));

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Common')).toBeInTheDocument();
    expect(within(listbox).getAllByText('Invoke').length).toBeGreaterThan(0);
  });
});

describe('Step Functions', () => {
  it('opens on ListStateMachines and pages executions with the service’s token', async () => {
    const fetchStub = stubTarget(envelope => {
      const body = JSON.parse(envelope.body) as { nextToken?: string };
      if (body.nextToken) {
        return {
          body: {
            executions: [
              {
                name: 'run-2',
                executionArn: 'arn:aws:states:us-east-1:000000000000:execution:pipeline:run-2',
                stateMachineArn: 'arn:aws:states:us-east-1:000000000000:stateMachine:pipeline',
                status: 'SUCCEEDED',
                startDate: 1.756e9,
              },
            ],
          },
        };
      }
      return {
        body: {
          executions: [
            {
              name: 'run-1',
              executionArn: 'arn:aws:states:us-east-1:000000000000:execution:pipeline:run-1',
              stateMachineArn: 'arn:aws:states:us-east-1:000000000000:stateMachine:pipeline',
              status: 'RUNNING',
              startDate: 1.756e9,
            },
          ],
          nextToken: 'page-2',
        },
      };
    });
    vi.stubGlobal('fetch', fetchStub);

    const user = await openService('stepfunctions', 'Resources');

    // The preselected view is the profile's first entry.
    expect(await screen.findByText('Run ListStateMachines')).toBeInTheDocument();

    await user.click(await screen.findByLabelText('Read operation'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getAllByText('ListExecutions')[0]);
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() => expect(within(table).getByText('run-1')).toBeInTheDocument());
    expect(within(table).getByText('RUNNING')).toBeInTheDocument();

    await user.click(within(table).getByLabelText('Next page'));
    await waitFor(() => expect(within(table).getByText('run-2')).toBeInTheDocument());

    expect(operationsSent(fetchStub)).toEqual(['ListExecutions', 'ListExecutions']);
  });
});

describe('Kinesis', () => {
  it('renders ListStreams’ string list as a single value column', async () => {
    vi.stubGlobal(
      'fetch',
      stubTarget(() => ({ body: { StreamNames: ['events', 'clicks'], HasMoreStreams: false } })),
    );

    const user = await openService('kinesis', 'Resources');
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() => expect(within(table).getByText('events')).toBeInTheDocument());
    expect(within(table).getByText('clicks')).toBeInTheDocument();
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(['Value']);
  });

  it('shows a record’s data as the service returned it', async () => {
    vi.stubGlobal(
      'fetch',
      stubTarget(() => ({
        body: {
          Records: [
            {
              SequenceNumber: '49590338271490256608559692538361571095921575989136588898',
              PartitionKey: 'orders',
              // Kinesis models Data as a blob: base64 on the wire.
              Data: 'eyJvcmRlciI6MX0=',
              ApproximateArrivalTimestamp: 1.756e9,
            },
          ],
          NextShardIterator: 'AAAA',
          MillisBehindLatest: 0,
        },
      })),
    );

    const user = await openService('kinesis', 'Resources');
    await user.click(await screen.findByLabelText('Read operation'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getAllByText('GetRecords')[0]);
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() => expect(within(table).getByText('orders')).toBeInTheDocument());
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(['Sequence number', 'Partition key', 'Approximate arrival timestamp', 'Data']);
  });
});

describe('Secrets Manager', () => {
  it('opens on ListSecrets with rotation and change dates', async () => {
    const fetchStub = stubTarget(() => ({
      body: {
        SecretList: [
          {
            ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db-abc',
            Name: 'db',
            Description: 'Database credentials',
            RotationEnabled: false,
            LastChangedDate: 1.756e9,
            CreatedDate: 1.755e9,
          },
        ],
      },
    }));
    vi.stubGlobal('fetch', fetchStub);

    const user = await openService('secretsmanager', 'Resources');
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() => expect(within(table).getByText('db')).toBeInTheDocument());
    expect(within(table).getByText('Database credentials')).toBeInTheDocument();
    expect(within(table).getByText('false')).toBeInTheDocument();
    expect(operationsSent(fetchStub)).toEqual(['ListSecrets']);
  });

  it('renders GetSecretValue as a raw result rather than an empty table', async () => {
    vi.stubGlobal(
      'fetch',
      stubTarget(() => ({
        body: {
          ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db-abc',
          Name: 'db',
          VersionId: '11111111-2222-3333-4444-555555555555',
          SecretString: '{"username":"glaux"}',
          VersionStages: ['AWSCURRENT'],
        },
      })),
    );

    const user = await openService('secretsmanager', 'Resources');
    await user.click(await screen.findByLabelText('Read operation'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getAllByText('GetSecretValue')[0]);
    await user.type(await screen.findByLabelText('Secret id'), 'db');
    await user.click(await screen.findByTestId('run-read-operation'));

    // GetSecretValue's output carries a VersionStages list, so inference alone
    // would table the stages and hide the secret. The profile marks it raw.
    const response = await screen.findByTestId('operation-response');
    expect(response).toHaveTextContent('SecretString');
    expect(response).toHaveTextContent('AWSCURRENT');
    expect(screen.queryByTestId('resources-table')).not.toBeInTheDocument();
  });
});

describe('Systems Manager', () => {
  it('opens on DescribeParameters out of 152 modelled operations', async () => {
    const fetchStub = stubTarget(() => ({
      body: {
        Parameters: [
          {
            Name: '/glaux/db/host',
            ARN: 'arn:aws:ssm:us-east-1:000000000000:parameter/glaux/db/host',
            Type: 'String',
            Version: 3,
            Tier: 'Standard',
            DataType: 'text',
            LastModifiedDate: 1.756e9,
            Description: 'Primary host',
          },
        ],
      },
    }));
    vi.stubGlobal('fetch', fetchStub);

    const user = await openService('ssm', 'Resources');
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() => expect(within(table).getByText('/glaux/db/host')).toBeInTheDocument());
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual([
      'Name',
      'Type',
      'Version',
      'Tier',
      'Data type',
      'Last modified date',
      'Description',
    ]);
    expect(operationsSent(fetchStub)).toEqual(['DescribeParameters']);
  });

  it('promotes PutParameter without removing it from its Create group', async () => {
    vi.stubGlobal(
      'fetch',
      stubTarget(() => ({ body: { Version: 1, Tier: 'Standard' } })),
    );

    const user = await openService('ssm', 'Actions');
    await user.click(await screen.findByLabelText('Operation'));

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Common')).toBeInTheDocument();
    // Once under Common, once under Create — promoting must not hide it from
    // someone scanning the classification groups.
    expect(within(listbox).getAllByText('PutParameter')).toHaveLength(2);
  });
});

const LIST_ROLES = `<ListRolesResponse><ListRolesResult>
  <Roles>
    <member>
      <Path>/service-role/</Path>
      <RoleName>firehose-delivery</RoleName>
      <RoleId>AROA00000000000000001</RoleId>
      <Arn>arn:aws:iam::000000000000:role/service-role/firehose-delivery</Arn>
      <CreateDate>2026-08-20T09:00:00Z</CreateDate>
      <Description>Writes delivery stream output to the lake bucket</Description>
      <MaxSessionDuration>3600</MaxSessionDuration>
      <AssumeRolePolicyDocument>%7B%22Version%22%3A%222012-10-17%22%7D</AssumeRolePolicyDocument>
    </member>
  </Roles>
  <IsTruncated>false</IsTruncated>
</ListRolesResult></ListRolesResponse>`;

describe('IAM', () => {
  it('opens on ListRoles rather than thirty entries into 180 operations', async () => {
    const fetchStub = stubXmlTarget(() => ({ body: LIST_ROLES }));
    vi.stubGlobal('fetch', fetchStub);

    const user = await openService('iam', 'Resources');
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() => expect(within(table).getByText('firehose-delivery')).toBeInTheDocument());

    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(['Role name', 'Path', 'Description', 'Max session duration', 'Create date', 'Arn']);
    // The trust policy is a URL-encoded document in every row; curating the
    // columns keeps it out of the table without hiding it from the raw response.
    expect(within(table).queryByText(/2012-10-17/)).not.toBeInTheDocument();

    expect(operationsSent(fetchStub)).toEqual(['ListRoles']);
  });

  it('promotes the role-authoring actions', async () => {
    vi.stubGlobal(
      'fetch',
      stubXmlTarget(() => ({ body: '<GetRoleResponse><GetRoleResult /></GetRoleResponse>' })),
    );

    const user = await openService('iam', 'Actions');
    await user.click(await screen.findByLabelText('Operation'));

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Common')).toBeInTheDocument();
    expect(within(listbox).getAllByText('CreateRole').length).toBeGreaterThan(0);
    expect(within(listbox).getAllByText('AttachRolePolicy').length).toBeGreaterThan(0);
  });
});

const TOPIC_ATTRIBUTES = `<GetTopicAttributesResponse><GetTopicAttributesResult>
  <Attributes>
    <entry><key>TopicArn</key><value>arn:aws:sns:us-east-1:000000000000:orders</value></entry>
    <entry><key>SubscriptionsConfirmed</key><value>2</value></entry>
    <entry><key>DisplayName</key><value>Orders</value></entry>
  </Attributes>
</GetTopicAttributesResult></GetTopicAttributesResponse>`;

const SUBSCRIPTIONS = `<ListSubscriptionsByTopicResponse><ListSubscriptionsByTopicResult>
  <Subscriptions>
    <member>
      <SubscriptionArn>arn:aws:sns:us-east-1:000000000000:orders:1111</SubscriptionArn>
      <Owner>000000000000</Owner>
      <Protocol>sqs</Protocol>
      <Endpoint>arn:aws:sqs:us-east-1:000000000000:orders-queue</Endpoint>
      <TopicArn>arn:aws:sns:us-east-1:000000000000:orders</TopicArn>
    </member>
  </Subscriptions>
</ListSubscriptionsByTopicResult></ListSubscriptionsByTopicResponse>`;

describe('SNS', () => {
  it('renders a topic’s attribute map as a result rather than a table', async () => {
    const fetchStub = stubXmlTarget(() => ({ body: TOPIC_ATTRIBUTES }));
    vi.stubGlobal('fetch', fetchStub);

    const user = await openService('sns', 'Resources');
    await user.click(await screen.findByLabelText('Read operation'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getAllByText('GetTopicAttributes')[0]);
    await user.type(await screen.findByLabelText('Topic arn'), 'arn:aws:sns:::orders');
    await user.click(await screen.findByTestId('run-read-operation'));

    const response = await screen.findByTestId('operation-response');
    expect(response).toHaveTextContent('SubscriptionsConfirmed');
    expect(screen.queryByTestId('resources-table')).not.toBeInTheDocument();
    expect(operationsSent(fetchStub)).toEqual(['GetTopicAttributes']);
  });

  it('shows a subscription’s protocol and endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      stubXmlTarget(() => ({ body: SUBSCRIPTIONS })),
    );

    const user = await openService('sns', 'Resources');
    await user.click(await screen.findByLabelText('Read operation'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getAllByText('ListSubscriptionsByTopic')[0]);
    await user.type(await screen.findByLabelText('Topic arn'), 'arn:aws:sns:::orders');
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() => expect(within(table).getByText('sqs')).toBeInTheDocument());
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(['Subscription arn', 'Protocol', 'Endpoint', 'Owner', 'Topic arn']);
  });
});

describe('CloudWatch Logs', () => {
  it('opens its Resources tab on DescribeLogGroups with retention and size', async () => {
    const fetchStub = stubTarget(() => ({
      body: {
        logGroups: [
          {
            logGroupName: '/glaux/firehose/orders',
            creationTime: 1_756_000_000_000,
            retentionInDays: 7,
            metricFilterCount: 0,
            storedBytes: 4096,
            logGroupClass: 'STANDARD',
            arn: 'arn:aws:logs:us-east-1:000000000000:log-group:/glaux/firehose/orders:*',
          },
        ],
      },
    }));
    vi.stubGlobal('fetch', fetchStub);

    const user = await openService('logs', 'Resources');
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() =>
      expect(within(table).getByText('/glaux/firehose/orders')).toBeInTheDocument(),
    );
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual([
      'Log group name',
      'Log group class',
      'Retention in days',
      'Stored bytes',
      'Metric filter count',
      'Creation time',
      'Arn',
    ]);
    expect(operationsSent(fetchStub)).toEqual(['DescribeLogGroups']);
  });

  it('promotes FilterLogEvents on Actions, which no read picker would offer', async () => {
    vi.stubGlobal(
      'fetch',
      stubTarget(() => ({ body: { events: [] } })),
    );

    const user = await openService('logs', 'Actions');
    await user.click(await screen.findByLabelText('Operation'));

    const listbox = await screen.findByRole('listbox');
    // The model classifies FilterLogEvents as neither list nor describe, so the
    // Resources picker never shows it however far you scroll.
    expect(within(listbox).getAllByText('FilterLogEvents').length).toBeGreaterThan(0);
  });
});

describe('KMS', () => {
  it('opens on ListKeys, which returns nothing but ids', async () => {
    const fetchStub = stubTarget(() => ({
      body: {
        Keys: [
          {
            KeyId: '1234abcd-12ab-34cd-56ef-1234567890ab',
            KeyArn: 'arn:aws:kms:us-east-1:000000000000:key/1234abcd-12ab-34cd-56ef-1234567890ab',
          },
        ],
        Truncated: false,
      },
    }));
    vi.stubGlobal('fetch', fetchStub);

    const user = await openService('kms', 'Resources');
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() =>
      expect(within(table).getByText('1234abcd-12ab-34cd-56ef-1234567890ab')).toBeInTheDocument(),
    );
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(['Key id', 'Key arn']);
    expect(operationsSent(fetchStub)).toEqual(['ListKeys']);
  });

  it('renders DescribeKey’s metadata as a result', async () => {
    vi.stubGlobal(
      'fetch',
      stubTarget(() => ({
        body: {
          KeyMetadata: {
            KeyId: '1234abcd-12ab-34cd-56ef-1234567890ab',
            Enabled: true,
            KeyState: 'Enabled',
            KeyUsage: 'ENCRYPT_DECRYPT',
            KeySpec: 'SYMMETRIC_DEFAULT',
            CreationDate: 1.756e9,
          },
        },
      })),
    );

    const user = await openService('kms', 'Resources');
    await user.click(await screen.findByLabelText('Read operation'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getAllByText('DescribeKey')[0]);
    await user.type(await screen.findByLabelText('Key id'), 'alias/glaux');
    await user.click(await screen.findByTestId('run-read-operation'));

    const response = await screen.findByTestId('operation-response');
    expect(response).toHaveTextContent('SYMMETRIC_DEFAULT');
    expect(screen.queryByTestId('resources-table')).not.toBeInTheDocument();
  });
});
