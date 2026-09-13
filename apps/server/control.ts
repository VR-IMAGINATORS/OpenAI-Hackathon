export class SessionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

export interface Controller {
  clientId: string;
  controllerEpoch: number;
  leaseUntil: number;
}

export function assertController(control: Controller, clientId: string, epoch: number): void {
  if (control.clientId !== clientId || control.controllerEpoch !== epoch) {
    throw new SessionError('CONTROL_BUSY', 409);
  }
}

/** A takeover changes identity immediately, before any old voice cleanup awaits. */
export function claimController(
  control: Controller,
  clientId: string,
  takeover: boolean,
  now: number,
): boolean {
  if (control.clientId === clientId) return false;
  if (!takeover && now < control.leaseUntil) throw new SessionError('CONTROL_BUSY', 409);
  control.clientId = clientId;
  control.controllerEpoch += 1;
  control.leaseUntil = now + 30_000;
  return true;
}
