import type { PublicScenario } from './scenario.js';
export type AuthMode = 'required' | 'none';
export interface RelayHealth { service: 'relay'; mode: 'mock'; authMode: AuthMode }
export interface Bootstrap {
  app: { name: string; stage: 'foundation' };
  scenario: PublicScenario;
  relay: { reachable: boolean; authMode: AuthMode | null; mode: 'mock' | null };
}
export interface ConnectionResult {
  kind: 'mock'; message: string; path: string[]; scenarioId: string;
}
export interface ApiError { error: { code: string; message: string } }
