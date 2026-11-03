import { expect, test } from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:4610';

/**
 * End-to-end through the real stack: production build, standalone console
 * backend, SigV4 signing, a target over HTTP, and — for the Athena tests below —
 * the real Ace editor in a real browser.
 *
 * The target is the fixture in `e2e/fixtures/`, not glaux: the spec's scenario
 * against an all-in-one glaux binary still needs that binary in CI. What is
 * covered here is the console's own half of it, which is what this repo owns.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.goto('/#/endpoints');
});

type Page = import('@playwright/test').Page;

/**
 * Cloudscape renders each option's documentation into its accessible name, so
 * options are picked by their visible operation name inside the open listbox.
 */
async function chooseOperation(page: Page, label: string, operation: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole('listbox').getByText(operation, { exact: true }).click();
}

async function useFixtureEndpoint(page: Page) {
  await page.getByTestId('endpoint-url').getByRole('textbox').fill(FIXTURE);
  await page.getByTestId('add-endpoint').click();
  await expect(page.getByTestId('endpoints-table')).toContainText('(active)');
}

test('refuses a real AWS endpoint', async ({ page }) => {
  await page
    .getByTestId('endpoint-url')
    .getByRole('textbox')
    .fill('https://sqs.us-east-1.amazonaws.com');
  await page.getByTestId('add-endpoint').click();
  await expect(page.getByText(/refuses to send requests to it/)).toBeVisible();
});

test('discovers capabilities and lists queues through the console backend', async ({ page }) => {
  await useFixtureEndpoint(page);

  await page.goto('/#/');
  await expect(page.getByTestId('target-status')).toContainText('5 services running');
  await expect(page.getByTestId('target-status')).toContainText('e2e-fixture');

  await page.getByTestId('service-card-sqs').getByText('SQS').click();
  // SQS opens on its hand-built queue screen; the generated tabs sit behind it.
  await page.getByRole('tab', { name: 'Resources' }).click();
  await chooseOperation(page, 'Read operation', 'ListQueues');
  await page.getByTestId('run-read-operation').click();

  const table = page.getByTestId('resources-table');
  await expect(table).toContainText('000000000000/orders');
  await expect(table).toContainText('000000000000/events');
});

test('runs an action and shows the equivalent CLI command', async ({ page }) => {
  await useFixtureEndpoint(page);
  await page.goto('/#/service/sqs');

  await page.getByRole('tab', { name: 'Actions' }).click();
  await chooseOperation(page, 'Operation', 'CreateQueue');
  await page.getByLabel('Queue name').fill('e2e-queue');

  await page.getByText('View as CLI').click();
  await expect(page.getByTestId('cli-command')).toContainText('create-queue');
  await expect(page.getByTestId('cli-command')).toContainText('--queue-name e2e-queue');

  await page.getByTestId('run-operation').click();
  await expect(page.getByTestId('operation-response')).toContainText('e2e-queue');
});

test('surfaces the target’s own error', async ({ page }) => {
  await useFixtureEndpoint(page);
  await page.goto('/#/service/sqs');

  await page.getByRole('tab', { name: 'Resources' }).click();
  await chooseOperation(page, 'Read operation', 'GetQueueUrl');
  await page.getByLabel('Queue name').fill('missing-queue');
  await page.getByTestId('run-read-operation').click();

  await expect(page.getByTestId('resources-error')).toContainText('QueueDoesNotExist');
  await expect(page.getByTestId('resources-error')).toContainText('does not exist');
});

test('runs a query from the schema tree and reports results and bytes scanned', async ({
  page,
}) => {
  await useFixtureEndpoint(page);
  await page.goto('/#/service/athena');

  // The schema tree is Glue-backed: expand the database, then the table. The
  // names are matched case-sensitively so they cannot pick up the navigation's
  // own "Analytics" category heading.
  await page.getByRole('button', { name: /^analytics$/ }).click();
  await page.getByRole('button', { name: /^orders$/ }).click();
  await page.getByTestId('query-table-orders').click();

  await page.getByTestId('run-query').click();

  await expect(page.getByTestId('query-state')).toContainText('SUCCEEDED');
  await expect(page.getByTestId('bytes-scanned')).toContainText('4.00 KB');
  await expect(page.getByTestId('engine-time')).toContainText('42 ms');

  const results = page.getByTestId('query-results');
  await expect(results).toContainText('A-1');
  await expect(results).toContainText('7.25');

  await expect(page.getByTestId('query-history')).toContainText('FROM "analytics"."orders"');
});

