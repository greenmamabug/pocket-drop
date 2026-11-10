// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import yauzl from 'yauzl';
import { chooseArtwork, matchTrackIcons } from './artwork.mjs';
import { numberedLayout, numberedMetadata } from './numbered-archive.mjs';
import { openSevenZip } from './seven-zip.mjs';
import {
  isAudio,
  byAudioPath,
  audioPrefix,
  folderTitle,
  flexibleMetadata,
} from './flexible-audio.mjs';
import { playlistSlug } from '../vendor/sync-engine/dist/folder.js';
import { buildFolderLibrary } from '../vendor/sync-engine/dist/folder.js';
import { convertOpusFile } from './convert-audio.mjs';
import { nodeFolderDeps } from '../vendor/sync-engine/dist/folder-node.js';

export const LIMITS = {
  entries: 20000,
  total: 12 * 1024 ** 3,
  file: 4 * 1024 ** 3,
  metadata: 4 * 1024 ** 2,
  image: 10 * 1024 ** 2,
};

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function verifiedStream(entry, limit = LIMITS.file) {
  let crc = 0xffffffff,
    seen = 0;
  return new Transform({
    transform(chunk, encoding, done) {
      seen += chunk.length;
      if (seen > limit || seen > entry.uncompressedSize)
        return done(new Error('Oversized ZIP entry.'));
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      done(null, chunk);
    },
    flush(done) {
      if (seen !== entry.uncompressedSize || (crc ^ 0xffffffff) >>> 0 !== entry.crc32)
        return done(new Error('ZIP checksum failed. Download this archive again.'));
      done();
    },
  });
}

