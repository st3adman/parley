import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.js';
import { getGuildConfig, setGuildConfig } from '../src/store/config.js';
import { validateSetup } from '../src/commands/setup-logic.js';
import { nicknameFor, isStaleRecordingNickname, MAX_NICKNAME } from '../src/voice/nickname.js';

test('recording appends " 🔴" to the server nickname', () => {
  assert.equal(nicknameFor({ nickname: 'st3bot', username: 'Parley', recording: true }), 'st3bot 🔴');
  assert.equal(nicknameFor({ nickname: 'st3bot', username: 'Parley', recording: false }), 'st3bot');
});

test('without a nickname: username while recording, cleared when idle', () => {
  assert.equal(nicknameFor({ nickname: null, username: 'Parley', recording: true }), 'Parley 🔴');
  assert.equal(nicknameFor({ nickname: null, username: 'Parley', recording: false }), null);
});

test('recording nickname never exceeds Discord\'s 32-character limit', () => {
  const nick = nicknameFor({ nickname: null, username: 'x'.repeat(40), recording: true });
  assert.ok(nick.length <= 32);
  assert.ok(nick.endsWith(' 🔴'));
});

test('stale recording nicknames are detected', () => {
  assert.equal(isStaleRecordingNickname('st3bot 🔴'), true);
  assert.equal(isStaleRecordingNickname('[REC] Meeting Bot'), true);
  assert.equal(isStaleRecordingNickname('st3bot'), false);
  assert.equal(isStaleRecordingNickname(null), false);
});

test('validateSetup trims, clears with empty/"none", and enforces the length limit', () => {
  assert.deepEqual(validateSetup({ nickname: '  st3bot ' }, {}).patch, { nickname: 'st3bot' });
  assert.deepEqual(validateSetup({ nickname: '' }, {}).patch, { nickname: null });
  assert.deepEqual(validateSetup({ nickname: 'None' }, {}).patch, { nickname: null });
  assert.deepEqual(validateSetup({ nickname: null }, {}).patch, { nickname: null });
  assert.equal(validateSetup({ nickname: 'x'.repeat(MAX_NICKNAME) }, {}).ok, true);
  assert.match(validateSetup({ nickname: 'x'.repeat(MAX_NICKNAME + 1) }, {}).error, /at most 29/);
});

test('nickname is stored per server', () => {
  const db = openDb(':memory:');
  assert.equal(getGuildConfig(db, 'a').nickname, null);
  setGuildConfig(db, 'a', { nickname: 'st3bot' });
  assert.equal(getGuildConfig(db, 'a').nickname, 'st3bot');
  assert.equal(getGuildConfig(db, 'b').nickname, null);
  setGuildConfig(db, 'a', { autoJoin: false }); // other settings keep it
  assert.equal(getGuildConfig(db, 'a').nickname, 'st3bot');
});
