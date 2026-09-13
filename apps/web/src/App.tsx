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
      .catch(() => setError('画面を読み込めません。再読み込みしてください。'));
  }, []);
  return bootstrap ? (
    <JoinScreen bootstrap={bootstrap} />
  ) : (
    <main className="play-shell">
      <p role="status">{error || '読み込んでいます…'}</p>
    </main>
  );
}
