import type { ReactNode } from 'react';
import type { ServiceCatalog } from '../catalog/types';
import { AthenaScreen } from './athena/AthenaScreen';

/**
 * Hand-built screens, keyed by service id.
 *
 * The generated Resources and Actions tabs are the floor for every service; a
 * service in this registry gets its own tab in front of them. Adding the Glue
 * and Firehose screens later is one entry each.
 */
export interface DeepScreen {
  /** Tab id, and the anchor the tab is selected by. */
  id: string;
  label: string;
  render(catalog: ServiceCatalog): ReactNode;
}

export const deepScreens: Record<string, DeepScreen> = {
  athena: {
    id: 'query-editor',
    label: 'Query editor',
    render: catalog => <AthenaScreen catalog={catalog} />,
  },
};

export function deepScreenFor(serviceId: string): DeepScreen | undefined {
  return deepScreens[serviceId];
}
