/** Portable password records for Node and Workers; password policy lives in API. */
const ITERATIONS = 100000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const MAX_PASSWORD_BYTES = 512;
const encoder = new TextEncoder();

const toHex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const fromHex = hex => Uint8Array.from(hex.match(/../g), pair => Number.parseInt(pair, 16));

function encodePassword(password) {
  if (typeof password !== 'string') throw new TypeError('Password must be a string.');
  const bytes = encoder.encode(password);
  if (bytes.length > MAX_PASSWORD_BYTES) throw new RangeError('Password is too long.');
  return bytes;
}

async function derive(passwordBytes, salt) {
  const key = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt,
  }, key, HASH_BYTES * 8));
}

/** Return a JSON-safe salted PBKDF2-SHA256 record; never retain the password. */
export async function hashPassword(password) {
  const passwordBytes = encodePassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(passwordBytes, salt);
  return { salt: toHex(salt), hash: toHex(hash), iterations: ITERATIONS };
}

/** Malformed records fail closed; iteration counts cannot request unbounded work. */
export async function verifyPassword(password, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.iterations !== ITERATIONS
    || typeof record.salt !== 'string' || !/^[0-9a-f]{32}$/i.test(record.salt)
    || typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(record.hash)) return false;
  let passwordBytes;
  try { passwordBytes = encodePassword(password); }
  catch { return false; }
  const actual = await derive(passwordBytes, fromHex(record.salt));
  const expected = fromHex(record.hash);
  // Every well-formed record compares exactly 32 bytes without an early exit.
  let difference = 0;
  for (let index = 0; index < HASH_BYTES; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}
