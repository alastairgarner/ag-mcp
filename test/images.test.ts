import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { decodeImage, MAX_IMAGE_BYTES, MAX_IMAGE_BASE64_LENGTH } from '../src/images.js';
import { hash } from '../src/files.js';
import { png, jpeg, gif, webp } from './image-fixtures.js';

const images = [
  { extension: 'png', mimeType: 'image/png', base64: png },
  { extension: 'jpg', mimeType: 'image/jpeg', base64: jpeg },
  { extension: 'jpeg', mimeType: 'image/jpeg', base64: jpeg },
  { extension: 'gif', mimeType: 'image/gif', base64: gif },
  { extension: 'webp', mimeType: 'image/webp', base64: webp },
];

test('image formats are identified from bytes and must match lowercase extensions', () => {
  for (const { extension, mimeType, base64 } of images) {
    const decoded = decodeImage(`ai/attachments/image.${extension}`, base64);
    assert.equal(decoded.mimeType, mimeType);
    assert.equal(decoded.bytes.toString('base64'), base64);
    assert.throws(() => decodeImage('ai/attachments/mismatch.svg', base64), /extension/);
  }
  for (const base64 of ['', 'AA', 'AB==', png + '\n', ' ' + png, '!!!!', 'data:image/png;base64,' + png]) {
    assert.throws(() => decodeImage('ai/attachments/image.png', base64), /base64/);
  }
  for (const content of ['not an image', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'GIF89a', 'RIFF', '# Markdown']) {
    assert.throws(() => decodeImage('ai/attachments/image.png', Buffer.from(content).toString('base64')), /signature/);
  }
  for (const name of ['image.png', 'ai/image.png', 'AI/attachments/image.png', 'ai/Attachments/image.png', 'ai/attachments-other/image.png']) {
    assert.throws(() => decodeImage(name, png), /ai\/attachments/);
  }
  assert.throws(() => decodeImage('ai/attachments/image.jpg', png), /extension/);
  assert.throws(() => decodeImage('ai/attachments/image.PNG', png), /extension/);
  const atLimit = Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(MAX_IMAGE_BYTES - Buffer.from(png, 'base64').length)]);
  assert.equal(decodeImage('ai/attachments/limit.png', atLimit.toString('base64')).bytes.length, MAX_IMAGE_BYTES);
  assert.throws(() => decodeImage('ai/attachments/large.png', Buffer.concat([atLimit, Buffer.of(0)]).toString('base64')), /too large/);
  assert.throws(() => decodeImage('ai/attachments/large.png', 'A'.repeat(MAX_IMAGE_BASE64_LENGTH + 4)), /too large/);
});