export function safeName(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.includes('\\') ||
    name.includes('\0') ||
    /^[A-Za-z]:/.test(name) ||
    name.startsWith('/') ||
    name.split('/').some((p) => p === '..' || p === '.')
  )
    throw new Error('Unsafe archive path rejected.');
  return name.replace(/\/$/, '');
}
const visible = (n) => !n.split('/').some((p) => p.startsWith('.') || p === '__MACOSX');
const exists = async (p) => !!(await fs.stat(p).catch(() => null));
export async function tree(root) {
  const files = [];
  let total = 0;
  async function walk(dir, prefix = '', depth = 0) {
    if (depth > 24) throw new Error('This folder is nested too deeply.');
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix + e.name;
      safeName(rel);
      if (e.isSymbolicLink())
        throw new Error('Symbolic links are not supported in audiobook folders.');
      if (!visible(rel)) continue;
      const s = await fs.lstat(path.join(root, rel));
      if (++walk.count > LIMITS.entries) throw new Error('Too many files in this audiobook.');
      if (e.isDirectory()) await walk(path.join(root, rel), rel + '/', depth + 1);
      else if (e.isFile()) {
        total += s.size;
        if (s.size > LIMITS.file || total > LIMITS.total)
          throw new Error('Audiobook exceeds the 12 GB processing limit.');
        files.push({ name: rel, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs });
      } else throw new Error('Unsupported special file.');
    }
  }
  walk.count = 0;
  await walk(root);
  return files;
}
export async function fingerprint(source) {
  const s = await fs.lstat(source);
  if (s.isSymbolicLink()) throw new Error('Symbolic links are not supported.');
  const records = s.isDirectory()
    ? await tree(source)
    : [{ name: path.basename(source), size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }];
  return createHash('sha256')
    .update(JSON.stringify(records.sort((a, b) => a.name.localeCompare(b.name))))
    .digest('hex');
}
export async function openArchive(source) {
  const s = await fs.lstat(source);
  if (s.isSymbolicLink()) throw new Error('Symbolic links are not supported.');
  if (s.isDirectory()) {
    const entries = await tree(source);
    return {
      entries,
      close() {},
      read: async (name, limit) => {
        const e = entries.find((e) => e.name === name);
        if (!e || e.size > limit) throw new Error('Missing or oversized metadata or cover.');
        return fs.readFile(path.join(source, name));
      },
      extract: async () => ({ root: source, cleanup: async () => {} }),
    };
  }
  if (/\.7z$/i.test(source))
    return openSevenZip(source, { safeName, visible, tree, limits: LIMITS });
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(
      source,
      { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
      (err, z) => (err ? reject(err) : resolve(z)),
    ),
  );
  try {
    const entries = [];
    const names = new Set();
    let total = 0;
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (e) => {
        try {
          const name = safeName(e.fileName);
          if (entries.length >= LIMITS.entries) throw new Error('Too many ZIP entries.');
          const mode = (e.externalFileAttributes >>> 16) & 0xf000;
          if (mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000))
            throw new Error('Unsafe ZIP link or special file rejected.');
          const key = name.toLowerCase();
          if (names.has(key)) throw new Error('ZIP has duplicate or conflicting paths.');
          names.add(key);
          if (e.generalPurposeBitFlag & 1)
            throw new Error('Encrypted ZIP files are not supported.');
          total += e.uncompressedSize;
          if (
            e.uncompressedSize > LIMITS.file ||
            total > LIMITS.total ||
            (e.uncompressedSize > 1024 ** 2 &&
              e.uncompressedSize / Math.max(1, e.compressedSize) > 1000)
          )
            throw new Error('ZIP exceeds safe extraction limits.');
          entries.push({ name, size: e.uncompressedSize, entry: e, dir: e.fileName.endsWith('/') });
          zip.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zip.readEntry();
    });
    const files = entries.filter((e) => !e.dir && visible(e.name));
    const stream = (e) =>
      new Promise((resolve, reject) =>
        zip.openReadStream(e.entry, (err, s) => (err ? reject(err) : resolve(s))),
      );
    return {
      entries: files,
      close: () => zip.close(),
      read: async (name, limit) => {
        const e = files.find((e) => e.name === name);
        if (!e || e.size > limit) throw new Error('Missing or oversized metadata or cover.');
        return pipeline(await stream(e), verifiedStream(e.entry, limit), async function (input) {
          const chunks = [];
          for await (const b of input) chunks.push(b);
          return Buffer.concat(chunks);
        });
      },
      extract: async (selected, { signal } = {}) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-drop-'));
        const cleanup = () => fs.rm(root, { recursive: true, force: true });
        try {
          const selectedFiles = files.filter((e) => !selected || selected.includes(e.name)),
            needed = selectedFiles.reduce((n, e) => n + e.size, 0);
          const free = await fs.statfs(root);
          if (needed + 256 * 1024 ** 2 > free.bavail * free.bsize)
            throw new Error('Not enough temporary disk space to process this ZIP.');
          for (const e of selectedFiles) {
            const out = path.join(root, e.name);
            await fs.mkdir(path.dirname(out), { recursive: true });
            await pipeline(
              await stream(e),
              verifiedStream(e.entry),
              createWriteStream(out, { flags: 'wx' }),
              { signal },
            );
          }
          return { root, cleanup };
        } catch (err) {
          await cleanup();
          throw err;
        }
      },
    };
  } catch (err) {
    zip.close();
    throw err;
  }
}
const parse = async (a, n) => JSON.parse((await a.read(n, LIMITS.metadata)).toString('utf8'));
export async function inspect(source) {
  const a = await openArchive(source);
  try {
    const names = a.entries.map((e) => e.name);
    const audioFiles = names.filter(isAudio).sort(byAudioPath);
    if (!audioFiles.length)
      throw new Error('No supported audio files found in this folder or archive.');
    const roots = names
      .filter((n) => /(^|\/)metadata\.json$/.test(n) && !/(^|\/)data\//.test(n))
      .map((n) => n.slice(0, -'metadata.json'.length));
    const chrome = names
      .filter((n) => /(^|\/)data\/simplified-card-data\.json$/.test(n))
      .map((n) => n.slice(0, -'data/simplified-card-data.json'.length));
    let prefix = '',
      meta = null,
      format = 'folder';
    const optionalParse = async (name) => {
      try {
        return await parse(a, name);
      } catch (error) {
        if (error instanceof SyntaxError || /oversized metadata/.test(error.message)) return null;
        throw error;
      }
    };
    if (roots.length === 1) {
      prefix = roots[0];
      meta = await optionalParse(prefix + 'metadata.json');
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        // Paths remain untrusted even when other metadata is unusable.
        for (const t of Array.isArray(meta.tracks) ? meta.tracks : []) {
          if (typeof t?.audio === 'string') safeName(t.audio);
          if (typeof t?.icon === 'string') safeName(t.icon);
        }
        const valid =
          typeof meta.title === 'string' &&
          meta.title.trim() &&
          Array.isArray(meta.tracks) &&
          meta.tracks.length &&
          meta.tracks.every((t) => t && typeof t.title === 'string' && Number.isFinite(t.index));
        const downloaded = audioFiles.filter((n) => n.startsWith(prefix + 'audio/'));
        if (
          valid &&
          downloaded.length === meta.tracks.length &&
          downloaded.length === audioFiles.length
        ) {
          const explicit = meta.tracks
            .filter((t) => typeof t.audio === 'string')
            .map((t) => prefix + t.audio);
          if (
            meta.format !== 'myo-studio-archive' ||
            (explicit.length === audioFiles.length &&
              new Set(explicit).size === audioFiles.length &&
              explicit.every((n) => audioFiles.includes(n)))
          )
            format = 'website';
        }
      }
    } else if (chrome.length === 1) {
      prefix = chrome[0];
      meta = await optionalParse(prefix + 'data/simplified-card-data.json');
      if (
        meta &&
        typeof meta.title === 'string' &&
        Array.isArray(meta.chapters) &&
        meta.chapters.length
      ) {
        try {
          const mapped = convertChrome({ prefix, meta, title: meta.title }, names);
          if (mapped.tracks.length === audioFiles.length) format = 'chrome';
        } catch {
          /* Incomplete card details are optional; use the audio itself. */
        }
      }
    }
    const numbered = numberedLayout(names);
    if (format === 'folder' && numbered) {
      format = 'numbered';
      prefix = '';
    }
    const inferred = format === 'numbered' ? numbered.prefix : audioPrefix(audioFiles);
    const title =
      (typeof meta?.title === 'string' && meta.title.trim()) ||
      folderTitle(source, inferred, (await fs.lstat(source)).isDirectory());
    const declared = typeof meta?.cover === 'string' ? prefix + safeName(meta.cover) : null;
    const artwork = await chooseArtwork(
      a,
      [format === 'numbered' ? numbered.coverName : null, declared],
      LIMITS.image,
    );
    const coverName = artwork?.name ?? null,
      cover = artwork ? `data:${artwork.mime};base64,${artwork.bytes.toString('base64')}` : null;
    const iconAssignments =
      format === 'folder' ? matchTrackIcons(audioFiles, names, coverName) : {};
    return {
      title,
      format,
      iconAssignments,
      numbered: format === 'numbered' ? numbered : null,
      notes: format === 'numbered' ? numbered.notes : [],
      prefix: format === 'folder' ? '' : prefix,
      meta: ['folder', 'numbered'].includes(format) ? null : meta,
      cover,
      coverName,
      audioFiles,
      opusFiles: audioFiles.filter((n) => /\.(opus|ogg)$/i.test(n)),
      fileCount: audioFiles.length,
      size: a.entries.reduce((n, e) => n + e.size, 0),
    };
  } finally {
    a.close();
  }
}
export function convertChrome(info, names) {
  const audio = names.filter(
    (n) => n.startsWith(info.prefix + 'audio/') && /\.(mp3|m4a|aac|opus|ogg|flac|wav)$/i.test(n),
  );
  const icons = names.filter((n) => n.startsWith(info.prefix + 'icons/') && /\.png$/i.test(n));
  const used = new Set();
  const tracks = info.meta.chapters.map((c, i) => {
    if (typeof c.title !== 'string' || !/^\d+$/.test(String(c.key)))
      throw new Error('A Chrome chapter is missing its numbered key or title.');
    const matches = audio.filter((n) => {
      const m = path.posix.basename(n).match(/^(\d+)(?:[-_ .]|$)/);
      return m && Number(m[1]) === Number(c.key);
    });
    if (matches.length !== 1 || used.has(matches[0]))
      throw new Error(`Cannot uniquely match chapter ${i + 1} to a local audio file.`);
    used.add(matches[0]);
    const icon = icons.filter((n) => {
      const m = path.posix.basename(n).match(/^(\d+)(?:[-_ .]|$)/);
      return m && Number(m[1]) === Number(c.key);
    });
    if (icon.length > 1) throw new Error('Ambiguous chapter icon filenames.');
    return {
      index: i,
      title: c.title,
      audio: matches[0].slice(info.prefix.length),
      ...(icon.length ? { icon: icon[0].slice(info.prefix.length) } : {}),
    };
  });
  if (used.size !== audio.length)
    throw new Error('Some local audio files have no chapter metadata; nothing was skipped.');
  return {
    format: 'myo-studio-archive',
    title: info.title,
    ...(info.coverName ? { cover: info.coverName.slice(info.prefix.length) } : {}),
    tracks,
  };
}
export async function prepare(
  source,
  {
    convertOpus = false,
    conversionCache,
    onConversion = () => {},
    cancelled = () => false,
    encode,
    onTiming,
    editPlan,
    normalizeIcon,
    onPreparation = () => {},
    signal,
  } = {},
) {
  onPreparation({ phase: 'Reading audio details', file: path.basename(source) });
  const info = await inspect(source);
  const a = await openArchive(source);
  let extracted;
  try {
    onPreparation({ phase: 'Extracting audio', file: path.basename(source) });
    extracted = await a.extract(undefined, { signal });
  } finally {
    a.close();
  }
  try {
    if (cancelled() || signal?.aborted) throw new Error('Transfer cancelled.');
    const opusFiles = editPlan
      ? info.opusFiles.filter((n) => editPlan.tracks.some((t) => t.key === n && !t.excluded))
      : info.opusFiles;
    if (convertOpus && opusFiles.length) {
      if ((await fs.lstat(source)).isDirectory()) {
        const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-drop-convert-'));
        const oldCleanup = extracted.cleanup;
        try {
          await fs.cp(source, path.join(copy, 'source'), {
            recursive: true,
            errorOnExist: true,
            force: false,
            dereference: false,
          });
          await tree(path.join(copy, 'source'));
        } catch (error) {
          await fs.rm(copy, { recursive: true, force: true });
          throw error;
        }
        extracted = {
          root: path.join(copy, 'source'),
          cleanup: async () => {
            await fs.rm(copy, { recursive: true, force: true });
            await oldCleanup();
          },
        };
      }
      for (let i = 0; i < opusFiles.length; i++) {
        if (cancelled()) throw new Error('Transfer cancelled.');
        const file = opusFiles[i],
          target = file.replace(/\.(opus|ogg)$/i, '.m4a');
        if (await exists(path.join(extracted.root, target)))
          throw new Error(
            'Opus conversion would conflict with an existing M4A file. Rename the conflicting file first.',
          );
        await convertOpusFile(path.join(extracted.root, file), path.join(extracted.root, target), {
          cacheDir: conversionCache,
          cancelled,
          ...(encode ? { encode } : {}),
          ...(onTiming
            ? { onTiming: (event) => onTiming({ ...event, playlist: info.title }) }
            : {}),
          onProgress: (percent, phase) =>
            onConversion({
              file: path.posix.basename(file),
              index: i + 1,
              total: opusFiles.length,
              percent: (i + percent) / opusFiles.length,
              phase,
            }),
        });
        await fs.rm(path.join(extracted.root, file));
      }
      if (info.format === 'website' && !editPlan) {
        const metadata = {
          ...info.meta,
          tracks: info.meta.tracks.map((t) => ({
            ...t,
            audio:
              typeof t.audio === 'string' ? t.audio.replace(/\.(opus|ogg)$/i, '.m4a') : t.audio,
          })),
        };
        await fs.writeFile(
          path.join(extracted.root, info.prefix, 'metadata.json'),
          JSON.stringify(metadata),
        );
      }
    }
    const progressDeps = {
      ...nodeFolderDeps,
      sha256: async (file) => {
        const hash = createHash('sha256');
        let last = 0;
        for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
          if (cancelled()) throw new Error('Transfer cancelled.');
          hash.update(chunk);
          if (performance.now() - last > 200) {
            last = performance.now();
            onPreparation({ phase: 'Checking source audio', file: path.basename(file) });
          }
        }
        return hash.digest('hex');
      },
      probe: async (file, mime) => {
        if (cancelled()) throw new Error('Transfer cancelled.');
        onPreparation({ phase: 'Reading audio duration', file: path.basename(file) });
        return nodeFolderDeps.probe(file, mime);
      },
    };
    const dir = path.join(extracted.root, editPlan ? '' : info.prefix);
    let deps = progressDeps;
    if (info.format === 'chrome') {
      const names = (await tree(extracted.root)).map((e) => e.name);
      const data = Buffer.from(JSON.stringify(convertChrome(info, names)));
      const metadata = path.join(dir, 'metadata.json');
      deps = {
        ...deps,
        list: async (p) => [
          ...(await nodeFolderDeps.list(p)),
          ...(p === dir ? [{ name: 'metadata.json', path: metadata, isDir: false }] : []),
        ],
        read: async (p, max) => (p === metadata ? data : nodeFolderDeps.read(p, max)),
      };
    }
    let library,
      orderNotes = [];
    if (info.format === 'folder' || info.format === 'numbered' || editPlan) {
      const actualInfo = {
        ...info,
        iconAssignments: Object.fromEntries(
          Object.entries(info.iconAssignments ?? {}).map(([key, value]) => [
            convertOpus ? key.replace(/\.(opus|ogg)$/i, '.m4a') : key,
            value,
          ]),
        ),
        audioFiles: info.audioFiles.map((n) =>
          convertOpus ? n.replace(/\.(opus|ogg)$/i, '.m4a') : n,
        ),
        numbered: info.numbered
          ? {
              ...info.numbered,
              tracks: info.numbered.tracks.map((t) => ({
                ...t,
                key: convertOpus ? t.key.replace(/\.(opus|ogg)$/i, '.m4a') : t.key,
              })),
            }
          : null,
      };
      const generated = editPlan
        ? {
            notes: [],
            metadata: {
              format: 'myo-studio-archive',
              title: info.title,
              tracks: editPlan.tracks
                .filter((t) => !t.excluded)
                .map((t, index) => {
                  if (!info.audioFiles.includes(t.key))
                    throw new Error(
                      'An edited track is missing. Open Audio details to review the changed files.',
                    );
                  return {
                    index,
                    title: t.title,
                    audio: convertOpus ? t.key.replace(/\.(opus|ogg)$/i, '.m4a') : t.key,
                    ...(t.iconKey && !t.iconKey.startsWith('asset:')
                      ? { icon: safeName(t.iconKey) }
                      : {}),
                  };
                }),
            },
          }
        : info.format === 'numbered'
          ? await numberedMetadata(extracted.root, actualInfo, { cancelled })
          : await flexibleMetadata(extracted.root, actualInfo, { cancelled });
      orderNotes = generated.notes;
      const aliases = new Map();
      generated.metadata.tracks.forEach((track, i) => {
        if (/\.m4b$/i.test(track.audio)) {
          const original = path.join(dir, track.audio);
          track.audio = `__pocket_drop_audio__/${i}.m4a`;
          aliases.set(path.join(dir, track.audio), original);
        }
      });
      let iconTemp = null;
      for (const track of generated.metadata.tracks.filter((t) => t.icon)) {
        const file = path.join(dir, track.icon);
        if (aliases.has(file)) continue;
        const st = await fs.stat(file);
        if (st.size > LIMITS.image)
          throw new Error('Track icon exceeds the 10 MB image limit: ' + path.basename(file));
        const header = await nodeFolderDeps.read(file, 24),
          isPng = header.length === 24 && header.readUInt32BE(0) === 0x89504e47;
        if (!isPng) throw new Error('Track icon is not a valid PNG: ' + path.basename(file));
        if (header.readUInt32BE(16) * header.readUInt32BE(20) > 50_000_000)
          throw new Error('Track icon has too many pixels: ' + path.basename(file));
        if (header.readUInt32BE(16) === 16 && header.readUInt32BE(20) === 16) continue;
        if (!normalizeIcon)
          throw new Error(
            'This track image needs 16-pixel conversion. Import it with the Pocket Drop app: ' +
              path.basename(file),
          );
        if (!iconTemp) {
          iconTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-icons-'));
          const oldCleanup = extracted.cleanup;
          const iconRoot = iconTemp;
          extracted = {
            ...extracted,
            cleanup: async () => {
              try {
                await fs.rm(iconRoot, { recursive: true, force: true });
              } finally {
                await oldCleanup();
              }
            },
          };
        }
        const target = path.join(iconTemp, aliases.size + '.png');
        await normalizeIcon(file, target);
        const result = await nodeFolderDeps.read(target, 24);
        if (
          result.length !== 24 ||
          result.readUInt32BE(0) !== 0x89504e47 ||
          result.readUInt32BE(16) !== 16 ||
          result.readUInt32BE(20) !== 16
        )
          throw new Error('Track image conversion did not produce a 16-pixel PNG.');
        aliases.set(file, target);
      }
      const metadata = path.join(dir, 'metadata.json'),
        data = Buffer.from(JSON.stringify(generated.metadata));
      const resolve = (p) => aliases.get(p) ?? p;
      // A virtual manifest adapts any nesting to the unchanged upstream engine.
      // Nothing is written into the user's folder or download.
      const flexibleDeps = {
        ...progressDeps,
        list: async (p) =>
          p === dir
            ? [{ name: 'metadata.json', path: metadata, isDir: false }]
            : nodeFolderDeps.list(p),
        read: async (p, max) => (p === metadata ? data : nodeFolderDeps.read(resolve(p), max)),
        size: (p) => nodeFolderDeps.size(resolve(p)),
        sha256: (p) => progressDeps.sha256(resolve(p)),
        probe: (p, mime) => progressDeps.probe(resolve(p), mime),
      };
      library = await buildFolderLibrary(dir, flexibleDeps);
      for (const playlist of library.playlists)
        for (const track of playlist.tracks) {
          track.localPath = resolve(track.localPath);
          if (track.iconPath) track.iconPath = resolve(track.iconPath);
        }
    } else library = await buildFolderLibrary(dir, deps);
    if (library.playlists.length !== 1) throw new Error('Expected exactly one audiobook.');
    const playlist = library.playlists[0];
    if (info.format === 'folder' || info.format === 'numbered' || editPlan) {
      playlist.manifest.title = info.title;
      playlist.manifest.id = playlistSlug(info.title);
    }
    if (!playlist.coverPath && info.coverName && info.cover) {
      playlist.coverPath = path.join(extracted.root, info.coverName);
      playlist.manifest.cover = info.cover.startsWith('data:image/png')
        ? 'cover.png'
        : info.cover.startsWith('data:image/jpeg')
          ? 'cover.jpg'
          : 'cover.webp';
    }
    // Never silently omit unsupported or unlisted audio from MYO downloads.
    if (
      info.format === 'website' &&
      !editPlan &&
      playlist.tracks.length !== info.meta.tracks.length
    )
      throw new Error('The archive has incomplete chapter data.');
    return {
      root: extracted.root,
      info,
      playlist,
      notes: [...orderNotes, ...(library.notes ?? [])],
      cleanup: extracted.cleanup,
    };
  } catch (err) {
    await extracted.cleanup();
    throw err;
  }
}
export async function contentKey(playlist) {
  const hash = createHash('sha256').update(JSON.stringify(playlist.manifest));
  for (const p of [
    playlist.coverPath,
    playlist.iconPath,
    ...playlist.tracks.map((t) => t.iconPath),
  ].filter(Boolean))
    hash.update(await nodeFolderDeps.sha256(p));
  return hash.digest('hex');
}
