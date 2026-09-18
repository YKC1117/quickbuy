const api = globalThis.QBA_PWA_API || globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);
async function getAll(){ return api.storage.local.get(null); }
async function getState(){ const all=await getAll(), state=QBASyncCore.normalizeState(all.qbaSyncState||{}); if(!all.qbaSyncState?.deviceId) await api.storage.local.set({qbaSyncState:state}); return state; }
function t(ts){ return ts?new Date(ts).toLocaleString('zh-TW',{hour12:false}):'尚未'; }
async function render(msg=''){ const s=await getState(); $('deviceName').textContent=s.deviceName||'未命名'; $('deviceId').textContent=String(s.deviceId||'').replace(/^qbd_/,'').slice(0,8)||'—'; $('revision').textContent=s.revision||0; $('conflicts').textContent=(s.conflicts||[]).length; if(document.activeElement!==$('deviceNameInput')) $('deviceNameInput').value=s.deviceName||''; const j=Array.isArray(s.journal)?s.journal:[]; if($('journalCount'))$('journalCount').textContent=j.length; if($('lastSyncAction'))$('lastSyncAction').textContent=j[0]?`${({export:'匯出',import:'匯入','import-skip':'略過舊版','conflicts-cleared':'清除衝突'})[j[0].kind]||j[0].kind} · ${t(j[0].at)}`:'尚未'; if($('clearConflictsBtn'))$('clearConflictsBtn').disabled=!(s.conflicts||[]).length; const box=$('syncActivity'); if(box)box.innerHTML=j.slice(0,5).map(x=>`<div class="healthrow good"><i>${x.kind==='export'?'↑':x.kind==='import'?'↓':'•'}</i><span>${({export:'匯出同步封包',import:'匯入同步封包','import-skip':'略過舊 Revision','conflicts-cleared':'清除衝突紀錄'})[x.kind]||x.kind}</span><b>${t(x.at)}</b></div>`).join('')||'<div class="healthrow"><i>•</i><span>尚無同步活動</span><b>—</b></div>'; if(msg) $('status').textContent=msg; }
function download(name,data){ const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000); }

const SAFARI_RECOVERY_KEY='qbaSafariRecoveryV1';
async function createSafariRecovery(reason='手動建立'){
  const all=await getAll();
  const data={
    qbaCustomShortcutsV1:Array.isArray(all.qbaCustomShortcutsV1)?all.qbaCustomShortcutsV1.slice(0,24):[],
    qbaSafariPlatformLauncherPrefsV1:all.qbaSafariPlatformLauncherPrefsV1&&typeof all.qbaSafariPlatformLauncherPrefsV1==='object'?all.qbaSafariPlatformLauncherPrefsV1:{recent:[]},
    qbaSyncState:all.qbaSyncState&&typeof all.qbaSyncState==='object'?all.qbaSyncState:null,
    qbaMobilePrepV1:normalizeMobilePrep(all.qbaMobilePrepV1||{})
  };
  const point={at:Date.now(),reason:String(reason||'復原點').slice(0,80),version:'1.0-PWA',fingerprint:await QBASyncCore.fingerprint(data),data};
  await api.storage.local.set({[SAFARI_RECOVERY_KEY]:point});
  return point;
}
async function refreshSafariRecoveryUi(){
  try{const r=await api.storage.local.get(SAFARI_RECOVERY_KEY),has=Boolean(r?.[SAFARI_RECOVERY_KEY]?.at);const b=$('safariRecoveryRestoreBtn');if(b)b.disabled=!has;return has;}catch(_){const b=$('safariRecoveryRestoreBtn');if(b)b.disabled=true;return false;}
}
async function restoreSafariRecovery(){
  const all=await api.storage.local.get(SAFARI_RECOVERY_KEY),point=all?.[SAFARI_RECOVERY_KEY];
  if(!point?.data) throw new Error('目前沒有可回復的 Safari 復原點。');
  if(point.fingerprint){const actual=await QBASyncCore.fingerprint(point.data);if(actual!==point.fingerprint)throw new Error('Safari 復原點完整性驗證失敗，已停止回復。');}
  const d=point.data,patch={};
  if(Array.isArray(d.qbaCustomShortcutsV1))patch.qbaCustomShortcutsV1=d.qbaCustomShortcutsV1.slice(0,24);
  if(d.qbaSafariPlatformLauncherPrefsV1&&typeof d.qbaSafariPlatformLauncherPrefsV1==='object')patch.qbaSafariPlatformLauncherPrefsV1=d.qbaSafariPlatformLauncherPrefsV1;
  if(d.qbaSyncState&&typeof d.qbaSyncState==='object')patch.qbaSyncState=d.qbaSyncState;
  if(d.qbaMobilePrepV1&&typeof d.qbaMobilePrepV1==='object')patch.qbaMobilePrepV1=normalizeMobilePrep(d.qbaMobilePrepV1);
  await api.storage.local.set(patch);
  try{await loadPlatformPrefs();renderPlatformLauncher();await loadCustomShortcuts();await render();}catch(_){}
  return point;
}

$('saveBtn').addEventListener('click',async()=>{const s=await getState();s.deviceName=$('deviceNameInput').value.trim().slice(0,80);await api.storage.local.set({qbaSyncState:s});await render('裝置名稱已儲存。');});
$('clearConflictsBtn')?.addEventListener('click',async()=>{const s=await getState();s.conflicts=[];s.journal=[{at:Date.now(),kind:'conflicts-cleared'},...(s.journal||[])].slice(0,200);await api.storage.local.set({qbaSyncState:s});await render('衝突紀錄已清除；同步資料本身未刪除。');});
async function createEncryptedSyncFile(){const pass=$('passphrase').value||'';const all=await getAll(),s=await getState(),r=await QBASyncCore.createBundle(all,s,'1.0-PWA');const env=await QBASyncCrypto.encryptBundle(r.bundle,pass);await api.storage.local.set({qbaSyncState:r.state});const name=`QuickBuy加密接力_${new Date().toISOString().slice(0,10)}.json`;return{name,env,revision:r.bundle.revision};}
$('exportBtn').addEventListener('click',async()=>{try{const x=await createEncryptedSyncFile();download(x.name,x.env);await render(`已下載加密備份 Revision ${x.revision}。`);}catch(e){await render(`匯出失敗：${e.message}`);}});
$('shareSyncBtn')?.addEventListener('click',async()=>{try{const x=await createEncryptedSyncFile();const file=new File([JSON.stringify(x.env,null,2)],x.name,{type:'application/json'});if(navigator.share&&(!navigator.canShare||navigator.canShare({files:[file]}))){await navigator.share({title:'QuickBuy 加密接力',text:'QuickBuy 跨裝置加密接力檔',files:[file]});await render(`已開啟分享選單 · Revision ${x.revision}`);}else{download(x.name,x.env);await render(`此裝置不支援直接分享檔案，已改為下載 · Revision ${x.revision}`);}}catch(e){if(e?.name==='AbortError'){await render('已取消分享，資料沒有送出。');return;}await render(`分享失敗：${e.message}`);}});
$('importFile').addEventListener('change',async e=>{try{const f=e.target.files?.[0];if(!f)return;await createSafariRecovery('匯入加密同步封包前');const raw=JSON.parse(await f.text()),pass=$('passphrase').value||'',b=raw?.format===QBASyncCrypto.FORMAT?await QBASyncCrypto.decryptEnvelope(raw,pass):raw,all=await getAll(),s=await getState(),r=await QBASyncCore.importBundle(all,s,b);if(Object.keys(r.patch).length)await api.storage.local.set(r.patch);await api.storage.local.set({qbaSyncState:r.state});await render(r.skipped?'較舊 Revision，已略過。':`同步資料已合併；衝突 ${r.conflicts.length}。`);}catch(err){await render(`匯入失敗：${err.message}`);}finally{e.target.value='';}});


