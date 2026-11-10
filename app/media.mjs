// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
export async function mediaResponse(file, request) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  const stat = await fs.lstat(file);
  if ((await fs.realpath(file)) !== path.resolve(file) || !stat.isFile() || stat.isSymbolicLink())
    return new Response(null, { status: 404 });
  const size = stat.size,
    range = request.headers.get('range');
  let start = 0,
    end = size - 1,
    status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (
      !match ||
      (!match[1] && !match[2]) ||
      [match?.[1], match?.[2]].some((part) => part && !Number.isSafeInteger(Number(part)))
    )
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else start = Math.max(0, size - Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    status = 206;
  }
  const mime =
    {
      '.mp3': 'audio/mpeg',
      '.aac': 'audio/aac',
      '.m4a': 'audio/mp4',
      '.m4b': 'audio/mp4',
      '.opus': 'audio/ogg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    }[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const headers = {
    'Content-Type': mime,
    'Content-Length': String(Math.max(0, end - start + 1)),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  };
  return new Response(
    request.method === 'HEAD' || !size
      ? null
      : Readable.toWeb(createReadStream(file, { start, end })),
    { status, headers },
  );
}
