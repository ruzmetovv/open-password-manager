import {
  deriveRawKey, importAesKey, encryptJSON, decryptJSON, randomSalt
} from './crypto.js';

const state = {
  key: null,
  vault: [],
  salt: null,
  lastActivity: 0,
  query: '',
  sortPref: 'site-asc',
  expandedGroups: {},
  detectedDomain: ''
};

const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const $ = (id) => document.getElementById(id);
const views = { setup: $('view-setup'), lock: $('view-lock'), vault: $('view-vault') };

function showView(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}

function setMsg(id, text, isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'msg ' + (isError ? 'error' : 'ok');
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function touchActivity() {
  state.lastActivity = Date.now();
  chrome.storage.session.set({ lastActivity: state.lastActivity });
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function shortDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return 'сегодня';
  if (diffDays === 1) return 'вчера';
  if (diffDays < 7) return `${diffDays} дн.`;
  const p = n => String(n).padStart(2, '0');
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${p(d.getDate())}.${p(d.getMonth() + 1)}`
    : `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)}`;
}

function domainKey(site) {
  let s = String(site).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.replace(/\/$/, '');
  return s;
}

function faviconUrl(site, size = 32) {
  if (!site) return '';
  let url = site.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { return ''; }
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size}`);
}
function makeFaviconImg(site, size = 16) {
  const img = document.createElement('img');
  img.width = size; img.height = size; img.alt = '';
  const src = faviconUrl(site);
  if (src) img.src = src;
  img.onerror = () => { img.style.visibility = 'hidden'; };
  return img;
}

async function copyToClipboard(text, chip) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    chip.classList.add('copied');
    const copyIcon = chip.querySelector('.chip-copy');
    const orig = copyIcon.textContent;
    copyIcon.textContent = '✓';
    setMsg('vault-msg-list', 'Скопировано');
    touchActivity();
    setTimeout(() => { chip.classList.remove('copied'); copyIcon.textContent = orig; }, 1200);
  } catch {
    setMsg('vault-msg-list', 'Не удалось скопировать', true);
  }
}

async function ensureCreatedAt() {
  let changed = false;
  state.vault.forEach((item, i) => {
    if (typeof item.createdAt !== 'number') {
      item.createdAt = Date.now() - (state.vault.length - i) * 1000;
      changed = true;
    }
  });
  if (changed) {
    const encrypted = await encryptJSON(state.key, state.vault);
    await chrome.storage.local.set({ vault: encrypted });
  }
}

async function init() {
  const local = await chrome.storage.local.get(['salt', 'vault', 'sortPref', 'expandedGroups']);
  const session = await chrome.storage.session.get(['key', 'lastActivity']);

  state.sortPref = local.sortPref || 'site-asc';
  state.expandedGroups = local.expandedGroups || {};
  $('sort-select').value = state.sortPref;

  if (!local.salt) { showView('setup'); return; }
  state.salt = new Uint8Array(local.salt);

  const fresh = session.key && session.lastActivity
    && (Date.now() - session.lastActivity) < LOCK_TIMEOUT_MS;

  if (fresh) {
    try {
      state.key = await importAesKey(new Uint8Array(session.key));
      state.vault = await decryptJSON(state.key, local.vault.iv, local.vault.data);
      state.lastActivity = session.lastActivity;
      await ensureCreatedAt();
      showView('vault');
      renderList();
      detectCurrentSite();
      loadPending();
      return;
    } catch {
      await lock();
      return;
    }
  }

  if (session.key) await chrome.storage.session.remove(['key', 'lastActivity']);
  showView('lock');
}

$('setup-btn').onclick = async () => {
  const p1 = $('setup-pass1').value;
  const p2 = $('setup-pass2').value;
  if (p1.length < 8) return setMsg('setup-msg', 'Минимум 8 символов', true);
  if (p1 !== p2)     return setMsg('setup-msg', 'Пароли не совпадают', true);

  $('setup-btn').disabled = true;
  try {
    const salt = randomSalt();
    const rawKey = await deriveRawKey(p1, salt);
    const key = await importAesKey(rawKey);
    const encrypted = await encryptJSON(key, []);

    await chrome.storage.local.set({ salt: Array.from(salt), vault: encrypted });
    await chrome.storage.session.set({ key: Array.from(rawKey), lastActivity: Date.now() });

    state.key = key; state.salt = salt; state.vault = []; state.lastActivity = Date.now();
    showView('vault'); renderList(); detectCurrentSite(); loadPending();
    setMsg('vault-msg-list', 'Хранилище создано');
  } catch (e) {
    setMsg('setup-msg', 'Ошибка: ' + e.message, true);
  } finally {
    $('setup-btn').disabled = false;
  }
};

