import assert from 'node:assert/strict';
import test from 'node:test';
import { accountStage } from '../src/account/screens/stage.ts';
import { buildHomeRows, buildIdentity, rowBlocked } from '../src/account/home-view.ts';
import { accountEn } from '../src/account/account-messages.ts';
import { choicesSettled } from '../src/account/deletion-view.ts';
import { accountSidebarWidth, accountDividerWidth, accountDetailMinWidth, canSplitAccount } from '../src/account/split-width.ts';

const state = (status, account = null, extra = {}) => ({ status, account, passwordChangePending: false, ...extra });
const account = { subjectId: 'subject' };

test('13-inch iPad fits both columns; an 11-inch portrait or narrow window uses one column', () => {
  for (const width of [834, 900, 940]) assert.equal(canSplitAccount(width), false);
  for (const width of [941, 1024, 1194]) {
    assert.equal(canSplitAccount(width), true);
    assert.ok(width - accountSidebarWidth - accountDividerWidth >= accountDetailMinWidth);
  }
});

test('entry does not treat a restoring or unreadable vault as an anonymous account', () => {
  assert.equal(accountStage(state('anonymous')), 'entry');
  assert.equal(accountStage(state('bootstrapping')), 'restoring');
  assert.equal(accountStage(state('secure-storage-unavailable')), 'fatal');
  assert.equal(accountStage(state('offline-available', account)), 'home');
  assert.equal(accountStage(state('reauth-required', account)), 'entry');
  assert.equal(accountStage(state('reauth-required', account, { passwordChangePending: true })), 'home');
});

test('account home shows reported identity and disables only online rows while offline', () => {
  const methods = [{ identityId: 'apple:one', kind: 'apple', status: 'active' }];
  const identity = buildIdentity({ methods, offline: true, child: false, text: accountEn });
  assert.equal(identity.name, accountEn.appleAccount);
  assert.equal(identity.pills[0].label, accountEn.offline);
  const rows = buildHomeRows({ methods, deviceCount: 2, pendingFamilies: 1, offline: true,
    adult: true, spaceKind: 'local', text: accountEn });
  assert.equal(rows.some(row => row.key === 'password'), false);
  assert.equal(rowBlocked(rows.find(row => row.key === 'devices'), true), true);
  assert.equal(rowBlocked(rows.find(row => row.key === 'space'), true), false);
  assert.equal(rows.find(row => row.key === 'space').value, accountEn.spaceOriginal);
});

test('deletion cannot continue with an unchosen family or an unaccepted handover', () => {
  const family = familyId => ({ familyId, choice: null });
  const families = [family('first'), family('second')];
  const view = rows => ({ step: 'families', families: rows });
  assert.equal(choicesSettled(view(families), {}), false);
  const ended = { ...families[0], choice: { kind: 'end-family-access', familyId: 'first' } };
  assert.equal(choicesSettled(view([ended, families[1]]), {}), false);
  const transfer = { ...families[1], choice: { kind: 'transfer', familyId: 'second', recipientSubjectId: 'recipient' } };
  assert.equal(choicesSettled(view([ended, transfer]), {}), false);
  assert.equal(choicesSettled(view([ended, transfer]), { second: { subjectId: 'recipient', membership: 'active', management: 'pending', guardianship: 'accepted' } }), false);
  assert.equal(choicesSettled(view([ended, transfer]), { second: { subjectId: 'recipient', membership: 'active', management: 'accepted', guardianship: 'accepted' } }), true);
});
