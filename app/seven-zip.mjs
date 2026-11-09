// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
export function sevenZipPath() {
  return import.meta.url.includes('app.asar/')
    ? path.join(process.resourcesPath, 'tools', '7zz')
    : fileURLToPath(new URL(`../assets/tools/7zz-${process.platform}${process.platform === 'darwin' ? '-'+process.arch : ''}`, import.meta.url));
}
async function run(args, maxBuffer = 16 * 1024 ** 2,signal) {
  try {
    return (await exec(sevenZipPath(), args, {encoding: 'buffer', maxBuffer, timeout: 30 * 60 * 1000, windowsHide: true,signal})).stdout;
  } catch (error) {
    if(signal?.aborted)throw new Error('Duplicate check paused.');
    if (error.code === 'ENOENT') throw new Error('The 7z reader is missing. Reinstall Pocket Drop.');
    throw new Error('Cannot read this 7z archive. It may be damaged, encrypted, or use an unsupported format.');
  }
}

// List and validate every path before the external extractor can write anything.
// No shell, user-supplied switches, links, overwrite prompts, or password prompts.
export async function openSevenZip(source, {safeName, visible, tree, limits}) {
  const listing = (await run(['l', '-slt', '-ba', '-sccUTF-8', '-p-', '--', source])).toString('utf8');
  const records = listing.trim().split(/\r?\n\r?\n/).filter(Boolean);
  if (records.length > limits.entries) throw new Error('Too many 7z entries.');
  const entries = [], paths = new Map(); let total = 0;
  for (const record of records) {
    const seenFields = new Set();
    const fields = Object.fromEntries(record.split(/\r?\n/).map(line => {
      const i = line.indexOf(' = '); if (i < 0) throw new Error('Invalid 7z entry listing.');
      const key = line.slice(0, i);
      if (seenFields.has(key)) throw new Error('Ambiguous 7z entry listing.');
      seenFields.add(key);
      return [key, line.slice(i + 3)];
    }));
    const name = safeName(fields.Path), size = Number(fields.Size);
    const attrs = fields.Attributes ?? '', mode = attrs.match(/(?:^| )([dlbcps-][rwxstST-]{9})(?: |$)/)?.[1];
    if (fields.Encrypted === '+') throw new Error('Encrypted 7z archives are not supported.');
    if (fields['Symbolic Link'] || fields['Hard Link'] || (mode && !/^[d-]/.test(mode)) || /\bReparse\b/i.test(attrs)) throw new Error('Unsafe 7z link or special file rejected.');
    const dir = fields.Folder === '+' || /D/.test(attrs.split(' ')[0]) || mode?.startsWith('d');
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.file || (total += size) > limits.total) throw new Error('7z exceeds safe extraction limits.');
    const key = name.toLowerCase();
    if (paths.has(key)) throw new Error('7z has duplicate or conflicting paths.');
    paths.set(key, !!dir);
    entries.push({name, size, dir: !!dir});
  }
  for (const name of paths.keys()) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) {
      if (paths.get(parts.join('/')) === false) throw new Error('7z has conflicting file and folder paths.');
      parts.pop();
    }
  }
  const files = entries.filter(e => !e.dir && visible(e.name));
  return {
    entries: files, close() {},
    read: async (name, limit) => {
      const entry = files.find(e => e.name === name);
      if (!entry || entry.size > limit) throw new Error('Missing or oversized metadata or cover.');
      const bytes = await run(['x', '-so', '-spd', '-p-', '--', source, name], limit + 1);
      if (bytes.length !== entry.size) throw new Error('7z entry size does not match its listing.');
      return bytes;
    },
    extract: async (selected,{signal}={}) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-drop-7z-'));
      const cleanup = () => fs.rm(root, {recursive: true, force: true});
      try {
        const free = await fs.statfs(root);
        if (total + 256 * 1024 ** 2 > Number(free.bavail) * Number(free.bsize)) throw new Error('Not enough temporary disk space to process this 7z archive.');
        if(selected?.some(name=>!files.some(f=>f.name===name)))throw new Error('Unknown archive entry.');
        await run(['x', '-y', '-bd', '-bb0', '-mmt=2', '-spd', '-p-', `-o${root}`, '--', source,...(selected??[])],16*1024**2,signal);
        const actual = await tree(root);
        const expected=files.filter(f=>!selected||selected.includes(f.name));
        if (actual.length !== expected.length || actual.some(e => !expected.some(f => f.name === e.name && f.size === e.size))) throw new Error('Extracted 7z contents do not match the archive listing.');
        return {root, cleanup};
      } catch (error) { await cleanup(); throw error; }
    },
  };
}
