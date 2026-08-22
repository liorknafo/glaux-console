import { useNavigate } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { serviceIndex } from '../catalog/loader';
import { useEndpoints } from '../endpoints/context';

/** Landing screen: target status, and every catalogued service as a card. */
export function HomePage() {
  const navigate = useNavigate();
  const { active, capabilities, refreshCapabilities } = useEndpoints();

  const running =
    capabilities !== 'loading' && capabilities.state === 'known'
      ? capabilities.report.supported
      : undefined;

  const services = [...serviceIndex].sort((a, b) => {
    const aRunning = running ? Number(running.has(b.id)) - Number(running.has(a.id)) : 0;
    return aRunning !== 0 ? aRunning : a.label.localeCompare(b.label);
  });

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="A console for local AWS emulators. Not affiliated with, or endorsed by, Amazon Web Services."
          actions={
            <Button iconName="refresh" onClick={refreshCapabilities}>
              Re-check target
            </Button>
          }
        >
          glaux-console
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Target</Header>}>
          <ColumnLayout columns={3} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">Endpoint</Box>
              <Box>{active.url}</Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Region</Box>
              <Box>{active.region}</Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Status</Box>
              {capabilities === 'loading' ? (
                <Spinner />
              ) : capabilities.state === 'known' ? (
                <StatusIndicator type="success" data-testid="target-status">
                  {capabilities.report.supported.size} services running
                  {capabilities.report.version ? ` · ${capabilities.report.version}` : ''}
                </StatusIndicator>
              ) : (
                <StatusIndicator type="warning" data-testid="target-status">
                  Capabilities unknown
                </StatusIndicator>
              )}
            </div>
          </ColumnLayout>
        </Container>

        {capabilities !== 'loading' && capabilities.state === 'unknown' && (
          <Alert type="info" header="Capability discovery did not answer">
            {capabilities.reason} Every catalogued service is shown; requests still go through to
            the target.
          </Alert>
        )}

        {capabilities !== 'loading' &&
          capabilities.state === 'known' &&
          capabilities.report.unmatched.length > 0 && (
            <Alert type="info" header="Services reported but not catalogued">
              The target reports {capabilities.report.unmatched.join(', ')}, which have no catalog
              entry yet. Add them to scripts/catalog-services.json and regenerate.
            </Alert>
          )}

        <Cards
          ariaLabels={{
            itemSelectionLabel: (_data, item) => item.label,
            selectionGroupLabel: 'Services',
          }}
          cardDefinition={{
            header: item => (
              <span data-testid={`service-card-${item.id}`}>
                <Link
                  href={`#/service/${item.id}`}
                  onFollow={event => {
                    event.preventDefault();
                    navigate(`/service/${item.id}`);
                  }}
                >
                  {item.label}
                </Link>
              </span>
            ),
            sections: [
              {
                id: 'status',
                content: item =>
                  running ? (
                    running.has(item.id) ? (
                      <Badge color="green">Running</Badge>
                    ) : (
                      <Badge color="grey">Not running</Badge>
                    )
                  ) : (
                    <Badge color="blue">Unknown</Badge>
                  ),
              },
              {
                id: 'operations',
                content: item => `${item.operations} operations · ${item.category}`,
              },
            ],
          }}
          cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 3 }, { minWidth: 1000, cards: 4 }]}
          items={services}
          header={
            <Header variant="h2" counter={`(${services.length})`}>
              Services
            </Header>
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
