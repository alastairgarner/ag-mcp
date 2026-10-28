import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitsFromEnv, limitsSchema } from '../src/limits.js';

test('resource defaults are finite and environment overrides are validated', () => {
  const defaults = limitsFromEnv({});
  assert.equal(defaults.maxPendingOperations, 8);
  assert.equal(defaults.maxHttpRequests, 8);
  assert.equal(defaults.maxHttpConnections, 32);
  assert.equal(defaults.maxCollectionBytes, 64 * 1024 * 1024);
  const overridden = limitsFromEnv({ MAX_PENDING_OPERATIONS: '2', MAX_COLLECTION_BYTES: '1024' });
  assert.equal(overridden.maxPendingOperations, 2);
  assert.equal(overridden.maxCollectionBytes, 1024);
  for (const input of ['0', '-1', 'Infinity', 'NaN', '1.5', '99999999999999', '']) {
    assert.throws(() => limitsFromEnv({ MAX_HTTP_REQUESTS: input }));
  }
  assert.throws(() => limitsSchema.parse({ maxPendingOperations: 0 }));
  assert.throws(() => limitsSchema.parse({ ignored: true }));
});
