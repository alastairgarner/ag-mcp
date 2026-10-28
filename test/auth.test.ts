import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TokenAuth, hashToken } from '../src/auth.js';

const makeToken = () => randomBytes(32).toString('hex');
const configFor = (token: string, name = 'agent') => ({ version: 1, tokens: [{ name, sha256: hashToken(token) }] });

test('named token hashes authenticate with constant-length digest comparison, not plaintext credentials', () => {
  const a = makeToken();
  const b = makeToken();
  const auth = TokenAuth.parse({ version: 1, tokens: [...configFor(a, 'agent-a').tokens, ...configFor(b, 'agent-b').tokens] });
  assert.deepEqual(auth.authenticate([`Bearer ${a}`]), { name: 'agent-a' });
  assert.deepEqual(auth.authenticate([`bearer ${b}`]), { name: 'agent-b' });
  assert.deepEqual(auth.authenticate([`BEARER  ${b}`]), { name: 'agent-b' });
  for (const headers of [undefined, [], [''], [`Bearer ${makeToken()}`], [`Bearer ${a}`, `Bearer ${b}`], [`Basic ${a}`], [`Bearer ${hashToken(a)}`], ['Bearer short'], [`Bearer ${a} trailing`]]) {
    assert.equal(auth.authenticate(headers), undefined);
  }
  assert.equal(hashToken(a), createHash('sha256').update(a).digest('hex'));
});

test('auth configuration fails closed without leaking malformed configuration values', () => {
  const token = makeToken();
  const entry = { name: 'agent', sha256: hashToken(token) };
  for (const input of [undefined, {}, { version: 1, tokens: [] }, { version: 2, tokens: [entry] },
    { version: 1, tokens: [{ name: 'agent', token }] },
    { version: 1, tokens: [{ name: 'agent', sha256: 'plaintext-' + token }] },
    { version: 1, tokens: [entry], ignored: true },
    { version: 1, tokens: [entry, entry] },
    { version: 1, tokens: [entry, { name: 'other', sha256: entry.sha256 }] },
    { version: 1, tokens: [entry, { name: 'agent', sha256: hashToken(makeToken()) }] },
  ]) {
    assert.throws(() => TokenAuth.parse(input), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(token));
      return true;
    });
  }
});

test('manual config rotation/revocation takes effect when config is loaded again', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-auth-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'auth.json');
  const oldToken = makeToken();
  const newToken = makeToken();
  await fs.writeFile(file, JSON.stringify(configFor(oldToken)), { mode: 0o600 });
  const initial = await TokenAuth.fromFile(file);
  await fs.writeFile(file, JSON.stringify(configFor(newToken)));
  const reloaded = await TokenAuth.fromFile(file);
  assert.deepEqual(initial.authenticate([`Bearer ${oldToken}`]), { name: 'agent' });
  assert.equal(reloaded.authenticate([`Bearer ${oldToken}`]), undefined);
  assert.deepEqual(reloaded.authenticate([`Bearer ${newToken}`]), { name: 'agent' });
  await fs.writeFile(file, '{broken-json-' + oldToken);
  await assert.rejects(TokenAuth.fromFile(file), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(oldToken));
    return true;
  });
  await fs.writeFile(file, ' '.repeat(64 * 1024 + 1));
  await assert.rejects(TokenAuth.fromFile(file), /64 KiB/);
  await fs.symlink(file, path.join(base, 'link.json'));
  await assert.rejects(TokenAuth.fromFile(path.join(base, 'link.json')));
  await assert.rejects(TokenAuth.fromFile(path.join(base, 'absent.json')));
});

test('token-hash helper accepts stdin, outputs only SHA-256, and never echoes invalid secrets', () => {
  const token = makeToken();
  const script = fileURLToPath(new URL('../src/token-hash.js', import.meta.url));
  const valid = spawnSync(process.execPath, [script], { input: token + '\n', encoding: 'utf8' });
  assert.equal(valid.status, 0);
  assert.equal(valid.stdout, hashToken(token) + '\n');
  assert.equal(valid.stderr, '');
  for (const input of [token + ' invalid', token.repeat(10), '']) {
    const invalid = spawnSync(process.execPath, [script], { input, encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.ok(!invalid.stderr.includes(token));
  }
});

test('HTTP entrypoint refuses absent/invalid config even with the old unauthenticated flag', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-auth-startup-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'notes');
  const state = path.join(base, 'state');
  const config = path.join(base, 'auth.json');
  const token = makeToken();
  await fs.mkdir(root);
  await fs.writeFile(config, JSON.stringify({ version: 1, tokens: [{ name: 'agent', token }] }));
  const script = fileURLToPath(new URL('../src/http-main.js', import.meta.url));
  for (const authConfig of [undefined, config, path.join(base, 'absent.json')]) {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, NOTES_ROOT: root, STATE_DIR: state, AUTH_CONFIG: authConfig, ALLOW_UNAUTHENTICATED_HTTP: '1' },
    });
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));
    await assert.rejects(fs.stat(path.join(root, '.brain-writer.lock')), /ENOENT/);
    await assert.rejects(fs.stat(state), /ENOENT/);
  }
});
