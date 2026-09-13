import type { PublicScenario } from './scenario.js';
export interface ApiError {
  error: { code: string; message: string };
}
import type { PublicGameState, LiveCommand } from './game.js';
export type PlayLifecycle =
  | 'connecting'
  | 'active'
  | 'recovering'
  | 'closing'
  | 'terminal'
  | 'quarantined';
export interface HostedBootstrap {
  app: { name: string; stage: 'hosted-multiplayer' };
  scenario: PublicScenario;
  auth: { required: true };
  ai: { mode: 'mock' | 'live' };
}
export interface HostedSession {
  authenticated: true;
  playId: string | null;
  lifecycle: PlayLifecycle | null;
  expiresAt: string | null;
}
export interface HostedPlayState {
  playId?: string;
  state: PublicGameState;
  lifecycle: PlayLifecycle;
  expiresAt: string;
  recoveryExpiresAt: string | null;
}
export interface CreatedPlay extends HostedPlayState {
  playId: string;
  controlEpoch: number;
}
export interface ControlledPlay extends HostedPlayState {
  controlEpoch: number;
}
export interface HostedPlayUpdate extends HostedPlayState {
  commands: LiveCommand[];
}
export interface PlayControl {
  playId: string;
  clientId: string;
  controlEpoch: number;
}
