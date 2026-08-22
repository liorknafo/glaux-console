import TopNavigation from '@cloudscape-design/components/top-navigation';
import { useNavigate } from 'react-router-dom';
import { useEndpoints } from '../endpoints/EndpointContext';

/**
 * The console top bar: glaux's own name and owl mark, never an AWS logo or
 * wordmark. The endpoint switcher lives here, where the console puts its
 * region and account menus.
 */
export function TopBar() {
  const { endpoints, active, capabilities, select, refreshCapabilities } = useEndpoints();
  const navigate = useNavigate();

  const capabilityLabel =
    capabilities === 'loading'
      ? 'Checking…'
      : capabilities.state === 'known'
        ? `${capabilities.report.supported.size} services`
        : 'Capabilities unknown';

  return (
    <div id="glaux-console-top-bar">
      <TopNavigation
        identity={{
          href: '#/',
          title: 'glaux-console',
          logo: { src: 'owl.svg', alt: 'glaux' },
          onFollow: event => {
            event.preventDefault();
            navigate('/');
          },
        }}
        utilities={[
          {
            type: 'menu-dropdown',
            text: active.name,
            description: active.url,
            iconName: 'share',
            ariaLabel: 'Target endpoint',
            onItemClick: event => {
              if (event.detail.id === 'manage') navigate('/endpoints');
              else if (event.detail.id === 'refresh') refreshCapabilities();
              else select(event.detail.id);
            },
            items: [
              {
                id: 'endpoints',
                text: 'Target endpoint',
                items: endpoints.map(endpoint => ({
                  id: endpoint.id,
                  text: endpoint.name,
                  description: endpoint.url,
                  disabled: endpoint.id === active.id,
                })),
              },
              {
                id: 'actions',
                text: capabilityLabel,
                items: [
                  { id: 'refresh', text: 'Re-check capabilities' },
                  { id: 'manage', text: 'Manage endpoints' },
                ],
              },
            ],
          },
          {
            type: 'button',
            text: 'Local only',
            iconName: 'lock-private',
            ariaLabel: 'This console refuses real AWS endpoints',
            disableUtilityCollapse: true,
            href: '#/endpoints',
          },
        ]}
      />
    </div>
  );
}
