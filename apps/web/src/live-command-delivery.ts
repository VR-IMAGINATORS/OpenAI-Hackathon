import type { CoreLiveCommand } from '../../../packages/shared/conversation.js';

/** Server epoch plus local elapsed time avoids relying on a phone's wall clock. */
export function discardWarning(
  command: CoreLiveCommand,
  ended: boolean,
  serverNow: number,
  receivedAt: number,
  now: number,
): boolean {
  if (command.noticeKind !== 'time-warning') return false;
  return (
    ended ||
    command.validUntil === undefined ||
    !Number.isFinite(serverNow) ||
    serverNow + Math.max(0, now - receivedAt) >= command.validUntil
  );
}
