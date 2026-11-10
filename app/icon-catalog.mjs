// SPDX-License-Identifier: GPL-3.0-only
import { randomUUID } from 'node:crypto';
import { remoteData } from './remote-data.mjs';

const decode = (text) =>
  text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (all, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[code.toLowerCase()] ?? all;
  });
const clean = (value) =>
  decode(String(value ?? '').replace(/<[^>]*>/g, ''))
    .trim()
    .slice(0, 180);
export function standardIcons(html) {
  const icons = [];
  const seen = new Set();
  for (const match of html.matchAll(
    /<img\s+[^>]*src="https:\/\/card-content\.yotoplay\.com\/yoto\/([\w-]{43})"[^>]*alt="([^"]*)"/g,
  )) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    icons.push({
      id: match[1],
      name: clean(match[2]),
      url: 'https://card-content.yotoplay.com/yoto/' + match[1],
      source: 'Yoto',
    });
    if (icons.length >= 3000) break;
  }
  if (!icons.length)
    throw new Error('Yoto’s public icon list has changed. Please try again later.');
  return icons;
}
export function communityIcons(html) {
  const icons = [],
    seen = new Set();
  // Parse the site's data arguments as text only. Never evaluate downloaded script.
  const argument = "'((?:[^'\\\\]|\\\\.)*)'";
  const pattern = new RegExp(
    'populate_icon_modal\\(' + Array(6).fill(argument).join('\\s*,\\s*') + '\\)',
    'g',
  );
  for (const m of html.matchAll(pattern)) {
    if (!/^\d{1,10}$/.test(m[1]) || seen.has(m[1])) continue;
    seen.add(m[1]);
    const label = (s) => clean(s.replace(/\\(['\\])/g, '$1'));
    icons.push({
      id: m[1],
      name: label(m[3]) || label(m[2]) || 'Community icon',
      author: label(m[5]),
      source: 'Yotoicons.com',
      url: `https://yotoicons.com/static/uploads/${m[1]}.png`,
    });
    if (icons.length >= 25) break;
  }
  return icons;
}
export function personalIcons(data) {
  if (!Array.isArray(data?.displayIcons)) throw new Error('Yoto returned an unfamiliar icon list.');
  return data.displayIcons.slice(0, 3000).flatMap((icon) => {
    let url;
    try {
      url = new URL(icon.url);
    } catch {
      return [];
    }
    if (
      url.origin !== 'https://card-content.yotoplay.com' ||
      !/^\/[\w/.-]+$/.test(url.pathname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      return [];
    return [
      {
        id: String(icon.displayIconId).slice(0, 180),
        name: clean(icon.title) || 'Personal icon',
        url: url.href,
        source: 'My Yoto icons',
      },
    ];
  });
}

export class IconCatalog {
  constructor({ fetcher = fetch, account, normalize }) {
    Object.assign(this, { fetcher, account, normalize });
    this.cache = new Map();
    this.results = new Map();
  }
  async cached(key, ttl, load) {
    const previous = this.cache.get(key);
    if (previous && previous.expires > Date.now()) return previous.promise;
    const promise = load();
    this.cache.set(key, { expires: Date.now() + ttl, promise });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
    try {
      return await promise;
    } catch (error) {
      this.cache.delete(key);
      throw error;
    }
  }
  async search(session, source, query = '', page = 0) {
    if (
      !['yoto', 'community', 'personal'].includes(source) ||
      typeof query !== 'string' ||
      query.length > 80 ||
      !Number.isInteger(page) ||
      page < 0 ||
      page > 100
    )
      throw new Error('Choose an icon source and a shorter search.');
    const q = query.trim().toLowerCase();
    const generation = this.account?.generation;
    const checkAccount = () => {
      if (
        source === 'personal' &&
        (!this.account.status.connected || this.account.generation !== generation)
      )
        throw new Error('Your Yoto connection changed. Search again to browse personal icons.');
    };
    let all,
      communityMore = false;
    if (source === 'yoto')
      all = await this.cached('standard', 86400000, async () =>
        standardIcons(
          (
            await remoteData(this.fetcher, 'https://yoto.dev/icons/using-icons/', {
              limit: 4 * 1024 ** 2,
            })
          ).toString(),
        ),
      );
    else if (source === 'personal') {
      const token = await this.account.accessToken();
      checkAccount();
      all = await this.cached('personal:' + this.account.generation, 60000, async () =>
        personalIcons(
          JSON.parse(
            (
              await remoteData(
                this.fetcher,
                'https://api.yotoplay.com/media/displayIcons/user/me',
                { headers: { Authorization: 'Bearer ' + token } },
              )
            ).toString(),
          ),
        ),
      );
    } else {
      if (!q) return { items: [], more: false, message: 'Enter a word to search Yotoicons.com.' };
      const result = await this.cached('community:' + q + ':' + page, 300000, async () => {
        const html = (
          await remoteData(
            this.fetcher,
            'https://yotoicons.com/icons?' +
              new URLSearchParams({
                tag: q,
                sort: 'popular',
                type: 'singles',
                page: String(page + 1),
              }).toString(),
          )
        ).toString();
        const icons = communityIcons(html);
        const total = html.match(/25\s*\*\s*page\)\s*<\s*(\d{1,8})/)?.[1];
        return { icons, more: total ? (page + 1) * 25 < Number(total) : icons.length === 25 };
      });
      all = result.icons;
      communityMore = result.more;
    }
    checkAccount();
    const filtered =
      source === 'community' ? all : all.filter((i) => !q || i.name.toLowerCase().includes(q));
    const selected = source === 'community' ? filtered : filtered.slice(page * 24, (page + 1) * 24);
    const items = [];
    for (let offset = 0; offset < selected.length; offset += 4) {
      const batch = await Promise.allSettled(
        selected.slice(offset, offset + 4).map(async (item) => {
          const png = await this.cached('image:' + item.url, 3600000, async () =>
            this.normalize(await remoteData(this.fetcher, item.url, { limit: 512 * 1024 })),
          );
          const key = randomUUID();
          this.results.set(key, { session, png, name: item.name, source, generation });
          while (this.results.size > 300) this.results.delete(this.results.keys().next().value);
          return {
            key,
            name: item.name,
            source: item.source,
            author: item.author,
            url: 'data:image/png;base64,' + png.toString('base64'),
          };
        }),
      );
      checkAccount();
      for (const result of batch) if (result.status === 'fulfilled') items.push(result.value);
    }
    if (selected.length && !items.length)
      throw new Error('Icon previews could not load. Check your connection and try again.');
    return {
      items,
      more:
        page < 100 && (source === 'community' ? communityMore : (page + 1) * 24 < filtered.length),
      message:
        items.length < selected.length
          ? 'Some previews could not load.'
          : source === 'community'
            ? 'Icons from Yotoicons.com, credited to their creators.'
            : '',
    };
  }
  take(session, key) {
    const item = this.results.get(key);
    if (
      !item ||
      item.session !== session ||
      (item.source === 'personal' &&
        (!this.account.status.connected || item.generation !== this.account.generation))
    )
      throw new Error('This icon search expired. Search again to choose it.');
    return item;
  }
  close(session) {
    for (const [key, item] of this.results) if (item.session === session) this.results.delete(key);
  }
}
