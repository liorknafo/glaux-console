import type { ReactNode } from 'react';
import type { ServiceCatalog } from '../catalog/types';
import { AthenaScreen } from './athena/AthenaScreen';
import { DynamoDbScreen } from './dynamodb/DynamoDbScreen';
import { EventBridgeScreen } from './eventbridge/EventBridgeScreen';
import { FirehoseScreen } from './firehose/FirehoseScreen';
import { GlueScreen } from './glue/GlueScreen';
import { S3Screen } from './s3/S3Screen';
import { SqsScreen } from './sqs/SqsScreen';

/**
 * Hand-built screens, keyed by service id.
 *
 * The generated Resources and Actions tabs are the floor for every service; a
 * service in this registry gets its own tab in front of them. Adding a screen
 * for another service is one entry each.
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
  dynamodb: {
    id: 'tables',
    label: 'Tables',
    render: catalog => <DynamoDbScreen catalog={catalog} />,
  },
  events: {
    id: 'rules',
    label: 'Buses and rules',
    render: catalog => <EventBridgeScreen catalog={catalog} />,
  },
  firehose: {
    id: 'delivery',
    label: 'Delivery',
    render: catalog => <FirehoseScreen catalog={catalog} />,
  },
  glue: {
    id: 'data-catalog',
    label: 'Data catalog',
    render: catalog => <GlueScreen catalog={catalog} />,
  },
  s3: {
    id: 'browser',
    label: 'Browser',
    render: catalog => <S3Screen catalog={catalog} />,
  },
  sqs: {
    id: 'queues',
    label: 'Queues',
    render: catalog => <SqsScreen catalog={catalog} />,
  },
};

export function deepScreenFor(serviceId: string): DeepScreen | undefined {
  return deepScreens[serviceId];
}