test('image publication is contained, atomic no-clobber, queued and separate from Markdown', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-images-'));
  const root = path.join(base, 'notes');
  await fs.mkdir(root);
  const brain = await Brain.open(root, path.join(base, 'state'), { maxPendingOperations: 2 });
  t.after(async () => { await brain.close(); await fs.rm(base, { recursive: true, force: true }); });
  await assert.rejects(brain.createAttachment('ai/attachments/image.png', png), /ENOENT/);
  await assert.rejects(fs.stat(path.join(root, 'ai')), /ENOENT/);
  const directory = path.join(root, 'ai', 'attachments');
  await fs.mkdir(path.join(directory, 'nested'), { recursive: true });
  for (const { extension, base64, mimeType } of images) {
    const name = `ai/attachments/nested/image.${extension}`;
    const result = await brain.createAttachment(name, base64);
    assert.equal(result.path, name);
    assert.equal(result.committed, true);
    assert.equal(result.bytes, Buffer.from(base64, 'base64').length);
    assert.equal(result.mimeType, mimeType);
    assert.equal(result.hash, hash(Buffer.from(base64, 'base64')));
    assert.deepEqual(await fs.readFile(path.join(root, name)), Buffer.from(base64, 'base64'));
    assert.equal((await fs.stat(path.join(root, name))).mode & 0o777, 0o600);
    await assert.rejects(brain.createAttachment(name, base64), /EEXIST/);
    await assert.rejects(brain.read(name), /\.md/);
    await assert.rejects(brain.edit(name, result.hash, [{ oldText: 'x', newText: 'y' }]), /\.md/);
  }
  assert.deepEqual((await brain.list()).paths, []);
  assert.equal((await brain.refresh()).freshness.state, 'snapshot');
  const outcomes = await Promise.allSettled([1, 2].map(() => brain.createAttachment('ai/attachments/race.png', png)));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const held = brain.read('missing.md');
  const queued = brain.createAttachment('ai/attachments/queued.png', png);
  await assert.rejects(brain.createAttachment('ai/attachments/busy.png', png), /Server busy/);
  await assert.rejects(held, /ENOENT/);
  await queued;
  await assert.rejects(fs.stat(path.join(directory, 'busy.png')), /ENOENT/);
  await assert.rejects(brain.create('ai/not-an-image.png', 'text'), /\.md/);
  await fs.writeFile(path.join(root, 'existing.md'), 'old');
  const note = await brain.read('existing.md');
  await brain.edit('existing.md', note.hash, [{ oldText: 'old', newText: '![[ai/attachments/race.png]]' }]);
  assert.equal((await brain.read('existing.md')).content, '![[ai/attachments/race.png]]');

  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.png'), Buffer.from(png, 'base64'));
  await fs.symlink(outside, path.join(directory, 'escape'));
  await fs.symlink(path.join(outside, 'secret.png'), path.join(directory, 'linked.png'));
  for (const name of [
    '../outside/new.png', '/ai/attachments/new.png', 'ai-other/new.png',
    'ai/attachments/../new.png', 'ai/attachments/../../new.png',
    'ai/attachments/./new.png', 'ai/attachments//new.png',
    'ai/attachments/.hidden.png', 'ai/attachments/a\\b.png', 'ai/attachments/a\0b.png',
    'ai/attachments/escape/new.png', 'ai/attachments/linked.png',
    'ai/attachments/missing/new.png', 'ai/attachments/package.json', 'ai/attachments/note.md',
    'ai/attachments/' + 'a'.repeat(1024) + '.png',
  ]) await assert.rejects(brain.createAttachment(name, png), name);
  await fs.link(path.join(outside, 'secret.png'), path.join(directory, 'hard.png'));
  await assert.rejects(brain.createAttachment('ai/attachments/hard.png', png), /EEXIST/);
  assert.deepEqual(await fs.readFile(path.join(outside, 'secret.png')), Buffer.from(png, 'base64'));
  await assert.rejects(fs.stat(path.join(outside, 'new.png')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(directory, 'missing')), /ENOENT/);
  await fs.unlink(path.join(directory, 'hard.png'));
  assert.ok(!(await fs.readdir(directory)).some(name => name.endsWith('.tmp')));
  await fs.rename(directory, path.join(root, 'ai', 'saved-attachments'));
  await fs.symlink(outside, directory);
  await assert.rejects(brain.createAttachment('ai/attachments/new.png', png));
  await assert.rejects(fs.stat(path.join(outside, 'new.png')), /ENOENT/);
});

test('images share collection budgets with notes; unrelated vault images stay outside upload budgets', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-image-budget-'));
  const root = path.join(base, 'notes');
  await fs.mkdir(path.join(root, 'ai', 'attachments'), { recursive: true });
  const size = Buffer.from(png, 'base64').length;
  const brain = await Brain.open(root, path.join(base, 'state'), { maxCollectionFiles: 2, maxCollectionBytes: size + 3 });
  t.after(async () => { await brain.close(); await fs.rm(base, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'existing.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
  await brain.createAttachment('ai/attachments/image.png', png);
  const note = await brain.create('ai/note.md', 'abc');
  await assert.rejects(brain.createAttachment('ai/attachments/rejected.png', png), /Collection file limit/);
  await assert.rejects(brain.edit('ai/note.md', note.hash, [{ oldText: 'abc', newText: 'abcd' }]), /Collection byte limit/);
  assert.equal((await brain.read('ai/note.md')).content, 'abc');
  await fs.unlink(path.join(root, 'ai', 'note.md'));
  await assert.rejects(brain.createAttachment('ai/attachments/rejected.png', png), /Collection byte limit/);
  await assert.rejects(fs.stat(path.join(root, 'ai', 'attachments', 'rejected.png')), /ENOENT/);
});
