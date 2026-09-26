import test from 'node:test';
import assert from 'node:assert/strict';
import { dateQuickPicks, formatLocalDate, parseLocalDate, shiftLocalDate } from '../src/space/dates.ts';

test('calendar choices cross month and leap-day boundaries without UTC day drift', () => {
  assert.deepEqual(dateQuickPicks('2028-02-28'), [
    { key: 'today', date: '2028-02-28' },
    { key: 'tomorrow', date: '2028-02-29' },
    { key: 'saturday', date: '2028-03-04' },
  ]);
  assert.equal(shiftLocalDate('2028-02-29', 1), '2028-03-01');
  assert.equal(parseLocalDate('2027-02-29'), null);
});

test('goal and task dates render in the selected interface language', () => {
  assert.equal(formatLocalDate('zh-CN', '2026-09-25', '2026-09-25'), '今天');
  assert.equal(formatLocalDate('en', '2026-09-26', '2026-09-25'), 'Tomorrow');
});
