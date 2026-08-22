import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { discoverCapabilities, type Capabilities } from '../api/health';
import {
  defaultEndpoint,
  loadActiveEndpointId,
  loadEndpoints,
  saveActiveEndpointId,
  saveEndpoints,
  type EndpointConfig,
} from './store';

interface EndpointContextValue {
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

const EndpointContext = createContext<EndpointContextValue | undefined>(undefined);

export function EndpointProvider({
  children,
  origin = window.location.origin,
}: {
  children: ReactNode;
  origin?: string;
}) {
  const [endpoints, setEndpoints] = useState<EndpointConfig[]>(() => loadEndpoints(origin));
  const [activeId, setActiveId] = useState<string>(
    () => loadActiveEndpointId() ?? loadEndpoints(origin)[0]?.id ?? 'origin',
  );
  const [discovered, setDiscovered] = useState<{ key: string; value: Capabilities }>();
  const [nonce, setNonce] = useState(0);

  const active = useMemo(
    () => endpoints.find(entry => entry.id === activeId) ?? endpoints[0] ?? defaultEndpoint(origin),
    [endpoints, activeId, origin],
  );

  // Discovery results are cached per endpoint; the nonce is how "re-check"
  // asks for a fresh probe. Deriving `capabilities` from the key means
  // switching endpoints shows "loading" without resetting state in the effect.
  const discoveryKey = `${active.url}|${active.region}|${nonce}`;
  const capabilities: Capabilities | 'loading' =
    discovered?.key === discoveryKey ? discovered.value : 'loading';

  useEffect(() => {
    const controller = new AbortController();
    discoverCapabilities(active, controller.signal).then(value => {
      if (!controller.signal.aborted) setDiscovered({ key: discoveryKey, value });
    });
    return () => controller.abort();
  }, [active, discoveryKey]);

  const select = useCallback((id: string) => {
    setActiveId(id);
    saveActiveEndpointId(id);
  }, []);

  const upsert = useCallback((endpoint: EndpointConfig) => {
    setEndpoints(current => {
      const index = current.findIndex(entry => entry.id === endpoint.id);
      const next =
        index === -1
          ? [...current, endpoint]
          : current.map(e => (e.id === endpoint.id ? endpoint : e));
      saveEndpoints(next);
      return next;
    });
  }, []);

  const remove = useCallback(
    (id: string) => {
      setEndpoints(current => {
        const next = current.filter(entry => entry.id !== id);
        const safe = next.length ? next : [defaultEndpoint(origin)];
        saveEndpoints(safe);
        if (id === activeId) {
          setActiveId(safe[0].id);
          saveActiveEndpointId(safe[0].id);
        }
        return safe;
      });
    },
    [activeId, origin],
  );

  const isUnavailable = useCallback(
    (serviceId: string) =>
      capabilities !== 'loading' &&
      capabilities.state === 'known' &&
      !capabilities.report.supported.has(serviceId),
    [capabilities],
  );

  const value = useMemo(
    () => ({
      endpoints,
      active,
      capabilities,
      select,
      upsert,
      remove,
      refreshCapabilities: () => setNonce(n => n + 1),
      isUnavailable,
    }),
    [endpoints, active, capabilities, select, upsert, remove, isUnavailable],
  );

  return <EndpointContext.Provider value={value}>{children}</EndpointContext.Provider>;
}

export function useEndpoints(): EndpointContextValue {
  const value = useContext(EndpointContext);
  if (!value) throw new Error('useEndpoints must be used inside an EndpointProvider');
  return value;
}
