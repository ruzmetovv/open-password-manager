// oPass content script. Card numbers/CVV never appear in UI suggestions:
// a card is fetched from the encrypted vault only after an explicit user click.
(() => {
 if (window.__opassLoaded) return;
 window.__opassLoaded = true;
 if (location.protocol !== 'https:') return;
 const digits=s=>String(s||'').replace(/\D/g,'');
 const norm=s=>String(s||'').toLowerCase().replace(/[\s_-]+/g,'');
 const visible=el=>el&&el.isConnected&&!el.disabled&&!el.readOnly&&el.getClientRects().length>0;
 // Read the DOM once per event rather than querying the whole page repeatedly.
 const inputs=()=>[...document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select')].filter(visible);
 const typeCache=new WeakMap();
 const attr=el=>norm([el.name,el.id,el.getAttribute('autocomplete'),el.placeholder,el.getAttribute('aria-label'),el.labels?.[0]?.textContent||''].join(' '));
 const typeOf=el=>{
   const raw=[el.name,el.id,el.getAttribute('autocomplete'),el.placeholder,el.getAttribute('aria-label'),el.labels?.[0]?.textContent||''].join('|');
   const cached=typeCache.get(el);
   if(cached?.raw===raw)return cached.type;
   const a=norm(raw),placeholder=norm(el.getAttribute('placeholder'));
   const ac=norm(el.getAttribute('autocomplete'));
   let kind=null;
   if(ac==='cc-number'||/(?:ccnumber|cardnumber|creditcardnumber|kartennummer|номеркарты|cardno|cardnum|cardnumberinput|cardnumberfield)/.test(a))kind='number';
   else if(ac==='cc-csc'||/(?:cccsc|cvc|cvv|cardsecuritycode|cardverification|securitycode|prüfnummer|кодбезопасности)/.test(a))kind='cvv';
   else if(ac==='cc-exp-month'||/(?:ccexpmonth|expirymonth|expmonth|monthofexpiry)/.test(a)||/^(mm|monat|month)$/.test(placeholder))kind='month';
   else if(ac==='cc-exp-year'||/(?:ccexpyear|expiryyear|expyear|yearofexpiry)/.test(a)||/^(yy|yyyy|jahr|year)$/.test(placeholder))kind='year';
   else if(ac==='cc-exp'||/(?:ccexp|expirydate|expirationdate|expdate|validuntil|срокдействия|gültigbis)/.test(a)||/^(mm\/?yy|mm\/?yyyy|mm\/yy|mm\/yyyy)$/.test(placeholder))kind='expiry';
   else if(ac==='cc-name'||/(?:ccname|cardholder|nameoncard|cardowner|karteninhaber|владелецкарты)/.test(a))kind='holder';
   typeCache.set(el,{raw,type:kind});return kind;
 };
 const mapFields=()=>{
   const out={};for(const el of inputs()){const t=typeOf(el);if(t&&!out[t])out[t]=el;}return out;
 };
 const getExpiry=fields=>{
   if(fields.expiry?.value){
     let s=String(fields.expiry.value).trim();const raw=digits(s);
     if(raw.length===4||raw.length===6)s=raw.slice(0,2)+'/'+raw.slice(2);
     return s;
   }
   if(fields.month&&fields.year)return String(fields.month.value).padStart(2,'0')+'/'+String(fields.year.value).slice(-2);
   return '';
 };
 const validExpiry=s=>{const m=String(s||'').match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);if(!m||+m[1]<1||+m[1]>12)return false;const y=m[2].length===2?2000+ +m[2]:+m[2],n=new Date();return y>n.getFullYear()||y===n.getFullYear()&&+m[1]>=n.getMonth()+1;};
 const luhn=s=>{let sum=0,d=false;for(let i=s.length-1;i>=0;i--){let x=+s[i];if(d){x*=2;if(x>9)x-=9;}sum+=x;d=!d;}return sum%10===0;};
 const brand=n=>{n=digits(n);if(/^4/.test(n))return 'Visa';if(/^(5[1-5]|2[2-7])/.test(n))return 'Mastercard';if(/^3[47]/.test(n))return 'American Express';return 'Банковская карта';};
 const readCard=()=>{
   const f=mapFields(),number=digits(f.number?.value||''),expiry=getExpiry(f);
   if(number.length<12||number.length>19||!luhn(number)||!validExpiry(expiry))return null;
   return {number,expiry,holder:f.holder?.value?.trim()||'',cvv:digits(f.cvv?.value||''),label:brand(number),brand:brand(number)};
 };
 function nativeSet(el,value){
   if(!el||!visible(el))return false;
   const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
   const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
   if(setter)setter.call(el,String(value));else el.value=String(value);
   el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
   return true;
 }
 function chooseOption(el,possibilities){
   for(const v of possibilities){
     const opt=[...el.options].find(o=>o.value===v||o.textContent?.trim()===v);
     if(opt){nativeSet(el,opt.value);return true;}
   }
   return false;
 }
 // Input[ maxlength=2 ] containing YY must get "27", NOT "2027" (which truncates to "20").
 const setYear=(el,shortYear)=>{
   if(!el)return false;
   const yy=String(shortYear).padStart(2,'0').slice(-2),yyyy='20'+yy;
   if(el instanceof HTMLSelectElement)return chooseOption(el,[yyyy,yy]);
   const max=el.maxLength;
   const ac=norm(el.getAttribute('autocomplete'));
   const placeholder=norm(el.placeholder);
   const useShort=max>0&&max<=2||placeholder==='yy'&&!/yyyy/.test(placeholder);
   return nativeSet(el,useShort?yy:yyyy);
 };
 const setMonth=(el,month)=>{
   if(!el)return false;
   if(el instanceof HTMLSelectElement)return chooseOption(el,[month,String(Number(month))]);
   return nativeSet(el,month);
 };
 const setExpiry=(el,expiry)=>{
   if(!el)return false;
   const [month,storedYear]=expiry.split('/');
   const year=storedYear.slice(-2);
   if(el instanceof HTMLSelectElement)return chooseOption(el,[month+'/'+year,month+'/20'+year]);
   const max=el.maxLength;
   const placeholder=norm(el.placeholder);
   const wantsFullYear=placeholder.includes('yyyy');
   const value=max===4||placeholder==='mmyy'?month+year:
    max===6&&wantsFullYear?month+'20'+year:
    wantsFullYear?month+'/20'+year:
    max>0&&max<=5?month+'/'+year:month+'/'+year;
   return nativeSet(el,value);
 };
 const fillCard=card=>{
   const f=mapFields();let count=0;
   const [month,storedYear]=String(card.expiry||'').split('/');
   const year=storedYear?.slice(-2);
   if(!month||!year)return false;
   if(f.number)count+=+nativeSet(f.number,card.number);
   if(f.holder)count+=+nativeSet(f.holder,card.holder);
   if(f.expiry)count+=+setExpiry(f.expiry,month+'/'+year);
   if(f.month)count+=+setMonth(f.month,month);
   if(f.year)count+=+setYear(f.year,year);
   if(f.cvv&&card.cvv)count+=+nativeSet(f.cvv,card.cvv);
   return count>0;
 };
 const passField=()=>inputs().find(el=>el.type==='password'||el.autocomplete==='current-password');
 const usernameField=()=>inputs().find(el=>el.autocomplete==='username')||inputs().find(el=>/email|user|login|логин|benutzer/.test(attr(el)))||inputs().find(el=>el.type==='email');
 const fillLogin=p=>{let filled=false;const u=usernameField(),pw=passField();if(u)filled=nativeSet(u,p.user)||filled;if(pw)filled=nativeSet(pw,p.pass)||filled;return filled;};
 // The site's own favicon is snapshotted once and encrypted alongside the
 // credential when the user confirms saving. No third-party favicon server.
 let pageIconData=null;
 (async()=>{
   const source=document.querySelector('link[rel~="icon"][href]')?.getAttribute('href')||'/favicon.ico';
   const url=new URL(source,location.href);
   if(url.origin!==location.origin)return;
   const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),2500);
   try{
     const res=await fetch(url.href,{credentials:'same-origin',cache:'force-cache',signal:ctrl.signal});
     if(!res.ok||Number(res.headers.get('content-length')||0)>64000)return;
     const blob=await res.blob();
     if(blob.size>64000 || !/^image\/(png|jpeg|webp|gif|x-icon|vnd.microsoft.icon)$/.test(blob.type))return;
     const bitmap=await createImageBitmap(blob);
     const c=document.createElement('canvas');c.width=32;c.height=32;
     c.getContext('2d').drawImage(bitmap,0,0,32,32);
     bitmap.close?.();
     const data=c.toDataURL('image/png');
     if(data.length>400&&data.length<24000)pageIconData=data;
   }catch{}finally{clearTimeout(timer);}
 })();
 let savedBanner=null,savedMenu=null;
 let settingsCache={};
 // Cache only masked suggestions (never card numbers, CVV or passwords).
 const suggestionsCache = new Map();
 async function getSuggestions(action){
   const cached=suggestionsCache.get(action);
   if(cached && Date.now()-cached.at<2500)return cached.res;
   const res=await chrome.runtime.sendMessage({action}).catch(()=>null);
   if(res?.ok)suggestionsCache.set(action,{at:Date.now(),res});
   return res;
 }
 chrome.storage.local.get('settings').then(data=>{settingsCache=data.settings||{};}).catch(()=>{});
 chrome.storage.onChanged.addListener((changes,area)=>{
   if(area==='local'&&changes.settings)settingsCache=changes.settings.newValue||{};
   if(area==='local'&&(changes.vault||changes.cardsVault))suggestionsCache.clear();
 });
 function dismissBanner(){if(savedBanner){savedBanner.remove();savedBanner=null;}}
 function dismissMenu(){if(savedMenu){savedMenu.remove();savedMenu=null;}}
 function shell(){
  const host=document.createElement('div');host.style.cssText='all:initial;position:fixed;z-index:2147483647;';
  const shadow=host.attachShadow({mode:'closed'});
  const style=document.createElement('style');style.textContent=`
  *{box-sizing:border-box} .box{background:#0f2018;border:1px solid #276349;color:#f4fff8;border-radius:13px;box-shadow:0 16px 45px #0008;font:13px/1.4 system-ui,'Segoe UI',sans-serif;padding:11px;min-width:230px;max-width:320px} .title{font-weight:700;margin-bottom:3px}.desc{color:#a0b8aa;font-size:11px;margin-bottom:10px}.row{display:flex;align-items:center;gap:7px;margin-top:8px}.btn{background:#047857;color:white;border:0;border-radius:8px;padding:8px 11px;cursor:pointer;font:600 12px system-ui}.btn.secondary{background:#192e23;border:1px solid #345441}.entry{padding:8px 9px;border-radius:8px;cursor:pointer;color:#d6fce8;white-space:nowrap}.entry:hover{background:#164b32}.label{font-weight:700}.sub{color:#9cb9aa;font-size:11px}
  `;shadow.append(style);return {host,shadow};
 }
 const textEl=(cls,txt)=>{const el=document.createElement('div');el.className=cls;el.textContent=txt;return el;};
 const btn=(label,cb,secondary=false)=>{const b=document.createElement('button');b.className='btn'+(secondary?' secondary':'');b.textContent=label;b.addEventListener('click',cb);return b;};
 function showBanner(id,type,description){
  dismissBanner();const {host,shadow}=shell();savedBanner=host;
  host.style.top='14px';host.style.right='14px';
  const box=document.createElement('div');box.className='box';
  box.append(textEl('title',type==='card'?'💳 Сохранить банковскую карту?':'🔐 Сохранить пароль?'));
  box.append(textEl('desc',description));
  const row=document.createElement('div');row.className='row';
  row.append(btn('Не сейчас',async()=>{await chrome.runtime.sendMessage({action:'rejectPending',id}).catch(()=>{});dismissBanner();},true));
  row.append(btn('Сохранить',async()=>{
   const res=await chrome.runtime.sendMessage({action:'confirmPending',id}).catch(()=>null);
   box.replaceChildren(textEl('title',res?.ok?'Сохранено ✓':'Ошибка сохранения'));
   setTimeout(dismissBanner,1700);
  }));box.append(row);shadow.append(box);document.documentElement.append(host);
  setTimeout(()=>{if(savedBanner===host)dismissBanner();},26000);
 }
 const recent=new Map();
 async function capture(kind){
  const settings=settingsCache;
  if(kind==='card'&&settings.captureCards===false)return;
  if(kind==='password'&&settings.capturePasswords===false)return;
  let req,desc;
  if(kind==='card'){
   const card=readCard();if(!card)return;
   req={action:'captureCard',card};desc=card.brand+' •••• '+card.number.slice(-4);
  }else{
   const p=passField(),u=usernameField();if(!p?.value)return;
   req={action:'capturePassword',user:u?.value||'',pass:p.value,iconData:pageIconData};desc=location.hostname+' · '+req.user;
  }
  const fingerprint=kind+'|'+(req.card?.number||req.user)+'|'+(req.pass||'');
  if(Date.now()-(recent.get(fingerprint)||0)<45000)return;
  recent.set(fingerprint,Date.now());
  const result=await chrome.runtime.sendMessage(req).catch(()=>null);
  if(result?.ok&&result.id)showBanner(result.id,kind,desc);
 }
 function looksSubmit(el){return el && (el.type==='submit'||/pay|checkout|purchase|placeorder|continue|submit|оплатить|заказ|bezahlen|zahlen|kaufen|weiter|login|signin|войти/i.test((el.textContent||'')+' '+(el.value||'')+' '+(el.name||'')));}
 document.addEventListener('submit',e=>{
  const form=e.target;
  if(!(form instanceof HTMLFormElement))return;
  const hasCard=!!form.querySelector('input[autocomplete="cc-number"]')||!!mapFields().number;
  if(hasCard)capture('card');else if(passField())capture('password');
 },true);
 document.addEventListener('click',e=>{
  const target=e.target.closest?.('button,input[type="submit"],[role="button"]');
  if(target&&looksSubmit(target)){
   const fields=mapFields();if(fields.number)capture('card');else if(passField())capture('password');
  }
 },true);
 document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.target?.tagName==='INPUT'){
   const fields=mapFields();if(fields.number)capture('card');else if(passField())capture('password');
  }
 },true);
 function showMenu(target,items,kind){
  dismissMenu();if(!items?.length)return;
  const {host,shadow}=shell();savedMenu=host;
  const rect=target.getBoundingClientRect();
  host.style.top=Math.max(0,Math.min(rect.bottom+5,window.innerHeight-40))+'px';
  host.style.left=Math.max(0,Math.min(rect.left,window.innerWidth-260))+'px';
  const box=document.createElement('div');box.className='box';box.append(textEl('title',kind==='card'?'💳 oPass · Выбрать карту':'🔑 oPass · Выбрать аккаунт'));
  for(const item of items){const row=document.createElement('div');row.className='entry';
   row.append(textEl('label',kind==='card'?(item.label||item.brand)+' •••• '+item.last4:item.user));
   row.append(textEl('sub',kind==='card'?item.expiry:item.site));
   row.addEventListener('mousedown',async e=>{
    e.preventDefault();e.stopPropagation();
    const action=kind==='card'?'getCardRecord':'getLoginRecord';
    const record=await chrome.runtime.sendMessage({action,id:item.id}).catch(()=>null);
    if(record?.ok)kind==='card'?fillCard(record.item):fillLogin(record.item);
    dismissMenu();
   });box.append(row);
  }shadow.append(box);document.documentElement.append(host);
 }
 document.addEventListener('focusin',async e=>{
  const target=e.target;
  if(!(target instanceof HTMLInputElement))return;
  const type=typeOf(target),settings=settingsCache;
  if(type){if(settings.fillCards===false)return;
   const res=await getSuggestions('getCardOptions');
   if(document.activeElement===target&&res?.ok)showMenu(target,res.items,'card');
  }else if(target.type==='password'||target===usernameField()){
   if(settings.fillPasswords===false)return;
   const res=await getSuggestions('getLoginOptions');
   if(document.activeElement===target&&res?.ok)showMenu(target,res.items,'login');
  }
 });
 document.addEventListener('mousedown',e=>{if(savedMenu&&!e.composedPath().includes(savedMenu))dismissMenu();},true);
 window.addEventListener('scroll',dismissMenu,true);
 window.addEventListener('resize',dismissMenu);
 chrome.runtime.onMessage.addListener((request,sender,send)=>{
  if(request.action==='opassFillCardFromPopup') {
   send({ok:fillCard(request.card||{})});return false;
  }
  if(request.action==='fill') {send({ok:fillLogin(request)});return false;}
  if(request.action==='detect'){send({username:usernameField()?.value?.trim()||'',url:location.href});return false;}
 });
})();