$('unlock-btn').onclick = async () => {
  const pass = $('unlock-pass').value;
  if (!pass) return setMsg('unlock-msg', 'Введите пароль', true);

  $('unlock-btn').disabled = true;
  try {
    const local = await chrome.storage.local.get(['vault']);
    const rawKey = await deriveRawKey(pass, state.salt);
    const key = await importAesKey(rawKey);
    const vault = await decryptJSON(key, local.vault.iv, local.vault.data);

    await chrome.storage.session.set({ key: Array.from(rawKey), lastActivity: Date.now() });

    state.key = key; state.vault = vault; state.lastActivity = Date.now();
    $('unlock-pass').value = '';

    await ensureCreatedAt();
    showView('vault'); renderList(); detectCurrentSite(); loadPending();
  } catch {
    setMsg('unlock-msg', 'Неверный мастер-пароль', true);
  } finally {
    $('unlock-btn').disabled = false;
  }
};
$('unlock-pass').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('unlock-btn').click();
});

async function lock() {
  state.key = null; state.vault = [];
  await chrome.storage.session.remove(['key', 'lastActivity']);
  showView('lock');
}
$('lock-btn').onclick = lock;

async function loadPending() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getPending' });
    const pending = resp?.pending || [];
    const box = $('pending-box');
    const list = $('pending-list');
    list.innerHTML = '';
    if (pending.length === 0) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');

    pending.forEach(p => {
      const row = document.createElement('div');
      row.className = 'pending-item';

      const label = document.createElement('span');
      label.className = 'grow';
      label.innerHTML = `🔐 <b>${escapeHtml(p.site)}</b> — ${escapeHtml(p.user || 'без логина')}`;

      const save = document.createElement('button');
      save.className = 'small';
      save.textContent = 'Сохранить';
      save.onclick = () => confirmPending(p.id);

      const skip = document.createElement('button');
      skip.className = 'secondary small';
      skip.textContent = '×';
      skip.title = 'Не сохранять';
      skip.onclick = () => removePending(p.id);

      row.append(label, save, skip);
      list.appendChild(row);
    });
  } catch {}
}

async function confirmPending(id) {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'confirmPending', id });
    if (resp?.ok) {
      await reloadVault();
      renderList();
      detectCurrentSite();
      await loadPending();
      setMsg('vault-msg-list', resp.duplicate ? 'Уже было сохранено' : 'Сохранено');
      touchActivity();
    } else if (resp?.error === 'locked') {
      setMsg('vault-msg-list', 'Разблокируйте хранилище', true);
    } else {
      setMsg('vault-msg-list', 'Ошибка: ' + (resp?.error || 'неизвестно'), true);
    }
  } catch {
    setMsg('vault-msg-list', 'Ошибка сообщения с фоновым скриптом', true);
  }
}

async function removePending(id) {
  try { await chrome.runtime.sendMessage({ action: 'removePending', id }); } catch {}
  await loadPending();
}

async function reloadVault() {
  if (!state.key) return;
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) return;
  state.vault = await decryptJSON(state.key, vault.iv, vault.data);
  await ensureCreatedAt();
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.pendingSaves) loadPending();
});

$('menu-btn').onclick = () => $('menu-panel').classList.toggle('hidden');

function downloadFile(filename, content, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function dateStamp() { return new Date().toISOString().slice(0, 10); }

$('export-encrypted').onclick = async () => {
  const local = await chrome.storage.local.get(['vault']);
  const backup = {
    format: 'helium-pm-backup', version: 1,
    createdAt: new Date().toISOString(),
    salt: Array.from(state.salt), vault: local.vault
  };
  downloadFile(`helium-pm-backup-${dateStamp()}.json`, JSON.stringify(backup, null, 2));
  setMsg('vault-msg-list', 'Зашифрованная копия скачана');
  touchActivity();
};

$('export-plain').onclick = () => {
  if (!confirm('⚠️ Открытый JSON содержит пароли в незашифрованном виде.\n\nПродолжить?')) return;
  downloadFile(`helium-pm-plain-${dateStamp()}.json`, JSON.stringify(state.vault, null, 2));
  setMsg('vault-msg-list', 'Открытый JSON скачан');
  touchActivity();
};

$('import-btn').onclick = () => $('import-file').click();

$('import-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  try {
    const text = await file.text();
    await handleImport(text);
  } catch {
    setMsg('vault-msg-list', 'Ошибка чтения файла', true);
  }
};

