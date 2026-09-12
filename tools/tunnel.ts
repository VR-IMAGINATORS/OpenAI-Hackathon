import { spawn, type ChildProcess } from 'node:child_process';
export function publicOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('PUBLIC_GAME_URLはHTTPSのURLにしてください。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_GAME_URLは認証情報やパスのないHTTPS originにしてください。');
  return url.origin;
}
export function parseTunnelUrl(line: string): string | undefined {
  const match = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s|]|$)/.exec(line);
  return match ? publicOrigin(match[0]) : undefined;
}
export async function stopTunnel(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
export function startTunnel(port: number, onExit: () => void, executable = 'cloudflared'): Promise<{ origin: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['tunnel', '--url', 'http://127.0.0.1:' + port, '--no-autoupdate'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let resolved = false;
    let buffer = '';
    const timer = setTimeout(() => { void stopTunnel(child); reject(new Error('トンネルの準備が時間内に完了しませんでした。回線とcloudflaredの設定を確認してください。')); }, 45_000);
    const read = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString('utf8')).slice(-16_384);
      const origin = parseTunnelUrl(buffer);
      if (origin && !resolved) { resolved = true; clearTimeout(timer); resolve({ origin, child }); }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('error', () => { clearTimeout(timer); reject(new Error('cloudflaredを起動できません。インストール後に再実行してください。')); });
    child.once('exit', () => { clearTimeout(timer); if (resolved) onExit(); else reject(new Error('トンネルが終了しました。cloudflaredの設定とネットワークを確認してください。')); });
  });
}
