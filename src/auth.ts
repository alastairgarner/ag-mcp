import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_CONFIG_BYTES = 64 * 1024;
const configSchema = z.object({
  version: z.literal(1),
  tokens: z.array(z.object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(128),
}).strict();

export function hashToken(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error('Token must contain 32–256 URL-safe characters (letters, numbers, underscore, hyphen)');
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class TokenAuth {
  private constructor(private readonly entries: { name: string; digest: Buffer }[]) {}

  static parse(input: unknown): TokenAuth {
    const parsed = configSchema.safeParse(input);
    // Never include validation input: an admin might accidentally paste a raw token.
    if (!parsed.success) throw new Error('Invalid auth config: expected version 1 and 1–128 named SHA-256 token hashes');
    const names = new Set<string>();
    const hashes = new Set<string>();
    for (const entry of parsed.data.tokens) {
      if (names.has(entry.name) || hashes.has(entry.sha256)) throw new Error('Auth config requires unique names and unique token hashes');
      names.add(entry.name);
      hashes.add(entry.sha256);
    }
    return new TokenAuth(parsed.data.tokens.map(entry => ({ name: entry.name, digest: Buffer.from(entry.sha256, 'hex') })));
  }

  static async fromFile(file: string): Promise<TokenAuth> {
    // Config is administrator-owned, loaded once at startup, never stored in the index.
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error('Auth config must be a regular file of at most 64 KiB');
      const content = await handle.readFile();
      if (content.length > MAX_CONFIG_BYTES) throw new Error('Auth config exceeds 64 KiB');
      let input: unknown;
      try { input = JSON.parse(content.toString('utf8')); }
      catch { throw new Error('Auth config is not valid JSON'); }
      return TokenAuth.parse(input);
    } finally { await handle.close(); }
  }

  authenticate(authorization: readonly string[] | undefined): { name: string } | undefined {
    // headersDistinct preserves duplicate headers that Node's normalized headers discard.
    if (!authorization || authorization.length !== 1) return undefined;
    const [header] = authorization;
    if (!header) return undefined;
    const match = /^Bearer +([A-Za-z0-9_-]{32,256})$/i.exec(header);
    const token = match?.[1];
    if (!token) return undefined;
    const digest = Buffer.from(hashToken(token), 'hex');
    let principal: { name: string } | undefined;
    for (const entry of this.entries) {
      if (timingSafeEqual(digest, entry.digest)) principal = { name: entry.name };
    }
    return principal;
  }
}