function mergeVaults(existing, incoming) {
  const keyOf = x => x.site.trim().toLowerCase() + '|' + x.user.trim().toLowerCase();
  const map = new Map(existing.map(x => [keyOf(x), x]));
  for (const item of incoming) map.set(keyOf(item), item);
  return [...map.values()];
}

function normalizeEntry(x, i) {
  return {
    site: x.site, user: x.user, pass: x.pass,
    createdAt: typeof x.createdAt === 'number' ? x.createdAt : Date.now() + i
  };
}

async function handleImport(text) {
  let data;
  try { data = JSON.parse(text); }
  catch { return setMsg('vault-msg-list', 'Некорректный JSON', true); }

  let incoming = null;

  if (data && data.format === 'helium-pm-backup' && Array.isArray(data.salt) && data.vault) {
    const backupSalt = new Uint8Array(data.salt);
    const sameSalt = arraysEqual(backupSalt, state.salt);

    let backupKey;
    if (sameSalt) backupKey = state.key;
    else {
      const pass = await promptPassword('Пароль от резервной копии');
      if (!pass) return;
      try {
        const raw = await deriveRawKey(pass, backupSalt);
        backupKey = await importAesKey(raw);
      } catch {
        return setMsg('vault-msg-list', 'Ошибка импорта', true);
      }
    }

    try {
      incoming = await decryptJSON(backupKey, data.vault.iv, data.vault.data);
    } catch {
      return setMsg('vault-msg-list', 'Неверный пароль или файл повреждён', true);
    }
    if (!Array.isArray(incoming)) {
      return setMsg('vault-msg-list', 'Некорректные данные в копии', true);
    }
  } else if (Array.isArray(data)) {
    const ok = data.every(x => x && typeof x.site === 'string'
      && typeof x.user === 'string' && typeof x.pass === 'string');
    if (!ok) return setMsg('vault-msg-list', 'Неверный формат записей', true);
    incoming = data;
  } else {
    return setMsg('vault-msg-list', 'Неизвестный формат файла', true);
  }

  if (incoming.length === 0) return setMsg('vault-msg-list', 'Файл пуст');
  incoming = incoming.map(normalizeEntry);

  let target;
  if (state.vault.length === 0) target = incoming;
  else {
    const replace = confirm(
      `Найдено ${incoming.length} записей.\nТекущих записей: ${state.vault.length}.\n\n` +
      `OK — заменить все текущие\n` +
      `Отмена — объединить (по сайту и логину, входящие перекрывают)`
    );
    target = replace ? incoming : mergeVaults(state.vault, incoming);
  }

  state.vault = target;
  await persistVault();
  renderList(); detectCurrentSite();
  setMsg('vault-msg-list', `Импортировано: ${incoming.length}`);
  touchActivity();
}

function promptPassword(title) {
  return new Promise(resolve => {
    const modal = $('import-modal');
    const input = $('import-pass');
    const msg = $('import-modal-msg');
    $('import-modal-title').textContent = title;
    input.value = ''; msg.textContent = '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);

    const cleanup = () => {
      modal.classList.add('hidden');
      $('import-confirm').onclick = null;
      $('import-cancel').onclick = null;
    };
    $('import-confirm').onclick = () => {
      const v = input.value;
      if (!v) { msg.textContent = 'Введите пароль'; msg.className = 'msg error'; return; }
      cleanup(); resolve(v);
    };
    $('import-cancel').onclick = () => { cleanup(); resolve(null); };
    input.onkeydown = e => {
      if (e.key === 'Enter') $('import-confirm').click();
      if (e.key === 'Escape') $('import-cancel').click();
    };
  });
}

async function detectCurrentSite() {
  const box = $('detect-box');
  box.classList.add('hidden');
  state.detectedDomain = '';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const url = new URL(tab.url);
    if (!/^https?:$/.test(url.protocol)) return;

    const domain = url.hostname.replace(/^www\./, '');
    state.detectedDomain = domain;

    const img = $('detect-favicon');
    const src = faviconUrl(domain, 32);
    if (src) { img.src = src; img.style.visibility = 'visible'; }

    if (!$('site').value) $('site').value = domain;

    chrome.tabs.sendMessage(tab.id, { action: 'detect' }, (resp) => {
      if (chrome.runtime.lastError) return;
      const uname = resp?.username?.trim();
      if (uname && !$('user').value) $('user').value = uname;
      updateDetectBox(domain, uname);
    });
    updateDetectBox(domain, '');
  } catch {}
}

