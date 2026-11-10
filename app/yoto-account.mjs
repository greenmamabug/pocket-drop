// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { writeJson } from './atomic-json.mjs';
import { remoteData } from './remote-data.mjs';

export const YOTO_SETUP = 'https://yoto.dev/authentication/headless-cli-auth';
export const YOTO_REDIRECT = 'http://127.0.0.1:8787/callback';
const TOKEN_URL = 'https://login.yotoplay.com/oauth/token';

export class YotoAccount {
  constructor({
    folder,
    storage,
    openExternal,
    fetcher = fetch,
    changed = () => {},
    port = 8787,
    timeout = 300000,
  }) {
    Object.assign(this, { storage, openExternal, fetcher, changed, port, timeout });
    this.file = path.join(folder, 'yoto-account.json');
    this.status = { connected: false, connecting: false, clientId: '' };
    this.queue = Promise.resolve();
    this.saving = Promise.resolve();
    this.generation = 0;
  }
  secure() {
    return (
      this.storage?.isEncryptionAvailable() &&
      this.storage.getSelectedStorageBackend?.() !== 'basic_text'
    );
  }
  publish(patch = {}) {
    Object.assign(this.status, patch, { secureStorage: !!this.secure() });
    this.changed({ ...this.status });
    return { ...this.status };
  }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!/^[\w-]{8,200}$/.test(data.clientId)) throw new Error('Invalid saved Yoto setup.');
      this.status.clientId = data.clientId;
      if (data.encrypted && this.secure()) {
        const tokens = JSON.parse(
          this.storage.decryptString(Buffer.from(data.encrypted, 'base64')),
        );
        if (typeof tokens.refresh_token !== 'string' || !Number.isFinite(tokens.expiresAt))
          throw new Error('Invalid saved Yoto connection.');
        this.tokens = tokens;
        this.status.connected = true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT')
        this.status.error = 'Reconnect your Yoto account to use personal icons.';
    }
    this.publish();
    return this;
  }
  persist(tokens, clientId, generation) {
    const operation = this.saving
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation) throw new Error('Yoto connection cancelled.');
        if (!this.secure())
          throw new Error(
            'Secure credential storage is unavailable. Enable macOS Keychain and try again.',
          );
        const encrypted = this.storage.encryptString(JSON.stringify(tokens)).toString('base64');
        await writeJson(this.file, { clientId, encrypted });
        await fs.chmod(this.file, 0o600);
        if (generation !== this.generation) {
          // Remove a cancelled save before the next generation can persist credentials.
          await writeJson(this.file, { clientId: this.status.clientId });
          throw new Error('Yoto connection cancelled.');
        }
        this.tokens = tokens;
        this.publish({ connected: true, clientId, error: null });
      });
    this.saving = operation;
    return operation;
  }
  async exchange(fields, generation) {
    const data = JSON.parse(
      (
        await remoteData(this.fetcher, TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields).toString(),
          limit: 64000,
        })
      ).toString(),
    );
    if (generation !== this.generation) throw new Error('Yoto connection cancelled.');
    if (
      typeof data.access_token !== 'string' ||
      data.access_token.length > 32000 ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new Error('Yoto returned an incomplete connection. Please sign in again.');
    const refresh_token = data.refresh_token ?? this.tokens?.refresh_token;
    if (typeof refresh_token !== 'string' || refresh_token.length > 32000)
      throw new Error('Yoto did not grant offline access. Please sign in again.');
    return {
      access_token: data.access_token,
      refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }
  async connect(clientId) {
    if (typeof clientId !== 'string' || !/^[\w-]{8,200}$/.test(clientId.trim()))
      throw new Error('Enter your Yoto public client ID from the developer dashboard.');
    if (!this.secure())
      throw new Error(
        'Secure credential storage is unavailable. Enable macOS Keychain and try again.',
      );
    if (this.status.connecting) throw new Error('Yoto sign-in is already open in your browser.');
    if (this.disconnecting) throw new Error('Wait for Yoto to disconnect before signing in again.');
    if (this.status.connected) throw new Error('Disconnect before changing Yoto accounts.');
    clientId = clientId.trim();
    const generation = ++this.generation;
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const redirect = `http://127.0.0.1:${this.port}/callback`;
    const server = http.createServer((req, res) => {
      const reply = (status, message) => {
        res.writeHead(status, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(message);
      };
      if (
        req.method !== 'GET' ||
        req.url.length > 8192 ||
        req.headers.host !== `127.0.0.1:${this.port}`
      )
        return reply(400, 'Invalid callback.');
      const url = new URL(req.url, redirect);
      const received = url.searchParams.get('state') ?? '';
      if (
        url.pathname !== '/callback' ||
        !/^[\w-]{43}$/.test(received) ||
        !timingSafeEqual(Buffer.from(received), Buffer.from(state))
      )
        return reply(400, 'Invalid sign-in state. Return to the original sign-in page.');
      if (generation !== this.generation || this.exchanging)
        return reply(409, 'This sign-in has ended.');
      this.exchanging = true;
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) {
        reply(400, 'Sign-in was not completed. You can try again in Pocket Drop.');
        this.finish('Yoto sign-in was not completed.');
        return;
      }
      reply(200, 'You can return to Pocket Drop. Finishing your Yoto connection…');
      this.stopServer(true);
      this.authTask = this.exchange(
        {
          grant_type: 'authorization_code',
          client_id: clientId,
          code_verifier: verifier,
          code,
          redirect_uri: redirect,
        },
        generation,
      )
        .then((tokens) => this.persist(tokens, clientId, generation))
        .then(() => {
          if (generation === this.generation) this.finish();
        })
        .catch(() => {
          if (generation === this.generation)
            this.finish(
              'Yoto sign-in could not finish. Check your client ID and registered callback, then try again.',
            );
        });
    });
    server.maxHeadersCount = 30;
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    this.server = server;
    this.exchanging = false;
    this.publish({ connecting: true, clientId, error: null });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, '127.0.0.1', resolve);
      });
      if (generation !== this.generation) {
        server.close();
        server.closeAllConnections?.();
        if (this.server === server) this.server = null;
        return this.publish();
      }
      this.timer = setTimeout(
        () => this.cancel('Yoto sign-in timed out. Please try again.'),
        this.timeout,
      );
      this.timer.unref?.();
      const url = new URL('https://login.yotoplay.com/authorize');
      url.search = new URLSearchParams({
        audience: 'https://api.yotoplay.com',
        scope: 'user:icons:manage offline_access',
        response_type: 'code',
        client_id: clientId,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        redirect_uri: redirect,
        state,
      }).toString();
      await this.openExternal(url.href);
    } catch (error) {
      this.cancel();
      throw new Error(
        error.code === 'EADDRINUSE'
          ? 'Yoto sign-in port 8787 is in use. Close the other sign-in window/app and try again.'
          : 'Could not open Yoto sign-in. Try again.',
      );
    }
    return this.publish();
  }
  stopServer(graceful = false) {
    clearTimeout(this.timer);
    this.server?.close();
    if (graceful) this.server?.closeIdleConnections?.();
    else this.server?.closeAllConnections?.();
    this.server = null;
  }
  finish(error = null) {
    this.stopServer();
    this.publish({ connecting: false, error });
  }
  cancel(error = null) {
    ++this.generation;
    this.finish(error);
  }
  async disconnect() {
    this.disconnecting = true;
    this.cancel();
    this.tokens = null;
    this.publish({ connected: false, disconnecting: true });
    try {
      await this.queue.catch(() => {});
      await this.authTask?.catch(() => {});
      await this.saving.catch(() => {});
      await writeJson(this.file, { clientId: this.status.clientId });
    } finally {
      this.disconnecting = false;
      this.publish({ connected: false, disconnecting: false, error: null });
    }
  }
  accessToken() {
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        if (!this.status.connected || !this.tokens)
          throw new Error('Connect your Yoto account in Settings to browse personal icons.');
        if (this.tokens.expiresAt > Date.now() + 30000) return this.tokens.access_token;
        const generation = this.generation;
        try {
          const tokens = await this.exchange(
            {
              grant_type: 'refresh_token',
              client_id: this.status.clientId,
              refresh_token: this.tokens.refresh_token,
            },
            generation,
          );
          await this.persist(tokens, this.status.clientId, generation);
          return tokens.access_token;
        } catch {
          if (generation === this.generation) {
            this.tokens = null;
            this.publish({ connected: false, error: 'Reconnect Yoto to browse personal icons.' });
          }
          throw new Error('Yoto connection expired. Reconnect in Settings.');
        }
      });
    this.queue = operation;
    return operation;
  }
}
