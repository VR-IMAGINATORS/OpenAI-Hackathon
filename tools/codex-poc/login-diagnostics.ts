/** Only fixed labels leave the RPC boundary. Never return upstream text or credentials. */
export function loginRpcFailure(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  const text = message.slice(0, 32768);
  if (/certificate|UnknownIssuer|CertNotValid|TLS|SSL/i.test(text)) return 'LOGIN_TLS_ERROR';
  if (/\b403\b|forbidden|access.denied/i.test(text)) return 'LOGIN_HTTP_403';
  if (/\b429\b|rate.limit|too many requests/i.test(text)) return 'LOGIN_RATE_LIMIT';
  if (/timed? ?out|timeout/i.test(text)) return 'LOGIN_NETWORK_TIMEOUT';
  if (/error sending request|connect|DNS|resolve.*host|network/i.test(text))
    return 'LOGIN_NETWORK_ERROR';
  if (/device.*(?:disabled|not enabled)/i.test(text)) return 'LOGIN_DEVICE_DISABLED';
  return undefined;
}
