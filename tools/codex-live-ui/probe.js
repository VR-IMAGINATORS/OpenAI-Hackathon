const el = (id) => document.getElementById(id);
const labels = {
  disconnected: '未接続',
  login: 'ログイン準備中',
  pending: 'OpenAIでの承認待ち',
  ready: '認証済み。マイクを接続できます',
  starting: '音声接続を準備中',
  connected: 'SDP交換完了。実際の音声を確認してください',
  stopping: '終了処理中',
  closed: '終了しました',
  failed: '接続に失敗しました',
};
let view = { state: 'disconnected' },
  busy = false,
  peer,
  stream,
  channel,
  generation = 0,
  inBytes = 0;
const types = new Map();
async function api(path, body) {
  const response = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(40000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.code || 'REQUEST_FAILED');
  return result;
}
function render() {
  el('state').textContent = labels[view.state] || view.state;
  el('login').disabled =
    busy ||
    !['disconnected', 'closed', 'failed'].includes(view.state) ||
    (view.state === 'failed' && !view.processClosed);
  el('start').disabled = busy || view.state !== 'ready';
  el('speech').disabled = busy || view.state !== 'connected';
  el('play').disabled = !peer;
  el('stop').disabled = ['disconnected', 'closed'].includes(view.state) || view.processClosed;
  el('approval').hidden = view.state !== 'pending';
  el('code').textContent = view.userCode || '';
  if (view.verificationUrl) el('verify').href = view.verificationUrl;
  else el('verify').removeAttribute('href');
  el('closed').textContent =
    `音声終了通知: ${view.stopConfirmed === true ? '確認済み' : view.stopConfirmed === false ? '未確認' : '—'} / 専用プロセス破棄: ${view.processClosed ? '確認済み' : '未確認'}`;
  el('remaining').textContent = view.deadline
    ? Math.max(0, Math.ceil((view.deadline - Date.now()) / 1000)) + ' 秒'
    : '—';
  if (view.errorCode)
    el('error').textContent =
      view.errorCode +
      (view.diagnostic ? ' / 診断: ' + view.diagnostic : '') +
      ' / 診断版: ' +
      (view.diagnosticRevision || '旧版') +
      (view.startupDetail ? ' / 接続エラー詳細（伏字あり）: ' + view.startupDetail : '') +
      '（この表示を共有してください。原因はまだ確定していません）';
}
function closeMedia() {
  generation++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = undefined;
  channel?.close();
  channel = undefined;
  peer?.close();
  peer = undefined;
  el('audio').pause();
  el('audio').srcObject = null;
}
async function action(fn) {
  if (busy) return;
  busy = true;
  el('error').textContent = '';
  render();
  try {
    await fn();
  } catch (e) {
    el('error').textContent = e.message || '接続に失敗しました';
  } finally {
    busy = false;
    render();
  }
}
el('login').onclick = () =>
  action(async () => {
    await api('auth', {});
    view = await api('login', {});
    types.clear();
    inBytes = 0;
    el('events').textContent = '未受信';
    el('bytes').textContent = '0 bytes';
    el('model').textContent = '未報告';
    el('peer').textContent = '未接続';
  });
el('start').onclick = () =>
  action(async () => {
    const g = ++generation;
    try {
      const input = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (g !== generation) {
        input.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = input;
      const p = (peer = new RTCPeerConnection());
      input.getTracks().forEach((t) => p.addTrack(t, input));
      p.ontrack = (e) => {
        if (g !== generation) return;
        el('audio').srcObject = e.streams[0] || new MediaStream([e.track]);
        void el('audio')
          .play()
          .catch(() => {
            el('error').textContent = '「音声を再生」を押してください';
          });
      };
      p.onconnectionstatechange = () => {
        if (g === generation) el('peer').textContent = p.connectionState;
      };
      const c = (channel = p.createDataChannel('oai-events'));
      c.onmessage = (e) => {
        if (g !== generation || typeof e.data !== 'string' || e.data.length > 32768) return;
        try {
          const m = JSON.parse(e.data);
          if (typeof m.type !== 'string' || !/^[-a-zA-Z0-9_.]{1,100}$/.test(m.type)) return;
          if (types.has(m.type) || types.size < 32) types.set(m.type, (types.get(m.type) || 0) + 1);
          el('events').textContent = [...types].map(([type, n]) => type + ': ' + n).join('\n');
          const model = m.session?.model;
          if (typeof model === 'string' && /^[-a-zA-Z0-9_.]{1,100}$/.test(model)) {
            el('model').textContent = model;
            if (!/^gpt-live-1(?:-|$)/.test(model)) {
              el('error').textContent =
                'MODEL_MISMATCH: GPT-Live以外のモデルが報告されたため停止しました。';
              closeMedia();
              void api('stop', {}).catch(() => {});
            }
          }
        } catch {}
      };
      await p.setLocalDescription(await p.createOffer());
      await new Promise((yes, no) => {
        if (p.iceGatheringState === 'complete') return yes();
        const timer = setTimeout(() => {
          p.removeEventListener('icegatheringstatechange', check);
          no(new Error('ICE_TIMEOUT'));
        }, 10000);
        function check() {
          if (p.iceGatheringState === 'complete') {
            clearTimeout(timer);
            p.removeEventListener('icegatheringstatechange', check);
            yes();
          }
        }
        p.addEventListener('icegatheringstatechange', check);
      });
      if (g !== generation) return;
      const answer = await api('start', { sdp: p.localDescription.sdp });
      if (g !== generation) return;
      await p.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch (e) {
      closeMedia();
      await api('stop', {})
        .then((status) => {
          view = status;
        })
        .catch(() => {});
      throw e;
    }
  });
el('speech').onclick = () =>
  action(async () => {
    await api('speech', {});
  });
el('play').onclick = () => {
  void el('audio')
    .play()
    .catch(() => {
      el('error').textContent = '再生できません。音声接続を確認してください';
    });
};
el('stop').onclick = async () => {
  closeMedia();
  try {
    view = await api('stop', {});
    render();
  } catch (e) {
    el('error').textContent = e.message;
  }
};
async function poll() {
  try {
    view = await api('status');
    if (['closed', 'failed', 'stopping', 'disconnected'].includes(view.state) && peer) closeMedia();
    render();
    if (peer) {
      const stats = await peer.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio'))
          inBytes = Math.max(inBytes, r.bytesReceived || 0);
      });
      el('bytes').textContent = inBytes + ' bytes';
    }
  } catch (e) {
    if (e.message !== 'AUTH_REQUIRED') {
      el('error').textContent = e.message;
      closeMedia();
    }
  }
  setTimeout(poll, 1000);
}
window.addEventListener('pagehide', () => {
  closeMedia();
  void fetch('/api/stop', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    keepalive: true,
  }).catch(() => {});
});
render();
void poll();
