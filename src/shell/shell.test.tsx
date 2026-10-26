import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';

/**
 * Shell tests. These drive the console through its own backend contract: the
 * only thing stubbed is `fetch` to /api/request, which is exactly what the
 * standalone server and the embedded Rust mount implement.
 */

function stubBackend(handler: (envelope: Record<string, unknown>) => unknown) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body ?? '{}'));
    const payload = handler(envelope);
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response;
  });
}

const healthyTarget = (services: string[]) =>
  stubBackend(envelope => {
    if (envelope.path === '/_fakecloud/health') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok', version: '0.4.2', services }),
        bodyEncoding: 'utf8',
        durationMs: 3,
      };
    }
    return { status: 200, headers: {}, body: '{}', bodyEncoding: 'utf8', durationMs: 1 };
  });

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('console shell', () => {
  it('renders glaux branding and no AWS marks', async () => {
    vi.stubGlobal('fetch', healthyTarget(['s3', 'sqs', 'athena']));
    render(<App />);

    expect((await screen.findAllByText('glaux-console')).length).toBeGreaterThan(0);
    // The only mark in the shell is glaux's own owl.
    expect(screen.getAllByAltText('glaux').length).toBeGreaterThan(0);
    for (const image of document.querySelectorAll('img')) {
      expect(image.getAttribute('alt')).toBe('glaux');
      expect(image.getAttribute('src')).toBe('owl.svg');
    }
    // "Amazon Web Services" appears exactly once, in the non-affiliation notice.
    const mentions = document.body.textContent?.match(/Amazon Web Services/g) ?? [];
    expect(mentions).toHaveLength(1);
    expect(
      screen.getByText(/Not affiliated with, or endorsed by, Amazon Web Services/),
    ).toBeInTheDocument();
  });

  it('reports the target’s capabilities from /_fakecloud/health', async () => {
    vi.stubGlobal('fetch', healthyTarget(['s3', 'sqs', 'athena', 'glue']));
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId('target-status')).toHaveTextContent('4 services running'),
    );
    expect(screen.getByTestId('target-status')).toHaveTextContent('0.4.2');
  });

  it('greys out services the target does not run', async () => {
    vi.stubGlobal('fetch', healthyTarget(['s3']));
    render(<App />);

    await waitFor(() => expect(screen.getByTestId('target-status')).toBeInTheDocument());
    const cards = screen.getByRole('main');
    await waitFor(() =>
      expect(within(cards).getAllByText('Not running').length).toBeGreaterThan(10),
    );
    expect(within(cards).getAllByText('Running')).toHaveLength(1);
  });

  it('falls back to "capabilities unknown" when discovery does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      stubBackend(() => ({
        status: 404,
        headers: {},
        body: 'not found',
        bodyEncoding: 'utf8',
        durationMs: 1,
      })),
    );
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId('target-status')).toHaveTextContent('Capabilities unknown'),
    );
    expect(screen.getByText(/Capability discovery did not answer/)).toBeInTheDocument();
  });

  it('surfaces reported services that have no catalog entry', async () => {
    vi.stubGlobal('fetch', healthyTarget(['s3', 'quantumledger']));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText(/Services reported but not catalogued/)).toBeInTheDocument(),
    );
  });

  it('navigates to a service screen with generated tabs', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', healthyTarget(['athena']));
    render(<App />);

    await waitFor(() => expect(screen.getByTestId('target-status')).toBeInTheDocument());
    await user.click(within(screen.getByTestId('service-card-athena')).getByText('Athena'));

    expect(await screen.findByRole('tab', { name: 'Resources' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Actions' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Amazon Athena · API version 2017-05-18/)).toBeInTheDocument(),
    );
  });
});

describe('endpoint management', () => {
  it('refuses a real AWS endpoint in the form, before any request', async () => {
    const user = userEvent.setup();
    const fetchStub = healthyTarget(['s3']);
    vi.stubGlobal('fetch', fetchStub);
    window.location.hash = '#/endpoints';
    render(<App />);

    const input = await screen.findByTestId('endpoint-url');
    await user.type(within(input).getByRole('textbox'), 'https://s3.us-east-1.amazonaws.com');
    const callsBefore = fetchStub.mock.calls.length;
    await user.click(screen.getByTestId('add-endpoint'));

    expect(await screen.findByText(/refuses to send requests to it/)).toBeInTheDocument();
    expect(fetchStub.mock.calls.length).toBe(callsBefore);
  });

  it('adds a local endpoint and re-runs capability discovery against it', async () => {
    const user = userEvent.setup();
    const fetchStub = healthyTarget(['s3']);
    vi.stubGlobal('fetch', fetchStub);
    window.location.hash = '#/endpoints';
    render(<App />);

    const input = await screen.findByTestId('endpoint-url');
    await user.type(within(input).getByRole('textbox'), 'http://localhost:4566');
    await user.click(screen.getByTestId('add-endpoint'));

    await waitFor(() =>
      expect(
        fetchStub.mock.calls.some(
          call =>
            JSON.parse(String((call[1] as RequestInit).body)).endpoint === 'http://localhost:4566',
        ),
      ).toBe(true),
    );
    expect(
      within(screen.getByTestId('endpoints-table')).getByText(/\(active\)/),
    ).toBeInTheDocument();
  });
});
