import { createRelayApp } from './app.js';
import { loadRelayConfig } from './config.js';
import { configureServer } from '../../packages/server/http.js';
try {
  const config = loadRelayConfig();
  const app = createRelayApp(config);
  const server = app.listen(config.port, config.host, () =>
    console.log(
      (config.mode === 'live' ? 'Live' : 'Mock') +
        ' relay ready on port ' +
        config.port +
        ' (auth: ' +
        config.authMode +
        ')',
    ),
  );
  configureServer(server);
  server.timeout = 35000;
  server.requestTimeout = 35000;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    server.closeAllConnections();
    const timer = setTimeout(() => process.exit(1), 95000);
    timer.unref();
    await app.locals.relayShutdown?.();
    clearTimeout(timer);
    if (app.locals.relayUnconfirmed?.())
      console.error('Live session termination remains unconfirmed; operator action required.');
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  server.on('error', () => {
    console.error('Relay could not start. Check configuration and port.');
    process.exitCode = 1;
  });
} catch {
  console.error('Relay configuration is invalid. Check .env.relay.local and documented variables.');
  process.exitCode = 1;
}