// PWA local health + privacy-safe diagnostics + one-click local recovery.
function renderSafariHealth(rows){const box=$('safariHealthBox');if(!box)return;box.hidden=false;box.innerHTML=(rows||[]).map(r=>`<div class="healthrow ${r.state||''}"><i>${r.state==='good'?'✓':r.state==='warn'?'!':'•'}</i><span>${r.label||'檢查'}</span><b>${r.text||''}</b></div>`).join('');}
async function runSafariHealth(){
  const rows=[];
  try{const k='qbaPwaProbe';await api.storage.local.set({[k]:Date.now()});const g=await api.storage.local.get(k);await api.storage.local.remove(k);rows.push({state:g?.[k]?'good':'warn',label:'本機資料儲存',text:g?.[k]?'正常':'異常'});}catch(_){rows.push({state:'warn',label:'本機資料儲存',text:'無法寫入'});}
  const n=globalThis.QBA_PLATFORM_CATALOG?.list?.()?.length||0;rows.push({state:n>=10?'good':'warn',label:'平台 Catalog',text:`${n} 個平台（售票 + 購物）`});
  rows.push({state:globalThis.QBASyncCore&&globalThis.QBASyncCrypto?'good':'warn',label:'加密同步核心',text:globalThis.QBASyncCore&&globalThis.QBASyncCrypto?'可用':'缺少模組'});
  if(globalThis.QBA_PWA){
    rows.push({state:'good',label:'手機模式',text:window.matchMedia?.('(display-mode: standalone)')?.matches?'主畫面 App 模式':'Safari / 瀏覽器模式'});
    rows.push({state:'good',label:'跨頁限制',text:'不讀取或控制其他 Safari 分頁'});
    try{const m=normalizeMobilePrep((await api.storage.local.get(MOBILE_PREP_KEY))?.[MOBILE_PREP_KEY]||{});rows.push({state:m.targetUrl?'good':'good',label:'準備資料',text:m.targetUrl?'已設定目標':'尚未設定目標（可直接選平台）'});}catch(_){rows.push({state:'warn',label:'準備資料',text:'無法讀取'});}
    rows.push({state:navigator.serviceWorker?'good':'warn',label:'離線核心',text:navigator.serviceWorker?'瀏覽器支援 Service Worker':'目前瀏覽器不支援 Service Worker'});
  }else{
    rows.push({state:api?.tabs?.query?'good':'warn',label:'Safari 分頁 API',text:api?.tabs?.query?'可用':'依 Safari 權限限制'});
    rows.push({state:api?.permissions?.request?'good':'warn',label:'網站權限請求',text:api?.permissions?.request?'可一鍵請求':'需到 Safari 手動設定'});
  }
  try{const r=await api.storage.local.get(SAFARI_RECOVERY_KEY);rows.push({state:'good',label:'本機復原點',text:r?.[SAFARI_RECOVERY_KEY]?.at?`已建立 · ${t(r[SAFARI_RECOVERY_KEY].at)}`:'尚未建立'});}catch(_){rows.push({state:'warn',label:'本機復原點',text:'無法讀取'});}
  const rec={at:Date.now(),version:'1.0-PWA',rows};try{await api.storage.local.set({qbaSafariLastHealth:rec});}catch(_){}
  renderSafariHealth(rows);return rows;
}
async function exportSafariDiagnostic(){
  const all=await getAll(),state=await getState(),health=all.qbaSafariLastHealth?.rows||await runSafariHealth();
  const shortcuts=Array.isArray(all.qbaCustomShortcutsV1)?all.qbaCustomShortcutsV1:[];
  const payload={app:'QuickBuy PWA',reportType:'privacy-safe-diagnostic',version:'1.0-PWA',exportedAt:new Date().toISOString(),userAgent:navigator.userAgent,sync:{revision:Number(state.revision||0),conflicts:Array.isArray(state.conflicts)?state.conflicts.length:0,deviceNamed:Boolean(state.deviceName)},data:{shortcutCount:shortcuts.length,shortcutCategories:shortcuts.reduce((m,x)=>{const k=String(x?.category||'other');m[k]=(m[k]||0)+1;return m;},{}),recentPlatformCount:Array.isArray(all.qbaSafariPlatformLauncherPrefsV1?.recent)?all.qbaSafariPlatformLauncherPrefsV1.recent.length:0,relayConfigured:Boolean(all.qbaSyncProviderConfig?.endpoint),recoveryAvailable:Boolean(all[SAFARI_RECOVERY_KEY]?.at),mobilePrepConfigured:Boolean(all.qbaMobilePrepV1?.targetUrl||all.qbaMobilePrepV1?.keyword||all.qbaMobilePrepV1?.targetAt)},health};
  download(`QuickBuy_PWA_診斷_${new Date().toISOString().replace(/[:.]/g,'-')}.json`,payload);
  $('status').textContent='已下載去識別化診斷；未包含密語、Relay Key/Room、快捷網址或個人資料。';
}
$('safariHealthBtn')?.addEventListener('click',async()=>{const rows=await runSafariHealth();$('status').textContent=`裝置體檢完成：${rows.filter(x=>x.state==='warn').length} 項提醒。`;});
$('safariRecoveryCreateBtn')?.addEventListener('click',async()=>{try{const p=await createSafariRecovery('手動建立');await refreshSafariRecoveryUi();$('status').textContent=`已建立本機復原點：${t(p.at)}。`;}catch(e){$('status').textContent=`復原點建立失敗：${e.message}`;}});
$('safariRecoveryRestoreBtn')?.addEventListener('click',async()=>{try{const p=await restoreSafariRecovery();await refreshSafariRecoveryUi();$('status').textContent=`已回復最近復原點：${t(p.at)}。`;}catch(e){$('status').textContent=`回復失敗：${e.message}`;}});
$('safariDiagnosticBtn')?.addEventListener('click',()=>exportSafariDiagnostic().catch(e=>{$('status').textContent=`診斷建立失敗：${e.message}`;}));
render();
refreshSafariRecoveryUi().catch(()=>{});
setTimeout(()=>runSafariHealth().catch(()=>{}),120);


async function getProvider(){
  const all=await api.storage.local.get([QBASyncProvider.CONFIG_KEY,QBASyncProvider.STATE_KEY]);
  return {config:QBASyncProvider.normalizeConfig(all[QBASyncProvider.CONFIG_KEY]||{}),providerState:QBASyncProvider.normalizeState(all[QBASyncProvider.STATE_KEY]||{})};
}
async function renderProvider(msg=''){
  const {config}=await getProvider();
  if(document.activeElement!==$('relayEndpoint')) $('relayEndpoint').value=config.endpoint||'';
  if(document.activeElement!==$('relayRoom')) $('relayRoom').value=config.roomId||'';
  if(document.activeElement!==$('relayKey')) $('relayKey').value=config.accessKey||'';
  if(msg) $('status').textContent=msg;
}
async function saveProvider(){
  try{
    const c=QBASyncProvider.validateConfig({enabled:true,endpoint:$('relayEndpoint').value.trim(),roomId:$('relayRoom').value.trim(),accessKey:$('relayKey').value.trim()});
    const ok=await QBASyncProvider.requestOriginPermission(c.endpoint); if(!ok) throw new Error('未授權 Relay 網域。');
    await api.storage.local.set({[QBASyncProvider.CONFIG_KEY]:c}); await renderProvider('Relay 設定已保存在此裝置。');
  }catch(e){$('status').textContent=`Relay 設定失敗：${e.message}`;}
}
async function testProvider(){
  try{
    const c=QBASyncProvider.validateConfig({enabled:true,endpoint:$('relayEndpoint').value.trim(),roomId:$('relayRoom').value.trim(),accessKey:$('relayKey').value.trim()});
    const ok=await QBASyncProvider.requestOriginPermission(c.endpoint); if(!ok) throw new Error('未授權 Relay 網域。');
    const h=await QBASyncProvider.health(c); $('status').textContent=`Relay 正常 · protocol ${h.protocol??'?'} · uptime ${Math.round(Number(h.uptimeSec||0))}s`;
  }catch(e){$('status').textContent=`Relay 測試失敗：${e.message}`;}
}
async function cloudPull(){
  try{
    const pass=$('passphrase').value||''; if(pass.length<10) throw new Error('請先輸入同步密語。');
    await createSafariRecovery('Relay Pull 前');
    const {config,providerState}=await getProvider(),c=QBASyncProvider.validateConfig(config),remote=await QBASyncProvider.pull(c);
    if(!remote.found){$('status').textContent='Relay Room 尚無資料；可先由任一裝置 Push。';return;}
    const b=await QBASyncCrypto.decryptEnvelope(remote.envelope,pass),all=await getAll(),st=await getState(),r=await QBASyncCore.importBundle(all,st,b);
    if(Object.keys(r.patch).length) await api.storage.local.set(r.patch);
    await api.storage.local.set({qbaSyncState:r.state,[QBASyncProvider.STATE_KEY]:{...providerState,etag:remote.etag||'',lastPullAt:Date.now(),lastError:''}});
    await render(r.skipped?'遠端 Revision 無需更新。':`Relay Pull 完成；衝突 ${r.conflicts.length}。`);
  }catch(e){$('status').textContent=`Relay Pull 失敗：${e.message}`;}
}
async function cloudPush(){
  try{
    const pass=$('passphrase').value||''; if(pass.length<10) throw new Error('請先輸入同步密語。');
    const {config,providerState}=await getProvider(),c=QBASyncProvider.validateConfig(config),all=await getAll(),st=await getState(),r=await QBASyncCore.createBundle(all,st,'1.0-PWA'),env=await QBASyncCrypto.encryptBundle(r.bundle,pass),push=await QBASyncProvider.push(c,env,providerState.etag||'');
    if(push.conflict) throw new Error('雲端版本衝突，請先 Pull。');
    await api.storage.local.set({qbaSyncState:r.state,[QBASyncProvider.STATE_KEY]:{...providerState,etag:push.etag||'',lastPushAt:Date.now(),lastError:''}});
    await render(`Relay Push 完成 · Revision ${r.bundle.revision}。`);
  }catch(e){$('status').textContent=`Relay Push 失敗：${e.message}`;}
}
$('relayGenerateBtn').addEventListener('click',()=>{const p=QBASyncProvider.makePairing();$('relayRoom').value=p.roomId;$('relayKey').value=p.accessKey;$('status').textContent='已產生新的 Room / Key。';});
$('relaySaveBtn').addEventListener('click',saveProvider);
$('relayTestBtn').addEventListener('click',testProvider);
$('cloudPullBtn').addEventListener('click',cloudPull);
$('cloudPushBtn').addEventListener('click',cloudPush);
renderProvider();


let platformDetectTimer=0;
async function detectPlatformFromInput({adopt=true}={}){
  const input=$('platformUrl');
  const raw=input?.value||'';
  const normalized=globalThis.QBA_PLATFORM_CATALOG?.normalizeUrlInput?.(raw)||'';
  const p=normalized?(globalThis.QBA_PLATFORM_CATALOG?.detect?.(normalized)||null):null;
  const info=p?globalThis.QBA_PLATFORM_CATALOG.compact(p):null;
  if(input&&normalized&&input.value!==normalized) input.value=normalized;
  if(!$('platformStatus')) return p;
  if(!raw.trim()){$('platformStatus').textContent='貼上售票或購物網址，QuickBuy 會自動辨識。';return null;}
  if(!normalized){$('platformStatus').textContent='沒有讀到有效網址；可以直接貼整段分享文字，QuickBuy 會自動抓出連結。';return null;}
  if(!info){
    $('platformStatus').textContent='一般網站 · 已讀到網址，但目前不在平台 Catalog。';
    if(adopt&&globalThis.QBA_PWA){
      mobilePrep.platformId='';
      mobilePrep.targetUrl=cleanMobileTargetUrl(normalized);
      mobilePrep.updatedAt=Date.now();
      try{await saveMobilePrep('',{quiet:true});}catch(_){}
      renderMobileJourneyState();
    }
    return null;
  }
  $('platformStatus').textContent=info.category==='shopping' ? ('已辨識：'+info.name+' · 購物平台') : ('已辨識：'+info.name+' · 售票平台');
  if(adopt&&globalThis.QBA_PWA){
    mobilePrep.platformId=info.id;
    mobilePrep.targetUrl=cleanMobileTargetUrl(normalized);
    mobilePrep.updatedAt=Date.now();
    try{await saveMobilePrep('',{quiet:true});}catch(_){}
    try{await rememberPlatform(info.id);renderPlatformLauncher();}catch(_){}
    renderMobileJourneyState();
    try{await rememberMobileTarget(mobilePrep.targetUrl,info.id);}catch(_){}
    setMobileHomeStatus('已辨識 '+(info.shortName||info.name)+'，網址已套用。','good');
  }
  return p;
}
$('detectPlatformBtn')?.addEventListener('click',()=>detectPlatformFromInput());
$('platformUrl')?.addEventListener('change',()=>detectPlatformFromInput());
$('platformUrl')?.addEventListener('input',()=>{clearTimeout(platformDetectTimer);platformDetectTimer=setTimeout(()=>detectPlatformFromInput(),220);});

