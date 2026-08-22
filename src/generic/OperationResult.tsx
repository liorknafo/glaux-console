import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard';
import Header from '@cloudscape-design/components/header';
import StatusIndicator from '@cloudscape-design/components/status-indicator';

/** The raw response of an operation, alongside status and timing. */
export function OperationResult({
  output,
  status,
  durationMs,
}: {
  output: unknown;
  status: number;
  durationMs: number;
}) {
  const text = JSON.stringify(output, null, 2) ?? 'null';
  const succeeded = status >= 200 && status < 300;
  return (
    <Container
      header={
        <Header
          variant="h3"
          actions={
            <CopyToClipboard
              copyButtonText="Copy"
              textToCopy={text}
              copySuccessText="Response copied"
              copyErrorText="Could not copy the response"
            />
          }
          description={`HTTP ${status} · ${durationMs} ms`}
        >
          Response
        </Header>
      }
    >
      <StatusIndicator type={succeeded ? 'success' : 'error'}>
        {succeeded ? 'Succeeded' : 'Failed'}
      </StatusIndicator>
      <Box variant="code">
        <pre className="glaux-response" data-testid="operation-response">
          {text}
        </pre>
      </Box>
    </Container>
  );
}
