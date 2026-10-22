import { importAesKey, encryptJSON, decryptJSON } from './crypto.js';

const PENDING_KEY = 'pendingSaves';

async function getPending() {
  const data = await chrome.storage.session.get(PENDING_KEY);
  return data[PENDING_KEY] || [];
}
async function setPending(list) {
  await chrome.storage.session.set({ [PENDING_KEY]: list });
  await updateBadge(list.length);
}
async function updateBadge(count) {
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
}

async function savePendingItem(id) {
  const session = await chrome.storage.session.get('key');
  if (!session.key) return { ok: false, error: 'locked' };

  const pending = await getPending();
  const item = pending.find(p => p.id === id);
  if (!item) return { ok: false, error: 'not_found' };

  try {
    const key = await importAesKey(new Uint8Array(session.key));
    const { vault } = await chrome.storage.local.get('vault');
    if (!vault) return { ok: false, error: 'no_vault' };

    const arr = await decryptJSON(key, vault.iv, vault.data);

    const exists = arr.some(v =>
      v.site.toLowerCase() === item.site.toLowerCase() &&
      v.user.toLowerCase() === item.user.toLowerCase() &&
      v.pass === item.pass
    );
    if (!exists) {
      arr.push({
        site: item.site,
        user: item.user,
        pass: item.pass,
        createdAt: Date.now()
      });
      const encrypted = await encryptJSON(key, arr);
      await chrome.storage.local.set({ vault: encrypted });
    }

    const remaining = pending.filter(p => p.id !== id);
    await setPending(remaining);
    return { ok: true, duplicate: exists };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function removePendingItem(id) {
  const pending = await getPending();
  const remaining = pending.filter(p => p.id !== id);
  await setPending(remaining);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  (async () => {
    try {
      if (req.action === 'pendingSave') {
        const pending = await getPending();
        const dup = pending.find(p =>
          p.site.toLowerCase() === req.site.toLowerCase() &&
          p.user.toLowerCase() === req.user.toLowerCase() &&
          p.pass === req.pass
        );
        if (dup) return sendResponse({ id: dup.id, dup: true });

        const id = crypto.randomUUID();
        pending.push({
          id, site: req.site, url: req.url,
          user: req.user, pass: req.pass, ts: Date.now()
        });
        await setPending(pending);
        return sendResponse({ id });
      }

      if (req.action === 'confirmPending') return sendResponse(await savePendingItem(req.id));
      if (req.action === 'removePending') return sendResponse(await removePendingItem(req.id));
      if (req.action === 'getPending') return sendResponse({ pending: await getPending() });
      if (req.action === 'clearPending') {
        await setPending([]);
        return sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const pending = await getPending();
  await updateBadge(pending.length);
});
chrome.runtime.onStartup.addListener(async () => {
  const pending = await getPending();
  await updateBadge(pending.length);
});