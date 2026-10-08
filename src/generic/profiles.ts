/**
 * Per-service presentation overrides on top of the generated catalog.
 *
 * The generated Resources and Actions tabs work for every catalogued service
 * without any entry here — that is the point of the catalog layer. What they
 * cannot know is which of a service's operations a person actually opens the
 * screen to run. Systems Manager models 152 operations; Lambda models 88. An
 * operation picker sorted alphabetically over all of them is technically
 * complete and practically useless: `DescribeParameters` sits thirty entries
 * below `DescribeActivations`, and `ListFunctions` below a dozen `Get…` calls.
 *
 * A profile is the queue's `tier: generic` work, and nothing more:
 *
 * - **resources** — read operations promoted to the top of the Resources
 *   picker, the first one preselected so the tab opens on something useful.
 * - **columns** — the columns a curated view shows, in order. Inference keeps
 *   the first eight scalar members of the element shape, which for
 *   `ListFunctions` means `Role`, `Handler` and `CodeSize` before `Runtime` or
 *   `State`. A curated list replaces that ordering outright; the raw response
 *   is still one expander away, so nothing is lost.
 * - **raw** — says that a read describes one thing rather than listing many,
 *   which the model itself does not record. See `ResourceView.raw`.
 * - **actions** — operations promoted to the top of the Actions picker.
 *
 * Every name here is checked against the generated catalog by
 * `profiles.test.ts`, so a typo or a model change fails the gate rather than
 * quietly rendering an empty column.
 */

export interface ResourceView {
  /** A `list` or `describe` operation in the service's model. */
  operation: string;
  /**
   * Column ids, in display order. Omit for operations that return no
   * collection — those render as a raw result rather than a table.
   */
  columns?: string[];
  /**
   * Force the raw result even though the output shape contains a list.
   *
   * Column inference takes the first list member of the output shape as the
   * collection when the model declares no paginator. That is right for a list
   * operation and wrong for one that describes a single thing which happens to
   * carry a list: `GetSecretValue` would render a table of `VersionStages`,
   * `DescribeSecret` one of `ExternalSecretRotationMetadata`, and
   * `GetFunctionConfiguration` one of `Layers` — in each case a table of a
   * detail instead of the answer. The model has no trait distinguishing the
   * two, so a profile says which it is.
   */
  raw?: true;
}

export interface ServiceProfile {
  /** Read operations promoted to a "Common" group, first one preselected. */
  resources: ResourceView[];
  /** Operations promoted to a "Common" group on the Actions tab. */
  actions: string[];
  /** One line of orientation, shown above the Resources picker. */
  summary: string;
}

