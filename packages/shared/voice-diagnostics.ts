/** Return only fixed diagnostic labels, never upstream text, URLs or credentials. */
export function voiceDiagnostic(message: unknown): string {
  if (typeof message !== 'string') return 'UNKNOWN';
  const text = message.slice(0, 32768);
  const status = text.match(
    /(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:\s+code)?[\s:="']+)([45]\d{2})\b/i,
  )?.[1];
  const rules: [string, RegExp][] = [
    [
      'MODEL_NOT_FOUND',
      /\bmodel_not_found\b|model.{0,80}(?:does not exist|not found|not supported|unsupported)/i,
    ],
    ['AUTHENTICATION', /\b(?:unauthorized|invalid_api_key|invalid_token|authentication_error)\b/i],
    [
      'ACCESS_DENIED',
      /\b(?:forbidden|permission_denied|insufficient_permissions|access_denied)\b|do not have access/i,
    ],
    ['RATE_LIMIT', /\b(?:rate_limit_exceeded|insufficient_quota)\b|rate limit|too many requests/i],
    [
      'INVALID_REQUEST',
      /\b(?:invalid_request_error|invalid_parameter|unknown_parameter)\b|unsupported (?:parameter|version|transport)|is not allowed for|Invalid value:.*Supported values are:/i,
    ],
    ['SDP', /\bSDP\b/i],
    [
      'NETWORK',
      /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\b|connection (?:reset|refused)|certificate|TLS|DNS/i,
    ],
    ['TIMEOUT', /timed? ?out|timeout/i],
  ];
  const label = rules.find(([, pattern]) => pattern.test(text))?.[0] ?? 'UNKNOWN';
  return status ? `HTTP_${status}/${label}` : label;
}

/** Error message only. Keep technical wording, redact common credential/PII formats.
 * Used by the owning browser and the local Codex launcher; never pass event payloads.
 */
export function voiceStartupDetail(message: unknown): string {
  if (typeof message !== 'string') return 'No string error message';
  return message
    .slice(0, 16384)
    .replace(/data:[^\s"'<>]+/gi, '[DATA]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"'}]+/gi, '[AUTH]')
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]+|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g,
      '[TOKEN]',
    )
    .replace(
      /(["']?(?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
    .replace(/\b[a-zA-Z]:[\\/][^\r\n"'<>]+/g, '[PATH]')
    .replace(/(?:\/Users\/|\/home\/|\/tmp\/)[^\s"'<>]+/g, '[PATH]')
    .replace(/\bv=0(?:\\r\\n|\r?\n)[\s\S]*/g, '[SDP]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 1600);
}
