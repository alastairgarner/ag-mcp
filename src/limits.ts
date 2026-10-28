import { z } from 'zod';

export const limitsSchema = z.object({
  maxPendingOperations: z.coerce.number().int().min(1).max(256).default(8),
  maxHttpRequests: z.coerce.number().int().min(1).max(64).default(8),
  maxHttpConnections: z.coerce.number().int().min(1).max(256).default(32),
  maxCollectionFiles: z.coerce.number().int().min(1).max(100_000).default(10_000),
  maxCollectionBytes: z.coerce.number().int().min(1).max(1024 * 1024 * 1024).default(64 * 1024 * 1024),
  maxScanEntries: z.coerce.number().int().min(1).max(200_000).default(20_000),
  maxScanDepth: z.coerce.number().int().min(1).max(64).default(32),
}).strict();
export type ResourceLimits = Readonly<z.output<typeof limitsSchema>>;

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): ResourceLimits {
  return limitsSchema.parse({
    maxPendingOperations: env.MAX_PENDING_OPERATIONS,
    maxHttpRequests: env.MAX_HTTP_REQUESTS,
    maxHttpConnections: env.MAX_HTTP_CONNECTIONS,
    maxCollectionFiles: env.MAX_COLLECTION_FILES,
    maxCollectionBytes: env.MAX_COLLECTION_BYTES,
    maxScanEntries: env.MAX_SCAN_ENTRIES,
    maxScanDepth: env.MAX_SCAN_DEPTH,
  });
}

// UTF-16 code-unit caps for display text; references are never shortened.
export const MAX_SEARCH_TITLE_LENGTH = 256;
export const MAX_SEARCH_EXCERPT_LENGTH = 400;
export const MAX_SEARCH_DATA_BYTES = 32 * 1024;
// The SDK repeats structured data as escaped text; reserve room for both and JSON-RPC.
export const MAX_SEARCH_RESPONSE_BYTES = 128 * 1024;
export const MAX_NOTE_PATH_BYTES = 1024;
