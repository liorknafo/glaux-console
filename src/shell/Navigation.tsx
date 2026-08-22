import Badge from '@cloudscape-design/components/badge';
import SideNavigation, {
  type SideNavigationProps,
} from '@cloudscape-design/components/side-navigation';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMemo } from 'react';
import { servicesByCategory } from '../catalog/loader';
import { useEndpoints } from '../endpoints/EndpointContext';

/**
 * Service navigation, grouped by category like the console's own.
 *
 * Services the target does not report are still listed but marked
 * unavailable — the spec's "greyed out rather than failing mysteriously".
 * Cloudscape's SideNavigation has no disabled link, so unavailable services
 * render as non-interactive text with an "not running" tag.
 */
export function Navigation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isUnavailable, capabilities } = useEndpoints();

  const items = useMemo<SideNavigationProps.Item[]>(() => {
    const groups = servicesByCategory().map<SideNavigationProps.Item>(group => ({
      type: 'expandable-link-group',
      text: group.category,
      href: `#category-${group.category}`,
      defaultExpanded: group.category === 'Analytics',
      items: group.services.map<SideNavigationProps.Item>(service => ({
        type: 'link',
        text: service.label,
        href: `#/service/${service.id}`,
        ...(isUnavailable(service.id) ? { info: <Badge color="grey">Not running</Badge> } : {}),
      })),
    }));

    return [
      { type: 'link', text: 'Home', href: '#/' },
      { type: 'link', text: 'Endpoints', href: '#/endpoints' },
      { type: 'divider' },
      ...groups,
    ];
  }, [isUnavailable]);

  return (
    <SideNavigation
      header={{
        href: '#/',
        text:
          capabilities === 'loading'
            ? 'Services'
            : capabilities.state === 'known'
              ? `Services (${capabilities.report.supported.size} running)`
              : 'Services (all shown)',
      }}
      activeHref={`#${location.pathname}`}
      items={items}
      onFollow={event => {
        if (event.detail.external || !event.detail.href.startsWith('#/')) return;
        event.preventDefault();
        navigate(event.detail.href.slice(1));
      }}
    />
  );
}