// Quick platform launcher: shared Catalog, local recent preference, no transaction automation.
const PLATFORM_PREFS_KEY='qbaSafariPlatformLauncherPrefsV1';
let platformPrefs={recent:[]};
let platformSearch="";
async function loadPlatformPrefs(){
  try{const x=await api.storage.local.get(PLATFORM_PREFS_KEY);const r=x?.[PLATFORM_PREFS_KEY]?.recent;platformPrefs={recent:Array.isArray(r)?r.filter(v=>typeof v==='string').slice(0,6):[]};}catch(_){platformPrefs={recent:[]};}
}
async function rememberPlatform(id){
  if(!id)return;
  platformPrefs={recent:[id,...platformPrefs.recent.filter(x=>x!==id)].slice(0,6)};
  try{await api.storage.local.set({[PLATFORM_PREFS_KEY]:platformPrefs});}catch(_){}
}
function orderedPlatforms(category=''){const rows=globalThis.QBA_PLATFORM_CATALOG?.list?.()||[],rank=new Map(platformPrefs.recent.map((id,i)=>[id,i]));return rows.filter(x=>!category||x.category===category).sort((a,b)=>(rank.has(a.id)?rank.get(a.id):999)-(rank.has(b.id)?rank.get(b.id):999)||rows.findIndex(x=>x.id===a.id)-rows.findIndex(x=>x.id===b.id));}
function renderPlatformLauncher(){const latest=platformPrefs.recent[0]||'',query=platformSearch.trim().toLowerCase();const group=(category,hostId,countId)=>{const all=orderedPlatforms(category),rows=all.filter(p=>!query||`${p.name} ${p.shortName} ${p.categoryLabel||''}`.toLowerCase().includes(query)),host=$(hostId);if($(countId))$(countId).textContent=query?`${rows.length} / ${all.length}`:all.length;if(host)host.innerHTML=rows.length?rows.map(p=>`<button type="button" data-platform-id="${p.id}" class="${p.id===latest?'recent':''}"><b>${p.shortName}</b><small>${p.id===latest?'最近':'開官網'}</small></button>`).join(''):'<div class="platform-empty">沒有符合搜尋的平台</div>';};group('ticket','ticketPlatformQuickPick','ticketPlatformCount');group('shopping','shoppingPlatformQuickPick','shoppingPlatformCount');const recent=(globalThis.QBA_PLATFORM_CATALOG?.list?.()||[]).find(p=>p.id===latest),row=$('recentPlatformRow');if(row)row.hidden=!recent;if($('recentPlatformName'))$('recentPlatformName').textContent=recent?.name||'—';if($('recentPlatformBtn'))$('recentPlatformBtn').dataset.platformId=recent?.id||'';}
async function choosePlatform(id){
  const p=(globalThis.QBA_PLATFORM_CATALOG?.list?.()||[]).find(x=>x.id===id);if(!p?.homepage)return;
  $('platformUrl').value=p.homepage;detectPlatformFromInput();await rememberPlatform(id);renderPlatformLauncher();
  if(globalThis.QBA_PWA){mobilePrep.platformId=p.id;mobilePrep.targetUrl=cleanMobileTargetUrl(p.homepage);mobilePrep.updatedAt=Date.now();try{await saveMobilePrep('',{quiet:true});}catch(_){}renderMobileJourneyState();}
  try{await navigateSafari(p.homepage);mobileToast(`已開啟 ${p.shortName||p.name}`,'good',1000);if(!globalThis.QBA_PWA)setTimeout(()=>{try{window.close();}catch(_){}},80);}catch(_){mobileToast(globalThis.QBA_PWA?'已選平台，可按前往繼續':'已選平台，請回 Safari 繼續','good');}
}
$('platformQuickPick')?.addEventListener('click',e=>{const b=e.target.closest?.('button[data-platform-id]');if(b?.dataset?.platformId)choosePlatform(b.dataset.platformId);});
$('recentPlatformBtn')?.addEventListener('click',e=>{const id=e.currentTarget?.dataset?.platformId;if(id)choosePlatform(id);});
$('clearRecentPlatformBtn')?.addEventListener('click',async()=>{platformPrefs={recent:[]};try{await api.storage.local.remove(PLATFORM_PREFS_KEY);}catch(_){}renderPlatformLauncher();});
$('platformSearch')?.addEventListener('input',e=>{platformSearch=String(e.target?.value||'');renderPlatformLauncher();});
(async()=>{await loadPlatformPrefs();renderPlatformLauncher();})();


// Custom shortcut library + family sharing: categories, search, edit, safe share pack; synced via qbaCustomShortcutsV1.
const CUSTOM_SHORTCUTS_KEY='qbaCustomShortcutsV1';
const SHORTCUT_CATEGORY_LABELS=Object.freeze({ticket:'售票',shop:'商城',event:'活動',other:'其他'});
let customShortcuts=[],customShortcutFilter='all',customShortcutSearch='',editingShortcutId='';
function sanitizeShortcutUrl(raw){try{const normalized=globalThis.QBA_PLATFORM_CATALOG?.normalizeUrlInput?.(raw)||String(raw||'').trim();const u=new URL(normalized);if(!/^https?:$/.test(u.protocol))return'';u.username='';u.password='';u.search='';u.hash='';return `${u.origin}${u.pathname||'/'}`;}catch(_){return'';}}
function normalizeShortcutCategory(v){v=String(v||'').trim().toLowerCase();return Object.prototype.hasOwnProperty.call(SHORTCUT_CATEGORY_LABELS,v)?v:'other';}
function inferShortcutCategory(url,title=''){try{const known=globalThis.QBA_PLATFORM_CATALOG?.detect?.(url);if(known)return known.category==='shopping'?'shop':'ticket';const u=new URL(url),text=`${u.hostname} ${u.pathname} ${title}`.toLowerCase();if(/(?:shop|store|mall|product|merch|goods|商品|商城|商店)/i.test(text))return'shop';if(/(?:event|activity|show|expo|展覽|活動|展演)/i.test(text))return'event';}catch(_){}return'other';}
function shortcutNameFallback(url,title=''){const clean=String(title||'').replace(/\s+/g,' ').trim();if(clean)return clean.slice(0,40);try{return new URL(url).hostname.replace(/^www\./,'').slice(0,40);}catch(_){return'我的網站';}}
function normalizeShortcut(raw={}){const url=sanitizeShortcutUrl(raw.url);if(!url)return null;return{id:String(raw.id||`qbs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`).slice(0,80),name:shortcutNameFallback(url,raw.name),url,category:normalizeShortcutCategory(raw.category||inferShortcutCategory(url,raw.name)),pinned:!!raw.pinned,createdAt:Number(raw.createdAt||Date.now()),lastUsedAt:Number(raw.lastUsedAt||0),updatedAt:Number(raw.updatedAt||raw.createdAt||Date.now())};}
async function loadCustomShortcuts(){try{const x=await api.storage.local.get(CUSTOM_SHORTCUTS_KEY);customShortcuts=(Array.isArray(x?.[CUSTOM_SHORTCUTS_KEY])?x[CUSTOM_SHORTCUTS_KEY]:[]).map(normalizeShortcut).filter(Boolean).slice(0,24);}catch(_){customShortcuts=[];}renderCustomShortcuts();}
async function saveCustomShortcuts(){customShortcuts=customShortcuts.map(normalizeShortcut).filter(Boolean).slice(0,24);await api.storage.local.set({[CUSTOM_SHORTCUTS_KEY]:customShortcuts});renderCustomShortcuts();}
function orderedCustomShortcuts(){const qv=customShortcutSearch.trim().toLowerCase();return[...customShortcuts].filter(x=>customShortcutFilter==='all'||x.category===customShortcutFilter).filter(x=>!qv||`${x.name} ${x.url} ${SHORTCUT_CATEGORY_LABELS[x.category]||''}`.toLowerCase().includes(qv)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||Number(b.lastUsedAt||0)-Number(a.lastUsedAt||0)||Number(b.updatedAt||0)-Number(a.updatedAt||0));}
function renderCustomShortcuts(){const host=$('shortcutList');if(!host)return;$('shortcutFilters')?.querySelectorAll?.('button[data-shortcut-filter]').forEach(b=>b.classList.toggle('active',b.dataset.shortcutFilter===customShortcutFilter));const rows=orderedCustomShortcuts();if(!customShortcuts.length){host.innerHTML='<div class="shortcut-empty">尚未收藏網站。</div>';return;}if(!rows.length){host.innerHTML='<div class="shortcut-empty">沒有符合目前搜尋 / 分類的快捷網站。</div>';return;}host.innerHTML=rows.map(x=>{let display=x.url;try{const u=new URL(x.url);display=`${u.hostname}${u.pathname==='/'?'':u.pathname}`;}catch(_){}return `<div class="shortcut-card" data-shortcut-id="${x.id}"><button class="shortcut-open" data-action="open"><b>${x.name}</b><span class="shortcut-meta"><span class="shortcut-cat">${SHORTCUT_CATEGORY_LABELS[x.category]||'其他'}</span><span class="shortcut-url">${display}</span></span></button><button class="shortcut-tool" data-action="edit" aria-label="編輯">✎</button><button class="shortcut-tool${x.pinned?' pinned':''}" data-action="pin" aria-label="置頂">★</button><button class="shortcut-tool" data-action="delete" aria-label="刪除">×</button></div>`;}).join('');}
function showShortcutForm(prefill={}){editingShortcutId=String(prefill.id||'');$('shortcutForm').hidden=false;$('shortcutName').value=String(prefill.name||'').slice(0,40);$('shortcutUrl').value=String(prefill.url||'');$('shortcutCategory').value=prefill.category?normalizeShortcutCategory(prefill.category):'';}
function hideShortcutForm(){editingShortcutId='';$('shortcutForm').hidden=true;}
async function upsertShortcut({id='',name,url,title='',category=''}={}){const safe=sanitizeShortcutUrl(url);if(!safe)throw new Error('請輸入有效的 http / https 網址。');const cat=category?normalizeShortcutCategory(category):inferShortcutCategory(safe,name||title);const byId=id?customShortcuts.find(x=>x.id===id):null;const existing=byId||customShortcuts.find(x=>x.url===safe);if(existing){const dup=customShortcuts.find(x=>x.id!==existing.id&&x.url===safe);if(dup)throw new Error('這個網址已經收藏過。');existing.url=safe;existing.name=shortcutNameFallback(safe,name||title||existing.name);existing.category=cat;existing.updatedAt=Date.now();if(!byId)existing.lastUsedAt=Date.now();}else{if(customShortcuts.length>=24)throw new Error('快捷網站最多 24 個。');customShortcuts.push(normalizeShortcut({name:name||title,url:safe,category:cat,lastUsedAt:Date.now(),updatedAt:Date.now()}));}await saveCustomShortcuts();}
async function saveCurrentPageShortcut(){try{const tabs=await api.tabs?.query?.({active:true,currentWindow:true});const tab=tabs?.[0];const safe=sanitizeShortcutUrl(tab?.url||'');if(!safe)throw new Error('目前分頁不是可收藏網頁。');await upsertShortcut({url:safe,title:tab?.title||'',category:inferShortcutCategory(safe,tab?.title||'')});$('platformStatus').textContent='已收藏目前頁面；同步後其他裝置也會看到。';}catch(e){$('platformStatus').textContent=`收藏失敗：${e.message}`;}}
async function openShortcut(id){const x=customShortcuts.find(v=>v.id===id);if(!x)return;x.lastUsedAt=Date.now();await saveCustomShortcuts();$('platformUrl').value=x.url;detectPlatformFromInput();if(globalThis.QBA_PWA){const p=globalThis.QBA_PLATFORM_CATALOG?.detect?.(x.url)||null;mobilePrep.platformId=p?.id||'';mobilePrep.targetUrl=cleanMobileTargetUrl(x.url);mobilePrep.updatedAt=Date.now();try{await saveMobilePrep('',{quiet:true});}catch(_){}renderMobileJourneyState();}try{await navigateSafari(x.url);mobileToast(`已開啟 ${x.name}`,'good',1000);if(!globalThis.QBA_PWA)setTimeout(()=>{try{window.close();}catch(_){}},80);}catch(_){mobileToast(globalThis.QBA_PWA?'已選收藏，可按前往繼續':'已選收藏，請回 Safari 繼續','good');}}
function shortcutPackPayload(){return{format:'quickbuy-shortcuts-pack',version:1,exportedAt:new Date().toISOString(),shortcuts:customShortcuts.map(x=>({id:x.id,name:x.name,url:sanitizeShortcutUrl(x.url),category:normalizeShortcutCategory(x.category),pinned:!!x.pinned,createdAt:Number(x.createdAt||0),updatedAt:Number(x.updatedAt||0)})).filter(x=>x.url)};}
function exportShortcutPack(){if(!customShortcuts.length)throw new Error('目前沒有可匯出的快捷網站。');download(`QuickBuy快捷網站_${new Date().toISOString().slice(0,10)}.json`,shortcutPackPayload());}
async function importShortcutPack(file){if(!file)return 0;if(file.size>128*1024)throw new Error('快捷網站匯入檔超過 128 KB。');await createSafariRecovery('匯入快捷網站前');const data=JSON.parse(await file.text());if(!data||data.format!=='quickbuy-shortcuts-pack'||Number(data.version)!==1||!Array.isArray(data.shortcuts))throw new Error('這不是 QuickBuy 快捷網站分享檔。');const incoming=data.shortcuts.slice(0,24).map(normalizeShortcut).filter(Boolean),merged=new Map(customShortcuts.map(x=>[x.url,x]));for(const item of incoming){const old=merged.get(item.url);merged.set(item.url,old?{...old,...item,id:old.id,pinned:old.pinned||item.pinned,updatedAt:Math.max(Number(old.updatedAt||0),Number(item.updatedAt||0))}:item);}customShortcuts=[...merged.values()].slice(0,24);await saveCustomShortcuts();return incoming.length;}

