import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

// Evaluate the real helper out of the component file; the component itself needs React Native.
const source = readFileSync(new URL('../src/ui/password-rules.tsx', import.meta.url), 'utf8');
const start = source.indexOf('export function passwordRuleState');
const end = source.indexOf('/* --- component --- */');
assert.ok(start >= 0 && end > start, 'passwordRuleState must stay extractable from password-rules.tsx');
const helper = source.slice(start, end).replace('export function', 'function');
const passwordRuleState = runInNewContext(`${stripTypeScriptTypes(helper)}\npasswordRuleState`);

test('password length counts Unicode code points rather than UTF-16 units', () => {
  assert.equal(passwordRuleState('12345', undefined, 6, 20).length, 5);
  assert.equal(passwordRuleState('a'.repeat(20), undefined, 6, 20).length, 20);
  assert.equal(passwordRuleState('😀😀😀😀😀😀', undefined, 6, 20).length, 6);
  assert.equal(passwordRuleState('𝄞𝄞𝄞', undefined, 6, 20).length, 3);
  assert.equal(passwordRuleState('密'.repeat(8) + '码', undefined, 6, 20).length, 9);
});

test('the length rule is inclusive at both bounds and rejects everything outside them', () => {
  const at = (length) => passwordRuleState('x'.repeat(length), undefined, 6, 20);
  assert.equal(at(5).lengthOk, false);
  assert.equal(at(6).lengthOk, true);
  assert.equal(at(20).lengthOk, true);
  assert.equal(at(21).lengthOk, false);
  assert.equal(at(0).lengthOk, false);
  assert.equal(passwordRuleState('abc', undefined, 1, 3).lengthOk, true);
});

test('the confirm rule stays undecided until a confirmation value is supplied', () => {
  assert.equal(passwordRuleState('secret12', undefined, 6, 20).matchOk, null);
  assert.equal(passwordRuleState('secret12', 'secret12', 6, 20).matchOk, true);
  assert.equal(passwordRuleState('secret12', 'secret13', 6, 20).matchOk, false);
  assert.equal(passwordRuleState('secret12', '', 6, 20).matchOk, false);
  assert.equal(passwordRuleState('', '', 6, 20).matchOk, true);
});

test('the confirm comparison uses the exact value, including case and code points', () => {
  assert.equal(passwordRuleState('Secret12', 'secret12', 6, 20).matchOk, false);
  assert.equal(passwordRuleState('😀😀😀😀😀😀', '😀😀😀😀😀😀', 6, 20).matchOk, true);
  assert.equal(passwordRuleState('a b', 'a  b', 1, 20).matchOk, false);
});
