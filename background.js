import { importAesKey, encryptJSON, decryptJSON } from './crypto.js';

// This is the OAuth client used by the original repository's background.js.
const GOOGLE_CLIENT_ID = '509211745069-nphnrfjl61ahe04pik58ugpn28rsvf7i.apps.googleusercontent.com';
const DRIVE_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const LOCK_MS = 15 * 60 * 1000;
const AUTO_SYNC_ALARM = 'opass-cloud-sync';
const norm = x => String(x || '').trim().toLowerCase();
const digits = x => String(x || '').replace(/\D/g, '');

async function sessionKey() {
  const s = await chrome.storage.session.get(['key','lastActivity']);
  if (!s.key || Date.now() - (s.lastActivity || 0) > LOCK_MS) {
    await chrome.storage.session.remove(['key','lastActivity','pendingEncrypted']);
    return null;
  }
  return importAesKey(new Uint8Array(s.key));
}
async function touch() { await chrome.storage.session.set({lastActivity:Date.now()}); }
async function readList(key, field) {
  const local = await chrome.storage.local.get(field);
  if (!local[field]) return [];
  const rows = await decryptJSON(key,local[field].iv,local[field].data);
  if (!Array.isArray(rows)) throw Error('Некорректная структура хранилища');
  return rows;
}
async function pendingList(key) {
  const s = await chrome.storage.session.get('pendingEncrypted');
  if (!s.pendingEncrypted) return [];
  try { return await decryptJSON(key,s.pendingEncrypted.iv,s.pendingEncrypted.data); }
  catch { return []; }
}
async function updatePending(key,rows) {
  await chrome.storage.session.set({pendingEncrypted:await encryptJSON(key,rows)});
  await chrome.action.setBadgeText({text:rows.length ? String(rows.length) : ''});
  await chrome.action.setBadgeBackgroundColor({color:'#059669'});
}
const describePending = p => p.type === 'card'
  ? {id:p.id,type:'card',site:p.site,label:p.card.label || p.card.brand,last4:digits(p.card.number).slice(-4)}
  : {id:p.id,type:'password',site:p.site,user:p.user};
function checkCardNumber(s) {
  if (!/^\d{12,19}$/.test(s)) return false;
  let n=0,d=false;
  for(let i=s.length-1;i>=0;i--){let x=+s[i];if(d){x*=2;if(x>9)x-=9;}n+=x;d=!d;}
  return n%10===0;
}
function validExpiry(exp) {
  const m=String(exp||'').match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if(!m||+m[1]<1||+m[1]>12)return false;
  const year=m[2].length===2?2000+ +m[2]:+m[2];
  const now=new Date();return year>now.getFullYear() || year===now.getFullYear() && +m[1]>=now.getMonth()+1;
}
function recordTime(x) { return x.updatedAt || x.createdAt || 0; }
function mergeLists(a,b,keyOf) {
  const out = new Map();
  for (const x of [...a,...b]) {
    const k=keyOf(x); if(!k)continue;
    if(!out.has(k) || recordTime(x)>recordTime(out.get(k)))out.set(k,x);
  }
  return [...out.values()];
}
const mergePasswords=(a,b)=>mergeLists(a,b,x=>norm(x.site)+'\u0000'+norm(x.user));
const mergeCards=(a,b)=>mergeLists(a,b,x=>x.id || digits(x.number));

