function box(type: string, ...payloads: Buffer[]) {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}
function words(...values: number[]) {
  const result = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => result.writeUInt32BE(value, index * 4));
  return result;
}

// Synthetic ISO BMFF fixture: checks container structure only, not decoded A/V.
export function syntheticEndingMp4(
  options: {
    audio?: boolean;
    width?: number;
    seconds?: number;
    external?: boolean;
    outsideMdat?: boolean;
    audioPriming?: {
      ticks: number;
      editStart?: number;
      editDuration?: number;
      rate?: number;
      version?: 0 | 1;
      omitEdit?: boolean;
    };
  } = {},
) {
  const seconds = options.seconds ?? 15;
  const ftyp = box('ftyp', Buffer.from('isom'), words(0), Buffer.from('isommp42'));
  const mdat = box('mdat', Buffer.alloc(32, 1));
  const track = (kind: 'vide' | 'soun', id: number) => {
    const priming = kind === 'soun' ? options.audioPriming : undefined;
    const tkhd = Buffer.alloc(84);
    tkhd.writeUInt32BE(3, 0);
    tkhd.writeUInt32BE(id, 12);
    tkhd.writeUInt32BE(seconds * 1000, 20);
    const width = options.width ?? 768;
    if (kind === 'vide') {
      tkhd.writeUInt32BE(width * 65536, 76);
      tkhd.writeUInt32BE(768 * 65536, 80);
    }
    const mdhd = Buffer.alloc(24);
    mdhd.writeUInt32BE(1000, 12);
    mdhd.writeUInt32BE(seconds * 1000, 16);
    const hdlr = Buffer.alloc(24);
    hdlr.write(kind, 8);
    const entry = Buffer.alloc(kind === 'vide' ? 78 : 28);
    entry.writeUInt16BE(1, 6);
    if (kind === 'vide') {
      entry.writeUInt16BE(width, 24);
      entry.writeUInt16BE(768, 26);
    } else {
      entry.writeUInt16BE(2, 16);
      entry.writeUInt32BE(48000 * 65536, 24);
    }
    const config =
      kind === 'vide'
        ? box(
            'avcC',
            Buffer.from([1, 100, 0, 31, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 2, 0x68, 0]),
          )
        : box('esds', Buffer.from([0, 0, 0, 0, 3]));
    const stsd = box('stsd', words(0, 1), box(kind === 'vide' ? 'avc1' : 'mp4a', entry, config));
    const offset = options.outsideMdat ? 0 : ftyp.length + 8 + (id - 1) * 16;
    const stbl = box(
      'stbl',
      stsd,
      box('stsz', words(0, 16, 1)),
      box('stts', words(0, 1, 1, seconds * 1000 + (priming?.ticks ?? 0))),
      box('stsc', words(0, 1, 1, 1, 1)),
      box('stco', words(0, 1, offset)),
    );
    const dref = box(
      'dref',
      words(0, 1),
      box('url ', options.external ? Buffer.from([0, 0, 0, 0, 120]) : words(1)),
    );
    const edits: Buffer[] = [];
    if (priming && !priming.omitEdit) {
      const version = priming.version ?? 0;
      const entry = Buffer.alloc(version ? 20 : 12);
      const segment = priming.editDuration ?? seconds * 1000;
      const start = priming.editStart ?? priming.ticks;
      if (version) {
        entry.writeBigUInt64BE(BigInt(segment), 0);
        entry.writeBigInt64BE(BigInt(start), 8);
      } else {
        entry.writeUInt32BE(segment, 0);
        entry.writeInt32BE(start, 4);
      }
      entry.writeUInt32BE(priming.rate ?? 0x10000, version ? 16 : 8);
      edits.push(box('edts', box('elst', words(version * 0x1000000, 1), entry)));
    }
    return box(
      'trak',
      box('tkhd', tkhd),
      ...edits,
      box('mdia', box('mdhd', mdhd), box('hdlr', hdlr), box('minf', box('dinf', dref), stbl)),
    );
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([
    ftyp,
    mdat,
    box(
      'moov',
      box('mvhd', mvhd),
      track('vide', 1),
      ...(options.audio === false ? [] : [track('soun', 2)]),
    ),
  ]);
}