export const serviceProfiles: Record<string, ServiceProfile> = {
  lambda: {
    summary:
      'Functions, their configuration, and their event source mappings. “Invoke” is under Actions — its response payload renders as the raw result, including a function error when the handler threw.',
    resources: [
      {
        operation: 'ListFunctions',
        columns: [
          'FunctionName',
          'Runtime',
          'PackageType',
          'MemorySize',
          'Timeout',
          'State',
          'LastModified',
          'Version',
          'FunctionArn',
        ],
      },
      {
        operation: 'GetFunctionConfiguration',
        raw: true,
      },
      {
        operation: 'ListEventSourceMappings',
        columns: [
          'UUID',
          'State',
          'EventSourceArn',
          'FunctionArn',
          'BatchSize',
          'LastProcessingResult',
          'LastModified',
        ],
      },
      {
        operation: 'ListLayers',
        columns: ['LayerName', 'LayerArn'],
      },
      {
        operation: 'ListVersionsByFunction',
        columns: ['Version', 'Runtime', 'MemorySize', 'Timeout', 'LastModified', 'CodeSha256'],
      },
    ],
    actions: [
      'Invoke',
      'CreateFunction',
      'UpdateFunctionCode',
      'UpdateFunctionConfiguration',
      'CreateEventSourceMapping',
      'DeleteFunction',
    ],
  },

  stepfunctions: {
    summary:
      'State machines, their executions, and an execution’s history. History events carry one detail structure per event type; the table shows the event spine and the raw response holds the details.',
    resources: [
      {
        operation: 'ListStateMachines',
        columns: ['name', 'type', 'creationDate', 'stateMachineArn'],
      },
      {
        operation: 'ListExecutions',
        columns: ['name', 'status', 'startDate', 'stopDate', 'executionArn', 'stateMachineArn'],
      },
      {
        operation: 'GetExecutionHistory',
        columns: ['id', 'type', 'timestamp', 'previousEventId'],
      },
      {
        operation: 'DescribeExecution',
        raw: true,
      },
      {
        operation: 'ListActivities',
        columns: ['name', 'creationDate', 'activityArn'],
      },
    ],
    actions: [
      'StartExecution',
      'StartSyncExecution',
      'StopExecution',
      'CreateStateMachine',
      'UpdateStateMachine',
      'DeleteStateMachine',
    ],
  },

  kinesis: {
    summary:
      'Streams, their shards, and records. Reading records is two calls: `GetShardIterator` for a position in a shard, then `GetRecords` with the iterator it returns. Record `Data` is base64 on the wire and shown as the service returned it.',
    resources: [
      {
        operation: 'ListStreams',
      },
      {
        operation: 'DescribeStreamSummary',
        raw: true,
      },
      {
        operation: 'ListShards',
        columns: ['ShardId', 'ParentShardId', 'AdjacentParentShardId'],
      },
      {
        operation: 'GetShardIterator',
        raw: true,
      },
      {
        operation: 'GetRecords',
        columns: ['SequenceNumber', 'PartitionKey', 'ApproximateArrivalTimestamp', 'Data'],
      },
      {
        operation: 'ListStreamConsumers',
        columns: ['ConsumerName', 'ConsumerStatus', 'ConsumerCreationTimestamp', 'ConsumerARN'],
      },
    ],
    actions: [
      'PutRecord',
      'PutRecords',
      'CreateStream',
      'RegisterStreamConsumer',
      'SplitShard',
      'MergeShards',
      'DeleteStream',
    ],
  },

  secretsmanager: {
    summary:
      'Secrets and their versions. `GetSecretValue` returns the secret material itself — it is a read, so it sits here rather than under Actions, and its response is shown in full.',
    resources: [
      {
        operation: 'ListSecrets',
        columns: [
          'Name',
          'Description',
          'RotationEnabled',
          'LastChangedDate',
          'LastAccessedDate',
          'CreatedDate',
          'ARN',
        ],
      },
      {
        operation: 'GetSecretValue',
        raw: true,
      },
      {
        operation: 'DescribeSecret',
        raw: true,
      },
      {
        operation: 'ListSecretVersionIds',
        columns: ['VersionId', 'CreatedDate', 'LastAccessedDate'],
      },
    ],
    actions: [
      'CreateSecret',
      'PutSecretValue',
      'UpdateSecret',
      'RotateSecret',
      'RestoreSecret',
      'DeleteSecret',
    ],
  },

  ssm: {
    summary:
      'Parameter Store, documents, and Run Command. `DescribeParameters` lists parameters without their values; `GetParameter` and `GetParametersByPath` return the values.',
    resources: [
      {
        operation: 'DescribeParameters',
        columns: ['Name', 'Type', 'Version', 'Tier', 'DataType', 'LastModifiedDate', 'Description'],
      },
      {
        operation: 'GetParametersByPath',
        columns: ['Name', 'Type', 'Value', 'Version', 'LastModifiedDate', 'ARN'],
      },
      {
        operation: 'GetParameter',
        raw: true,
      },
      {
        operation: 'ListDocuments',
        columns: [
          'Name',
          'DocumentType',
          'DocumentFormat',
          'Owner',
          'DocumentVersion',
          'TargetType',
        ],
      },
      {
        operation: 'ListCommands',
        columns: [
          'CommandId',
          'DocumentName',
          'Status',
          'RequestedDateTime',
          'TargetCount',
          'CompletedCount',
          'ErrorCount',
        ],
      },
      {
        operation: 'ListCommandInvocations',
        columns: [
          'CommandId',
          'InstanceId',
          'DocumentName',
          'Status',
          'StatusDetails',
          'RequestedDateTime',
        ],
      },
      {
        operation: 'DescribeInstanceInformation',
        columns: [
          'InstanceId',
          'Name',
          'PingStatus',
          'PlatformType',
          'PlatformName',
          'AgentVersion',
          'IPAddress',
          'LastPingDateTime',
        ],
      },
    ],
    actions: [
      'PutParameter',
      'GetParameters',
      'SendCommand',
      'StartAutomationExecution',
      'CreateDocument',
      'DeleteParameter',
      'DeleteDocument',
    ],
  },

  iam: {
    summary:
      'Roles, users, groups and policies. Roles come first because they are what a local pipeline actually references — a Firehose delivery role, a Glue crawler role — while users and access keys are usually incidental on an emulator.',
    resources: [
      {
        operation: 'ListRoles',
        columns: ['RoleName', 'Path', 'Description', 'MaxSessionDuration', 'CreateDate', 'Arn'],
      },
      {
        operation: 'GetRole',
        raw: true,
      },
      {
        operation: 'ListAttachedRolePolicies',
        columns: ['PolicyName', 'PolicyArn'],
      },
      {
        // Inline policies, which IAM returns as a list of names — the document
        // itself is one GetRolePolicy away.
        operation: 'ListRolePolicies',
      },
      {
        operation: 'ListPolicies',
        columns: [
          'PolicyName',
          'Path',
          'AttachmentCount',
          'IsAttachable',
          'DefaultVersionId',
          'CreateDate',
          'UpdateDate',
          'Arn',
        ],
      },
      {
        operation: 'ListUsers',
        columns: ['UserName', 'Path', 'UserId', 'CreateDate', 'PasswordLastUsed', 'Arn'],
      },
      {
        operation: 'ListGroups',
        columns: ['GroupName', 'Path', 'GroupId', 'CreateDate', 'Arn'],
      },
      {
        operation: 'ListAccessKeys',
        columns: ['UserName', 'AccessKeyId', 'Status', 'CreateDate'],
      },
      {
        operation: 'ListInstanceProfiles',
        columns: ['InstanceProfileName', 'Path', 'InstanceProfileId', 'CreateDate', 'Arn'],
      },
      {
        // SummaryMap is a map of quota counters, not a collection.
        operation: 'GetAccountSummary',
        raw: true,
      },
    ],
    actions: [
      'CreateRole',
      'PutRolePolicy',
      'AttachRolePolicy',
      'CreatePolicy',
      'CreateUser',
      'CreateAccessKey',
      'AddUserToGroup',
      'DeleteRole',
    ],
  },

  sns: {
    summary:
      'Topics, their subscriptions, and publishing. A topic carries its configuration in an attribute map rather than in modelled members, so `GetTopicAttributes` is shown in full instead of as a table.',
    resources: [
      {
        // The model's Topic structure has one member, TopicArn, so inference
        // already produces the only column there is.
        operation: 'ListTopics',
      },
      {
        operation: 'GetTopicAttributes',
        raw: true,
      },
      {
        operation: 'ListSubscriptionsByTopic',
        columns: ['SubscriptionArn', 'Protocol', 'Endpoint', 'Owner', 'TopicArn'],
      },
      {
        operation: 'ListSubscriptions',
        columns: ['SubscriptionArn', 'Protocol', 'Endpoint', 'Owner', 'TopicArn'],
      },
      {
        operation: 'GetSubscriptionAttributes',
        raw: true,
      },
    ],
    actions: [
      'Publish',
      'PublishBatch',
      'Subscribe',
      'CreateTopic',
      'SetTopicAttributes',
      'SetSubscriptionAttributes',
      'Unsubscribe',
      'DeleteTopic',
    ],
  },

  logs: {
    summary:
      'Log groups, their streams, and the events in one stream. The Tail tab follows a whole log group instead, across every stream at once.',
    resources: [
      {
        operation: 'DescribeLogGroups',
        columns: [
          'logGroupName',
          'logGroupClass',
          'retentionInDays',
          'storedBytes',
          'metricFilterCount',
          'creationTime',
          'arn',
        ],
      },
      {
        operation: 'DescribeLogStreams',
        columns: [
          'logStreamName',
          'creationTime',
          'firstEventTimestamp',
          'lastEventTimestamp',
          'lastIngestionTime',
          'arn',
        ],
      },
      {
        // GetLogEvents pages on nextForwardToken/nextBackwardToken rather than
        // a modelled paginator, so the columns are curated rather than guessed.
        operation: 'GetLogEvents',
        columns: ['timestamp', 'message', 'ingestionTime'],
      },
      {
        operation: 'DescribeSubscriptionFilters',
        columns: [
          'filterName',
          'logGroupName',
          'filterPattern',
          'destinationArn',
          'roleArn',
          'distribution',
          'creationTime',
        ],
      },
      {
        operation: 'DescribeMetricFilters',
        columns: ['filterName', 'logGroupName', 'filterPattern', 'creationTime'],
      },
      {
        operation: 'DescribeQueries',
        columns: ['queryId', 'status', 'logGroupName', 'createTime', 'queryString'],
      },
    ],
    actions: [
      'FilterLogEvents',
      'PutLogEvents',
      'CreateLogGroup',
      'CreateLogStream',
      'PutRetentionPolicy',
      'PutSubscriptionFilter',
      'StartQuery',
      'DeleteLogGroup',
    ],
  },

  kms: {
    summary:
      'Keys, their aliases, policies, rotation state and grants. `ListKeys` returns only ids — `DescribeKey` is what carries a key’s state, spec and usage.',
    resources: [
      {
        operation: 'ListKeys',
        columns: ['KeyId', 'KeyArn'],
      },
      {
        operation: 'DescribeKey',
        raw: true,
      },
      {
        operation: 'ListAliases',
        columns: ['AliasName', 'TargetKeyId', 'CreationDate', 'LastUpdatedDate', 'AliasArn'],
      },
      {
        operation: 'GetKeyRotationStatus',
        raw: true,
      },
      {
        operation: 'ListKeyRotations',
        columns: [
          'RotationDate',
          'RotationType',
          'KeyMaterialId',
          'KeyMaterialState',
          'ImportState',
          'ExpirationModel',
        ],
      },
      {
        operation: 'ListKeyPolicies',
      },
      {
        operation: 'GetKeyPolicy',
        raw: true,
      },
      {
        operation: 'ListGrants',
        columns: [
          'GrantId',
          'Name',
          'GranteePrincipal',
          'RetiringPrincipal',
          'IssuingAccount',
          'CreationDate',
        ],
      },
      {
        operation: 'ListResourceTags',
        columns: ['TagKey', 'TagValue'],
      },
    ],
    actions: [
      'CreateKey',
      'CreateAlias',
      'Encrypt',
      'Decrypt',
      'GenerateDataKey',
      'CreateGrant',
      'EnableKeyRotation',
      'ScheduleKeyDeletion',
    ],
  },
};

export function profileFor(serviceId: string): ServiceProfile | undefined {
  return serviceProfiles[serviceId];
}

function viewFor(serviceId: string, operationName: string | undefined): ResourceView | undefined {
  if (!operationName) return undefined;
  return serviceProfiles[serviceId]?.resources.find(
    candidate => candidate.operation === operationName,
  );
}

/** The curated column order for one operation, if the service has a profile. */
export function preferredColumns(
  serviceId: string,
  operationName: string | undefined,
): string[] | undefined {
  return viewFor(serviceId, operationName)?.columns;
}

/** Whether a profile says this read describes one thing rather than listing many. */
export function rendersRawResult(serviceId: string, operationName: string | undefined): boolean {
  return viewFor(serviceId, operationName)?.raw === true;
}
