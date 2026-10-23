import { importAesKey, encryptJSON, decryptJSON } from './crypto.js';

const GOOGLE_CLIENT_ID = '509211745069-nphnrfjl61ahe04pik58ugpn28rsvf7i.apps.googleusercontent.com';
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

async function getAuthToken(forceInteractive = false) {
  if (!forceInteractive) {
    const session = await chrome.storage.session.get('googleToken');
    if (session.googleToken) return session.googleToken;
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const scopes = encodeURIComponent('https://www.googleapis.com/auth/drive.appdata');
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
    `&response_type=token` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!redirectUrl) return reject(new Error('Авторизация отменена пользователем'));

      try {
        const url = new URL(redirectUrl);
        const params = new URLSearchParams(url.hash.substring(1));
        const token = params.get('access_token');
        if (token) {
          await chrome.storage.session.set({ googleToken: token });
          resolve(token);
        } else {
          reject(new Error(params.get('error') || 'Токен не получен'));
        }
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function driveFetch(url, options = {}, retry = true) {
  let token = await getAuthToken();
  options.headers = { ...options.headers, Authorization: `Bearer ${token}` };
  let res = await fetch(url, options);

  // Если токен истек через час (401), сбрасываем кэш и получаем новый
  if (res.status === 401 && retry) {
    await chrome.storage.session.remove('googleToken');
    token = await getAuthToken(true);
    options.headers.Authorization = `Bearer ${token}`;
    res = await fetch(url, options);
  }
  return res;
}

async function syncVault() {
  try {
    // 1. Поиск файла в appDataFolder с корректным синтаксисом Drive v3
    const q = encodeURIComponent("name = 'vault.json' and trashed = false");
    const searchRes = await driveFetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name)`);
    
    if (!searchRes.ok) {
      const err = await searchRes.text();
      throw new Error(`Ошибка поиска в Google Drive (${searchRes.status}): ${err}`);
    }

    const searchData = await searchRes.json();
    const fileId = searchData.files?.[0]?.id;

    const local = await chrome.storage.local.get(['vault', 'salt', 'updatedAt']);
    const localTime = local.updatedAt || 0;
    let remoteTime = 0;
    let remoteData = null;

    // 2. Скачивание существующего файла
    if (fileId) {
      const fileRes = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      if (fileRes.ok) {
        remoteData = await fileRes.json();
        remoteTime = remoteData.updatedAt || 0;
      } else {
        const err = await fileRes.text();
        throw new Error(`Ошибка скачивания из Google Drive (${fileRes.status}): ${err}`);
      }
    }

    // Случай 1: Чистая установка на втором ПК — скачиваем базу
    if (!local.vault && remoteData) {
      await chrome.storage.local.set({
        vault: remoteData.vault,
        salt: remoteData.salt,
        updatedAt: remoteTime
      });
      return { ok: true, action: 'downloaded' };
    }

    // Случай 2: На Google Диске ничего нет, но есть локальная база — первичная выгрузка
    if (!remoteData && local.vault) {
      await uploadToDrive(null, local.vault, local.salt, localTime);
      return { ok: true, action: 'uploaded' };
    }

    // Случай 3: Данные есть и локально, и в облаке
    if (remoteData && local.vault) {
      const session = await chrome.storage.session.get('key');

      if (session.key) {
        const key = await importAesKey(new Uint8Array(session.key));
        const localList = await decryptJSON(key, local.vault.iv, local.vault.data);

        let remoteList = [];
        try {
          remoteList = await decryptJSON(key, remoteData.vault.iv, remoteData.vault.data);
        } catch {
          remoteList = [];
        }

        const map = new Map();
        const keyOf = x => (x.site || '').toLowerCase() + '|' + (x.user || '').toLowerCase();

        localList.forEach(item => map.set(keyOf(item), item));
        remoteList.forEach(item => {
          const k = keyOf(item);
          if (!map.has(k) || (item.createdAt || 0) > (map.get(k).createdAt || 0)) {
            map.set(k, item);
          }
        });

        const mergedList = Array.from(map.values());
        const newLocalTime = Math.max(localTime, remoteTime, Date.now());
        const encrypted = await encryptJSON(key, mergedList);

        await chrome.storage.local.set({ vault: encrypted, updatedAt: newLocalTime });
        await uploadToDrive(fileId, encrypted, local.salt, newLocalTime);
        return { ok: true, action: 'merged' };
      }

      if (remoteTime > localTime) {
        await chrome.storage.local.set({
          vault: remoteData.vault,
          salt: remoteData.salt,
          updatedAt: remoteTime
        });
        return { ok: true, action: 'downloaded' };
      } else if (localTime > remoteTime) {
        await uploadToDrive(fileId, local.vault, local.salt, localTime);
        return { ok: true, action: 'uploaded' };
      }
    }

    // В облаке ничего нет и локально ничего нет
    if (!remoteData && !local.vault) {
      return { ok: false, error: 'Копия на Google Диске не найдена' };
    }

    return { ok: true, action: 'synced' };
  } catch (e) {
    console.error('Сбой синхронизации:', e);
    return { ok: false, error: e.message || String(e) };
  }
}

async function uploadToDrive(fileId, vault, salt, updatedAt) {
  const bodyData = { vault, salt, updatedAt };
  // Поле parents разрешено только при POST-запросе (создание). При PATCH его передавать нельзя
  const metadata = fileId
    ? { name: 'vault.json' }
    : { name: 'vault.json', parents: ['appDataFolder'] };

  const boundary = 'helium_sync_boundary';
  const delimiter = `--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  const body =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify(bodyData) +
    closeDelim;

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  const res = await driveFetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: body
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ошибка выгрузки в Google Drive (${res.status}): ${errText}`);
  }

  return await res.json();
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
      await chrome.storage.local.set({ vault: encrypted, updatedAt: Date.now() });
      syncVault().catch(() => {});
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
  await setPending(pending.filter(p => p.id !== id));
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

      if (req.action === 'getAutoFill') {
        const session = await chrome.storage.session.get('key');
        if (!session.key) return sendResponse({ ok: false, error: 'locked' });

        const { vault } = await chrome.storage.local.get('vault');
        if (!vault) return sendResponse({ ok: false });

        try {
          const key = await importAesKey(new Uint8Array(session.key));
          const arr = await decryptJSON(key, vault.iv, vault.data);
          const domain = req.host.replace(/^www\./, '').toLowerCase();

          const matches = arr.filter(v => {
            let s = v.site.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
            return domain === s || domain.includes(s);
          });

          if (matches.length > 0) {
            matches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            return sendResponse({ ok: true, cred: matches[0] });
          }
          return sendResponse({ ok: false });
        } catch {
          return sendResponse({ ok: false });
        }
      }

      if (req.action === 'confirmPending') return sendResponse(await savePendingItem(req.id));
      if (req.action === 'removePending') return sendResponse(await removePendingItem(req.id));
      if (req.action === 'getPending') return sendResponse({ pending: await getPending() });
      if (req.action === 'clearPending') {
        await setPending([]);
        return sendResponse({ ok: true });
      }
      if (req.action === 'forceSync') {
        return sendResponse(await syncVault());
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