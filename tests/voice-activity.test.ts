import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ActivityDetector,
  VoiceActivityMonitor,
  type VoiceActivitySnapshot,
} from '../apps/web/src/voice-activity.js';

test('activity requires 800ms continuous silence and hysteresis avoids breath gaps', () => {
  const detector = new ActivityDetector();
  assert.equal(detector.sample(0.03, 0), 'active');
  assert.equal(detector.sample(0.015, 50), 'active');
  for (let time = 100; time < 900; time += 50) assert.equal(detector.sample(0, time), 'active');
  assert.equal(detector.sample(0, 900), 'quiet');
  assert.equal(detector.sample(0.015, 950), 'quiet');
  assert.equal(detector.sample(0.025, 1000), 'active');
});

test('missing samples, invalid RMS and unknown never count as established silence', () => {
  const detector = new ActivityDetector();
  for (let time = 0; time <= 800; time += 50) detector.sample(0, time);
  assert.equal(detector.sample(0, 1200), 'unknown');
  assert.equal(detector.sample(Number.NaN, 1250), 'unknown');
  assert.equal(detector.sample(null, 1300), 'unknown');
  for (let time = 1350; time < 2150; time += 50) assert.equal(detector.sample(0, time), 'unknown');
  assert.equal(detector.sample(0, 2150), 'quiet');
});

test('monitor reports activity only, throttles, resets on unknown and frees analysis without playback', async (t) => {
  let now = 0;
  let tick: (() => void) | null = null;
  let cleared = 0;
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = 'visible';
  const restore = (name: string, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  };
  const nodes: FakeNode[] = [];
  class FakeNode {
    disconnected = false;
    fftSize = 1024;
    rms = 0;
    connect(target: unknown) {
      assert.ok(target instanceof FakeNode);
    }
    disconnect() {
      this.disconnected = true;
    }
    getFloatTimeDomainData(samples: Float32Array) {
      samples.fill(this.rms);
    }
  }
  class FakeContext {
    static current: FakeContext;
    state = 'suspended';
    closed = false;
    constructor() {
      FakeContext.current = this;
    }
    async resume() {
      this.state = 'running';
    }
    async close() {
      this.closed = true;
      this.state = 'closed';
    }
    get destination(): never {
      throw new Error('Analysis must never connect to playback');
    }
    createMediaStreamSource() {
      const node = new FakeNode();
      nodes.push(node);
      return node;
    }
    createAnalyser() {
      const node = new FakeNode();
      nodes.push(node);
      return node;
    }
  }
  restore('document', doc);
  restore('AudioContext', FakeContext);
  restore('performance', { now: () => now });
  restore('setInterval', (fn: () => void, delay: number) => {
    assert.equal(delay, 50);
    tick = fn;
    return 1;
  });
  restore('clearInterval', () => {
    cleared++;
    tick = null;
  });
  const track = {
    enabled: true,
    muted: false,
    readyState: 'live',
    stop: () => assert.fail('Monitor must not stop owned tracks'),
  };
  const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
  const reports: VoiceActivitySnapshot[] = [];
  const monitor = new VoiceActivityMonitor((value) => reports.push(value));
  t.after(() => monitor.close());
  const advance = (ms: number) => {
    for (let i = 0; i < ms; i += 50) {
      now += 50;
      tick?.();
    }
  };
  monitor.setInput(stream);
  monitor.setOutput(stream);
  monitor.setGeneration(1);
  monitor.setPlaybackReady(true);
  advance(50);
  assert.equal(reports.at(-1)?.output, 'unknown');
  await monitor.resume();
  advance(1000);
  assert.equal(reports.at(-1)?.input, 'quiet');
  assert.equal(reports.at(-1)?.output, 'quiet');
  nodes[1]!.rms = 0.04;
  nodes[3]!.rms = 0.04;
  advance(250);
  assert.equal(reports.at(-1)?.input, 'active');
  assert.equal(reports.at(-1)?.output, 'active');
  monitor.setPlaybackReady(false);
  advance(250);
  assert.equal(reports.at(-1)?.output, 'unknown');
  assert.equal(reports.at(-1)?.playbackReady, false);
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  advance(250);
  assert.equal(reports.at(-1)?.input, 'unknown');
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  monitor.setPlaybackReady(true);
  FakeContext.current.state = 'suspended';
  advance(250);
  assert.equal(reports.at(-1)?.input, 'unknown');
  await monitor.resume();
  track.muted = true;
  advance(1000);
  assert.equal(reports.at(-1)?.input, 'unknown');
  assert.deepEqual(Object.keys(reports[0]!).sort(), [
    'generation',
    'input',
    'output',
    'playbackReady',
    'sequence',
  ]);
  const before = reports.length;
  advance(3000);
  assert.equal(reports.length - before, 3);
  monitor.setGeneration(2);
  advance(50);
  assert.equal(reports.at(-1)?.generation, 2);
  assert.equal(reports.at(-1)?.sequence, 1);
  monitor.setOutput(stream);
  assert.equal(nodes[2]!.disconnected, true);
  assert.equal(nodes[3]!.disconnected, true);
  monitor.close();
  monitor.close();
  assert.equal(cleared, 1);
  assert.equal(FakeContext.current.closed, true);
  assert.ok(nodes.every((node) => node.disconnected));
  const count = reports.length;
  doc.dispatchEvent(new Event('visibilitychange'));
  advance(1000);
  assert.equal(reports.length, count);
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    writable: true,
    value: class {
      constructor() {
        throw new Error('Analysis unavailable');
      }
    },
  });
  const unavailable: VoiceActivitySnapshot[] = [];
  const fallback = new VoiceActivityMonitor((snapshot) => unavailable.push(snapshot));
  fallback.setGeneration(3);
  fallback.setInput(stream);
  fallback.setOutput(stream);
  await fallback.resume();
  advance(1000);
  assert.equal(unavailable.at(-1)?.input, 'unknown');
  assert.equal(unavailable.at(-1)?.output, 'unknown');
  fallback.close();
});
