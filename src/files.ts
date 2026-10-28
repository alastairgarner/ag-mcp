import { constants as C } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BinaryLike } from 'node:crypto';
import { hasErrorCode } from './errors.js';
import { limitsSchema, MAX_NOTE_PATH_BYTES } from './limits.js';
import type { ResourceLimits } from './limits.js';

export type ExactEdit = { oldText: string; newText: string };
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const hash = (content: BinaryLike) => createHash('sha256').update(content).digest('hex');
export const MAX_BYTES = 1024 * 1024;
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const directoryFlags = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;

// Linux dirfd anchoring: no check-then-follow ancestor symlink window.
export class Notes {
  static async open(root: string, limits: ResourceLimits = limitsSchema.parse({})) {
    if (process.platform !== 'linux') throw new Error('This prototype requires Linux /proc/self/fd');
    const absolute = path.resolve(root);
    if (await fs.realpath(absolute) !== absolute) throw new Error('Root must not contain symlinks');
    return new Notes(absolute, await fs.open(absolute, directoryFlags), limits);
  }
  private constructor(readonly root: string, private readonly handle: FileHandle, private readonly limits: ResourceLimits) {}
  private parts(name: string) {
    if (typeof name !== 'string' || name.includes('\\') || name.includes('\0') || path.isAbsolute(name)) throw new Error('Invalid path');
    if (Buffer.byteLength(name) > MAX_NOTE_PATH_BYTES) throw new Error('Note path exceeds 1024 bytes');
    const parts = name.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.')) || !name.endsWith('.md')) throw new Error('Use a relative, non-hidden .md path');
    return parts;
  }
  private async parent<T>(name: string, action: (target: string, parent: string) => Promise<T>): Promise<T> {
    const parts = this.parts(name);
    const handles: FileHandle[] = [];
    let parent = this.handle;
    try {
      for (const part of parts.slice(0, -1)) {
        parent = await fs.open(`${fdPath(parent)}/${part}`, directoryFlags);
        handles.push(parent);
      }
      return await action(`${fdPath(parent)}/${parts.at(-1)}`, fdPath(parent));
    } finally { for (const handle of handles.reverse()) await handle.close(); }
  }
  async read(name: string) {
    return this.parent(name, async target => {
      const handle = await fs.open(target, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Not a supported single-link Markdown file (max 1 MiB)');
        const bytes = await handle.readFile();
        if (bytes.length > MAX_BYTES) throw new Error('File too large');
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        return { path: name, content, hash: hash(bytes) };
      } finally { await handle.close(); }
    });
  }
  async size(name: string): Promise<number> {
    return this.parent(name, async target => {
      const handle = await fs.open(target, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Not a supported single-link Markdown file (max 1 MiB)');
        return stat.size;
      } finally { await handle.close(); }
    });
  }
  async list() {
    const notes: string[] = [];
    let scanned = 0;
    const walk = async (handle: FileHandle, prefix: string, depth: number): Promise<void> => {
      // Streaming iteration bounds memory even in directories with excessive entries.
      const directory = await fs.opendir(fdPath(handle));
      for await (const entry of directory) {
        if (++scanned > this.limits.maxScanEntries) throw new Error('Collection scan entry limit exceeded');
        if (entry.name.startsWith('.')) continue;
        const name = prefix + entry.name;
        if (Buffer.byteLength(name) > MAX_NOTE_PATH_BYTES) throw new Error('Collection path limit exceeded');
        if (entry.isDirectory()) {
          if (depth >= this.limits.maxScanDepth) throw new Error('Collection scan depth limit exceeded');
          const child = await fs.open(`${fdPath(handle)}/${entry.name}`, directoryFlags);
          try { await walk(child, name + '/', depth + 1); } finally { await child.close(); }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          if (notes.length >= this.limits.maxCollectionFiles) throw new Error('Collection file limit exceeded');
          notes.push(name);
        }
      }
    };
    await walk(this.handle, '', 0);
    return notes.sort();
  }
  async publish(name: string, content: string, create: boolean) {
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('File too large');
    return this.parent(name, async (target, parent) => {
      const temporary = `${parent}/.brain-${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      try {
        try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        if (create) await fs.link(temporary, target); // Atomic no-clobber publication.
        else await fs.rename(temporary, target);
        const dir = await fs.open(`${parent}/.`, directoryFlags);
        try { await dir.sync(); } finally { await dir.close(); }
      } finally { await fs.unlink(temporary).catch(error => { if (!hasErrorCode(error, 'ENOENT')) throw error; }); }
      return { path: name, hash: hash(content) };
    });
  }
  async acquireWriter() { await fs.mkdir(`${fdPath(this.handle)}/.brain-writer.lock`, { mode: 0o700 }); }
  async releaseWriter() { await fs.rmdir(`${fdPath(this.handle)}/.brain-writer.lock`); }
  async close() { await this.handle.close(); }
}

// All replacements refer to the ORIGINAL content, never preceding edits.
export function replaceExact(content: string, edits: readonly ExactEdit[]): string {
  const ranges = edits.map(({ oldText, newText }) => {
    if (!oldText) throw new Error('Empty oldText');
    const start = content.indexOf(oldText);
    if (start < 0 || content.indexOf(oldText, start + 1) >= 0) throw new Error('oldText must match exactly once');
    return { start, end: start + oldText.length, newText };
  }).sort((a, b) => a.start - b.start);
  let previousEnd = 0;
  for (const range of ranges) {
    if (range.start < previousEnd) throw new Error('Overlapping replacements');
    previousEnd = range.end;
  }
  for (const r of ranges.reverse()) content = content.slice(0, r.start) + r.newText + content.slice(r.end);
  return content;
}
