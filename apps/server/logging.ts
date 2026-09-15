export interface OperationalEvent {
  event: string;
  correlationId?: string;
  version?: string;
  durationMs?: number;
  remainingMs?: number;
  errorCode?: string;
  count?: number;
  clearedCount?: number;
  actionCount?: number;
  failedActionCount?: number;
  validationFields?: string;
  invalidSourceCount?: number;
  actionSourceMixupCount?: number;
  eventSourceMixupCount?: number;
  evidenceRecordCount?: number;
  evidenceBytes?: number;
  quoteMismatchCount?: number;
  route?: string;
  method?: string;
  stage?: string;
}

/** Only explicitly selected operational fields may reach stdout. */
export function operationalLog(event: OperationalEvent, write = console.log): void {
  const safe: Record<string, string | number> = { event: event.event };
  for (const key of [
    'correlationId', 'version', 'errorCode', 'validationFields', 'route', 'method', 'stage',
  ] as const) {
    if (event[key] !== undefined) safe[key] = event[key]!;
  }
  for (const key of [
    'durationMs',
    'remainingMs',
    'count',
    'clearedCount',
    'actionCount',
    'failedActionCount',
    'invalidSourceCount',
    'actionSourceMixupCount',
    'eventSourceMixupCount',
    'evidenceRecordCount',
    'evidenceBytes',
    'quoteMismatchCount',
  ] as const) {
    if (Number.isFinite(event[key])) safe[key] = event[key]!;
  }
  write(JSON.stringify(safe));
}
