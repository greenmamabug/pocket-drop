// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import {parseFile} from 'music-metadata';

export const isAudio = name => /\.(mp3|m4a|m4b|aac|opus|flac|wav|ogg|wma|aiff?|alac)$/i.test(name);
const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});
export function byAudioPath(a, b) {
  const aa = a.split('/'), bb = b.split('/');
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const order = collator.compare(aa[i], bb[i]);
    if (order) return order;
  }
  return aa.length - bb.length || (a < b ? -1 : a > b ? 1 : 0);
}
export function audioPrefix(names) {
  const dirs = names.map(n => n.split('/').slice(0, -1));
  const shared = dirs[0] ?? [];
  let length = shared.length;
  for (const dir of dirs) {
    let i = 0; while (i < length && shared[i] === dir[i]) i++;
    length = i;
  }
  return shared.slice(0, length).join('/') + (length ? '/' : '');
}
export function folderTitle(source, prefix, isDirectory) {
  const parts = prefix.split('/').filter(Boolean);
  while (parts.length && /^(audio|music|tracks?|chapters?|files|cd[\s_-]*\d+|dis[ck][\s_-]*\d+|part[\s_-]*\d+)$/i.test(parts.at(-1))) parts.pop();
  return parts.at(-1) || path.basename(source).replace(isDirectory ? /$^/ : /\.(zip|7z)$/i, '');
}

// Reading tags is deliberately deferred until Sync, so a library refresh never
// decodes or hashes every audio file. Plain names still give a stable quick order.
export async function flexibleMetadata(root, info, {cancelled = () => false} = {}) {
  const tracks = [];
  for (const name of info.audioFiles) {
    if (cancelled()) throw new Error('Transfer cancelled.');
    const tags = await parseFile(path.join(root, name), {skipCovers: true, duration: false}).then(m => m.common, () => ({}));
    tracks.push({name, tags});
  }
  const complete = tracks.every(t => Number.isInteger(t.tags.track?.no) && t.tags.track.no > 0);
  const disc = t => t.tags.disk?.no || Number(t.name.match(/(?:^|\/)(?:cd|dis[ck]|part)[ _-]*(\d+)(?:[ _-]|\/|$)/i)?.[1]) || 1;
  const numbered = complete && new Set(tracks.map(t => `${disc(t)}:${t.tags.track.no}`)).size === tracks.length;
  tracks.sort(numbered ? (a, b) => disc(a) - disc(b) || a.tags.track.no - b.tags.track.no || byAudioPath(a.name, b.name) : (a, b) => byAudioPath(a.name, b.name));
  const notes = [numbered ? 'Playback order uses the audio files’ disc and track tags.' : 'Playback order uses folder and file names in natural numeric order (2 before 10).'];
  return {metadata: {
    format: 'myo-studio-archive', title: info.title,
    ...(info.coverName ? {cover: info.coverName} : {}),
    tracks: tracks.map(({name, tags}, index) => ({index, title: tags.title?.trim() || path.posix.basename(name, path.posix.extname(name)), audio: name})),
  }, notes};
}
