import type { CodexLoginStatus } from '../../packages/shared/api.js';

export type GameResponder = (
  body: unknown,
  signal: AbortSignal | undefined,
  playId: string,
) => Promise<unknown>;

/** All owner/play identities are supplied by the server, never request bodies. */
export interface PlayerJudgments {
  status(owner: string): CodexLoginStatus;
  start(owner: string): CodexLoginStatus;
  logout(owner: string): Promise<void>;
  bind(owner: string, playId: string): void;
  release(playId: string): Promise<void>;
  respond: GameResponder;
  sweep(): Promise<void>;
  dispose(): Promise<void>;
}
