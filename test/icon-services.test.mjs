// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { YotoAccount } from '../app/yoto-account.mjs';
import { standardIcons, communityIcons, personalIcons, IconCatalog } from '../app/icon-catalog.mjs';
import { remoteData } from '../app/remote-data.mjs';

const id = '_WWpLHoOj6iqeREcGkJnGlsis2QSF6znM0UPFdXTjf8';
const html = `<img src="https://card-content.yotoplay.com/yoto/${id}" alt="Music &amp; notes">`;
// Test-only reversible stand-in: production uses Electron's operating-system credential encryption.
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s).map((n) => n ^ 42),
  decryptString: (b) =>
    Buffer.from(b)
      .map((n) => n ^ 42)
      .toString(),
};
const temporary = async (fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-icons-'));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};
const unusedPort = async () => {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
};
const waitFor = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
};

test('public catalogues parse only constrained IDs and display text, never executable markup', () => {
  assert.deepEqual(
    standardIcons(html + html).map((i) => i.name),
    ['Music & notes'],
  );
  assert.throws(() => standardIcons('<script>evil()</script>'), /changed/);
  const community = `<div onclick="populate_icon_modal('123', 'animals', 'Cat', 'Series', 'artist', '1234');"><img src="https://evil.test/x"></div>`;
  assert.equal(communityIcons(community)[0].url, 'https://yotoicons.com/static/uploads/123.png');
  assert.equal(communityIcons(community)[0].author, 'artist');
  assert.equal(communityIcons(community.replace("'123'", "'../secret'")).length, 0);
  assert.deepEqual(
    personalIcons({
      displayIcons: [
        { url: 'https://evil.test/a', displayIconId: 'x' },
        { url: 'https://card-content.yotoplay.com/icons/a.png', displayIconId: 'good' },
      ],
    }).map((i) => i.id),
    ['good'],
  );
});

test('remote responses enforce streaming limits, status and no redirects', async () => {
  await assert.rejects(
    remoteData(async () => new Response('too long'), 'https://example.test', { limit: 3 }),
    /too much/,
  );
  await assert.rejects(
    remoteData(async () => new Response('denied', { status: 401 }), 'https://example.test'),
    /401/,
  );
  await remoteData(async (_u, o) => {
    assert.equal(o.redirect, 'error');
    return new Response('ok');
  }, 'https://example.test');
});

test('icon search caches downloads and scopes selections to editor and signed-in account generation', async () => {
  let calls = 0;
  const account = {
    generation: 1,
    status: { connected: true },
    accessToken: async () => 'private-token',
  };
  const service = new IconCatalog({
    account,
    normalize: (b) => b,
    fetcher: async (u) => {
      calls++;
      return new Response(
        u.includes('using-icons')
          ? html
          : u.includes('/user/me')
            ? JSON.stringify({
                displayIcons: [
                  {
                    displayIconId: 'personal',
                    url: `https://card-content.yotoplay.com/yoto/${id}`,
                  },
                ],
              })
            : Buffer.from('png'),
      );
    },
  });
  const result = await service.search('session', 'yoto', 'music');
  assert.equal(result.items.length, 1);
  await service.search('session', 'yoto', 'music');
  assert.equal(calls, 2);
  assert.throws(() => service.take('other', result.items[0].key), /expired/);
  assert.equal(service.take('session', result.items[0].key).name, 'Music & notes');
  const personal = await service.search('session', 'personal');
  account.generation++;
  assert.throws(() => service.take('session', personal.items[0].key), /expired/);
  service.close('session');
  assert.throws(() => service.take('session', result.items[0].key), /expired/);
  await assert.rejects(service.search('session', 'untrusted', ''), /source/);
});

test('Yoto PKCE verifies state, stores encrypted tokens and serializes rotating refresh tokens', () =>
  temporary(async (folder) => {
    let authURL,
      exchanges = 0,
      refreshes = 0;
    const port = await unusedPort();
    const account = await new YotoAccount({
      folder,
      storage,
      port,
      openExternal: async (url) => {
        authURL = new URL(url);
      },
      fetcher: async (_url, options) => {
        const form = new URLSearchParams(options.body);
        if (form.get('grant_type') === 'authorization_code') {
          exchanges++;
          assert.equal(
            createHash('sha256').update(form.get('code_verifier')).digest('base64url'),
            authURL.searchParams.get('code_challenge'),
          );
          assert.equal(form.get('redirect_uri'), `http://127.0.0.1:${port}/callback`);
        } else {
          refreshes++;
          assert.equal(form.get('refresh_token'), 'secret-refresh');
        }
        return new Response(
          JSON.stringify({
            access_token: 'secret-access',
            refresh_token: refreshes ? 'rotated-refresh' : 'secret-refresh',
            expires_in: 3600,
          }),
        );
      },
    }).load();
    try {
      await account.connect('own-public-client');
      const callback = new URL(`http://127.0.0.1:${port}/callback`);
      callback.search = new URLSearchParams({ code: 'test-code', state: 'wrong' }).toString();
      assert.equal((await fetch(callback)).status, 400);
      assert.equal(exchanges, 0);
      callback.searchParams.set('state', authURL.searchParams.get('state'));
      assert.equal((await fetch(callback)).status, 200);
      await waitFor(() => account.status.connected && !account.status.connecting);
      const saved = await fs.readFile(account.file, 'utf8');
      assert.ok(!saved.includes('secret-refresh') && !saved.includes('secret-access'));
      assert.equal((await fs.stat(account.file)).mode & 0o777, 0o600);
      assert.ok(!JSON.stringify(account.status).includes('secret-'));
      account.tokens.expiresAt = 0;
      assert.deepEqual(
        await Promise.all([account.accessToken(), account.accessToken(), account.accessToken()]),
        Array(3).fill('secret-access'),
      );
      assert.equal(refreshes, 1);
      assert.equal(account.tokens.refresh_token, 'rotated-refresh');
      const restored = await new YotoAccount({ folder, storage }).load();
      assert.equal(restored.status.connected, true);
      await account.disconnect();
      assert.equal((await new YotoAccount({ folder, storage }).load()).status.connected, false);
      await assert.rejects(account.accessToken(), /Connect your Yoto/);
    } finally {
      account.cancel();
    }
  }));