function updateDetectBox(domain, username) {
  const box = $('detect-box');
  const text = $('detect-text');
  const fillBtn = $('detect-fill');

  const match = state.vault.find(e => {
    const s = domainKey(e.site);
    return s === domain.toLowerCase() || domain.toLowerCase().includes(s);
  });

  box.classList.remove('hidden');
  if (match) {
    text.innerHTML = `Есть запись: <b>${escapeHtml(match.site)}</b> — ${escapeHtml(match.user)}`;
    fillBtn.style.display = '';
    fillBtn.onclick = () => fillOnPage(match);
  } else {
    const who = username ? ` (логин: <b>${escapeHtml(username)}</b>)` : '';
    text.innerHTML = `Текущий сайт: <b>${escapeHtml(domain)}</b>${who}`;
    fillBtn.style.display = 'none';
  }
}

$('search').addEventListener('input', e => {
  state.query = e.target.value;
  renderList();
});
$('sort-select').addEventListener('change', e => {
  state.sortPref = e.target.value;
  chrome.storage.local.set({ sortPref: state.sortPref });
  renderList();
});

function getFilteredItems() {
  const q = state.query.trim().toLowerCase();
  let items = state.vault.map((item, i) => ({ item, i }));
  if (q) {
    items = items.filter(({ item }) =>
      item.site.toLowerCase().includes(q) || item.user.toLowerCase().includes(q)
    );
  }
  return items;
}

function buildGroups(items) {
  const map = new Map();
  for (const { item, i } of items) {
    const key = domainKey(item.site);
    if (!map.has(key)) {
      map.set(key, { domain: key, displaySite: item.site, items: [] });
    }
    map.get(key).items.push({ item, i });
  }
  return [...map.values()];
}

function sortGroups(groups) {
  const pref = state.sortPref;
  groups.sort((a, b) => {
    if (pref === 'site-desc') return b.domain.localeCompare(a.domain);
    if (pref === 'date-desc' || pref === 'date-asc') {
      const ma = Math.max(...a.items.map(x => x.item.createdAt || 0));
      const mb = Math.max(...b.items.map(x => x.item.createdAt || 0));
      return pref === 'date-desc' ? mb - ma : ma - mb;
    }
    return a.domain.localeCompare(b.domain);
  });
  for (const g of groups) {
    g.items.sort((a, b) => {
      if (pref === 'site-desc') return b.item.user.localeCompare(a.item.user);
      if (pref === 'site-asc')  return a.item.user.localeCompare(b.item.user);
      const da = a.item.createdAt || 0, db = b.item.createdAt || 0;
      return pref === 'date-desc' ? db - da : da - db;
    });
  }
  return groups;
}

