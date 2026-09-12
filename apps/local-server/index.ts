import { createLocalApp } from './app.js';
import { loadLocalConfig } from './config.js';
import { configureServer, installShutdown } from '../../packages/server/http.js';

try {
  const config = loadLocalConfig();
  const server = createLocalApp(config).listen(config.port, config.host, () => {
    console.log('Local foundation ready on port ' + config.port + ' (mock only)');
  });
  configureServer(server);
  installShutdown(server);
  server.on('error', () => { console.error('Local server could not start. Check its configuration and port.'); process.exitCode = 1; });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local server configuration is invalid.');
  process.exitCode = 1;
}
