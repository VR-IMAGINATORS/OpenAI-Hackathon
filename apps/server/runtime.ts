import { createHostedApp } from './app.js';
import type { HostedConfig } from './config.js';
import { CodexPlayerSessions } from '../../tools/codex-poc/player-sessions.js';

export function createServerRuntime(config: HostedConfig) {
  if (config.ai.provider !== 'codex') return createHostedApp(config);
  const players = new CodexPlayerSessions({
    model: config.ai.gameModel,
    capacity: config.capacity,
    reportLogin: ({ stage, code }) => console.log(`Codexログイン: failed / ${stage} / ${code}`),
    report: ({ status, durationMs }) => console.log(`Codex判断: ${status} / ${durationMs}ms`),
    reportVoice: ({ status, code }) =>
      console.log(`Codex音声: ${status}${code ? ' / ' + code : ''}`),
    reportImage: ({ status, code, durationMs }) =>
      console.log(`Codex画像: ${status} / ${durationMs}ms${code ? ' / ' + code : ''}`),
  });
  return createHostedApp(config, { playerJudgments: players, transport: players.transport });
}
