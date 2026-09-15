import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveConnection } from '../apps/web/src/live.js';

test('stopping input preserves remote playback and command delivery until explicit close', async (t) => {
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
    async setLocalDescription() {}
    close() {
      peerClosed++;
    }
  }
  restore('Audio', FakeAudio);
  restore('RTCPeerConnection', FakePeer);
  restore('document', new EventTarget());
  restore('window', { isSecureContext: true });
  restore('navigator', { mediaDevices: { getUserMedia: async () => stream } });
  const events: unknown[] = [];
  const connection = new LiveConnection({
    onState() {},
    onPlaybackBlocked() {},
    onEvent(event) {
      events.push(event);
    },
  });
  t.after(() => connection.close());
  await connection.prepare();
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
  connection.close();
  assert.equal(pauses, 1);
  assert.equal(peerClosed, 1);
  assert.equal(channelClosed, 1);
});
