import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--mobile')) {
  throw new Error('Usage: npm run play:expanded -- [--mobile]');
}
const mobile = args.includes('--mobile');
process.env.SCENARIO_PATH = fileURLToPath(
  new URL('../scenarios/playtest/warehouse-expanded-r1.json', import.meta.url),
);
process.env.AI_MODE = 'live';
process.env.HOST = '127.0.0.1';
process.env.PORT = process.env.PORT || '4311';
console.log('暗い倉庫・拡充版 r1（試遊候補） / 合言葉は .env.local の APP_PASSPHRASE');
if (mobile) {
  await import('./mobile.js');
} else {
  const port = process.env.PORT;
  process.env.PUBLIC_APP_URL = '';
  process.env.APP_ALLOWED_HOSTS = `127.0.0.1:${port},localhost:${port}`;
  process.env.APP_ALLOWED_ORIGINS = `http://127.0.0.1:${port},http://localhost:${port}`;
  await import('../apps/server/index.js');
}