test('Yoto refuses plaintext storage and cancellation closes the callback listener', () =>
  temporary(async (folder) => {
    const insecure = new YotoAccount({
      folder,
      storage: { ...storage, getSelectedStorageBackend: () => 'basic_text' },
    });
    await assert.rejects(insecure.connect('own-public-client'), /Secure credential/);
    const port = await unusedPort();
    const account = new YotoAccount({ folder, storage, port, openExternal: async () => {} });
    await account.connect('own-public-client');
    account.cancel();
    await assert.rejects(fetch(`http://127.0.0.1:${port}/callback`));
    assert.equal(account.status.connecting, false);
    assert.equal(account.status.connected, false);
  }));

test('cancelled credential saves cannot reconnect on restart or overwrite a newer sign-in', () =>
  temporary(async (folder) => {
    let newer;
    const account = new YotoAccount({
      folder,
      storage: {
        ...storage,
        encryptString(value) {
          if (JSON.parse(value).access_token === 'cancel-me')
            queueMicrotask(() => {
              account.cancel();
              newer = account.persist(
                {
                  access_token: 'new-access',
                  refresh_token: 'new-refresh',
                  expiresAt: Date.now() + 100000,
                },
                'new-public-client',
                account.generation,
              );
            });
          return storage.encryptString(value);
        },
      },
    });
    await assert.rejects(
      account.persist(
        { access_token: 'cancel-me', refresh_token: 'old-refresh', expiresAt: Date.now() + 100000 },
        'old-public-client',
        account.generation,
      ),
      /cancelled/,
    );
    await newer;
    const restored = await new YotoAccount({ folder, storage }).load();
    assert.equal(restored.tokens.access_token, 'new-access');
    assert.equal(restored.status.clientId, 'new-public-client');
    await account.disconnect();
    assert.equal((await new YotoAccount({ folder, storage }).load()).status.connected, false);
  }));

test('Yoto sign-in timeout and callback-port conflict release their listeners', () =>
  temporary(async (folder) => {
    const port = await unusedPort();
    const account = new YotoAccount({
      folder,
      storage,
      port,
      timeout: 25,
      openExternal: async () => {},
    });
    await account.connect('own-public-client');
    await waitFor(() => !account.status.connecting);
    assert.match(account.status.error, /timed out/);
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    try {
      await assert.rejects(account.connect('own-public-client'), /in use/);
      assert.equal(account.status.connecting, false);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  }));

test('a personal icon request cannot return selections from an account that changed during loading', async () => {
  let finish, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const account = {
    generation: 1,
    status: { connected: true },
    accessToken: async () => 'old-token',
  };
  const catalog = new IconCatalog({
    account,
    normalize: (bytes) => bytes,
    fetcher: async () => {
      started();
      await new Promise((resolve) => {
        finish = resolve;
      });
      return new Response(JSON.stringify({ displayIcons: [] }));
    },
  });
  const request = catalog.search('editor', 'personal');
  await ready;
  account.generation++;
  finish();
  await assert.rejects(request, /connection changed/);
  assert.equal(catalog.results.size, 0);
});

test('public catalogue uses its canonical URL and community searches fetch subsequent result pages', async () => {
  const urls = [];
  const service = new IconCatalog({
    normalize: (bytes) => bytes,
    fetcher: async (url) => {
      urls.push(url);
      if (url.includes('yoto.dev')) {
        assert.equal(url, 'https://yoto.dev/icons/using-icons/');
        return new Response(html);
      }
      if (url.includes('/icons?')) {
        const page = new URL(url).searchParams.get('page');
        const icon = page === '1' ? '11' : '12';
        return new Response(
          `populate_icon_modal('${icon}', 'animals', 'Cat', 'Series', 'artist', '1'); if ((25 * page) < 50) {}`,
        );
      }
      return new Response('png');
    },
  });
  await service.search('editor', 'yoto');
  const first = await service.search('editor', 'community', 'cat');
  const second = await service.search('editor', 'community', 'cat', 1);
  assert.equal(first.more, true);
  assert.equal(second.more, false);
  assert.ok(urls.some((url) => url.includes('page=2')));
  assert.ok(urls.some((url) => url.endsWith('/12.png')));
});
