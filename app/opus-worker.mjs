// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { OggOpusDecoder } from 'ogg-opus-decoder';
import { OggVorbisDecoder } from '@wasm-audio-decoders/ogg-vorbis';
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let r = n << 24;
  for (let i = 0; i < 8; i++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});
// CAF's LPCM flags are float=1 and little-endian=2 (not ASBD's flag layout).
export function cafHeader(channels, sampleRate) {
  const b = Buffer.alloc(68);
  b.write('caff', 0);
  b.writeUInt16BE(1, 4);
  b.write('desc', 8);
  b.writeBigInt64BE(32n, 12);
  b.writeDoubleBE(sampleRate, 20);
  b.write('lpcm', 28);
  b.writeUInt32BE(3, 32);
  b.writeUInt32BE(channels * 4, 36);
  b.writeUInt32BE(1, 40);
  b.writeUInt32BE(channels, 44);
  b.writeUInt32BE(32, 48);
  b.write('data', 52);
  b.writeBigInt64BE(-1n, 56);
  return b;
}
export async function decodeOpusToCAF(input, output, onProgress = () => {}) {
  let decoder;
  let codec;
  let out;
  let bytes = 0,
    samples = 0,
    channels = 0,
    rate = 48000,
    buffer = Buffer.alloc(0),
    serial,
    sequence,
    eos = false,
    pages = 0;
  try {
    const total = (await fs.stat(input)).size,
      space = await fs.statfs(output.substring(0, output.lastIndexOf('/')));
    const budget = Number(space.bavail) * Number(space.bsize) - 256 * 1024 ** 2;
    if (budget < 1024 ** 2)
      throw new Error('Not enough temporary disk space to convert Opus audio.');
    out = await fs.open(output, 'wx');
    await out.write(Buffer.alloc(68));
    const write = async (decoded) => {
      if (decoded.errors?.length)
        throw new Error('The Ogg audio contains damaged packets; download it again.');
      if (!decoded.samplesDecoded) return;
      const count = decoded.channelData.length;
      if (count < 1 || count > 2)
        throw new Error('Ogg conversion currently supports mono and stereo audio.');
      if (channels && (channels !== count || rate !== decoded.sampleRate))
        throw new Error('The Ogg audio changes its channel layout or sample rate.');
      channels = count;
      rate = decoded.sampleRate;
      const pcm = Buffer.allocUnsafe(decoded.samplesDecoded * channels * 4);
      for (let i = 0; i < decoded.samplesDecoded; i++)
        for (let ch = 0; ch < channels; ch++) {
          const v = decoded.channelData[ch][i];
          if (!Number.isFinite(v)) throw new Error('Invalid sample in Ogg audio.');
          pcm.writeFloatLE(v, (i * channels + ch) * 4);
        }
      if (68 + (samples + decoded.samplesDecoded) * channels * 4 > budget)
        throw new Error('Not enough temporary disk space to convert this Opus audio.');
      let offset = 0;
      while (offset < pcm.length) {
        const result = await out.write(pcm, offset, pcm.length - offset);
        if (!result.bytesWritten) throw new Error('Could not write decoded audio.');
        offset += result.bytesWritten;
      }
      samples += decoded.samplesDecoded;
    };
    for await (const chunk of createReadStream(input, { highWaterMark: 65536 })) {
      bytes += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 27) {
        if (buffer.toString('ascii', 0, 4) !== 'OggS' || buffer[4] !== 0)
          throw new Error('This file is not a valid Ogg audio stream.');
        const segments = buffer[26],
          header = 27 + segments;
        if (buffer.length < header) break;
        const size = header + buffer.subarray(27, header).reduce((n, v) => n + v, 0);
        if (buffer.length < size) break;
        const page = Buffer.from(buffer.subarray(0, size));
        buffer = buffer.subarray(size);
        const expected = page.readUInt32LE(22);
        page.writeUInt32LE(0, 22);
        let crc = 0;
        for (const byte of page) crc = (crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 255];
        page.writeUInt32LE(expected, 22);
        if (crc >>> 0 !== expected)
          throw new Error('The Ogg audio failed its checksum; download it again.');
        const id = page.readUInt32LE(14),
          seq = page.readUInt32LE(18);
        if (!pages) {
          if (!(page[5] & 2)) throw new Error('This Ogg file has no valid audio header.');
          codec =
            page.toString('ascii', header, header + 8) === 'OpusHead'
              ? 'Opus'
              : page[header] === 1 && page.toString('ascii', header + 1, header + 7) === 'vorbis'
                ? 'Vorbis'
                : null;
          if (!codec)
            throw new Error('This Ogg codec is unsupported. Use an Ogg Opus or Vorbis file.');
          decoder = codec === 'Opus' ? new OggOpusDecoder() : new OggVorbisDecoder();
          await decoder.ready;
          serial = id;
          sequence = seq;
        }
        if (eos || id !== serial || seq !== sequence)
          throw new Error('The Ogg stream is incomplete or contains multiple audio streams.');
        sequence = (seq + 1) >>> 0;
        pages++;
        eos = !!(page[5] & 4);
        await write(await decoder.decode(page));
      }
      onProgress(total ? bytes / total : 0);
    }
    if (buffer.length || !eos) throw new Error('The Ogg audio is incomplete; download it again.');
    if (decoder.flush) await write(await decoder.flush());
    if (!samples) throw new Error('The Ogg audio contains no playable samples.');
    await out.write(cafHeader(channels, rate), 0, 68, 0);
    await out.sync();
    return { channels, sampleRate: rate, samples, duration: samples / rate };
  } finally {
    await out?.close();
    decoder?.free();
  }
}
if (parentPort) {
  decodeOpusToCAF(workerData.input, workerData.output, (value) =>
    parentPort.postMessage({ progress: value }),
  ).then(
    (result) => parentPort.postMessage({ result }),
    (error) => parentPort.postMessage({ error: error.message }),
  );
}
