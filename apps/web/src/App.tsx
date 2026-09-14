import { useEffect, useState } from 'react';
import type { HostedBootstrap } from '../../../packages/shared/api.js';
import { playRequest } from './play-api.js';
import JoinScreen from './JoinScreen.js';
export default function App() {
  const [bootstrap, setBootstrap] = useState<HostedBootstrap | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void playRequest<HostedBootstrap>('/api/bootstrap')
      .then(setBootstrap)
      .catch(() => setError('Unable to load the page. Please reload.'));
  }, []);
  return bootstrap ? (
    <JoinScreen bootstrap={bootstrap} />
  ) : (
    <main className="play-shell">
      <p role="status">{error || 'Loading…'}</p>
    </main>
  );
}
