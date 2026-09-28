import { useState } from 'react';
import { HashRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import AppLayout from '@cloudscape-design/components/app-layout';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import { findService } from './catalog/loader';
import { EndpointProvider } from './endpoints/EndpointContext';
import { HomePage } from './pages/HomePage';
import { EndpointsPage } from './pages/EndpointsPage';
import { ServicePage } from './pages/ServicePage';
import { Navigation } from './shell/Navigation';
import { TopBar } from './shell/TopBar';

/**
 * The console shell: TopNavigation, AppLayout with collapsible service
 * navigation and breadcrumbs — the Cloudscape arrangement the AWS console
 * itself uses.
 *
 * Routing is hash-based so the same build works served from a static host, from
 * `npx glaux-console`, and embedded under an arbitrary mount path (glaux serves
 * it at /console) with no server rewrite rules.
 */
export function App() {
  return (
    <EndpointProvider>
      <HashRouter>
        <Shell />
      </HashRouter>
    </EndpointProvider>
  );
}

function Shell() {
  const [navigationOpen, setNavigationOpen] = useState(true);
  return (
    <>
      <TopBar />
      <AppLayout
        headerSelector="#glaux-console-top-bar"
        navigation={<Navigation />}
        navigationOpen={navigationOpen}
        onNavigationChange={event => setNavigationOpen(event.detail.open)}
        breadcrumbs={<Breadcrumbs />}
        toolsHide
        content={
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/endpoints" element={<EndpointsPage />} />
            <Route path="/service/:serviceId" element={<ServicePage />} />
            <Route path="*" element={<HomePage />} />
          </Routes>
        }
      />
    </>
  );
}

function Breadcrumbs() {
  const location = useLocation();
  const navigate = useNavigate();
  const items = [{ text: 'glaux-console', href: '#/' }];

  if (location.pathname.startsWith('/service/')) {
    const serviceId = location.pathname.split('/')[2] ?? '';
    const entry = findService(serviceId);
    items.push({ text: entry?.label ?? serviceId, href: `#/service/${serviceId}` });
  } else if (location.pathname === '/endpoints') {
    items.push({ text: 'Endpoints', href: '#/endpoints' });
  }

  return (
    <BreadcrumbGroup
      items={items}
      ariaLabel="Breadcrumbs"
      onFollow={event => {
        event.preventDefault();
        navigate(event.detail.href.slice(1));
      }}
    />
  );
}
