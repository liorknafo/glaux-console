/**
 * The Athena query lifecycle, as the service model describes it.
 *
 * Every field here comes from the `athena` catalog chunk — `QueryExecutionStatus`,
 * `AthenaError`, `QueryExecutionStatistics`, `ResultSet` — not from an assumption
 * about how any particular emulator answers.
 */

export type QueryState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export const TERMINAL_STATES: QueryState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

export function isTerminal(state: QueryState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface AthenaErrorDetail {
  /** 1 System, 2 User, 3 Other — see `AthenaError.ErrorCategory` in the model. */
  category?: number;
  type?: number;
  retryable?: boolean;
  message?: string;
}

export interface QueryStatistics {
  dataScannedInBytes?: number;
  engineExecutionTimeInMillis?: number;
  totalExecutionTimeInMillis?: number;
  queryQueueTimeInMillis?: number;
  queryPlanningTimeInMillis?: number;
  serviceProcessingTimeInMillis?: number;
}

export interface QueryExecutionSnapshot {
  id: string;
  state: QueryState;
  stateChangeReason?: string;
  athenaError?: AthenaErrorDetail;
  statistics?: QueryStatistics;
  statementType?: string;
  query?: string;
  submittedAt?: string;
  completedAt?: string;
  outputLocation?: string;
}

/** The editor's per-endpoint execution context, sent with StartQueryExecution. */
export interface QueryContext {
  catalog?: string;
  database?: string;
  workGroup?: string;
  outputLocation?: string;
}

export interface ResultColumn {
  name: string;
  label: string;
  type?: string;
}

export interface ResultPage {
  columns: ResultColumn[];
  rows: (string | undefined)[][];
  nextToken?: string;
  updateCount?: number;
}