async function authToken(force=false,interactive=true) {
  const cached=await chrome.storage.session.get('googleToken');
  if(!force&&cached.googleToken)return cached.googleToken;
  if(!interactive) throw Error('Откройте oPass и запустите ручную синхронизацию для входа в Google Drive');
  const redirect=chrome.identity.getRedirectURL();
  const url='https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({
    client_id:GOOGLE_CLIENT_ID,response_type:'token',redirect_uri:redirect,
    scope:'https://www.googleapis.com/auth/drive.appdata'
  });
  const returned=await chrome.identity.launchWebAuthFlow({url,interactive:true});
  if(!returned)throw Error('Авторизация Google отменена');
  const params=new URLSearchParams(new URL(returned).hash.slice(1));
  const token=params.get('access_token');
  if(!token)throw Error(params.get('error') || 'Не получен токен Google');
  await chrome.storage.session.set({googleToken:token});
  return token;
}
async function driveFetch(url,opts={},interactive=true) {
  let token=await authToken(false,interactive);
  let res=await fetch(url,{...opts,headers:{...opts.headers,Authorization:'Bearer '+token}});
  if(res.status===401) {
    await chrome.storage.session.remove('googleToken');
    token=await authToken(true,interactive);
    res=await fetch(url,{...opts,headers:{...opts.headers,Authorization:'Bearer '+token}});
  }
  if(!res.ok)throw Error('Google Drive: HTTP '+res.status+' '+(await res.text()).slice(0,300));
  return res;
}
async function uploadToDrive(id,data,interactive=true) {
  const metadata=id?{name:'vault.json'}:{name:'vault.json',parents:['appDataFolder']};
  const boundary='opass-'+crypto.randomUUID();
  const body='--'+boundary+'\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'+JSON.stringify(metadata)+
    '\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(data)+'\r\n--'+boundary+'--';
  const url=id?`${UPLOAD_URL}/${encodeURIComponent(id)}?uploadType=multipart`:`${UPLOAD_URL}?uploadType=multipart`;
  await driveFetch(url,{method:id?'PATCH':'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body},interactive);
}
let syncing=null;
function syncVault(interactive=true) {
  if(syncing)return syncing;
  syncing=performSync(interactive).finally(()=>{syncing=null;});
  return syncing;
}
async function performSync(interactive=true) {
  try {
    const q=encodeURIComponent("name = 'vault.json' and trashed = false");
    const result=await (await driveFetch(`${DRIVE_URL}?spaces=appDataFolder&q=${q}&fields=files(id,name)`,{},interactive)).json();
    const id=result.files?.[0]?.id||null;
    const local=await chrome.storage.local.get(['vault','cardsVault','salt','updatedAt','cardsUpdatedAt']);
    let remote=null;
    if(id)remote=await (await driveFetch(`${DRIVE_URL}/${encodeURIComponent(id)}?alt=media`,{},interactive)).json();
    if(!local.vault && remote?.vault) {
      await chrome.storage.local.set({vault:remote.vault,cardsVault:remote.cardsVault||null,salt:remote.salt,
        updatedAt:remote.updatedAt||0,cardsUpdatedAt:remote.cardsUpdatedAt||0});
      return {ok:true,action:'downloaded'};
    }
    if(local.vault && !remote) {
      await uploadToDrive(null,local,interactive);
      return {ok:true,action:'uploaded'};
    }
    if(!local.vault && !remote)return {ok:false,error:'В Google Drive нет резервной копии'};
    if(remote.updatedAt===local.updatedAt && remote.cardsUpdatedAt===local.cardsUpdatedAt &&
      remote.vault?.data===local.vault?.data && remote.cardsVault?.data===local.cardsVault?.data)
      return {ok:true,action:'synced'};
    const key=await sessionKey();
    if(!key)return {ok:false,error:'Разблокируйте oPass для безопасного объединения данных'};
    if(JSON.stringify(local.salt)!==JSON.stringify(remote.salt))
      throw Error('Разные мастер-ключи на устройствах. Создайте резервную копию перед импортом.');
    const dec=(encrypted)=>encrypted?decryptJSON(key,encrypted.iv,encrypted.data):Promise.resolve([]);
    // Never silently discard a remote vault if it cannot be decrypted.
    const [lp,rp,lc,rc]=await Promise.all([dec(local.vault),dec(remote.vault),dec(local.cardsVault),dec(remote.cardsVault)]);
    if(![lp,rp,lc,rc].every(Array.isArray))throw Error('Некорректный формат синхронизируемых данных');
    const passwords=mergePasswords(lp,rp);
    const cards=mergeCards(lc,rc);
    const beforeSave=await chrome.storage.local.get(['updatedAt']);
    if((beforeSave.updatedAt||0)>(local.updatedAt||0))
      throw Error('Данные изменились во время синхронизации. Повторите синхронизацию.');
    const now=Date.now();
    const vault=await encryptJSON(key,passwords);
    const cardsVault=await encryptJSON(key,cards);
    const saved={vault,cardsVault,salt:local.salt,updatedAt:now,cardsUpdatedAt:now};
    await chrome.storage.local.set(saved);
    await uploadToDrive(id,saved,interactive);
    return {ok:true,action:'merged'};
  } catch (e) {
    return {ok:false,error:e.message || String(e)};
  }
}

async function handle(req,sender) {
  if(req.action==='forceSync'){
    if(sender.tab)return {ok:false,error:'Access denied'};
    return syncVault(true);
  }
  if(req.action==='scheduleSync'){
    if(sender.tab)return {ok:false,error:'Access denied'};
    await chrome.alarms.create(AUTO_SYNC_ALARM,{delayInMinutes:0.5});
    return {ok:true,action:'scheduled'};
  }
  // When the master password changes, re-encrypting the cloud copy must be
  // explicit, authenticated, and conditional on its previous salt.
  if(req.action==='forceCloudRekey') {
    if(sender.tab) return {ok:false,error:'Not allowed from web pages'};
    const key=await sessionKey();
    if(!key) return {ok:false,error:'locked'};
    const local=await chrome.storage.local.get(['vault','cardsVault','salt','updatedAt','cardsUpdatedAt']);
    if(!local.vault || !local.salt) return {ok:false,error:'Empty local vault'};
    await decryptJSON(key,local.vault.iv,local.vault.data);
    if(local.cardsVault) await decryptJSON(key,local.cardsVault.iv,local.cardsVault.data);
    try {
      const q=encodeURIComponent("name = 'vault.json' and trashed = false");
      const result=await (await driveFetch(`${DRIVE_URL}?spaces=appDataFolder&q=${q}&fields=files(id,name)`)).json();
      const id=result.files?.[0]?.id||null;
      if(id) {
        const remote=await (await driveFetch(`${DRIVE_URL}/${encodeURIComponent(id)}?alt=media`)).json();
        if(JSON.stringify(remote.salt)!==JSON.stringify(req.previousSalt))
          throw Error('Облачная копия уже изменена другим устройством. Сохраните резервную копию и проверьте данные.');
      }
      await uploadToDrive(id,local);
      return {ok:true,action:'rekeyed'};
    }catch(e){return {ok:false,error:e.message||String(e)};}
  }
  const key=await sessionKey();
  if(!key)return {ok:false,error:'locked'};
  const fromPage=Boolean(sender.tab);
  const pageUrl=sender.url||sender.origin||'';
  const host=(()=>{try{return new URL(pageUrl).hostname;}catch{return '';}})();
  if(fromPage && !pageUrl.startsWith('https://'))return {ok:false,error:'HTTPS required'};
  if(req.action==='capturePassword' || req.action==='captureCard') {
    if(!fromPage || !host)return {ok:false,error:'invalid page'};
    const pending=await pendingList(key);
    if(req.action==='capturePassword') {
      if(typeof req.pass!=='string'||!req.pass||req.pass.length>4096)return {ok:false};
      if(pending.some(x=>x.type==='password'&&x.site===host&&x.user===req.user&&x.pass===req.pass))return {ok:true,duplicate:true};
      const iconData=typeof req.iconData==='string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(req.iconData) && req.iconData.length<24000 ? req.iconData : undefined;
      const item={id:crypto.randomUUID(),type:'password',site:host,user:String(req.user||'').slice(0,512),pass:req.pass,iconData};
      pending.push(item);await updatePending(key,pending);return {ok:true,id:item.id};
    }
    const card=req.card||{};
    const number=digits(card.number),cvv=digits(card.cvv);
    if(!checkCardNumber(number)||!validExpiry(card.expiry)||cvv.length>4||!/^\d{0,4}$/.test(cvv))return {ok:false};
    if(pending.some(x=>x.type==='card'&&x.card.number===number))return {ok:true,duplicate:true};
    const item={id:crypto.randomUUID(),type:'card',site:host,card:{number,cvv,
      holder:String(card.holder||'').trim().slice(0,128),expiry:card.expiry,
      label:String(card.label||'').trim().slice(0,80),brand:String(card.brand||'Карта').slice(0,32)}};
    pending.push(item);await updatePending(key,pending);return {ok:true,id:item.id};
  }
  if(req.action==='pending') {
    return {ok:true,items:(await pendingList(key)).map(describePending)};
  }
  if(req.action==='rejectPending' || req.action==='confirmPending') {
    const pending=await pendingList(key);
    const p=pending.find(x=>x.id===req.id);
    if(!p)return {ok:false,error:'not_found'};
    if(req.action==='confirmPending') {
      const now=Date.now();
      if(p.type==='password') {
        const arr=await readList(key,'vault');
        const dupe=arr.find(x=>!x.deleted&&norm(x.site)===norm(p.site)&&norm(x.user)===norm(p.user)&&x.pass===p.pass);
        if(!dupe) {
          arr.push({site:p.site,user:p.user,pass:p.pass,iconData:p.iconData,createdAt:now,updatedAt:now});
          await chrome.storage.local.set({vault:await encryptJSON(key,arr),updatedAt:now});
        }
      } else {
        const arr=await readList(key,'cardsVault');
        const existing=arr.find(x=>!x.deleted&&x.number===p.card.number);
        if(!existing) {
          arr.push({id:crypto.randomUUID(),...p.card,createdAt:now,updatedAt:now});
          await chrome.storage.local.set({cardsVault:await encryptJSON(key,arr),updatedAt:now,cardsUpdatedAt:now});
        }
      }
    }
    await updatePending(key,pending.filter(x=>x.id!==p.id));
    if(req.action==='confirmPending')chrome.alarms.create(AUTO_SYNC_ALARM,{delayInMinutes:0.5}).catch(()=>{});
    return {ok:true};
  }
  if(req.action==='getLoginOptions' && fromPage) {
    const arr=await readList(key,'vault');
    const matches=arr.filter(x=>!x.deleted && norm(x.site).replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0]===norm(host).replace(/^www\./,''));
    return {ok:true,items:matches.map(x=>({id:norm(x.site)+'\u0000'+norm(x.user),user:x.user,site:x.site}))};
  }
  if(req.action==='getLoginRecord' && fromPage) {
    const arr=await readList(key,'vault');
    const item=arr.find(x=>!x.deleted&&norm(x.site)+'\u0000'+norm(x.user)===req.id);
    if(!item)return {ok:false};
    const expected=norm(item.site).replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0];
    if(expected!==norm(host).replace(/^www\./,''))return {ok:false,error:'origin mismatch'};
    await touch();return {ok:true,item:{user:item.user,pass:item.pass}};
  }
  if(req.action==='getCardOptions' && fromPage) {
    const arr=await readList(key,'cardsVault');
    return {ok:true,items:arr.filter(x=>!x.deleted).map(x=>({id:x.id,brand:x.brand||'Карта',label:x.label||x.brand||'Карта',last4:digits(x.number).slice(-4),expiry:x.expiry}))};
  }
  if(req.action==='getCardRecord' && fromPage) {
    const arr=await readList(key,'cardsVault');
    const item=arr.find(x=>!x.deleted&&x.id===req.id);
    if(!item)return {ok:false};
    await touch();return {ok:true,item:{number:item.number,holder:item.holder,expiry:item.expiry,cvv:item.cvv||''}};
  }
  return {ok:false,error:'Unknown action'};
}
chrome.runtime.onMessage.addListener((req,sender,reply)=>{
  Promise.resolve(handle(req,sender)).then(reply,e=>reply({ok:false,error:e.message||String(e)}));
  return true;
});
chrome.runtime.onInstalled.addListener(()=>chrome.action.setBadgeBackgroundColor({color:'#059669'}));
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name!==AUTO_SYNC_ALARM)return;
  // Auto sync never opens an OAuth window unexpectedly; manual sync can authenticate.
  syncVault(false).catch(()=>{});
});
