import assert from 'node:assert/strict';
import test from 'node:test';
import { verifiedAccountSessionSchema } from './account-session.js';

const valid = () => ({
  subjectId: 'account-a',
  subjectKind: 'adult' as const,
  sessionId: 'session-a',
  expiresAt: '2026-09-14T00:00:00.000Z',
});

test('verified session contains identity only and accepts adult or child subjects', () => {
  assert.deepEqual(verifiedAccountSessionSchema.parse(valid()), valid());
  assert.equal(verifiedAccountSessionSchema.safeParse({...valid(), subjectKind: 'child'}).success, true);
});

for (const value of [
  {...valid(), role: 'owner'},
  {...valid(), spaceId: 'private-space'},
  {...valid(), subjectId: ' account-a'},
  {...valid(), sessionId: ''},
  {...valid(), subjectKind: 'admin'},
  {...valid(), expiresAt: 'tomorrow'},
]) {
  test(`verified session rejects authority or malformed identity: ${JSON.stringify(value)}`, () => {
    assert.equal(verifiedAccountSessionSchema.safeParse(value).success, false);
  });
}
