import { expect, test } from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:4610';

/**
 * End-to-end through the real stack: production build, standalone console
 * backend, SigV4 signing, a target over HTTP.
 *
 * The spec's full end-to-end scenario (Glue table -> Athena query -> results and
 * bytes scanned) needs a real glaux binary and lands with the Athena entry.
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
  await expect(page.getByTestId('target-status')).toContainText('1 services running');
  await expect(page.getByTestId('target-status')).toContainText('e2e-fixture');

  await page.getByTestId('service-card-sqs').getByText('SQS').click();
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

  await chooseOperation(page, 'Read operation', 'GetQueueUrl');
  await page.getByLabel('Queue name').fill('missing-queue');
  await page.getByTestId('run-read-operation').click();

  await expect(page.getByTestId('resources-error')).toContainText('QueueDoesNotExist');
  await expect(page.getByTestId('resources-error')).toContainText('does not exist');
});
