import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError } from './sessions.js';
import { createPasswordService, type PasswordService } from './passwords.js';

// Every fixture is deliberately absent from the SHA-256 common-password denylist: a password refused
// as "too common" would prove nothing about the length and Unicode rules asserted below. Note that
// repeated-character strings such as `aaaaaa` ARE on that list, so they cannot be used here.
const sixCodePoints = 'Syn-新7';
const twentyCodePoints = 'fixture-密码-20-abcdef';
// Hashed under the earlier 15–128 rule, so it can only be re-derived through rehashVerified.
const legacyThirty = '旧规则-15-128-密码-fixture-2026-abc';
const legacyFifteen = 'legacy pw 2026!';
let service: PasswordService | undefined;
const passwords = async () => (service ??= await createPasswordService());
// A refusal is pinned by code AND status: the two password errors are both 400, so the code is the
// only thing that distinguishes a length/Unicode policy failure from the unchanged denylist check.
const refused = (expected: string, status = 400) => (error: unknown) =>
  error instanceof AuthError && error.code === expected && error.status === status;

test('a password being set now is bounded at 6–20 code points', async () => {
  const api = await passwords();
  api.validateNew(sixCodePoints);
  api.validateNew(twentyCodePoints);
  // Length is counted in code points, not UTF-16 units: 20 astral characters are 40 units and are
  // still accepted, while the 21st code point is refused even though the raw string is far under the
  // 256-character cap.
  api.validateNew('🌙'.repeat(20));
  assert.throws(() => api.validateNew('🌙'.repeat(21)), refused('AUTH_PASSWORD_POLICY'));
  assert.throws(() => api.validateNew('Syn-新'), refused('AUTH_PASSWORD_POLICY'));
  assert.throws(() => api.validateNew(twentyCodePoints + 'z'), refused('AUTH_PASSWORD_POLICY'));
  // Both operands below are exactly 20 code points, so only the unpaired-surrogate rule can refuse
  // them: a lone high surrogate and a lone low surrogate are rejected in either position.
  assert.equal([...('a'.repeat(19) + '\uD800')].length, 20);
  assert.throws(() => api.validateNew('a'.repeat(19) + '\uD800'), refused('AUTH_PASSWORD_POLICY'));
  assert.throws(() => api.validateNew('\uDC00' + 'a'.repeat(19)), refused('AUTH_PASSWORD_POLICY'));
});

test('a 30-code-point password stored under the old rule keeps signing in', async () => {
  const api = await passwords();
  assert.equal([...legacyThirty].length, 30);
  assert.equal([...legacyFifteen].length, 15);
  // The stored hash is produced by the module's own hashing entry point for a presented credential,
  // never hardcoded, so this proves verification rather than a fixture artefact.
  const stored = await api.rehashVerified(legacyThirty);
  assert.equal(await api.verify(legacyThirty, stored), true);
  assert.equal(await api.verify(legacyFifteen, await api.rehashVerified(legacyFifteen)), true);
  assert.equal(await api.verify(legacyThirty + 'x', stored), false);
  // No stored credential is a denial even though dummy verification still runs, and 128 code points
  // stays well formed for proving a credential while 129 does not reach the hasher at all.
  assert.equal(await api.verify(legacyThirty, undefined), false);
  assert.equal(await api.verify('a'.repeat(128), stored), false);
  assert.equal(await api.verify('a'.repeat(129), stored), false);
  // The same 30 code points cannot be chosen or set now; validateNew runs before any hashing work.
  assert.throws(() => api.validateNew(legacyThirty), refused('AUTH_PASSWORD_POLICY'));
  await assert.rejects(() => api.hash(legacyThirty), refused('AUTH_PASSWORD_POLICY'));
});

test('a common password is refused only while a password is being set', async () => {
  const api = await passwords();
  // '123456' is exactly 6 code points, so this refusal can only come from the denylist.
  assert.throws(() => api.validateNew('123456'), refused('AUTH_PASSWORD_TOO_COMMON'));
  // The list is consulted case-insensitively, and setting a new password is the only path that uses it.
  assert.throws(() => api.validateNew('PASSWORD'), refused('AUTH_PASSWORD_TOO_COMMON'));
  await assert.rejects(() => api.hash('qwerty'), refused('AUTH_PASSWORD_TOO_COMMON'));
  assert.equal(await api.verify('password', await api.rehashVerified('password')), true);
  // Length is validated first: 'aaaaa' is also on the list but is reported as a policy failure.
  assert.throws(() => api.validateNew('aaaaa'), refused('AUTH_PASSWORD_POLICY'));
});
