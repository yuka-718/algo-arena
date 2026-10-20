import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { hashPassword, verifyPassword } from '../shared/passwords.js';

test('password hashes use independent random salts and match native PBKDF2-SHA256', async () => {
  const password = '推理するカード🔐 password';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.deepEqual(Object.keys(first).sort(), ['hash', 'iterations', 'salt']);
  assert.match(first.salt, /^[0-9a-f]{32}$/);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.equal(first.iterations, 100000);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  const native = pbkdf2Sync(password, Buffer.from(first.salt, 'hex'), 100000, 32, 'sha256').toString('hex');
  assert.equal(first.hash, native);
  assert.equal(await verifyPassword(password, JSON.parse(JSON.stringify(first))), true);
  assert.equal(await verifyPassword(password, second), true);
});

test('verification accepts an independently generated record and checks every hash byte', async () => {
  const password = 'a known password';
  const salt = '000102030405060708090a0b0c0d0e0f';
  const hash = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex');
  const record = { salt, hash, iterations: 100000 };
  const serialized = JSON.stringify(record);
  assert.equal(await verifyPassword(password, record), true);
  assert.equal(await verifyPassword('wrong password', record), false);
  for (const byte of [0, 15, 31]) {
    const tampered = Buffer.from(hash, 'hex');
    tampered[byte] ^= 1;
    assert.equal(await verifyPassword(password, { ...record, hash: tampered.toString('hex') }), false);
  }
  assert.equal(JSON.stringify(record), serialized, 'verification must not modify stored credentials');
});

test('password spaces, Unicode and letter case retain their exact meaning', async () => {
  const password = ' Café🔑 password ';
  const record = await hashPassword(password);
  assert.equal(await verifyPassword(password, record), true);
  for (const changed of [password.trim(), password.toUpperCase(), ' Cafe\u0301🔑 password ']) {
    assert.equal(await verifyPassword(changed, record), false);
  }
});

test('malformed and unsupported credential records fail closed', async () => {
  const record = {
    salt: '00'.repeat(16), hash: '00'.repeat(32), iterations: 100000,
  };
  for (const malformed of [
    null, undefined, false, 'record', [], {},
    { ...record, salt: null }, { ...record, salt: '00' },
    { ...record, salt: 'gg'.repeat(16) }, { ...record, salt: `${record.salt}00` },
    { ...record, hash: null }, { ...record, hash: '00' },
    { ...record, hash: 'zz'.repeat(32) }, { ...record, hash: `${record.hash}00` },
    { ...record, iterations: 0 }, { ...record, iterations: 1 },
    { ...record, iterations: 1000000000 }, { ...record, iterations: '100000' },
  ]) assert.equal(await verifyPassword('a password', malformed), false);
});

test('UTF-8 input bounds accept the API maximum and reject oversized/non-string inputs', async () => {
  const maximum = '🔑'.repeat(128); // 128 code points, 512 UTF-8 bytes.
  const record = await hashPassword(maximum);
  assert.equal(await verifyPassword(maximum, record), true);
  for (const invalid of [null, undefined, 123, {}, new Uint8Array([1, 2])]) {
    await assert.rejects(hashPassword(invalid), TypeError);
    assert.equal(await verifyPassword(invalid, record), false);
  }
  await assert.rejects(hashPassword('🔑'.repeat(129)), RangeError);
  assert.equal(await verifyPassword('🔑'.repeat(129), record), false);
});
