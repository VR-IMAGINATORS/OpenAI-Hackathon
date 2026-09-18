import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveConnection } from '../apps/web/src/live.js';

for (const serverStarted of [false, true]) {
  test(`voice initialization and playback with serverStarted=${serverStarted}`, async (t) => {
    const restore = (name: string, value: unknown) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
      t.after(() => {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      });
    };
    let pauses = 0,
      peerClosed = 0,
      channelClosed = 0,
      stops = 0;
    const track = {
      enabled: true,
      stop() {
        stops++;
      },
    };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    class FakeAudio extends EventTarget {
      autoplay = false;
      srcObject: unknown = null;
      setAttribute() {}
      async play() {}
      pause() {
        pauses++;
      }
    }
    const sent: unknown[] = [];
    const channel = {
      readyState: 'open',
      onmessage: null as null | ((event: { data: string }) => void),
      send(data: string) {
        sent.push(JSON.parse(data));
      },
      close() {
        channelClosed++;
      },
    };
    class FakePeer {
      iceGatheringState = 'complete';
      addTrack() {}
      createDataChannel() {
        return channel;
      }
      async createOffer() {
        return { type: 'offer', sdp: 'offer' };
      }
      localDescription = { sdp: 'offer' };
      async setLocalDescription() {}
      async setRemoteDescription() {
        if (!serverStarted)
          channel.onmessage!({ data: JSON.stringify({ type: 'session.started' }) });
      }
      close() {
        peerClosed++;
      }
    }
    restore('Audio', FakeAudio);
    restore('RTCPeerConnection', FakePeer);
    restore('document', new EventTarget());
    restore('window', {
      isSecureContext: true,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    const instruction = {
      type: 'session.instructions.append',
      event_id: 'init',
      delegation_id: null,
      content: 'Game instructions',
    };
    restore(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            sdp: 'answer',
            generation: 1,
            initialization: [instruction],
            sessionStarted: serverStarted,
            ...(serverStarted ? { protocol: 'codex-frameless' } : {}),
          }),
        ),
    );
    restore('navigator', { mediaDevices: { getUserMedia: async () => stream } });
    const events: unknown[] = [];
    const errors: string[] = [];
    const connection = new LiveConnection({
      onState() {},
      onError(message) {
        errors.push(message);
      },
      onPlaybackBlocked() {},
      onEvent(event) {
        events.push(event);
      },
    });
    t.after(() => connection.close());
    await connection.prepare();
    assert.equal(connection.send([]), false);
    await connection.connect({ playId: 'play', clientId: 'client', controlEpoch: 1 });
    const wireInstruction = serverStarted
      ? {
          type: 'session.context.append',
          content: [{ type: 'input_text', text: instruction.content }],
        }
      : instruction;
    assert.deepEqual(sent, [wireInstruction]);
    channel.onmessage!({ data: JSON.stringify({ type: 'session.started' }) });
    assert.deepEqual(sent, [wireInstruction]); // Repeated started never replays initialization.
    sent.length = 0;
    connection.stopInput();
    connection.stopInput();
    assert.equal(track.enabled, false);
    assert.equal(stops, 1);
    assert.equal(pauses, 0);
    assert.equal(peerClosed, 0);
    assert.equal(channelClosed, 0);
    assert.deepEqual(sent, []);
    for (const type of [
      'session.input_transcript.delta',
      'session.delegation.created',
      'session.output_transcript.delta',
    ])
      channel.onmessage!({ data: JSON.stringify({ type }) });
    assert.deepEqual(events, [{ type: 'session.output_transcript.delta' }]);
    assert.equal(
      connection.send([
        {
          type: 'session.commentary.append',
          event_id: 'final',
          delegation_id: null,
          content: 'Goodbye',
        },
      ]),
      true,
    );
    assert.equal(sent.length, 1);
    await connection.resumeAudio();
    assert.equal(pauses, 0);
    channel.onmessage!({
      data: JSON.stringify({
        type: 'error',
        error: { message: 'Invalid field session.example Bearer secret-token' },
      }),
    });
    assert.equal(connection.state, 'failed');
    assert.match(errors[0], /Invalid field session.example/);
    assert.doesNotMatch(errors[0], /secret-token/);
    assert.equal(pauses, 1);
    assert.equal(peerClosed, 1);
    assert.equal(channelClosed, 1);
  });
}
