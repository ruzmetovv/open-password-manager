// Compatible with the original oPass/Helium Password Manager v3 key derivation and vault format.
const PBKDF2_ITERATIONS = 310000;
export function bufToB64(buffer) {
  const data=new Uint8Array(buffer);let binary='';
  for(let i=0;i<data.length;i+=8192)binary+=String.fromCharCode(...data.subarray(i,i+8192));
  return btoa(binary);
}
export const b64ToBuf = str => Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer;
export async function deriveRawKey(password, saltBytes) {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const raw = await crypto.subtle.deriveBits({name:'PBKDF2',salt:saltBytes,iterations:PBKDF2_ITERATIONS,hash:'SHA-256'}, baseKey, 256);
  return new Uint8Array(raw);
}
export const importAesKey = raw => crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
export async function encryptJSON(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(value)));
  return {iv:bufToB64(iv),data:bufToB64(data)};
}
export async function decryptJSON(key,iv,data) {
  const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(b64ToBuf(iv))},key,b64ToBuf(data));
  return JSON.parse(new TextDecoder().decode(plain));
}
export const randomSalt = () => crypto.getRandomValues(new Uint8Array(16));
