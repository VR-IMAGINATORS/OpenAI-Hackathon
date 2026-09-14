export interface OperationalEvent {
  event: string;
  correlationId?: string;
  version?: string;
  durationMs?: number;
  errorCode?: string;
  count?: number;
  clearedCount?: number;
  actionCount?: number;
  failedActionCount?: number;
  validationFields?: string;
}

/** Only explicitly selected operational fields may reach stdout. */
export function operationalLog(event: OperationalEvent, write = console.log): void {
  const safe: Record<string, string | number> = { event: event.event };
  for (const key of ['correlationId', 'version', 'errorCode', 'validationFields'] as const) {
    if (event[key] !== undefined) safe[key] = event[key]!;
  }
  for (const key of [
    'durationMs',
    'count',
    'clearedCount',
    'actionCount',
    'failedActionCount',
  ] as const) {
    if (Number.isFinite(event[key])) safe[key] = event[key]!;
  }
  write(JSON.stringify(safe));
}