test('explains an unsupported SQL construct instead of a bare error', async ({ page }) => {
  await useFixtureEndpoint(page);
  await page.goto('/#/service/athena');

  // Typed into the real Ace editor, not injected into React state.
  const editor = page.locator('.ace_content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  // Typed with a delay: ace's own key handling drops characters typed faster
  // than a person can type them.
  await page.keyboard.type('SELECT dt FROM "analytics"."orders" GROUP BY GROUPING SETS ((dt));', {
    delay: 20,
  });

  await page.getByTestId('run-query').click();

  const explanation = page.getByTestId('unsupported-construct');
  await expect(explanation).toContainText('GROUPING SETS');
  await expect(explanation.getByRole('link')).toHaveAttribute('href', /glaux/);
  await expect(page.getByTestId('query-results')).toHaveCount(0);
  await expect(page.getByTestId('query-history')).toContainText('UNSUPPORTED');
});

test('browses a bucket, uploads an object, and downloads it back', async ({ page }) => {
  await useFixtureEndpoint(page);
  await page.goto('/#/service/s3');

  await page.getByTestId('open-bucket-lake').click();

  // The delimiter is what makes the flat key space browsable: the seeded keys
  // collapse into one prefix row rather than showing as keys.
  const objects = page.getByTestId('object-table');
  await expect(objects.getByTestId('open-prefix-orders/')).toBeVisible();

  await page.getByTestId('upload-object').click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'e2e.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('uploaded by the end-to-end test'),
  });
  await page.getByTestId('confirm-upload').click();

  await expect(page.getByTestId('s3-notice')).toContainText('e2e.txt');
  await expect(objects).toContainText('e2e.txt');

  await page.getByRole('radio', { name: 'Select e2e.txt' }).click();
  const details = page.getByTestId('object-details');
  await expect(details.getByTestId('metadata-size')).toContainText('31 B');
  await expect(details).toContainText('text/plain');
  await expect(details.getByTestId('user-metadata')).toContainText('written-by');

  // The bytes come back through the console backend and are handed to the
  // browser as a file, which is the whole point of the download path.
  const download = page.waitForEvent('download');
  await page.getByTestId('download-object').click();
  expect((await download).suggestedFilename()).toBe('e2e.txt');
});

test('watches a Firehose stream deliver a record into S3', async ({ page }) => {
  await useFixtureEndpoint(page);
  await page.goto('/#/service/firehose');

  await page.getByTestId('open-stream-orders-to-lake').click();
  await expect(page.getByTestId('stream-status')).toContainText('ACTIVE');

  // Delivery activity is read out of the destination bucket, so this is S3
  // answering rest-xml behind a Firehose screen.
  const delivered = page.getByTestId('delivered-objects');
  await expect(delivered).toContainText('orders/2026/08/24/orders-2.json.gz');
  const before = Number(await page.getByTestId('objects-written').innerText());

  await page.getByRole('tab', { name: 'Put test records' }).click();
  await page.getByTestId('put-records').click();
  await expect(page.getByTestId('put-result')).toContainText('2 records accepted');

  // The fixture lands a put as an object straight away, so the activity panel
  // has one more object to report once it refreshes.
  await page.getByRole('tab', { name: 'Delivery activity' }).click();
  await expect(page.getByTestId('objects-written')).toHaveText(String(before + 1));

  // Newest first, so the object just delivered is the first row.
  const newest = delivered.getByRole('link').first();
  const key = (await newest.innerText()).split('/').pop() ?? '';
  await newest.click();

  // The S3 browser opens on the bucket, at the prefix the object sits in.
  await expect(page.getByTestId('prefix-crumbs')).toContainText('lake');
  await expect(page.getByTestId('object-table')).toContainText(key);
});

test('opens the Athena editor from a Glue table', async ({ page }) => {
  await useFixtureEndpoint(page);
  await page.goto('/#/service/glue');

  await page.getByTestId('open-database-analytics').click();
  await page.getByTestId('open-table-orders').click();

  await expect(page.getByTestId('columns-table')).toContainText('order_id');
  await page.getByTestId('query-this-table').click();

  // The statement lands in the real Ace editor, and runs from there.
  await expect(page.locator('.ace_content')).toContainText('FROM "analytics"."orders"');
  await page.getByTestId('run-query').click();
  await expect(page.getByTestId('query-state')).toContainText('SUCCEEDED');
});

test('sends a message and peeks it back without consuming it', async ({ page }) => {
  await useFixtureEndpoint(page);
  await page.goto('/#/service/sqs');

  await page.getByTestId('open-queue-orders').click();
  await expect(page.getByTestId('queue-detail')).toContainText(
    'arn:aws:sqs:us-east-1:000000000000:orders',
  );

  await page.getByRole('tab', { name: 'Send message' }).click();
  await page.getByTestId('message-body-input').getByRole('textbox').fill('{"order_id":"e2e-1"}');
  await page.getByTestId('send-message').click();
  await expect(page.getByTestId('send-result')).toContainText('Message ID');

  await page.getByRole('tab', { name: 'Messages' }).click();
  await page.getByTestId('poll-messages').click();
  await expect(page.getByTestId('message-table')).toContainText('e2e-1');

  // The point of the peek: a second poll finds the same message still there,
  // and its receive count has moved rather than the message disappearing.
  await page.getByTestId('poll-messages').click();
  await expect(page.getByTestId('message-table')).toContainText('e2e-1');
  await expect(page.getByTestId('message-table')).toContainText('2');
});

test('shows the redrive policy of a queue that has one', async ({ page }) => {
  await useFixtureEndpoint(page);
  await page.goto('/#/service/sqs');

  await page.getByTestId('open-queue-orders').click();
  await page.getByRole('tab', { name: 'Dead-letter queue' }).click();

  await expect(page.getByTestId('max-receive-count')).toContainText('5');
  // The target ARN resolves to a queue that is actually on this endpoint.
  await page.getByTestId('open-dead-letter-target').click();
  await expect(page.getByTestId('queue-detail')).toContainText('events');
});
