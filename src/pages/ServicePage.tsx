import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import Tabs from '@cloudscape-design/components/tabs';
import { findService, loadServiceCatalog } from '../catalog/loader';
import type { ServiceCatalog } from '../catalog/types';
import { deepScreenFor } from '../deep/registry';
import { useEndpoints } from '../endpoints/context';
import { ActionsTab } from '../generic/ActionsTab';
import { ResourcesTab } from '../generic/ResourcesTab';

/**
 * A service screen. Every service gets the generated Resources/Actions pair;
 * a service with a hand-built screen gets it as the first tab, in front of them.
 */
export function ServicePage() {
  const { serviceId = '' } = useParams();
  const navigate = useNavigate();
  const { isUnavailable, capabilities } = useEndpoints();
  const entry = findService(serviceId);
  // Keyed by service id so switching services shows the spinner again without
  // a state reset inside the effect.
  const [loaded, setLoaded] = useState<{ id: string; catalog?: ServiceCatalog; error?: string }>();

  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    loadServiceCatalog(serviceId).then(
      catalog => !cancelled && setLoaded({ id: serviceId, catalog }),
      loadError => !cancelled && setLoaded({ id: serviceId, error: (loadError as Error).message }),
    );
    return () => {
      cancelled = true;
    };
  }, [serviceId, entry]);

  const current = loaded?.id === serviceId ? loaded : undefined;
  const catalog = current?.catalog;
  const error = current?.error;

  if (!entry) {
    return (
      <Alert type="error" header="Unknown service" action={<a href="#/">Back to home</a>}>
        No catalog entry for “{serviceId}”. Add it to scripts/catalog-services.json and regenerate
        the catalog.
      </Alert>
    );
  }

  const unavailable = isUnavailable(entry.id);
  const deep = deepScreenFor(entry.id);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={
            catalog
              ? `${catalog.metadata.serviceFullName} · API version ${catalog.metadata.apiVersion} · ${catalog.metadata.protocol}`
              : 'Loading the service model…'
          }
          info={unavailable ? <Badge color="grey">Not running on this target</Badge> : undefined}
        >
          {entry.label}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {unavailable && capabilities !== 'loading' && capabilities.state === 'known' && (
          <Alert
            type="info"
            header="This target does not report this service"
            data-testid="service-unavailable"
          >
            The target’s health report does not list {entry.label}. The forms below still work — the
            request will simply fail if the endpoint does not implement the operation. Switch
            targets from the endpoint menu, or{' '}
            <a
              href="#/endpoints"
              onClick={event => {
                event.preventDefault();
                navigate('/endpoints');
              }}
            >
              manage endpoints
            </a>
            .
          </Alert>
        )}

        {error && (
          <Alert type="error" header="Could not load the service catalog">
            {error}
          </Alert>
        )}

        {!catalog && !error && <Spinner size="large" />}

        {catalog && (
          <Tabs
            tabs={[
              ...(deep ? [{ id: deep.id, label: deep.label, content: deep.render(catalog) }] : []),
              {
                id: 'resources',
                label: 'Resources',
                content: <ResourcesTab catalog={catalog} />,
              },
              {
                id: 'actions',
                label: 'Actions',
                content: <ActionsTab catalog={catalog} />,
              },
            ]}
          />
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
