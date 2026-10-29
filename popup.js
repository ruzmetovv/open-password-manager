import {deriveRawKey,importAesKey,encryptJSON,decryptJSON,randomSalt} from './crypto.js';
const $=id=>document.getElementById(id);
const state={key:null,raw:null,salt:null,passwords:[],cards:[],view:'lock',tab:'passwords',editPass:null,editCard:null};
const digits=s=>String(s||'').replace(/\D/g,'');
const norm=s=>String(s||'').trim().toLowerCase();
const last4=s=>digits(s).slice(-4);
const host=s=>{try{return new URL(/^https?:\/\//i.test(s)?s:'https://'+s).hostname.replace(/^www\./,'').toLowerCase();}catch{return norm(s).replace(/^www\./,'');}};
const date=()=>new Date().toISOString().slice(0,10);
const brand=n=>{n=digits(n);if(/^4/.test(n))return 'Visa';if(/^(5[1-5]|2[2-7])/.test(n))return 'Mastercard';if(/^3[47]/.test(n))return 'American Express';if(/^35/.test(n))return 'JCB';if(/^(6011|65|64[4-9])/.test(n))return 'Discover';return 'Банковская карта';};
function luhn(n){let sum=0,d=false;for(let i=n.length-1;i>=0;i--){let x=+n[i];if(d){x*=2;if(x>9)x-=9;}sum+=x;d=!d;}return sum%10===0;}
function expiry(s){const m=String(s).trim().match(/^(\d{1,2})\s*[/.-]\s*(\d{2}|\d{4})$/);if(!m||+m[1]<1||+m[1]>12)return null;const y=m[2].length===2?2000+ +m[2]:+m[2],now=new Date();if(y<now.getFullYear()||(y===now.getFullYear()&&+m[1]<now.getMonth()+1))return null;return String(+m[1]).padStart(2,'0')+'/'+String(y).slice(-2);}
function show(view){state.view=view;for(const id of ['setup','lock','main','editpass','editcard','settings'])$('view-'+id).classList.toggle('hidden',id!==view);}
function msg(text,error=false,id='main-msg'){$(id).textContent=text;$(id).className='msg'+(error?' error':'');}
function activePasswords(){return state.passwords.filter(p=>!p.deleted);}
function activeCards(){return state.cards.filter(c=>!c.deleted);}
async function readData(){
 const data=await chrome.storage.local.get(['vault','cardsVault','salt']);
 if(!state.key)return;
 state.passwords=data.vault?await decryptJSON(state.key,data.vault.iv,data.vault.data):[];
 state.cards=data.cardsVault?await decryptJSON(state.key,data.cardsVault.iv,data.cardsVault.data):[];
 if(!Array.isArray(state.passwords)||!Array.isArray(state.cards))throw Error('Повреждённое хранилище');
}
async function persist(list){
 if(!state.key)throw Error('Сначала разблокируй хранилище');
 const now=Date.now(), changes={updatedAt:now};
 if(list==='passwords')changes.vault=await encryptJSON(state.key,state.passwords);
 if(list==='cards'){
   changes.cardsVault=await encryptJSON(state.key,state.cards);
   changes.cardsUpdatedAt=now;
 }
 await chrome.storage.local.set(changes);
 await chrome.storage.session.set({lastActivity:now});
 chrome.runtime.sendMessage({action:'scheduleSync'}).catch(()=>{});
}
async function copyText(s){await navigator.clipboard.writeText(s);msg('Скопировано');}
function icon(text){const e=document.createElement('span');e.className='avatar';e.textContent=text;return e;}
const faviconAttempts = new Set();
let faviconPersistTimer = null;
function siteFaviconUrl(site) {
 const domain=host(site);
 if(!/^[a-z0-9.-]+$/i.test(domain) || !domain.includes('.'))return '';
 return chrome.runtime.getURL('/_favicon/?pageUrl='+encodeURIComponent('https://'+domain+'/')+'&size=32');
}
function siteIcon(entry){
 const domain=host(entry.site);
 const tile=icon((domain.split('.')[0]||'?').slice(0,1).toUpperCase());
 tile.classList.add('site-icon');
 const src=typeof entry.iconData==='string' && /^data:image\/png;base64,/.test(entry.iconData)
   ? entry.iconData : siteFaviconUrl(entry.site);
 if(!src)return tile;
 const image=document.createElement('img');
 image.alt='';image.width=28;image.height=28;image.decoding='async';
 // The letter is ONLY a fallback. A loaded favicon replaces it entirely.
 // Previously both were in the same CSS grid, so the favicon was clipped below the letter.
 image.style.display='none';
 image.onload=()=>{
   if(!tile.isConnected)return;
   image.style.display='block';
   tile.replaceChildren(image);
   if(entry.iconData || faviconAttempts.has(domain) || entry.deleted || !state.key)return;
   faviconAttempts.add(domain);
   // Best-effort persistence in the encrypted vault. Browser favicons may block canvas extraction.
   try{
     if(!image.naturalWidth||!image.naturalHeight)return;
     const c=document.createElement('canvas');c.width=32;c.height=32;
     c.getContext('2d').drawImage(image,0,0,32,32);
     const data=c.toDataURL('image/png');
     if(data.length<=400||data.length>=24000)return;
     let updated=false;
     for(const item of state.passwords){
       if(!item.deleted && host(item.site)===domain && !item.iconData){item.iconData=data;updated=true;}
     }
     if(updated){
       clearTimeout(faviconPersistTimer);
       faviconPersistTimer=setTimeout(()=>{
         if(state.key)persist('passwords').catch(()=>{});
       },2000);
     }
   }catch{/* Invalid/tainted favicon: retain browser favicon, leave letter fallback for errors. */}
 };
 image.onerror=()=>image.remove();
 // Keep the placeholder visible until the image has loaded.
 tile.appendChild(image);
 image.src=src;
 return tile;
}
function cardLogo(brandName){
 const map={'Visa':'visa','Mastercard':'mastercard','American Express':'amex','Discover':'discover','JCB':'jcb'};
 const file=map[brandName];
 const wrap=icon('💳');wrap.classList.add('card-icon');
 if(file){const image=document.createElement('img');image.src='assets/cards/'+file+'.svg';image.alt=brandName;image.width=43;image.height=28;wrap.replaceChildren(image);}
 return wrap;
}

function button(label,title,click,cls='secondary'){const e=document.createElement('button');e.className=cls;e.textContent=label;e.title=title;e.addEventListener('click',click);return e;}
function copyAction(label,title,click){
 const e=button(label,title,click);
 e.classList.add('copy-action');
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','14');svg.setAttribute('height','14');
 svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');
 svg.setAttribute('stroke-width','1.9');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');
 const path=document.createElementNS('http://www.w3.org/2000/svg','path');
 path.setAttribute('d','M8 4h10a2 2 0 0 1 2 2v11M6 8h10a2 2 0 0 1 2 2v10H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z');
 svg.appendChild(path);e.prepend(svg);
 return e;
}
function drawPasswords(){
 const box=$('password-list');box.replaceChildren();
 const query=norm($('pass-search').value);
 const entries=activePasswords().filter(p=>norm(p.site).includes(query)||norm(p.user).includes(query)).sort((a,b)=>(b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0));
 if(!entries.length){const div=document.createElement('div');div.className='empty';div.textContent=query?'Ничего не найдено':'Пока нет паролей';box.append(div);return;}
 for(const p of entries){
  const row=document.createElement('div');row.className='item';row.append(siteIcon(p));
  const info=document.createElement('div');info.className='info';const top=document.createElement('strong');top.textContent=p.site;const bottom=document.createElement('small');bottom.textContent=p.user;info.append(top,bottom);row.append(info);
  const actions=document.createElement('div');actions.className='actions';
  actions.append(copyAction('Логин','Скопировать логин',()=>copyText(p.user).catch(()=>msg('Нет доступа к буферу',true))));
  actions.append(copyAction('Пароль','Скопировать пароль',()=>copyText(p.pass).catch(()=>msg('Нет доступа к буферу',true))));
  actions.append(button('✎','Редактировать',()=>editPass(p)));
  actions.append(button('×','Удалить',async()=>{
   if(!confirm('Удалить пароль для '+p.site+'?'))return;
   state.passwords=state.passwords.map(x=>x===p?{...x,deleted:true,pass:'',updatedAt:Date.now()}:x);
   try{await persist('passwords');drawPasswords();msg('Пароль удалён');}catch(e){msg(e.message,true);}
  }));
  row.append(actions);box.append(row);
 }
}
function drawCards(){
 const box=$('card-list');box.replaceChildren();
 const query=norm($('card-search').value);
 const entries=activeCards().filter(c=>[c.label,c.brand,c.holder,last4(c.number)].some(x=>norm(x).includes(query))).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
 if(!entries.length){const div=document.createElement('div');div.className='empty';div.textContent=query?'Ничего не найдено':'Пока нет банковских карт';box.append(div);return;}
 for(const c of entries){
  const row=document.createElement('div');row.className='item';row.append(cardLogo(c.brand));
  const info=document.createElement('div');info.className='info';const top=document.createElement('strong');top.textContent=c.label||c.brand||'Карта';const bottom=document.createElement('small');bottom.textContent='•••• '+last4(c.number)+' · '+c.expiry;info.append(top,bottom);row.append(info);
  const actions=document.createElement('div');actions.className='actions';
  actions.append(button('↗ Заполнить','Заполнить на открытом сайте' ,async()=>{
   const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
   if(!tab?.url?.startsWith('https://'))return msg('Открой HTTPS-страницу оплаты',true);
   try{
    // The card is only shared after the user explicitly presses this action.
    const resp=await chrome.tabs.sendMessage(tab.id,{action:'opassFillCardFromPopup',card:{number:c.number,holder:c.holder,expiry:c.expiry,cvv:c.cvv||''}});
    msg(resp?.ok?'Поля карты заполнены':'На странице не найдены подходящие поля',!resp?.ok);
   }catch{msg('Автозаполнение недоступно на этой странице',true);}
  }));
  actions.append(button('✎','Редактировать',()=>editCard(c)));
  actions.append(button('×','Удалить',async()=>{
   if(!confirm('Удалить карту •••• '+last4(c.number)+'?'))return;
   state.cards=state.cards.map(x=>x===c?{...x,deleted:true,number:'',cvv:'',updatedAt:Date.now()}:x);
   try{await persist('cards');drawCards();msg('Карта удалена');}catch(e){msg(e.message,true);}
  }));
  row.append(actions);box.append(row);
 }
}
function chooseTab(tab){state.tab=tab;$('passwords-panel').classList.toggle('hidden',tab!=='passwords');$('cards-panel').classList.toggle('hidden',tab!=='cards');$('tab-passwords').classList.toggle('active',tab==='passwords');$('tab-cards').classList.toggle('active',tab==='cards');tab==='cards'?drawCards():drawPasswords();}
function editPass(p){state.editPass=p||null;$('pass-title').textContent=p?'Изменить пароль':'Новый пароль';$('pass-site').value=p?.site||'';$('pass-user').value=p?.user||'';$('pass-password').value=p?.pass||'';show('editpass');}
function editCard(c){state.editCard=c||null;$('card-title').textContent=c?'Редактировать карту':'Добавить карту';$('card-label').value=c?.label||'';$('card-number').value=c?.number||'';$('card-holder').value=c?.holder||'';$('card-expiry').value=c?.expiry||'';$('card-cvv').value=c?.cvv||'';updatePreview();show('editcard');}
function updatePreview(){
 const n=digits($('card-number').value),b=brand(n);
 const file={'Visa':'visa','Mastercard':'mastercard','American Express':'amex','Discover':'discover','JCB':'jcb'}[b];
 const logo=$('preview-logo');logo.classList.toggle('hidden',!file);
 if(file){logo.src='assets/cards/'+file+'.svg';logo.alt=b;}
 $('preview-brand').textContent=!n?'oPass CARD':file?'':b;
 $('preview-number').textContent=n?'•••• •••• •••• '+n.slice(-4):'•••• •••• •••• ••••';
 $('preview-holder').textContent=$('card-holder').value||'CARDHOLDER';
 $('preview-expiry').textContent=$('card-expiry').value||'MM/YY';
}
async function loadPending(){
 const box=$('pending');box.replaceChildren();
 const resp=await chrome.runtime.sendMessage({action:'pending'}).catch(()=>null);
 if(!resp?.ok||!resp.items?.length){box.classList.add('hidden');return;}
 box.classList.remove('hidden');
 for(const p of resp.items){
  const row=document.createElement('div');row.className='banner';const text=document.createElement('strong');text.textContent=p.type==='card'?`💳 Сохранить карту •••• ${p.last4}?`:`🔐 Сохранить пароль для ${p.site}?`;
  const inner=document.createElement('div');inner.className='row topgap';inner.append(
   button('Не сейчас','Не сохранять',async()=>{await chrome.runtime.sendMessage({action:'rejectPending',id:p.id});loadPending();},'secondary'),
   button('Сохранить','Сохранить в зашифрованное хранилище',async()=>{const res=await chrome.runtime.sendMessage({action:'confirmPending',id:p.id});if(res?.ok){await readData();drawCards();drawPasswords();loadPending();msg('Сохранено');}else msg('Не удалось сохранить',true);},'')
  );row.append(text,inner);box.append(row);
 }
}
async function unlock(pass){
 const raw=await deriveRawKey(pass,state.salt),key=await importAesKey(raw);
 const {vault}=await chrome.storage.local.get('vault');if(!vault)throw Error('Хранилище отсутствует');
 await decryptJSON(key,vault.iv,vault.data); // Validates master password.
 state.key=key;state.raw=raw;
 await chrome.storage.session.set({key:Array.from(raw),lastActivity:Date.now()});
 await readData();show('main');chooseTab(state.tab);loadPending();
}
async function startup(){
 const local=await chrome.storage.local.get(['salt','vault']);
 if(!local.salt||!local.vault){show('setup');return;}
 state.salt=new Uint8Array(local.salt);
 const s=await chrome.storage.session.get(['key','lastActivity']);
 if(s.key&&Date.now()-s.lastActivity<15*60*1000){
  try{state.raw=new Uint8Array(s.key);state.key=await importAesKey(state.raw);await readData();show('main');chooseTab('passwords');loadPending();return;}catch{state.key=null;}
 }
 show('lock');
}
$('setup-btn').onclick=async()=>{
 const p=$('setup1').value;if(p.length<8)return msg('Мастер-пароль должен содержать минимум 8 символов',true,'setup-msg');
 if(p!==$('setup2').value)return msg('Пароли не совпадают',true,'setup-msg');
 $('setup-btn').disabled=true;
 try{
  const salt=randomSalt(),raw=await deriveRawKey(p,salt),key=await importAesKey(raw);
  const vault=await encryptJSON(key,[]),cardsVault=await encryptJSON(key,[]);
  await chrome.storage.local.set({salt:Array.from(salt),vault,cardsVault,updatedAt:Date.now()});
  state.salt=salt;state.raw=raw;state.key=key;state.passwords=[];state.cards=[];
  await chrome.storage.session.set({key:Array.from(raw),lastActivity:Date.now()});
  show('main');chooseTab('passwords');
 }catch(e){msg(e.message,true,'setup-msg');}finally{$('setup-btn').disabled=false;}
};
$('unlock-btn').onclick=async()=>{try{await unlock($('unlock-pass').value);$('unlock-pass').value='';}catch(e){msg('Неверный мастер-пароль или повреждённое хранилище',true,'lock-msg');}};
$('unlock-pass').onkeydown=e=>{if(e.key==='Enter')$('unlock-btn').click();};
$('restore-btn').onclick=async()=>{
 $('restore-btn').disabled=true;msg('Подключаем Google Drive…',false,'setup-msg');
 try{const r=await chrome.runtime.sendMessage({action:'forceSync'});if(r?.ok&&r.action==='downloaded'){const data=await chrome.storage.local.get('salt');state.salt=new Uint8Array(data.salt);show('lock');msg('Копия загружена — введи мастер-пароль',false,'lock-msg');}else msg(r.error||'Резервной копии нет',true,'setup-msg');}catch(e){msg(e.message,true,'setup-msg');}
 finally{$('restore-btn').disabled=false;}
};
$('tab-passwords').onclick=()=>chooseTab('passwords');$('tab-cards').onclick=()=>chooseTab('cards');
let searchTimer;
$('pass-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(drawPasswords,90);};
$('card-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(drawCards,90);};
$('add-pass').onclick=()=>editPass();$('add-card').onclick=()=>editCard();$('new-card-bottom').onclick=()=>editCard();
$('pass-cancel').onclick=()=>show('main');
$('pass-form').onsubmit=async e=>{
 e.preventDefault();const site=$('pass-site').value.trim(),user=$('pass-user').value.trim(),pass=$('pass-password').value;
 if(!site||!user||!pass)return msg('Все поля обязательны',true,'pass-msg');
 const previous=state.editPass,now=Date.now();
 if(previous && (norm(site)!==norm(previous.site)||norm(user)!==norm(previous.user))){
  state.passwords=state.passwords.map(x=>x===previous?{...x,deleted:true,pass:'',updatedAt:now}:x);
 }
 state.passwords=state.passwords.filter(x=>x!==previous);
 state.passwords.push({site,user,pass,iconData:previous&&host(previous.site)===host(site)?previous.iconData:undefined,createdAt:previous?.createdAt||now,updatedAt:now});
 try{await persist('passwords');show('main');drawPasswords();msg('Пароль сохранён');}catch(err){msg(err.message,true,'pass-msg');}
};
$('card-cancel').onclick=$('card-cancel-top').onclick=()=>show('main');
for(const id of ['card-number','card-holder','card-expiry'])$(id).oninput=updatePreview;
$('card-form').onsubmit=async e=>{
 e.preventDefault();const number=digits($('card-number').value),cvv=digits($('card-cvv').value),holder=$('card-holder').value.trim(),exp=expiry($('card-expiry').value);
 if(number.length<12||number.length>19||!luhn(number))return msg('Неверный номер карты',true,'card-msg');
 if(!holder)return msg('Введите имя владельца',true,'card-msg');
 if(!exp)return msg('Неверный или истёкший срок действия',true,'card-msg');
 if(cvv&&!/^\d{3,4}$/.test(cvv))return msg('CVV/CVC должен содержать 3–4 цифры',true,'card-msg');
 const now=Date.now(),prev=state.editCard;
 const card={id:prev?.id||crypto.randomUUID(),number,cvv,holder,expiry:exp,label:$('card-label').value.trim()||brand(number),brand:brand(number),createdAt:prev?.createdAt||now,updatedAt:now};
 state.cards=state.cards.filter(x=>x!==prev);
 state.cards.push(card);
 try{await persist('cards');show('main');chooseTab('cards');msg('Карта зашифрована и сохранена');}catch(err){msg(err.message,true,'card-msg');}
};
async function sync(){msg('Синхронизация с Google Drive…');const r=await chrome.runtime.sendMessage({action:'forceSync'});if(r?.ok){await readData();drawPasswords();drawCards();msg('Синхронизировано ✓');}else msg('Ошибка: '+(r?.error||'нет подключения'),true);}
$('sync-btn').onclick=sync;$('settings-sync').onclick=async()=>{const r=await chrome.runtime.sendMessage({action:'forceSync'});if(r?.ok){await readData();msg('Синхронизировано ✓',false,'settings-msg');}else msg(r?.error||'Ошибка',true,'settings-msg');};
$('lock-btn').onclick=async()=>{clearTimeout(faviconPersistTimer);state.key=null;state.raw=null;state.passwords=[];state.cards=[];await chrome.storage.session.remove(['key','lastActivity','pendingEncrypted']);show('lock');};
$('settings-btn').onclick=async()=>{
 const vals=await chrome.storage.local.get('settings');
 const s=vals.settings||{};
 for(const [id,key] of [['setting-fill-password','fillPasswords'],['setting-fill-card','fillCards'],['setting-capture-password','capturePasswords'],['setting-capture-card','captureCards']])$(id).checked=s[key]!==false;
 show('settings');
};
$('settings-back').onclick=()=>{show('main');chooseTab(state.tab);};
for(const [id,key] of [['setting-fill-password','fillPasswords'],['setting-fill-card','fillCards'],['setting-capture-password','capturePasswords'],['setting-capture-card','captureCards']]){
 $(id).onchange=async e=>{const vals=await chrome.storage.local.get('settings');await chrome.storage.local.set({settings:{...vals.settings,[key]:e.target.checked}});};
}
function download(filename,obj){const data=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});const url=URL.createObjectURL(data),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export-encrypted').onclick=async()=>{
 const l=await chrome.storage.local.get(['vault','cardsVault','salt','updatedAt']);
 download('opass-encrypted-'+date()+'.json',{format:'helium-pm-backup',version:2,createdAt:new Date().toISOString(),salt:l.salt,vault:l.vault,cardsVault:l.cardsVault,updatedAt:l.updatedAt});
 msg('Зашифрованная резервная копия сохранена',false,'settings-msg');
};
$('import-encrypted').onclick=()=>$('import-file').click();
$('import-file').onchange=async e=>{
 const f=e.target.files[0];e.target.value='';if(!f)return;
 try{
  const data=JSON.parse(await f.text());
  if(data.format!=='helium-pm-backup'||!data.vault||!Array.isArray(data.salt))throw Error('Это не зашифрованная копия oPass');
  let password=null,key;
  if(JSON.stringify(data.salt)===JSON.stringify(Array.from(state.salt)))key=state.key;
  else {password=prompt('Введи мастер-пароль от резервной копии');if(!password)return;key=await importAesKey(await deriveRawKey(password,new Uint8Array(data.salt)));}
  const p=await decryptJSON(key,data.vault.iv,data.vault.data);
  const c=data.cardsVault?await decryptJSON(key,data.cardsVault.iv,data.cardsVault.data):[];
  if(!Array.isArray(p)||!Array.isArray(c))throw Error('Повреждённая копия');
  if(!confirm('Импортировать '+p.length+' паролей и '+c.length+' карт? Текущие записи будут объединены.'))return;
  const merge=(a,b,k)=>{const m=new Map();for(const x of [...a,...b]){const id=k(x);if(!id)continue;if(!m.has(id)||(x.updatedAt||x.createdAt||0)>=(m.get(id).updatedAt||m.get(id).createdAt||0))m.set(id,x);}return [...m.values()];};
  state.passwords=merge(state.passwords,p,x=>norm(x.site)+'|'+norm(x.user));
  state.cards=merge(state.cards,c,x=>x.id||digits(x.number));
  const now=Date.now();
  await chrome.storage.local.set({vault:await encryptJSON(state.key,state.passwords),cardsVault:await encryptJSON(state.key,state.cards),updatedAt:now,cardsUpdatedAt:now});
  chrome.runtime.sendMessage({action:'scheduleSync'}).catch(()=>{});
  msg('Импортировано: '+p.length+' паролей и '+c.length+' карт',false,'settings-msg');
 }catch(err){msg(err.message||'Ошибка импорта',true,'settings-msg');}
};
$('change-master').onclick=async()=>{
 const old=$('old-master').value,pass=$('new-master').value,repeat=$('repeat-master').value;
 if(pass.length<8||pass!==repeat)return msg('Новый пароль слишком короткий или не совпадает',true,'settings-msg');
 try{
  const check=await importAesKey(await deriveRawKey(old,state.salt));
  const {vault}=await chrome.storage.local.get('vault');await decryptJSON(check,vault.iv,vault.data);
  const previousSalt=Array.from(state.salt);
  const salt=randomSalt(),raw=await deriveRawKey(pass,salt),key=await importAesKey(raw),now=Date.now();
  await chrome.storage.local.set({salt:Array.from(salt),vault:await encryptJSON(key,state.passwords),cardsVault:await encryptJSON(key,state.cards),updatedAt:now,cardsUpdatedAt:now});
  await chrome.storage.session.set({key:Array.from(raw),lastActivity:now});
  state.salt=salt;state.key=key;state.raw=raw;
  for(const id of ['old-master','new-master','repeat-master'])$(id).value='';
  const rekey=await chrome.runtime.sendMessage({action:'forceCloudRekey',previousSalt});
  msg(rekey?.ok?'Пароль изменён и облако перешифровано. На остальных устройствах потребуется восстановление с новым паролем.':'Мастер-пароль изменён локально. Google Drive не обновлён: '+(rekey?.error||'ошибка')+'. Сохрани зашифрованную резервную копию.',!rekey?.ok,'settings-msg');
 }catch(err){msg('Неверный старый пароль или ошибка перешифрования',true,'settings-msg');}
};
$('factory-reset').onclick=async()=>{
 if(!confirm('УДАЛИТЬ все локальные пароли, карты и настройки? Это действие необратимо без резервной копии.'))return;
 if(!confirm('Подтверди удаление локального хранилища oPass.'))return;
 await chrome.storage.local.clear();await chrome.storage.session.clear();state.key=null;state.raw=null;state.passwords=[];state.cards=[];show('setup');
};
startup().catch(err=>{show('lock');msg(err.message||'Ошибка загрузки',true,'lock-msg');});
