/** 24-hex identifiers shaped like MongoDB ObjectIds: 4 bytes of seconds, then 8 random bytes. */
export function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes.subarray(4));
  const seconds = Math.floor(Date.now() / 1000);
  bytes[0] = (seconds >>> 24) & 0xff;
  bytes[1] = (seconds >>> 16) & 0xff;
  bytes[2] = (seconds >>> 8) & 0xff;
  bytes[3] = seconds & 0xff;
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);

export const normalizePrn = (prn: string): string => prn.trim().toUpperCase().replace(/\s+/g, '');
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Lower-cased, whitespace-collapsed, punctuation-light form used for duplicate detection. */
export function normalizeQuestionText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/[?.!,;:]+$/g, '')
    .trim();
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same fingerprint as the original backend, so imported questions are still detected as duplicates. */
export const questionFingerprint = (text: string): Promise<string> => sha256Hex(normalizeQuestionText(text));

/** Escapes LIKE/ILIKE wildcards so a search term matches literally. */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** Builds a filesystem- and header-safe filename fragment. */
export const safeFilenamePart = (value: string): string =>
  value.normalize('NFKD').replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'competition';

export const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}
