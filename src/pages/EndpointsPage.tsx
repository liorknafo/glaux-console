import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { useEndpoints } from '../endpoints/context';
import { newEndpointId, type EndpointConfig } from '../endpoints/store';
import { checkEndpointUrl, isLikelyLocal, REAL_AWS_SUFFIXES } from '../endpoints/validation';

/**
 * Endpoint management. The refusal of real-AWS hosts is explained here rather
 * than only enforced: it is a product decision, not a missing feature.
 */
export function EndpointsPage() {
  const { endpoints, active, select, upsert, remove, capabilities } = useEndpoints();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [error, setError] = useState<string>();

  function add() {
    const check = checkEndpointUrl(url);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    const endpoint: EndpointConfig = {
      id: newEndpointId(),
      name: name.trim() || check.url,
      url: check.url,
      region: region.trim() || 'us-east-1',
    };
    upsert(endpoint);
    select(endpoint.id);
    setName('');
    setUrl('');
    setError(undefined);
  }

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Where the console sends requests. Local emulators only.">
          Endpoints
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Table
          data-testid="endpoints-table"
          variant="container"
          header={
            <Header variant="h2" counter={`(${endpoints.length})`}>
              Configured endpoints
            </Header>
          }
          columnDefinitions={[
            {
              id: 'name',
              header: 'Name',
              cell: (item: EndpointConfig) =>
                item.id === active.id ? `${item.name} (active)` : item.name,
            },
            { id: 'url', header: 'URL', cell: (item: EndpointConfig) => item.url },
            { id: 'region', header: 'Region', cell: (item: EndpointConfig) => item.region },
            {
              id: 'actions',
              header: 'Actions',
              cell: (item: EndpointConfig) => (
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    variant="inline-link"
                    disabled={item.id === active.id}
                    onClick={() => select(item.id)}
                  >
                    Use
                  </Button>
                  <Button
                    variant="inline-link"
                    disabled={endpoints.length === 1}
                    onClick={() => remove(item.id)}
                  >
                    Remove
                  </Button>
                </SpaceBetween>
              ),
            },
          ]}
          items={endpoints}
        />

        {capabilities !== 'loading' && capabilities.state === 'known' && (
          <Alert type="success" header={`${active.name} answered capability discovery`}>
            Reported {capabilities.report.reported.length} services
            {capabilities.report.version ? ` at version ${capabilities.report.version}` : ''}.
          </Alert>
        )}

        <Container header={<Header variant="h2">Add an endpoint</Header>}>
          <Form
            actions={
              <Button variant="primary" onClick={add} data-testid="add-endpoint">
                Add endpoint
              </Button>
            }
          >
            <SpaceBetween size="m">
              <FormField label="Name" description="Shown in the endpoint menu.">
                <Input
                  value={name}
                  onChange={event => setName(event.detail.value)}
                  ariaLabel="Name"
                />
              </FormField>
              <FormField
                label="Endpoint URL"
                errorText={error}
                warningText={
                  !error && url && isLikelyLocal(url) === false && checkEndpointUrl(url).ok
                    ? 'This name does not look like a local emulator. The backend resolves it on every request and refuses it if it points outside loopback and private ranges.'
                    : undefined
                }
                description="For example http://localhost:4566"
              >
                <Input
                  value={url}
                  placeholder="http://localhost:4566"
                  onChange={event => {
                    setUrl(event.detail.value);
                    setError(undefined);
                  }}
                  ariaLabel="Endpoint URL"
                  data-testid="endpoint-url"
                />
              </FormField>
              <FormField label="Region" description="Sent in the signature; emulators rarely care.">
                <Input
                  value={region}
                  onChange={event => setRegion(event.detail.value)}
                  ariaLabel="Region"
                />
              </FormField>
            </SpaceBetween>
          </Form>
        </Container>

        <Container header={<Header variant="h2">Why real AWS endpoints are refused</Header>}>
          <SpaceBetween size="s">
            <Box>
              This console generates full CRUD for every operation a target implements. Pointed at a
              production account that would be a liability, so the console backend refuses any host
              under these suffixes and reports the refusal instead of sending the request:
            </Box>
            <Box variant="code">{REAL_AWS_SUFFIXES.join('  ·  ')}</Box>
            <Box color="text-body-secondary" fontSize="body-s">
              The check runs in the backend, so it holds even if the browser is bypassed.
            </Box>
            <Box>
              A deny list only names what someone thought of, so the destination also has to be on
              the allow side of a positive rule: a loopback or private address. A hostname is
              resolved and every address it answers with is checked on every request, so an endpoint
              that resolved locally when it was added cannot later point the backend somewhere else.
              To reach an emulator that is not on a local network, an operator sets{' '}
              <Box variant="code" display="inline">
                GLAUX_CONSOLE_ALLOW_HOSTS
              </Box>{' '}
              on the backend. That override does not reopen the hosts above, or the cloud
              instance-metadata addresses.
            </Box>
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
