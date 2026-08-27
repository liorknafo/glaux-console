import Box from '@cloudscape-design/components/box';
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { Operation, ServiceCatalog } from '../catalog/types';
import { renderCliCommand } from '../protocol/cli';

/**
 * "View as CLI" — every generated form shows the equivalent `aws` command, so
 * anything done here can be scripted afterwards.
 */
export function ViewAsCli({
  catalog,
  operation,
  input,
  endpointUrl,
}: {
  catalog: ServiceCatalog;
  operation: Operation;
  input: Record<string, unknown>;
  endpointUrl: string;
}) {
  const command = renderCliCommand(catalog, operation, input, endpointUrl);
  return (
    <ExpandableSection headerText="View as CLI" variant="footer">
      <SpaceBetween size="xs">
        <Box variant="code" data-testid="cli-command">
          <pre className="glaux-cli-command">{command}</pre>
        </Box>
        <CopyToClipboard
          copyButtonText="Copy command"
          textToCopy={command}
          copySuccessText="Command copied"
          copyErrorText="Could not copy the command"
        />
      </SpaceBetween>
    </ExpandableSection>
  );
}
