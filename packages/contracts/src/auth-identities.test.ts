import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailLoginMethodId, emailLoginMethodIdSchema, parseEmailLoginMethodId, unlinkIdentityRequestSchema } from './auth-identities.js';

const rowId = '17898741-d6e6-4e64-b76b-927c2169a3e0';
const grant = rowId + '.' + 'A'.repeat(43);

test('the unbind handle is exactly one lower-case email UUID and never an Apple handle', () => {
  assert.equal(emailLoginMethodId(rowId), `email:${rowId}`);
  assert.equal(emailLoginMethodIdSchema.safeParse(`email:${rowId}`).success, true);
  assert.equal(parseEmailLoginMethodId(`email:${rowId}`), rowId);
  for (const value of [`apple:${rowId}`, `email:${rowId.toUpperCase()}`, `email:${rowId} `, `email:${rowId}${rowId}`,
    'email:', 'email:not-a-uuid', `email:urn:${rowId}`, rowId, '', 'email:17898741-d6e6-4e64-b76b-927c2169a3eZ'])
    assert.equal(parseEmailLoginMethodId(value), null, value);
});

test('the unbind body accepts one reauth grant and nothing else', () => {
  assert.deepEqual(unlinkIdentityRequestSchema.parse({reauthGrant: grant}), {reauthGrant: grant});
  for (const invalid of [{}, {reauthGrant: 'not-a-grant'}, {reauthGrant: `email:${rowId}`},
    {reauthGrant: grant, identityId: `email:${rowId}`}, {reauthGrant: grant, subjectId: rowId},
    {reauthGrant: grant, action: 'unlink-identity'}, {reauthGrant: grant, grant}, null, [], undefined])
    assert.equal(unlinkIdentityRequestSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});
