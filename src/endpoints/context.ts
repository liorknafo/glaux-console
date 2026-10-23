import { createContext, useContext } from 'react';
import type { Capabilities } from '../api/health';
import type { EndpointConfig } from './store';

export interface EndpointContextValue {
  endpoints: EndpointConfig[];
  active: EndpointConfig;
  capabilities: Capabilities | 'loading';
  select(id: string): void;
  upsert(endpoint: EndpointConfig): void;
  remove(id: string): void;
  refreshCapabilities(): void;
  /** True when the target reports it does not run this service. */
  isUnavailable(serviceId: string): boolean;
}

export const EndpointContext = createContext<EndpointContextValue | undefined>(undefined);

export function useEndpoints(): EndpointContextValue {
  const value = useContext(EndpointContext);
  if (!value) throw new Error('useEndpoints must be used inside an EndpointProvider');
  return value;
}
