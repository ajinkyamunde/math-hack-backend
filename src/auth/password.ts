import { argon2Verify, argon2id } from 'hash-wasm';

/**
 * Argon2id compiled to WebAssembly. The parameters match the original Node backend (OWASP: 19 MiB, 2 passes,
 * 1 lane, 32-byte hash, 16-byte salt) and the encoded format is the standard PHC string, so every password hash
 * imported from MongoDB verifies here unchanged.
 */
const PARAMS = { parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32 } as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return argon2id({ ...PARAMS, password, salt, outputType: 'encoded' });
}

let dummyHash: Promise<string> | undefined;

/** Verifies a password; when the account does not exist, a dummy hash keeps the timing the same. */
export async function verifyPassword(hash: string | undefined | null, password: string): Promise<boolean> {
  dummyHash ??= hashPassword('mathhack-timing-equaliser');
  const target = hash ?? (await dummyHash);
  try {
    const ok = await argon2Verify({ password, hash: target });
    return Boolean(hash) && ok;
  } catch {
    return false;
  }
}
