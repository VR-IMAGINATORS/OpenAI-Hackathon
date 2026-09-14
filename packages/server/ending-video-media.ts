export const MAX_ENDING_VIDEO_BYTES = 24 * 1024 * 1024;

export interface EndingVideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: true;
  byteLength: number;
}

export class EndingVideoMediaError extends Error {
  constructor() {
    super('Invalid ending video media');
    this.name = 'EndingVideoMediaError';
  }
}

interface Box {
  type: string;
  start: number;
  data: number;
  end: number;
}
const invalid = (): never => {
  throw new EndingVideoMediaError();
};
const requireValue = (condition: unknown): void => {
  if (!condition) invalid();
};

/**
 * Bounded ISO BMFF structural validation for the ordinary, nonfragmented MP4
 * returned by H3. This checks metadata and sample ranges; it does not decode
 * frames or assess story content, legibility, sound, or browser playback.
 */
export function validateEndingMp4(bytes: Uint8Array): EndingVideoMetadata {
  requireValue(bytes.byteLength >= 32 && bytes.byteLength <= MAX_ENDING_VIDEO_BYTES);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let boxCount = 0;
  function boxes(start: number, end: number): Box[] {
    const result: Box[] = [];
    while (start < end) {
      requireValue(end - start >= 8 && ++boxCount <= 10_000);
      const shortSize = buffer.readUInt32BE(start);
      let size = shortSize;
      let header = 8;
      if (shortSize === 1) {
        requireValue(end - start >= 16);
        const longSize = buffer.readBigUInt64BE(start + 8);
        requireValue(longSize <= BigInt(end - start));
        size = Number(longSize);
        header = 16;
      }
      // Unbounded (size zero) boxes and truncated/overflowing boxes are rejected.
      requireValue(size >= header && size <= end - start);
      const type = buffer.toString('latin1', start + 4, start + 8);
      result.push({ type, start, data: start + header, end: start + size });
      start += size;
    }
    return result;
  }
  function one(list: Box[], type: string): Box {
    const matches = list.filter((box) => box.type === type);
    requireValue(matches.length === 1);
    return matches[0];
  }
  function children(box: Box) {
    return boxes(box.data, box.end);
  }
  function minimum(box: Box, size: number) {
    requireValue(box.end - box.data >= size);
  }
  function fullBox(box: Box, minimumBytes: number) {
    minimum(box, minimumBytes);
    requireValue(buffer.readUInt32BE(box.data) === 0);
  }
  function uint64(offset: number) {
    const result = buffer.readBigUInt64BE(offset);
    requireValue(result <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(result);
  }
  function duration(box: Box, movie: boolean) {
    minimum(box, 4);
    const version = buffer[box.data];
    requireValue(version === 0 || version === 1);
    minimum(box, movie ? (version ? 112 : 100) : version ? 36 : 24);
    const timescale = buffer.readUInt32BE(box.data + (version ? 20 : 12));
    const ticks = version ? uint64(box.data + 24) : buffer.readUInt32BE(box.data + 16);
    requireValue(timescale > 0 && ticks > 0);
    const seconds = ticks / timescale;
    requireValue(Math.abs(seconds - 15) <= 0.5);
    return { seconds, ticks, timescale };
  }
  function audioPriming(
    track: Box[],
    mediaDuration: ReturnType<typeof duration>,
    trackTicks: number,
    movieTimescale: number,
  ): number {
    // Some muxers put post-edit AAC duration in mdhd but include encoder priming
    // in stts. Accept only a single normal-speed edit that explains the entire gap.
    const edit = one(children(one(track, 'edts')), 'elst');
    minimum(edit, 8);
    const version = buffer[edit.data];
    requireValue(
      (version === 0 || version === 1) && (buffer.readUInt32BE(edit.data) & 0xffffff) === 0,
    );
    requireValue(
      buffer.readUInt32BE(edit.data + 4) === 1 && edit.end - edit.data === (version ? 28 : 20),
    );
    const segment = version ? uint64(edit.data + 8) : buffer.readUInt32BE(edit.data + 8);
    const start = version ? uint64(edit.data + 16) : buffer.readInt32BE(edit.data + 12);
    requireValue(buffer.readUInt32BE(edit.data + (version ? 24 : 16)) === 0x10000);
    requireValue(start > 0 && start <= mediaDuration.timescale / 2);
    requireValue(segment === trackTicks);
    // The edit duration uses movie ticks; mdhd uses media ticks. Allow one movie
    // tick of conversion rounding, without widening the 15-second media limit.
    requireValue(Math.abs(segment / movieTimescale - mediaDuration.seconds) <= 1 / movieTimescale);
    return start;
  }

  const top = boxes(0, buffer.length);
  requireValue(top[0]?.type === 'ftyp' && !top.some((box) => box.type === 'moof'));
  const ftyp = one(top, 'ftyp');
  minimum(ftyp, 8);
  requireValue((ftyp.end - ftyp.data) % 4 === 0);
  const compatible: string[] = [buffer.toString('latin1', ftyp.data, ftyp.data + 4)];
  for (let offset = ftyp.data + 8; offset < ftyp.end; offset += 4) {
    compatible.push(buffer.toString('latin1', offset, offset + 4));
  }
  requireValue(
    compatible.some((brand) =>
      ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1'].includes(brand),
    ),
  );
  const media = top.filter((box) => box.type === 'mdat');
  requireValue(media.length > 0 && media.some((box) => box.end > box.data));
  const movie = children(one(top, 'moov'));
  requireValue(!movie.some((box) => box.type === 'mvex'));
  const movieDuration = duration(one(movie, 'mvhd'), true);
  const tracks = movie.filter((box) => box.type === 'trak');
  requireValue(tracks.length >= 2 && tracks.length <= 8);
  const ids = new Set<number>();
  let videoTracks = 0;
  let audioTracks = 0;

  for (const track of tracks) {
    const trackBoxes = children(track);
    const tkhd = one(trackBoxes, 'tkhd');
    minimum(tkhd, 4);
    const version = buffer[tkhd.data];
    requireValue(version === 0 || version === 1);
    minimum(tkhd, version ? 96 : 84);
    requireValue((buffer.readUInt32BE(tkhd.data) & 1) === 1);
    const trackId = buffer.readUInt32BE(tkhd.data + (version ? 20 : 12));
    requireValue(trackId > 0 && !ids.has(trackId));
    ids.add(trackId);
    const tkDuration = version ? uint64(tkhd.data + 28) : buffer.readUInt32BE(tkhd.data + 20);
    requireValue(Math.abs(tkDuration / movieDuration.timescale - 15) <= 0.5);
    const width = buffer.readUInt32BE(tkhd.data + (version ? 88 : 76)) / 65_536;
    const height = buffer.readUInt32BE(tkhd.data + (version ? 92 : 80)) / 65_536;
    const mdia = children(one(trackBoxes, 'mdia'));
    const trackDuration = duration(one(mdia, 'mdhd'), false);
    const handler = one(mdia, 'hdlr');
    minimum(handler, 24);
    const kind = buffer.toString('latin1', handler.data + 8, handler.data + 12);
    requireValue(kind === 'vide' || kind === 'soun');
    const minf = children(one(mdia, 'minf'));
    const samples = children(one(minf, 'stbl'));
    const stsd = one(samples, 'stsd');
    fullBox(stsd, 8);
    requireValue(buffer.readUInt32BE(stsd.data + 4) === 1);
    const entries = boxes(stsd.data + 8, stsd.end);
    requireValue(entries.length === 1);
    const entry = entries[0];
    minimum(entry, 8);
    // One local data reference. External movie sample locations are not supported.
    requireValue(buffer.readUInt16BE(entry.data + 6) === 1);
    const dref = one(children(one(minf, 'dinf')), 'dref');
    fullBox(dref, 8);
    requireValue(buffer.readUInt32BE(dref.data + 4) === 1);
    const references = boxes(dref.data + 8, dref.end);
    requireValue(references.length === 1 && references[0].type === 'url ');
    minimum(references[0], 4);
    requireValue(
      buffer.readUInt32BE(references[0].data) === 1 && references[0].end - references[0].data === 4,
    );

    if (kind === 'vide') {
      videoTracks++;
      requireValue(width === 768 && height === 768);
      minimum(entry, 78);
      requireValue(
        buffer.readUInt16BE(entry.data + 24) === 768 &&
          buffer.readUInt16BE(entry.data + 26) === 768,
      );
      const configTypes: Record<string, string> = {
        avc1: 'avcC',
        avc3: 'avcC',
        hvc1: 'hvcC',
        hev1: 'hvcC',
        av01: 'av1C',
      };
      const configType = configTypes[entry.type];
      requireValue(configType);
      const config = one(boxes(entry.data + 78, entry.end), configType);
      minimum(config, configType === 'avcC' ? 7 : configType === 'hvcC' ? 23 : 4);
      requireValue(buffer[config.data] === (configType === 'av1C' ? 0x81 : 1));
      if (configType === 'avcC') {
        // Parse parameter-set lengths, without attempting to decode their contents.
        requireValue(
          (buffer[config.data + 4] & 0xfc) === 0xfc && (buffer[config.data + 4] & 3) !== 2,
        );
        requireValue((buffer[config.data + 5] & 0xe0) === 0xe0);
        let position = config.data + 6;
        const parameterSets = (count: number) => {
          requireValue(count > 0);
          for (let i = 0; i < count; i++) {
            requireValue(position + 2 <= config.end);
            const size = buffer.readUInt16BE(position);
            position += 2;
            requireValue(size > 0 && position + size <= config.end);
            position += size;
          }
        };
        parameterSets(buffer[config.data + 5] & 0x1f);
        requireValue(position < config.end);
        parameterSets(buffer[position++]);
        // High-profile streams may append extension parameter sets.
        if (position < config.end) {
          requireValue(position + 4 <= config.end);
          position += 3;
          const count = buffer[position++];
          if (count) parameterSets(count);
        }
        requireValue(position === config.end);
      }
    } else {
      audioTracks++;
      requireValue(width === 0 && height === 0 && entry.type === 'mp4a');
      minimum(entry, 28);
      const audioVersion = buffer.readUInt16BE(entry.data + 8);
      requireValue(audioVersion === 0 || audioVersion === 1);
      const headerSize = audioVersion === 0 ? 28 : 44;
      minimum(entry, headerSize);
      requireValue(
        buffer.readUInt16BE(entry.data + 16) > 0 && buffer.readUInt32BE(entry.data + 24) > 0,
      );
      minimum(one(boxes(entry.data + headerSize, entry.end), 'esds'), 5);
    }

    const stsz = one(samples, 'stsz');
    fullBox(stsz, 12);
    const fixedSize = buffer.readUInt32BE(stsz.data + 4);
    const sampleCount = buffer.readUInt32BE(stsz.data + 8);
    requireValue(sampleCount > 0 && sampleCount <= 100_000);
    requireValue(stsz.end - stsz.data === 12 + (fixedSize ? 0 : sampleCount * 4));
    const sampleSize = (index: number) =>
      fixedSize || buffer.readUInt32BE(stsz.data + 12 + index * 4);
    const stts = one(samples, 'stts');
    fullBox(stts, 8);
    const timingCount = buffer.readUInt32BE(stts.data + 4);
    requireValue(
      timingCount > 0 && timingCount <= sampleCount && stts.end - stts.data === 8 + timingCount * 8,
    );
    let timedSamples = 0;
    let timedTicks = 0;
    for (let i = 0; i < timingCount; i++) {
      const count = buffer.readUInt32BE(stts.data + 8 + i * 8);
      const delta = buffer.readUInt32BE(stts.data + 12 + i * 8);
      requireValue(count > 0 && delta > 0);
      timedSamples += count;
      timedTicks += count * delta;
    }
    requireValue(timedSamples === sampleCount && Number.isSafeInteger(timedTicks));
    if (timedTicks !== trackDuration.ticks) {
      requireValue(kind === 'soun');
      const priming = audioPriming(trackBoxes, trackDuration, tkDuration, movieDuration.timescale);
      requireValue(timedTicks === trackDuration.ticks + priming);
    }

    const offsetBoxes = samples.filter((box) => box.type === 'stco' || box.type === 'co64');
    requireValue(offsetBoxes.length === 1);
    const offsets = offsetBoxes[0];
    fullBox(offsets, 8);
    const chunkCount = buffer.readUInt32BE(offsets.data + 4);
    const offsetSize = offsets.type === 'stco' ? 4 : 8;
    requireValue(
      chunkCount > 0 &&
        chunkCount <= sampleCount &&
        offsets.end - offsets.data === 8 + chunkCount * offsetSize,
    );
    const stsc = one(samples, 'stsc');
    fullBox(stsc, 8);
    const mapCount = buffer.readUInt32BE(stsc.data + 4);
    requireValue(
      mapCount > 0 && mapCount <= chunkCount && stsc.end - stsc.data === 8 + mapCount * 12,
    );
    const chunkMap: { first: number; count: number }[] = [];
    for (let i = 0; i < mapCount; i++) {
      const first = buffer.readUInt32BE(stsc.data + 8 + i * 12);
      const count = buffer.readUInt32BE(stsc.data + 12 + i * 12);
      const description = buffer.readUInt32BE(stsc.data + 16 + i * 12);
      requireValue((i === 0 ? first === 1 : first > chunkMap[i - 1].first) && first <= chunkCount);
      requireValue(count > 0 && count <= sampleCount && description === 1);
      chunkMap.push({ first, count });
    }
    let sampleIndex = 0;
    let mapIndex = 0;
    let previousEnd = 0;
    for (let chunk = 1; chunk <= chunkCount; chunk++) {
      if (mapIndex + 1 < chunkMap.length && chunk === chunkMap[mapIndex + 1].first) mapIndex++;
      const count = chunkMap[mapIndex].count;
      requireValue(sampleIndex + count <= sampleCount);
      let chunkSize = 0;
      for (let i = 0; i < count; i++) {
        const size = sampleSize(sampleIndex++);
        requireValue(size > 0);
        chunkSize += size;
      }
      const index = offsets.data + 8 + (chunk - 1) * offsetSize;
      const start = offsetSize === 4 ? buffer.readUInt32BE(index) : uint64(index);
      const end = start + chunkSize;
      requireValue(
        start >= previousEnd && media.some((box) => start >= box.data && end <= box.end),
      );
      previousEnd = end;
    }
    requireValue(sampleIndex === sampleCount);
  }
  requireValue(videoTracks === 1 && audioTracks >= 1);
  return {
    durationSeconds: movieDuration.seconds,
    width: 768,
    height: 768,
    hasAudio: true,
    byteLength: buffer.length,
  };
}
