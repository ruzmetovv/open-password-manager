const PBKDF2_ITERATIONS = 310000;

export function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
export function b64ToBuf(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;
}

export async function deriveRawKey(password, saltBytes) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    256
  );
  return new Uint8Array(bits);
}

export async function importAesKey(rawBytes) {
  return crypto.subtle.importKey(
    'raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
}

export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(obj))
  );
  return { iv: bufToB64(iv), data: bufToB64(ct) };
}

export async function decryptJSON(key, ivB64, dataB64) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(ivB64)) },
    key,
    b64ToBuf(dataB64)
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}