function familyPackPayload(){
  const validIds=new Set((globalThis.QBA_PLATFORM_CATALOG?.list?.()||[]).map(x=>x.id));
  return{format:'quickbuy-family-pack',version:1,appVersion:'1.0-PWA',exportedAt:new Date().toISOString(),data:{launcherPrefs:{recent:(platformPrefs.recent||[]).filter(id=>validIds.has(id)).slice(0,6)},shortcuts:shortcutPackPayload().shortcuts},privacy:'No credentials, payment data, cookies, tokens, personal profile fields or runtime mission data.'};
}
function exportFamilyPack(){download(`QuickBuy家人分享包_PWA_${new Date().toISOString().slice(0,10)}.json`,familyPackPayload());}
async function importFamilyPack(file){
  if(!file)throw new Error('請先選擇 QuickBuy 家人分享包。');if(file.size>256*1024)throw new Error('分享包超過 256 KB 安全上限。');
  await createSafariRecovery('匯入家人分享包前');
  const data=JSON.parse(await file.text());if(!data||data.format!=='quickbuy-family-pack'||Number(data.version)!==1||!data.data)throw new Error('這不是有效的 QuickBuy 家人分享包。');
  const incoming=(Array.isArray(data.data.shortcuts)?data.data.shortcuts:[]).slice(0,24).map(normalizeShortcut).filter(Boolean),merged=new Map(customShortcuts.map(x=>[x.url,x]));
  for(const item of incoming){const old=merged.get(item.url);merged.set(item.url,old?{...old,...item,id:old.id,pinned:old.pinned||item.pinned,updatedAt:Math.max(Number(old.updatedAt||0),Number(item.updatedAt||0))}:item);}customShortcuts=[...merged.values()].slice(0,24);
  const validIds=new Set((globalThis.QBA_PLATFORM_CATALOG?.list?.()||[]).map(x=>x.id));const remoteRecent=Array.isArray(data.data.launcherPrefs?.recent)?data.data.launcherPrefs.recent.filter(id=>validIds.has(id)).slice(0,6):[];
  platformPrefs={recent:[...remoteRecent,...(platformPrefs.recent||[]).filter(id=>!remoteRecent.includes(id)&&validIds.has(id))].slice(0,6)};
  await api.storage.local.set({[CUSTOM_SHORTCUTS_KEY]:customShortcuts,[PLATFORM_PREFS_KEY]:platformPrefs});renderCustomShortcuts();renderPlatformLauncher();return{shortcuts:incoming.length,platforms:remoteRecent.length};
}
$('familyExportBtn')?.addEventListener('click',()=>{try{exportFamilyPack();$('platformStatus').textContent='已建立安全家人分享包。';}catch(e){$('platformStatus').textContent=`分享失敗：${e.message}`;}});
$('familyImportBtn')?.addEventListener('click',()=>$('familyImportFile')?.click());
$('familyImportFile')?.addEventListener('change',async e=>{try{const r=await importFamilyPack(e.target?.files?.[0]);$('platformStatus').textContent=`分享包匯入完成：${r.shortcuts} 個快捷網站、${r.platforms} 個常用平台。`;}catch(err){$('platformStatus').textContent=`分享包匯入失敗：${err.message}`;}finally{if(e.target)e.target.value='';}});

$('saveCurrentShortcutBtn')?.addEventListener('click',()=>globalThis.QBA_PWA?showShortcutForm():saveCurrentPageShortcut());
$('addShortcutBtn')?.addEventListener('click',()=>showShortcutForm());
$('shortcutCancelBtn')?.addEventListener('click',hideShortcutForm);
$('shortcutSaveBtn')?.addEventListener('click',async()=>{try{await upsertShortcut({id:editingShortcutId,name:$('shortcutName').value,url:$('shortcutUrl').value,category:$('shortcutCategory').value});hideShortcutForm();$('platformStatus').textContent='快捷網站已儲存。';}catch(e){$('platformStatus').textContent=`儲存失敗：${e.message}`;}});
$('shortcutSearch')?.addEventListener('input',e=>{customShortcutSearch=String(e.target?.value||'');renderCustomShortcuts();});
$('shortcutFilters')?.addEventListener('click',e=>{const b=e.target.closest?.('button[data-shortcut-filter]');if(!b)return;customShortcutFilter=String(b.dataset.shortcutFilter||'all');renderCustomShortcuts();});
$('shortcutExportBtn')?.addEventListener('click',()=>{try{exportShortcutPack();}catch(e){$('platformStatus').textContent=`匯出失敗：${e.message}`;}});
$('shortcutImportBtn')?.addEventListener('click',()=>$('shortcutImportFile')?.click());
$('shortcutImportFile')?.addEventListener('change',async e=>{try{const n=await importShortcutPack(e.target?.files?.[0]);$('platformStatus').textContent=`已匯入 ${n} 個快捷網站；重複網址已安全合併。`;}catch(err){$('platformStatus').textContent=`匯入失敗：${err.message}`;}finally{if(e.target)e.target.value='';}});
$('shortcutList')?.addEventListener('click',async e=>{const card=e.target.closest?.('[data-shortcut-id]'),btn=e.target.closest?.('button[data-action]');if(!card||!btn)return;const id=card.dataset.shortcutId,action=btn.dataset.action,x=customShortcuts.find(v=>v.id===id);if(!x)return;if(action==='open')return openShortcut(id);if(action==='edit')return showShortcutForm(x);if(action==='pin'){x.pinned=!x.pinned;x.updatedAt=Date.now();return saveCustomShortcuts();}if(action==='delete'){customShortcuts=customShortcuts.filter(v=>v.id!==id);return saveCustomShortcuts();}});
loadCustomShortcuts();
try{api.storage.onChanged?.addListener?.((changes,area)=>{if(area==='local'&&changes?.[CUSTOM_SHORTCUTS_KEY])loadCustomShortcuts();});}catch(_){}

