import { createRelayApp } from './app.js';
import { loadRelayConfig } from './config.js';
import { configureServer, installShutdown } from '../../packages/server/http.js';

try {
  const config = loadRelayConfig();
  const server = createRelayApp(config).listen(config.port, config.host, () => {
    console.log('Mock relay ready on port ' + config.port + ' (auth: ' + config.authMode + ')');
  });
  configureServer(server);
  installShutdown(server);
  server.on('error', () => { console.error('Mock relay could not start. Check its configuration and port.'); process.exitCode = 1; });
} catch {
  console.error('Mock relay configuration is invalid. Check .env.relay.local and the documented variables.');
  process.exitCode = 1;
}