$('toggle-add').onclick = () => {
  const form = $('add-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) { $('site').focus(); detectCurrentSite(); }
};

$('save-btn').onclick = async () => {
  const site = $('site').value.trim();
  const user = $('user').value.trim();
  const pass = $('pass').value;
  if (!site || !user || !pass) return setMsg('vault-msg', 'Заполните все поля', true);

  state.vault.push({ site, user, pass, createdAt: Date.now() });

  const newKey = domainKey(site);
  state.expandedGroups[newKey] = true;
  chrome.storage.local.set({ expandedGroups: state.expandedGroups });

  await persistVault();

  $('site').value = ''; $('user').value = ''; $('pass').value = '';
  $('add-form').classList.add('hidden');
  renderList(); detectCurrentSite();
  setMsg('vault-msg-list', 'Сохранено');
  touchActivity();
};

async function persistVault() {
  const encrypted = await encryptJSON(state.key, state.vault);
  await chrome.storage.local.set({ vault: encrypted });
}

async function deleteEntry(index) {
  if (!confirm('Удалить запись?')) return;
  state.vault.splice(index, 1);
  await persistVault();
  renderList(); detectCurrentSite();
  touchActivity();
}

function toggleGroup(domain) {
  state.expandedGroups[domain] = !state.expandedGroups[domain];
  chrome.storage.local.set({ expandedGroups: state.expandedGroups });
  renderList();
}

function renderList() {
  const list = $('list');
  const items = getFilteredItems();
  list.innerHTML = '';

  if (state.vault.length === 0) {
    list.innerHTML = '<div class="empty">Хранилище пусто</div>';
    return;
  }
  if (items.length === 0) {
    list.innerHTML = '<div class="empty">Ничего не найдено</div>';
    return;
  }

  const groups = sortGroups(buildGroups(items));
  const searching = state.query.trim() !== '';

  for (const group of groups) {
    if (group.items.length === 1) {
      list.appendChild(renderEntry(group.items[0].item, group.items[0].i, false));
    } else {
      list.appendChild(renderGroup(group, searching));
    }
  }
}

function renderGroup(group, searching) {
  const wrapper = document.createElement('div');
  wrapper.className = 'group';

  const isExpanded = searching ? true : !!state.expandedGroups[group.domain];

  const header = document.createElement('div');
  header.className = 'group-header';
  header.title = searching ? '' : (isExpanded ? 'Свернуть' : 'Развернуть');
  if (!searching) header.onclick = () => toggleGroup(group.domain);

  const arrow = document.createElement('span');
  arrow.className = 'group-arrow';
  arrow.textContent = isExpanded ? '▾' : '▸';
  header.appendChild(arrow);

  header.appendChild(makeFaviconImg(group.displaySite, 18));

  const label = document.createElement('span');
  label.className = 'group-label';
  label.textContent = group.domain;
  header.appendChild(label);

  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = group.items.length;
  header.appendChild(count);

  wrapper.appendChild(header);

  if (isExpanded) {
    const body = document.createElement('div');
    body.className = 'group-body';
    for (const { item, i } of group.items) body.appendChild(renderEntry(item, i, true));
    wrapper.appendChild(body);
  }
  return wrapper;
}

function renderEntry(item, originalIndex, inGroup = false) {
  const row = document.createElement('div');
  row.className = 'entry' + (inGroup ? ' in-group' : '');

  if (!inGroup) row.appendChild(makeFaviconImg(item.site, 20));

  const label = document.createElement('div');
  label.className = 'label';

  if (!inGroup) {
    const siteRow = document.createElement('div');
    siteRow.className = 'site-row';
    const siteEl = document.createElement('span');
    siteEl.className = 'site';
    siteEl.textContent = item.site;
    siteRow.appendChild(siteEl);
    const dateStr = shortDate(item.createdAt);
    if (dateStr) {
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = dateStr;
      siteRow.appendChild(when);
    }
    label.appendChild(siteRow);
  }

  const fields = document.createElement('div');
  fields.className = 'fields';

  const loginChip = buildChip({
    icon: '👤', text: item.user, title: 'Копировать логин',
    onCopy: () => copyToClipboard(item.user, loginChip)
  });
  fields.appendChild(loginChip);

  const passChip = buildChip({
    icon: '🔑', text: '••••••••', masked: true, title: 'Копировать пароль',
    onCopy: () => copyToClipboard(item.pass, passChip)
  });
  fields.appendChild(passChip);

  const passTextEl = passChip.querySelector('.chip-text');
  const eyeBtn = document.createElement('button');
  eyeBtn.className = 'eye-btn';
  eyeBtn.type = 'button';
  eyeBtn.textContent = '👁';
  eyeBtn.title = 'Показать пароль';
  let revealed = false;
  eyeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    revealed = !revealed;
    passTextEl.textContent = revealed ? item.pass : '••••••••';
    passTextEl.classList.toggle('masked', !revealed);
    eyeBtn.textContent = revealed ? '🙈' : '👁';
    eyeBtn.title = revealed ? 'Скрыть пароль' : 'Показать пароль';
  });
  fields.appendChild(eyeBtn);

  label.appendChild(fields);
  row.appendChild(label);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const fill = document.createElement('button');
  fill.className = 'small';
  fill.textContent = '→';
  fill.title = 'Заполнить на странице';
  fill.onclick = () => fillOnPage(item);

  const del = document.createElement('button');
  del.className = 'danger small';
  del.textContent = '×';
  del.title = 'Удалить';
  del.onclick = () => deleteEntry(originalIndex);

  actions.append(fill, del);
  row.appendChild(actions);

  return row;
}

function buildChip({ icon, text, masked = false, title, onCopy }) {
  const chip = document.createElement('div');
  chip.className = 'chip';
  chip.setAttribute('role', 'button');
  chip.setAttribute('tabindex', '0');
  chip.title = title;

  const iconEl = document.createElement('span');
  iconEl.className = 'chip-icon';
  iconEl.textContent = icon;
  chip.appendChild(iconEl);

  const textEl = document.createElement('span');
  textEl.className = 'chip-text' + (masked ? ' masked' : '');
  textEl.textContent = text;
  chip.appendChild(textEl);

  const copyEl = document.createElement('span');
  copyEl.className = 'chip-copy';
  copyEl.textContent = '📋';
  chip.appendChild(copyEl);

  chip.addEventListener('click', onCopy);
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCopy(); }
  });
  return chip;
}

function fillOnPage(item) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    chrome.tabs.sendMessage(
      tabs[0].id,
      { action: 'fill', user: item.user, pass: item.pass },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.success) {
          setMsg('vault-msg-list', 'Не удалось заполнить на этой странице', true);
        } else {
          setMsg('vault-msg-list', 'Заполнено');
          touchActivity();
        }
      }
    );
  });
}

init();