// QuickBuy 1.0 mobile shell: single next-action CTA and clear readiness states.
const MOBILE_RECENT_TARGETS_KEY='qbaMobileRecentTargetsV1';
let mobileRecentTargets=[];
function normalizeRecentTarget(raw={}){
  const url=cleanMobileTargetUrl(raw.url||raw.targetUrl||'');
  if(!url)return null;
  const p=globalThis.QBA_PLATFORM_CATALOG?.detect?.(url)||null;
  return{
    id:String(raw.id||('qrt_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7))).slice(0,80),
    url,
    platformId:String(raw.platformId||p?.id||'').slice(0,80),
    label:String(raw.label||p?.shortName||p?.name||(()=>{try{return new URL(url).hostname.replace(/^www\./,'')}catch(_){return'網站'}})()).slice(0,60),
    at:Number(raw.at||Date.now())
  };
}
async function loadMobileRecentTargets(){
  try{
    const x=await api.storage.local.get(MOBILE_RECENT_TARGETS_KEY);
    mobileRecentTargets=(Array.isArray(x?.[MOBILE_RECENT_TARGETS_KEY])?x[MOBILE_RECENT_TARGETS_KEY]:[]).map(normalizeRecentTarget).filter(Boolean).slice(0,6);
  }catch(_){mobileRecentTargets=[];}
  renderMobileRecentTargets();
}
async function saveMobileRecentTargets(){
  mobileRecentTargets=mobileRecentTargets.map(normalizeRecentTarget).filter(Boolean).slice(0,6);
  try{await api.storage.local.set({[MOBILE_RECENT_TARGETS_KEY]:mobileRecentTargets});}catch(_){}
  renderMobileRecentTargets();
}
async function rememberMobileTarget(url,platformId=''){
  const safe=cleanMobileTargetUrl(url);if(!safe)return;
  const p=globalThis.QBA_PLATFORM_CATALOG?.detect?.(safe)||platformById(platformId);
  const key=safe;
  mobileRecentTargets=[
    {id:'qrt_'+Date.now().toString(36),url:safe,platformId:p?.id||platformId||'',label:p?.shortName||p?.name||(()=>{try{return new URL(safe).hostname.replace(/^www\./,'')}catch(_){return'網站'}})(),at:Date.now()},
    ...mobileRecentTargets.filter(x=>x.url!==key)
  ].slice(0,6);
  await saveMobileRecentTargets();
}
function renderMobileRecentTargets(){
  const host=$('mobileRecentTargets');if(!host)return;
  if(!mobileRecentTargets.length){host.innerHTML='<div class="target-history-empty">還沒有最近目標</div>';return;}
  host.innerHTML=mobileRecentTargets.map(x=>`<div class="target-history-row" data-recent-target-id="${x.id}"><button class="target-history-open" data-action="open"><b>${x.label}</b><small>${x.url}</small></button><button class="target-history-del" data-action="delete" aria-label="刪除">×</button></div>`).join('');
}
async function clearMobileTarget({keepPrep=true}={}){
  mobilePrep.platformId='';
  mobilePrep.targetUrl='';
  mobilePrep.updatedAt=Date.now();
  if(!keepPrep){mobilePrep.quantity=1;mobilePrep.keyword='';mobilePrep.targetAt='';}
  await api.storage.local.set({[MOBILE_PREP_KEY]:mobilePrep});
  if($('platformUrl'))$('platformUrl').value='';
  if(!keepPrep){
    if($('mobileQty'))$('mobileQty').value='1';
    if($('mobileKeyword'))$('mobileKeyword').value='';
    if($('mobileTargetAt'))$('mobileTargetAt').value='';
  }
  renderMobileCountdown();
  renderMobileJourneyState();
  await refreshMobileCurrentPage().catch(()=>{});
}
async function reopenMobileTarget(){
  if(!mobilePrep.targetUrl)throw new Error('目前沒有目標網址。');
  await rememberMobileTarget(mobilePrep.targetUrl,mobilePrep.platformId);
  return navigateSafari(mobilePrep.targetUrl);
}

const MOBILE_PREP_KEY='qbaMobilePrepV1';
let mobilePrep={quantity:1,keyword:'',targetAt:'',platformId:'',targetUrl:'',updatedAt:0};
let mobileCountdownTimer=0,mobilePrepSaveTimer=0,mobileResumeTimer=0,mobileToastTimer=0;
function cleanMobileTargetUrl(raw){try{const normalized=globalThis.QBA_PLATFORM_CATALOG?.normalizeUrlInput?.(raw)||String(raw||'').trim();const u=new URL(normalized);if(!/^https?:$/.test(u.protocol))return'';u.username='';u.password='';u.search='';u.hash='';return `${u.origin}${u.pathname||'/'}`;}catch(_){return'';}}
function normalizeMobilePrep(raw={}){const q=Math.max(1,Math.min(10,Number(raw.quantity||1)|0));return{quantity:q,keyword:String(raw.keyword||'').trim().slice(0,80),targetAt:String(raw.targetAt||'').slice(0,32),platformId:String(raw.platformId||'').slice(0,80),targetUrl:cleanMobileTargetUrl(raw.targetUrl||''),updatedAt:Number(raw.updatedAt||0)};}
function platformById(id){return (globalThis.QBA_PLATFORM_CATALOG?.list?.()||[]).find(x=>x.id===id)||null;}
function mobileToast(message,tone='good',ttl=1800){const el=$('mobileToast');if(!el)return;clearTimeout(mobileToastTimer);el.className=`mobile-toast ${tone} show`;el.textContent=String(message||'');mobileToastTimer=setTimeout(()=>el.classList.remove('show'),ttl);}function hideMobileToast(){clearTimeout(mobileToastTimer);const el=$('mobileToast');if(el)el.classList.remove('show');}
function setMobileHomeStatus(message,tone='good'){const el=$('mobileHomeStatus');if(!el)return;el.textContent=String(message||'');el.className='notice'+(tone==='good'?' success-note':'');if(tone==='warn'){el.style.background='#fff7df';el.style.color='#775212';}else if(tone==='error'){el.style.background='#fff0ea';el.style.color='#9b3e2f';}else{el.style.background='';el.style.color='';}}
function humanMobileError(err,fallback='剛剛沒有完成'){const msg=String(err?.message||err||'').trim();if(/storage|quota|儲存/i.test(msg))return '手機暫時無法儲存設定，請重新開啟 QuickBuy 再試一次。';if(!globalThis.QBA_PWA&&/permission|權限/i.test(msg))return 'Safari 網站權限尚未完成，請確認 QuickBuy 權限。';return msg?`${fallback}：${msg}`:`${fallback}，請再試一次。`;}
function setReadyChip(id,state,label,detail){const el=$(id);if(!el)return;el.className=`ready-chip ${state||''}`;const b=el.querySelector('b'),s=el.querySelector('small');if(b)b.textContent=label;if(s)s.textContent=detail;}
function currentPageAccessible(current){return Boolean(current?.safeUrl);}
function mobilePageKind(url,p=null){try{const u=new URL(String(url||'')),home=p?.homepage?new URL(p.homepage):null;const path=(u.pathname||'/').replace(/\/+$/,'')||'/';if(home&&u.origin===home.origin){const hp=(home.pathname||'/').replace(/\/+$/,'')||'/';if(path===hp&&!u.search)return'home';}if(path==='/'&&!u.search)return'home';return'candidate';}catch(_){return'unknown';}}
function updateMobileKeywordCopy(p=null){const label=$('mobileKeywordLabel'),input=$('mobileKeyword');if(!label||!input)return;if(p?.category==='shopping'){label.textContent='規格 / 型號（選填）';input.placeholder='例如：黑色、2XL、256GB';}else if(p?.category==='ticket'){label.textContent='票區 / 票種（選填）';input.placeholder='例如：A區、搖滾區、一般票';}else{label.textContent='規格 / 票區（選填）';input.placeholder='例如：A區、2XL、一般票';}}
function renderMobileNextAction(current=null){const btn=$('mobileNextActionBtn'),title=$('mobileNextActionTitle'),detail=$('mobileNextActionDetail');if(!btn||!title||!detail)return;const hasTarget=Boolean(mobilePrep.targetUrl),targetPlatform=platformById(mobilePrep.platformId),sameCurrent=Boolean(current?.safeUrl&&hasTarget&&current.safeUrl===mobilePrep.targetUrl),recognized=Boolean(current?.p),kind=mobilePageKind(current?.safeUrl,current?.p),differentPlatform=Boolean(hasTarget&&current?.p&&targetPlatform&&current.p.id!==targetPlatform.id),raw=$('mobileTargetAt')?.value||mobilePrep.targetAt||'',targetMs=raw?new Date(raw).getTime():NaN,waiting=Number.isFinite(targetMs)&&targetMs>Date.now();let action='platforms',label='選平台開始',t='先選你要使用的平台',d='數量、規格與時間會自動保存在這台裝置。';if(globalThis.QBA_PWA){if(hasTarget){action='open-target';label=`前往 ${targetPlatform?.shortName||targetPlatform?.name||'目標網站'}`;t=waiting?'設定完成・等待開賣':'設定完成';d=waiting?'時間到時直接按這裡前往；登入、排隊與付款由你完成。':'直接前往目標網站；登入、驗證與最後確認由你完成。';}btn.dataset.mobileAction=action;btn.textContent=label;title.textContent=t;detail.textContent=d;return;}if(currentPageAccessible(current)&&!hasTarget&&kind==='home'){action='return-browse';label='回 Safari 找活動 / 商品';t=recognized?`目前在 ${current.p.shortName||current.p.name} 首頁`:'目前在網站首頁';d='先找到真正要用的活動頁或商品頁，再打開 QuickBuy；不用複製網址。';}else if(currentPageAccessible(current)&&!hasTarget){action='adopt';label='使用目前頁面';t=recognized?'目前頁面可以準備':'目前頁面可以使用';d=recognized?`${current.p.shortName||current.p.name} 已辨識，點一下完成準備。`:'使用目前 Safari 頁面作為目標。';}if(hasTarget){action='return';label=waiting?'回 Safari 準備':'回 Safari 繼續';t=waiting?'設定已完成，等待時間到':'設定已完成';d=waiting?'需要時再回來看倒數；Safari 頁面保持正常即可。':'現在回 Safari 確認頁面狀態。';}if(hasTarget&&(!currentPageAccessible(current)||differentPlatform)){action='open-target';label=`回到 ${targetPlatform?.shortName||targetPlatform?.name||'目標頁面'}`;t='目前 Safari 不在原本目標';d='QuickBuy 會保留你的設定，直接幫你切回原本頁面。';}if(sameCurrent){action='return';label=waiting?'回 Safari 準備':'回 Safari 繼續';t=waiting?'目前頁面已跟上・等待中':'目前頁面已跟上';d=waiting?'QuickBuy 已記住這個頁面與你的設定。':'不需要再貼網址或重新選頁面。';}btn.dataset.mobileAction=action;btn.textContent=label;title.textContent=t;detail.textContent=d;}
function renderMobileReadiness(current=null){const access=currentPageAccessible(current),recognized=Boolean(current?.p),hasTarget=Boolean(mobilePrep.targetUrl),kind=mobilePageKind(current?.safeUrl,current?.p);if(globalThis.QBA_PWA){const p=platformById(mobilePrep.platformId);setReadyChip('mobileAccessChip','good','PWA','可使用');setReadyChip('mobilePageChip',hasTarget?'good':'warn','目標',p?.shortName||p?.name||(hasTarget?'一般網站':'未選平台'));setReadyChip('mobilePrepChip',hasTarget?'good':'warn','準備',hasTarget?'已儲存':'尚未完成');updateMobileKeywordCopy(p);const help=$('mobilePermissionHelp'),card=document.querySelector('.current');if(help)help.hidden=false;if(card)card.classList.remove('permission-missing');renderMobileNextAction(current);return;}setReadyChip('mobileAccessChip',access?'good':'warn','Safari',access?'可讀取':'需確認權限');setReadyChip('mobilePageChip',recognized&&kind!=='home'?'good':access?'':'warn','頁面',recognized?(kind==='home'?`${current.p.shortName||current.p.name} 首頁`:(current.p.shortName||current.p.name)):access?'一般網站':'尚未取得');setReadyChip('mobilePrepChip',hasTarget?'good':'warn','準備',hasTarget?'已儲存':'尚未完成');updateMobileKeywordCopy(hasTarget?platformById(mobilePrep.platformId):current?.p);const help=$('mobilePermissionHelp'),card=document.querySelector('.current');if(help)help.hidden=access;if(card)card.classList.toggle('permission-missing',!access);renderMobileNextAction(current);}
function renderMobileJourneyState(current=null){const wrap=$('mobileJourneyState'),title=$('mobileJourneyTitle'),detail=$('mobileJourneyDetail');if(!wrap||!title||!detail)return;let cls='journey',t='還差一步',d=globalThis.QBA_PWA?'先選平台，再設定數量或規格。':'先在 Safari 打開售票或商品頁。';const target=mobilePrep.targetUrl||'',p=platformById(mobilePrep.platformId);const clearTargetBtn=$('mobileClearTargetBtn'),reopenTargetBtn=$('mobileReopenTargetBtn');if(clearTargetBtn)clearTargetBtn.hidden=!target;if(reopenTargetBtn)reopenTargetBtn.hidden=!target;const raw=$('mobileTargetAt')?.value||mobilePrep.targetAt||'';const targetMs=raw?new Date(raw).getTime():NaN;const now=Date.now();if(target){cls+=' ready';t='準備完成';d=`${p?.shortName||p?.name||'目前網站'} · 數量 ${mobilePrep.quantity}${mobilePrep.keyword?` · ${mobilePrep.keyword}`:''}`;if(Number.isFinite(targetMs)&&targetMs>now){cls='journey wait';t='已準備・等待開賣';const mins=Math.ceil((targetMs-now)/60000);d=mins<=1?'不到 1 分鐘，保持 Safari 頁面準備好。':`約 ${mins} 分鐘後，時間到再回 Safari 確認。`;}else if(Number.isFinite(targetMs)&&targetMs<=now){cls='journey now';t='時間到了';d='回 Safari 確認頁面狀態；需要登入或驗證時由你完成。';}}
if(globalThis.QBA_PWA&&target){d=Number.isFinite(targetMs)&&targetMs>now?(Math.ceil((targetMs-now)/60000)<=1?'不到 1 分鐘；時間到直接按前往。':`約 ${Math.ceil((targetMs-now)/60000)} 分鐘後；時間到直接按前往。`):`${p?.shortName||p?.name||'目標網站'} · 數量 ${mobilePrep.quantity}${mobilePrep.keyword?` · ${mobilePrep.keyword}`:''}`;}else if(current?.safeUrl&&target&&current.safeUrl===target){d=`目前 Safari 頁面已跟上 · ${d}`;}else if(current?.p&&p&&current.p.id!==p.id&&target){d=`目前 Safari 在 ${current.p.shortName||current.p.name}；QuickBuy 仍保留 ${p.shortName||p.name} 目標，不會偷偷改掉。`;cls='journey wait';t='目前頁面不同';}
wrap.className=cls;title.textContent=t;detail.textContent=d;const useBtn=$('mobileUseCurrentBtn'),sameCurrent=Boolean(current?.safeUrl&&target&&current.safeUrl===target);if(useBtn){useBtn.classList.toggle('ready-action',sameCurrent);useBtn.textContent=globalThis.QBA_PWA?(sameCurrent?'目標已準備':'使用目前目標'):(sameCurrent?'重新讀取 Safari':'重新讀取目前頁面');}renderMobileReadiness(current);}
async function loadMobilePrep(){let original=null;try{const x=await api.storage.local.get(MOBILE_PREP_KEY);original=x?.[MOBILE_PREP_KEY]||{};mobilePrep=normalizeMobilePrep(original);}catch(_){mobilePrep=normalizeMobilePrep({});}const detected=mobilePrep.targetUrl?globalThis.QBA_PLATFORM_CATALOG?.detect?.(mobilePrep.targetUrl):null;if(mobilePrep.platformId&&!platformById(mobilePrep.platformId))mobilePrep.platformId=detected?.id||'';if(!mobilePrep.platformId&&detected)mobilePrep.platformId=detected.id;if(mobilePrep.targetAt&& !Number.isFinite(new Date(mobilePrep.targetAt).getTime()))mobilePrep.targetAt='';const repaired=JSON.stringify(normalizeMobilePrep(original||{}))!==JSON.stringify(mobilePrep);if(repaired){mobilePrep.updatedAt=Date.now();try{await api.storage.local.set({[MOBILE_PREP_KEY]:mobilePrep});}catch(_){}}if($('mobileQty'))$('mobileQty').value=mobilePrep.quantity;if($('mobileKeyword'))$('mobileKeyword').value=mobilePrep.keyword;if($('mobileTargetAt'))$('mobileTargetAt').value=mobilePrep.targetAt;renderMobileCountdown();renderMobileJourneyState();}
async function saveMobilePrep(msg='已自動儲存。',{quiet=false}={}){mobilePrep=normalizeMobilePrep({quantity:$('mobileQty')?.value,keyword:$('mobileKeyword')?.value,targetAt:$('mobileTargetAt')?.value,platformId:mobilePrep.platformId,targetUrl:mobilePrep.targetUrl,updatedAt:Date.now()});await api.storage.local.set({[MOBILE_PREP_KEY]:mobilePrep});if(!quiet)setMobileHomeStatus(msg,'good');renderMobileCountdown();renderMobileJourneyState();return mobilePrep;}
function formatMobileDuration(ms){const total=Math.max(0,Math.floor(ms/1000)),d=Math.floor(total/86400),h=Math.floor((total%86400)/3600),m=Math.floor((total%3600)/60),s=total%60;return `${d?`${d}天 `:''}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;}
function renderMobileWaitSummary(targetMs=NaN){const wrap=$('mobileWaitSummary'),clock=$('mobileWaitClock'),label=$('mobileWaitLabel');if(!wrap||!clock||!label)return;const diff=Number(targetMs)-Date.now(),show=Boolean(mobilePrep.targetUrl)&&Number.isFinite(Number(targetMs))&&diff>0;wrap.hidden=!show;if(!show)return;label.textContent=diff<=60000?'即將開賣':'等待開賣';clock.textContent=formatMobileDuration(diff);}
function renderMobileCountdown(){const el=$('mobileCountdown');if(!el)return;clearTimeout(mobileCountdownTimer);const raw=$('mobileTargetAt')?.value||mobilePrep.targetAt||'';if(!raw){el.innerHTML='<span>倒數</span><b>未設定</b>';renderMobileWaitSummary(NaN);renderMobileJourneyState();return;}const target=new Date(raw).getTime();if(!Number.isFinite(target)){el.innerHTML='<span>倒數</span><b>時間格式不正確</b>';renderMobileWaitSummary(NaN);renderMobileJourneyState();return;}const diff=target-Date.now();if(diff<=0){el.innerHTML='<span>現在</span><b>開賣時間已到</b>';renderMobileWaitSummary(NaN);renderMobileJourneyState();return;}el.innerHTML=`<span>距離設定時間</span><b>${formatMobileDuration(diff)}</b>`;renderMobileWaitSummary(target);renderMobileJourneyState();mobileCountdownTimer=setTimeout(renderMobileCountdown,1000);}
async function activeSafariTab(){if(globalThis.QBA_PWA){const m=normalizeMobilePrep((await api.storage.local.get(MOBILE_PREP_KEY))?.[MOBILE_PREP_KEY]||{});return m.targetUrl?{id:'pwa-target',url:m.targetUrl,title:'QuickBuy 目前目標'}:null;}try{const tabs=await api.tabs?.query?.({active:true,currentWindow:true});return tabs?.[0]||null;}catch(_){return null;}}
function mobileHostPattern(url){try{const u=new URL(String(url||''));if(!/^https?:$/.test(u.protocol))return'';return `${u.protocol}//${u.host}/*`;}catch(_){return'';}}
async function requestMobileSiteAccess({finish=false}={}){if(globalThis.QBA_PWA){if(finish)await finishMobileOnboarding();setMobileHomeStatus('QuickBuy PWA 已可使用；選平台後直接前往。','good');return true;}const perm=api?.permissions;if(!perm?.request){const help=$('mobilePermissionHelp');if(help){help.hidden=false;help.open=true;}mobileToast('請到 Safari 延伸功能允許網站存取','warn',2400);return false;}let tab=null;try{tab=await activeSafariTab();}catch(_){}const pattern=mobileHostPattern(tab?.url||'');const origins=pattern?[pattern]:['https://*/*','http://*/*'];let granted=false;try{granted=Boolean(await perm.request({origins}));}catch(_){granted=false;}if(!granted){const help=$('mobilePermissionHelp');if(help){help.hidden=false;help.open=true;}setMobileHomeStatus('Safari 尚未授權網站存取；可照上方步驟手動開啟。','warn');mobileToast('網站存取尚未允許','warn',2200);return false;}try{await loadMobilePrep();await adoptCurrentPage({manual:false,allowRecognizedAuto:true,reason:'permission-granted'});}catch(_){}setMobileHomeStatus('Safari 網站存取已允許。','good');mobileToast('Safari 網站存取已允許','good');if(finish)await finishMobileOnboarding();return true;}
async function navigateSafari(url){const safe=cleanMobileTargetUrl(url);if(!safe)throw new Error('無效的網站網址。');if(globalThis.QBA_PWA){window.open(safe,'_blank','noopener,noreferrer');return true;}const tab=await activeSafariTab();try{if(tab?.id!=null&&api?.tabs?.update){await api.tabs.update(tab.id,{url:safe,active:true});return true;}}catch(_){}if(api?.tabs?.create){await api.tabs.create({url:safe,active:true});return true;}throw new Error('Safari 無法開啟這個網站。');}
async function refreshMobileCurrentPage(){const tab=await activeSafariTab(),url=String(tab?.url||''),safeUrl=cleanMobileTargetUrl(url),p=globalThis.QBA_PLATFORM_CATALOG?.detect?.(url)||null,restricted=Boolean(tab)&&!safeUrl;if($('mobileCurrentPlatform'))$('mobileCurrentPlatform').textContent=p?.name||(safeUrl?'一般網站':restricted?'網站不可使用':'尚未選擇目標');if($('mobileCurrentTitle'))$('mobileCurrentTitle').textContent=String(tab?.title||'目前目標').slice(0,90);if($('mobileCurrentUrl')){try{$('mobileCurrentUrl').textContent=new URL(url).hostname;}catch(_){$('mobileCurrentUrl').textContent=restricted?'網站不可使用':'—';}}if($('mobileReadyPill')){$('mobileReadyPill').textContent=p?'平台已辨識':(safeUrl?'可使用':'需要確認');$('mobileReadyPill').style.background=p?'#e5f7ef':safeUrl?'#eef1f5':'#fff0cc';$('mobileReadyPill').style.color=p?'#176b4b':safeUrl?'#66758a':'#825b00';}const current={tab,p,url,safeUrl,restricted};renderMobileReadiness(current);return current;}
async function adoptCurrentPage({manual=false,allowRecognizedAuto=true,reason='foreground'}={}){const current=await refreshMobileCurrentPage();if(!current.safeUrl){renderMobileJourneyState(current);if(manual){const msg=current.restricted?'QuickBuy 目前看不到這個 Safari 網站，請先確認網站存取權限。':'請先在 Safari 打開售票、商品或活動頁。';setMobileHomeStatus(msg,'warn');mobileToast(current.restricted?'先確認 Safari 網站權限':'先到 Safari 打開你要的頁面','warn');}return{...current,adopted:false};}
  const currentPlatform=current.p,targetPlatform=platformById(mobilePrep.platformId),hasTarget=Boolean(mobilePrep.targetUrl);let shouldAdopt=manual;
  if(!hasTarget&&allowRecognizedAuto&&currentPlatform&&mobilePageKind(current.safeUrl,currentPlatform)!=='home')shouldAdopt=true;
  if(hasTarget&&currentPlatform&&targetPlatform&&currentPlatform.id===targetPlatform.id&&current.safeUrl!==mobilePrep.targetUrl)shouldAdopt=true;
  if(hasTarget&&!mobilePrep.platformId){try{shouldAdopt=shouldAdopt||new URL(current.safeUrl).hostname===new URL(mobilePrep.targetUrl).hostname;}catch(_){}}
  if(!shouldAdopt){renderMobileJourneyState(current);return{...current,adopted:false};}
  if($('platformUrl'))$('platformUrl').value=current.safeUrl;detectPlatformFromInput();if(currentPlatform){await rememberPlatform(currentPlatform.id);renderPlatformLauncher();}
  const changed=mobilePrep.targetUrl!==current.safeUrl||mobilePrep.platformId!==(currentPlatform?.id||'');mobilePrep.platformId=currentPlatform?.id||'';mobilePrep.targetUrl=current.safeUrl;await saveMobilePrep('',{quiet:true});try{await rememberMobileTarget(mobilePrep.targetUrl,mobilePrep.platformId);}catch(_){}
  const card=document.querySelector('.current');if(card){card.classList.toggle('auto-follow',true);setTimeout(()=>card.classList.remove('auto-follow'),900);}
  if(manual){setMobileHomeStatus(currentPlatform?`已套用 ${currentPlatform.shortName||currentPlatform.name} 目前頁面。`:'已套用目前網頁。','good');mobileToast('目前頁面已準備好','good');}
  else if(changed){setMobileHomeStatus(reason==='foreground'?'已自動跟上目前 Safari 頁面。':'目前頁面已更新。','good');mobileToast('已自動跟上目前頁面','good',1400);}
  renderMobileJourneyState(current);return{...current,adopted:changed};}
async function handleMobileForeground(reason='foreground'){clearTimeout(mobileResumeTimer);mobileResumeTimer=setTimeout(async()=>{try{await loadMobilePrep();const r=await adoptCurrentPage({manual:false,allowRecognizedAuto:true,reason});if(r?.restricted&&!mobilePrep.targetUrl)setMobileHomeStatus('QuickBuy 看不到目前 Safari 網站；確認一次網站權限即可。','warn');}catch(e){setMobileHomeStatus(humanMobileError(e,'頁面恢復失敗'),'warn');}},80);}
async function useMobileCurrentPage(){return adoptCurrentPage({manual:true,allowRecognizedAuto:true,reason:'manual'});}
async function openLatestMobilePlatform(){const id=platformPrefs.recent?.[0];if(id){await choosePlatform(id);mobileToast('已開啟最近的平台','good');return;}showMobileView('platforms');setMobileHomeStatus('還沒有最近平台，先選一次常用平台即可。','warn');}
async function runMobileSelfRepair({quiet=false}={}){try{await createSafariRecovery('一鍵自救前');}catch(_){}try{await loadMobilePrep();await loadPlatformPrefs();renderPlatformLauncher();await loadCustomShortcuts();await refreshSafariRecoveryUi();const current=await refreshMobileCurrentPage();const rows=await runSafariHealth();const warns=rows.filter(x=>x.state==='warn').length;if(!quiet){if(globalThis.QBA_PWA){setMobileHomeStatus(warns?`已完成自救，還有 ${warns} 項提醒。`:'已完成自救，目前狀態正常。',warns?'warn':'good');mobileToast(warns?'已整理，可查看提醒':'已完成自救','good');}else if(current.safeUrl){setMobileHomeStatus(warns?`已完成自救，還有 ${warns} 項提醒。`:'已完成自救，目前狀態正常。',warns?'warn':'good');mobileToast(warns?'已修復，可再看提醒':'已完成自救','good');}else{setMobileHomeStatus('本機資料已整理；Safari 網站權限仍需要你確認一次。','warn');mobileToast('剩 Safari 權限要確認','warn',2200);}}return{current,rows,warns};}catch(e){if(!quiet){const m=humanMobileError(e,'一鍵自救失敗');setMobileHomeStatus(m,'error');mobileToast(m,'error',2400);}throw e;}}
async function runMobileQuickFix(){const r=await runMobileSelfRepair({quiet:true});if(globalThis.QBA_PWA){setMobileHomeStatus('QuickBuy 本機資料與介面已重新整理。','good');mobileToast('已完成快速修復','good');return r;}if(r.current?.safeUrl){setMobileHomeStatus('已重新連上目前 Safari 頁面。','good');mobileToast('Safari 頁面已恢復','good');return r;}setMobileHomeStatus('QuickBuy 已整理本機狀態；請確認 Safari 權限後再重新檢查。','warn');mobileToast('只剩 Safari 權限要確認','warn',2400);return r;}
async function updateMobileOnboardingAccess(){const box=$('mobileOnboardingAccess'),title=$('mobileOnboardingAccessTitle'),detail=$('mobileOnboardingAccessDetail'),hint=$('mobileOnboardingHint'),grant=$('mobileOnboardingGrantBtn');if(!box||!title||!detail)return null;if(globalThis.QBA_PWA){box.classList.add('good');box.classList.remove('warn');title.textContent='完全免費';detail.textContent='加入主畫面後可像 App 一樣使用。';if(grant)grant.textContent='開始使用 QuickBuy';if(hint)hint.textContent='PWA 無法讀取另一個 Safari 分頁；這是 iOS 的正常限制。';return{ok:true,current:null};}let current=null;try{current=await refreshMobileCurrentPage();}catch(_){}const ok=Boolean(current?.safeUrl);box.classList.toggle('good',ok);box.classList.toggle('warn',!ok);title.textContent=ok?'Safari 已可讀取':'第一次需要網站權限';detail.textContent=ok?(current?.p?`已辨識 ${current.p.shortName||current.p.name}，可以直接開始。`:'目前網站可讀取，可以直接開始。'):'按一次允許即可；之後 QuickBuy 會自動讀取目前頁面。';if(grant)grant.textContent=ok?'開始使用':'允許 Safari 網站並開始';if(hint)hint.textContent=ok?'權限正常；之後不用再設定。':'Safari 仍會顯示系統權限確認，是否允許由你決定。';return{ok,current};}
function showMobileView(name){if(name==='favorites'||name==='data')name='more';hideMobileToast();document.querySelectorAll('[data-mobile-view]').forEach(el=>el.classList.toggle('active',el.dataset.mobileView===name));document.querySelectorAll('[data-mobile-tab]').forEach(el=>el.classList.toggle('active',el.dataset.mobileTab===name));window.scrollTo({top:0,behavior:'auto'});if(name==='home')handleMobileForeground('home');}
document.querySelector('.bottom-nav')?.addEventListener('click',e=>{const b=e.target.closest?.('[data-mobile-tab]');if(b)showMobileView(b.dataset.mobileTab);});
function scheduleMobilePrepSave(msg='已自動儲存。'){clearTimeout(mobilePrepSaveTimer);mobilePrepSaveTimer=setTimeout(()=>saveMobilePrep(msg,{quiet:true}).catch(e=>setMobileHomeStatus(humanMobileError(e,'儲存失敗'),'error')),180);}
$('mobileQtyMinus')?.addEventListener('click',()=>{const i=$('mobileQty');i.value=Math.max(1,Number(i.value||1)-1);scheduleMobilePrepSave();});
$('mobileQtyPlus')?.addEventListener('click',()=>{const i=$('mobileQty');i.value=Math.min(10,Number(i.value||1)+1);scheduleMobilePrepSave();});
$('mobileQty')?.addEventListener('input',()=>scheduleMobilePrepSave());
$('mobileKeyword')?.addEventListener('input',()=>scheduleMobilePrepSave());
$('mobileTargetAt')?.addEventListener('input',()=>{renderMobileCountdown();scheduleMobilePrepSave();});
$('mobileNextActionBtn')?.addEventListener('click',async e=>{const action=e.currentTarget?.dataset?.mobileAction||'platforms';if(action==='platforms'){showMobileView('platforms');return;}if(action==='open-target'){try{await navigateSafari(mobilePrep.targetUrl);if(!globalThis.QBA_PWA)setTimeout(()=>{try{window.close();}catch(_){}},80);}catch(err){const m=humanMobileError(err,'無法回到目標頁面');setMobileHomeStatus(m,'error');mobileToast(m,'error',2400);}return;}if(action==='return-browse'){if(globalThis.QBA_PWA){showMobileView('platforms');return;}try{window.close();}catch(_){mobileToast('回 Safari 找到活動或商品頁後，再打開 QuickBuy','good',2400);}return;}if(action==='adopt'){try{await useMobileCurrentPage();}catch(err){const m=humanMobileError(err,'目前頁面讀取失敗');setMobileHomeStatus(m,'error');mobileToast(m,'error',2400);}return;}if(action==='return'){if(!mobilePrep.targetUrl){showMobileView('platforms');return;}try{await saveMobilePrep('',{quiet:true});}catch(_){}if(globalThis.QBA_PWA){try{await navigateSafari(mobilePrep.targetUrl);}catch(e){mobileToast(humanMobileError(e,'無法開啟目標'),'error',2400);}return;}try{window.close();}catch(_){mobileToast('可以直接切回 Safari 繼續','good');}}});
$('mobileGrantAccessBtn')?.addEventListener('click',()=>requestMobileSiteAccess({finish:false}).catch(()=>{}));
$('mobilePermissionRetryBtn')?.addEventListener('click',async()=>{await handleMobileForeground('permission-retry');setTimeout(()=>updateMobileOnboardingAccess().catch(()=>{}),180);});
$('mobileSelfRepairBtn')?.addEventListener('click',()=>runMobileSelfRepair().catch(()=>{}));
$('mobileWaitReturnBtn')?.addEventListener('click',async()=>{try{await saveMobilePrep('',{quiet:true});}catch(_){}try{window.close();}catch(_){mobileToast('可以直接切回 Safari 繼續','good');}});
$('mobileUseCurrentBtn')?.addEventListener('click',()=>{if(globalThis.QBA_PWA){if(mobilePrep.targetUrl)navigateSafari(mobilePrep.targetUrl).catch(e=>mobileToast(humanMobileError(e,'無法開啟目標'),'error',2400));else showMobileView('platforms');return;}useMobileCurrentPage().catch(e=>{const m=humanMobileError(e,'目前頁面讀取失敗');setMobileHomeStatus(m,'error');mobileToast(m,'error',2400);});});
$('mobileOpenRecentBtn')?.addEventListener('click',()=>openLatestMobilePlatform().catch(e=>{const m=humanMobileError(e,'平台開啟失敗');setMobileHomeStatus(m,'error');mobileToast(m,'error',2400);}));
$('mobileSavePrepBtn')?.addEventListener('click',()=>saveMobilePrep().catch(e=>setMobileHomeStatus(humanMobileError(e,'儲存失敗'),'error')));
try{api.tabs?.onActivated?.addListener?.(()=>handleMobileForeground('tab-activated'));api.tabs?.onUpdated?.addListener?.(()=>handleMobileForeground('tab-updated'));}catch(_){ }
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')handleMobileForeground('foreground');});
window.addEventListener('focus',()=>handleMobileForeground('focus'));
window.addEventListener('pageshow',()=>handleMobileForeground('pageshow'));

// High-frequency mobile controls.
$('mobileSwapTargetBtn')?.addEventListener('click',()=>{
  showMobileView('platforms');
  const input=$('platformUrl');
  if(input){input.value='';input.focus();input.scrollIntoView({block:'center',behavior:'smooth'});}
  if($('platformStatus'))$('platformStatus').textContent='貼上新網址，QuickBuy 會自動辨識並取代目前目標。';
});
$('mobileClearTargetBtn')?.addEventListener('click',async()=>{
  await clearMobileTarget({keepPrep:true});
  setMobileHomeStatus('已清空目標；數量與規格保留。','good');
  mobileToast('目標已清空','good');
});
$('mobileReopenTargetBtn')?.addEventListener('click',async()=>{
  try{await reopenMobileTarget();mobileToast('已重新開啟目標','good');}
  catch(e){mobileToast(humanMobileError(e,'重新開啟失敗'),'error',2200);}
});
$('mobileRefreshAppBtn')?.addEventListener('click',async()=>{
  try{
    await loadMobilePrep();await loadPlatformPrefs();await loadMobileRecentTargets();renderPlatformLauncher();await refreshMobileCurrentPage();
    setMobileHomeStatus('QuickBuy 狀態已重新整理。','good');mobileToast('已重新整理','good');
  }catch(e){mobileToast(humanMobileError(e,'重新整理失敗'),'error',2200);}
});
$('pastePlatformUrlBtn')?.addEventListener('click',async()=>{
  try{
    const text=await navigator.clipboard.readText();
    const input=$('platformUrl');if(input){input.value=text;await detectPlatformFromInput();}
  }catch(_){
    const input=$('platformUrl');input?.focus();mobileToast('請長按貼上網址','warn',2200);
  }
});
$('clearPlatformUrlBtn')?.addEventListener('click',()=>{
  const input=$('platformUrl');if(input){input.value='';input.focus();}
  if($('platformStatus'))$('platformStatus').textContent='網址已清除；可直接貼新的連結。';
});
$('mobileRecentTargets')?.addEventListener('click',async e=>{
  const row=e.target.closest?.('[data-recent-target-id]'),btn=e.target.closest?.('button[data-action]');if(!row||!btn)return;
  const id=row.dataset.recentTargetId,x=mobileRecentTargets.find(v=>v.id===id);if(!x)return;
  if(btn.dataset.action==='delete'){mobileRecentTargets=mobileRecentTargets.filter(v=>v.id!==id);await saveMobileRecentTargets();return;}
  if(btn.dataset.action==='open'){
    mobilePrep.platformId=x.platformId||globalThis.QBA_PLATFORM_CATALOG?.detect?.(x.url)?.id||'';
    mobilePrep.targetUrl=x.url;mobilePrep.updatedAt=Date.now();
    await api.storage.local.set({[MOBILE_PREP_KEY]:mobilePrep});
    renderMobileJourneyState();showMobileView('home');
    try{await navigateSafari(x.url);}catch(_){}
  }
});
loadMobileRecentTargets();

loadMobilePrep().then(()=>handleMobileForeground('startup')).catch(()=>{});

// QuickBuy 1.0 onboarding and direct platform navigation.
const MOBILE_ONBOARDING_KEY='qbaMobileOnboardingV4';
async function refreshMobileOnboarding(){
  const el=$('mobileOnboarding');
  if(!el)return;
  try{
    const v=await api.storage.local.get(MOBILE_ONBOARDING_KEY);
    el.hidden=Boolean(v?.[MOBILE_ONBOARDING_KEY]);
  }catch(_){el.hidden=false;}
}
async function finishMobileOnboarding(){
  try{await api.storage.local.set({[MOBILE_ONBOARDING_KEY]:{done:true,at:Date.now(),version:'1.0'}});}catch(_){ }
  const el=$('mobileOnboarding');if(el)el.hidden=true;
  refreshMobileCurrentPage().catch(()=>{});
}
$('mobileOnboardingGrantBtn')?.addEventListener('click',async()=>{const r=await updateMobileOnboardingAccess();if(r?.ok){await finishMobileOnboarding();mobileToast('可以開始用了','good');return;}await requestMobileSiteAccess({finish:true});});
$('mobileOnboardingDoneBtn')?.addEventListener('click',()=>finishMobileOnboarding());
$('mobileChoosePlatformBtn')?.addEventListener('click',()=>showMobileView('platforms'));
refreshMobileOnboarding().then(()=>updateMobileOnboardingAccess().catch(()=>{})).catch(()=>{});
