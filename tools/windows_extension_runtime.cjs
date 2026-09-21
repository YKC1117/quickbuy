// Real browser/extension integration tests. Never mock chrome.* or invoke alarm handlers.
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const ext=path.resolve('windows/QuickBuy-Extension');
const manifest=JSON.parse(fs.readFileSync(path.join(ext,'manifest.json')));
const expectedId=[...crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
let id=expectedId;
const browserName=process.env.QBA_BROWSER||'chromium';
const out=path.resolve('runtime-results',browserName);fs.mkdirSync(out,{recursive:true});
const report={browser:browserName,os:os.platform(),commit:process.env.GITHUB_SHA||'local',expectedExtensionId:expectedId,extensionId:id,checks:[],errors:[],limitations:['At-most-once: a crash between claiming a reminder and opening its tab can lose the reminder.','60-minute lead is tested with sale time 60 minutes ahead; this is not a 60-minute wall-clock soak.']};
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'quickbuy-runtime-'));
if(browserName==='chrome'){
 const defaultDir=path.join(profile,'Default');fs.mkdirSync(defaultDir,{recursive:true});
 fs.writeFileSync(path.join(defaultDir,'Preferences'),JSON.stringify({
   extensions:{pinned_by_default:true,pinned_extensions:[expectedId]}
 }));
 console.log('Seeded Chrome test profile to pin QuickBuy action: '+expectedId);
}
let context,page,worker,cdp;
function saveChromeState(stage){
 if(browserName!=='chrome')return;
 const state={stage,extensionId:id};
 for(const name of ['Preferences','Secure Preferences']){
  try{const j=JSON.parse(fs.readFileSync(path.join(profile,'Default',name),'utf8'));const e=j.extensions||{},m=e.settings?.[id];
   state[name]={pinned_extensions:e.pinned_extensions,pinned_by_default:e.pinned_by_default,quickbuy:m?{state:m.state,disable_reasons:m.disable_reasons,location:m.location,path:m.path,was_installed_by_default:m.was_installed_by_default,toolbar_pin:m.toolbar_pin}:null};
  }catch(e){state[name]={readError:e.message};}
 }
 fs.writeFileSync(path.join(out,`chrome-profile-${stage}.json`),JSON.stringify(state,null,2));
}

function pass(name,detail){report.checks.push({name,result:'PASS',detail});console.log('PASS '+name);}
async function until(fn,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,150));}throw Error('Condition timed out');}
async function msg(type,data={}){return page.evaluate(async x=>chrome.runtime.sendMessage(x),{type,...data});}
async function local(key){return page.evaluate(async key=>(await chrome.storage.local.get(key))[key],key);}
function samePath(a,b){
 try{return path.resolve(String(a||'')).toLowerCase()===path.resolve(String(b||'')).toLowerCase()}catch(_){return false}
}
async function discoverInstalledExtensionId(timeout=8000){
 const candidates=[
   path.join(profile,'Default','Secure Preferences'),
   path.join(profile,'Default','Preferences')
 ];
 const started=Date.now();
 while(Date.now()-started<timeout){
   for(const file of candidates){
     try{
       if(!fs.existsSync(file))continue;
       const json=JSON.parse(fs.readFileSync(file,'utf8'));
       const settings=json?.extensions?.settings||{};
       for(const [candidate,meta] of Object.entries(settings)){
         if(meta?.path&&samePath(meta.path,ext))return candidate;
       }
     }catch(_){}
   }
   await new Promise(r=>setTimeout(r,200));
 }
 return '';
}
async function discoverExtensionIdFromManager(settings,timeout=8000){
 const started=Date.now();
 while(Date.now()-started<timeout){
   try{
     const rows=await settings.locator('extensions-item').evaluateAll(items=>items.map(item=>({
       id:item.getAttribute('id')||item.data?.id||'',
       name:item.data?.name||item.shadowRoot?.querySelector('#name')?.textContent?.trim()||''
     })));
     if(rows.length)console.log('Chrome extensions manager items: '+JSON.stringify(rows));
     const exact=rows.find(row=>row.name==="QuickBuy"||row.id===expectedId);
     if(exact?.id)return exact.id;
   }catch(error){console.log('Chrome extensions manager probe: '+error.message);}
   await new Promise(r=>setTimeout(r,200));
 }
 return '';
}
// Official Chrome side panels are not exposed as Playwright Pages in this build.
// Attach to the target created by the native Toolbar click, never create/navigate one.
async function attachNativePanel(target){
 const {EventEmitter}=require('node:events');
 const root=await context.browser().newBrowserCDPSession();
 const {sessionId}=await root.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
 const events=new EventEmitter(),pending=new Map();let serial=0;
 root.on('Target.receivedMessageFromTarget',e=>{
  if(e.sessionId!==sessionId)return;
  const m=JSON.parse(e.message);
  if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
  else events.emit(m.method,m.params);
 });
 const client={on:(...args)=>events.on(...args),send:(method,params={})=>new Promise((resolve,reject)=>{
  const n=++serial;const timer=setTimeout(()=>{pending.delete(n);reject(Error('Side Panel CDP timeout: '+method));},15000);
  pending.set(n,{resolve,reject,timer});root.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:n,method,params})}).catch(e=>{clearTimeout(timer);pending.delete(n);reject(e);});
 })};
 client.on('Runtime.exceptionThrown',e=>report.errors.push(JSON.stringify(e)));
 client.on('Runtime.consoleAPICalled',e=>{if(e.type==='error')report.errors.push(JSON.stringify(e));});
 await client.send('Runtime.enable');await client.send('Page.enable');await client.send('Runtime.runIfWaitingForDebugger');
 const panel={cdp:client,targetId:target.targetId,
  evaluate:async(fn,arg)=>{const r=await client.send('Runtime.evaluate',{expression:`(${fn.toString()})(${JSON.stringify(arg)??'undefined'})`,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;},
  waitForTimeout:ms=>new Promise(r=>setTimeout(r,ms)),
  screenshot:async({path:dest})=>{const r=await client.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dest,Buffer.from(r.data,'base64'));},
  reload:async()=>{await client.send('Page.reload');await panel.waitForTimeout(350);await panel.locator('#simpleTargetUrl').waitFor();}
 };
 panel.locator=(selector,index=null)=>{
  const evaluate=(fn,arg)=>panel.evaluate(new Function('arg',`return (${fn.toString()})(document.querySelectorAll(${JSON.stringify(selector)})[${index??0}],arg)`),arg);
  const visible=()=>evaluate(e=>!!e&&!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden');
  const loc={first:()=>panel.locator(selector,0),evaluate,
   evaluateAll:fn=>panel.evaluate(new Function(`return (${fn.toString()})([...document.querySelectorAll(${JSON.stringify(selector)})])`)),
   count:()=>panel.evaluate(s=>document.querySelectorAll(s).length,selector),isVisible:visible,
   waitFor:()=>until(visible),getAttribute:name=>evaluate((e,n)=>e.getAttribute(n),name),
   inputValue:()=>evaluate(e=>e.value),innerText:()=>evaluate(e=>e.innerText),
   click:async()=>{await until(visible);const r=await evaluate(e=>{e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await client.send('Input.dispatchMouseEvent',{type:'mousePressed',...r,button:'left',clickCount:1});await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...r,button:'left',clickCount:1});},
   fill:async value=>{await loc.click();const type=await evaluate(e=>e.type);
    if(['date','time'].includes(type)){await evaluate((e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));},value);return;}
    await evaluate(e=>{e.focus();e.select();});await client.send('Input.insertText',{text:value});},
   press:async key=>{assert.equal(key,'Tab');await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});},
   selectOption:value=>evaluate((e,v)=>{if(![...e.options].some(o=>o.value===v))throw Error('Missing option '+v);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));},value)
  };return loc;
 };
 await until(()=>panel.evaluate(()=>document.readyState==='complete'));
 const proof=await panel.evaluate(async()=>({id:chrome.runtime.id,url:location.href,contexts:await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']})}));
 assert.equal(proof.id,id);assert.equal(proof.url,`chrome-extension://${id}/sidepanel.html`);
 assert.ok(proof.contexts.some(c=>c.contextType==='SIDE_PANEL'&&c.documentUrl===proof.url));
 fs.writeFileSync(path.join(out,`sidepanel-context-${openNativePanel.count}.json`),JSON.stringify({target,...proof},null,2));
 return panel;
}
async function openNativePanel(chromeSettings){
 const extensionPageUrl=`chrome-extension://${id}/sidepanel.html`;
   await chromeSettings.bringToFront();
   await new Promise((resolve,reject)=>{
     const child=spawn('powershell.exe',['-NoProfile','-File',path.resolve('tools/click_chrome_extension_action.ps1'),'-ExtensionName',manifest.name,'-ActionTitle',manifest.action.default_title,'-ProcessName','chrome','-ArtifactDir',path.join(out,'native-'+(++openNativePanel.count))]);
     child.stdout.on('data',d=>console.log(String(d)));child.stderr.on('data',d=>console.error(String(d)));
     child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('Native Chrome extension action failed '+code)));
   });
   const probe=await context.newCDPSession(chromeSettings);
   const sideTarget=await until(async()=>{
     const {targetInfos}=await probe.send('Target.getTargets');
     const found=targetInfos.find(t=>t.url===extensionPageUrl);
     if(found)return found;
     return null;
   },15000);
   console.log('Chrome native Side Panel target: '+JSON.stringify({targetId:sideTarget.targetId,type:sideTarget.type,url:sideTarget.url,title:sideTarget.title}));
   await probe.detach();
   page=await attachNativePanel(sideTarget);


}
openNativePanel.count=0;
async function restorePanel(){
 if(browserName==='chrome'){const host=context.pages().find(p=>!p.url().startsWith('chrome-extension://'))||await context.newPage();await openNativePanel(host);}
 else{page=await context.newPage();await page.goto(`chrome-extension://${id}/sidepanel.html`);}
 await page.locator('#simpleTargetUrl').waitFor();
}
async function open(){
 context=await chromium.launchPersistentContext(profile,{channel:browserName,headless:browserName==='chromium',ignoreDefaultArgs:['--disable-extensions'],args:browserName==='chrome'?['--enable-unsafe-extension-debugging']:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--enable-unsafe-extension-debugging'],viewport:{width:520,height:1000}});
 let chromeSettings=null;
 report.browserVersion=context.browser()?.version();saveChromeState('started');
 context.on('page',p=>console.log('Browser Page attached: '+p.url()));
 context.on('console',m=>{if(m.type()==='error'&&m.location().url.startsWith(`chrome-extension://${id}/`))report.errors.push(m.text());});
 context.on('weberror',e=>report.errors.push(e.error().stack));
 // Official builds may reject load-extension. Ask the browser's documented CDP unpacked loader as a second path.
 if(!context.serviceWorkers().some(w=>w.url()===`chrome-extension://${id}/background.js`)){
   const session=await context.newCDPSession(context.pages()[0]);
   try{await session.send('Extensions.loadUnpacked',{path:ext});}catch(error){console.log('CDP unpacked loader: '+error.message);}
   await session.detach();
 }
 if(browserName==='chrome' && !context.serviceWorkers().some(w=>w.url()===`chrome-extension://${id}/background.js`)){
   const settings=chromeSettings=await context.newPage();await settings.goto('chrome://extensions/');
   const toggle=settings.locator('#devMode');await toggle.waitFor();
   if(!await toggle.evaluate(e=>e.checked))await toggle.click();
   settings.on('filechooser',async chooser=>{console.log('Browser directory chooser intercepted');await chooser.setFiles(ext);});
   const picker=new Promise((resolve,reject)=>{
     const child=spawn('powershell.exe',['-NoProfile','-File',path.resolve('tools/select_extension_folder.ps1'),'-ExtensionPath',ext]);
     child.stdout.on('data',d=>console.log(String(d)));child.stderr.on('data',d=>console.error(String(d)));
     child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('Folder picker failed '+code)));
   });
   await Promise.all([picker,settings.locator('#loadUnpacked').click()]).catch(async error=>{await settings.screenshot({path:path.join(out,'chrome-install-failure.png'),fullPage:true});throw error;});
   await settings.screenshot({path:path.join(out,'unpacked-install.png'),fullPage:true});
   let discovered=await discoverExtensionIdFromManager(settings);
   if(!discovered)discovered=await discoverInstalledExtensionId();
   if(discovered){
     id=discovered;
     report.extensionId=id;
     console.log('Discovered Chrome unpacked extension id: '+id+(id===expectedId?' (matches manifest key)':' (differs from manifest key)'));
   }else{
     console.log('Chrome manager/profile did not expose unpacked extension id; using manifest-derived id '+id);
   }
 }
 saveChromeState('installed');
 const extensionPageUrl=`chrome-extension://${id}/sidepanel.html`;
 if(browserName==='chrome'){
   if(!chromeSettings){chromeSettings=await context.newPage();await chromeSettings.goto('chrome://extensions/');}
   await openNativePanel(chromeSettings);
 }else{
   page=await context.newPage();
   await page.goto(extensionPageUrl);
 }
 await page.locator('#simpleTargetUrl').waitFor();
 await until(async()=>(await msg('QBA_SELF_TEST_PING')).ok);
 const backgroundContexts=await until(()=>page.evaluate(async()=>{try{const rows=await chrome.runtime.getContexts({contextTypes:['BACKGROUND']});return rows.length?rows:null}catch(_){return null}}),20000);
 const playwrightWorker=context.serviceWorkers().find(w=>w.url()===`chrome-extension://${id}/background.js`);
 worker=playwrightWorker||{url:()=>backgroundContexts[0]?.documentUrl||`chrome-extension://${id}/background.js`};
 cdp=page.cdp||await context.newCDPSession(page);cdp.on('ServiceWorker.workerErrorReported',e=>report.errors.push(JSON.stringify(e)));await cdp.send('ServiceWorker.enable');
 // Keep worker exceptions in the same report, including tasks after suspension.
 const versions=new Map();cdp.on('ServiceWorker.workerVersionUpdated',event=>{for(const v of event.versions)versions.set(v.versionId,v);});
 open.versions=versions;
 await page.screenshot({path:path.join(out,'sidepanel.png'),fullPage:true});
}
async function arm(url,lead=60,delay=5000){return msg('QBA_ARM_MISSION',{config:{targetUrl:url,saleTimeTs:Date.now()+lead*1000+delay,quantity:2,priorities:['Blue']},leadSec:lead,graceSec:120});}
async function waitLaunched(mission){return until(async()=>{const r=await local('qbaLastMissionResult');return r?.id===mission.id&&r.state==='launched'&&r;},25000);}
(async()=>{try{
 assert.equal(manifest.manifest_version,3);await open();
 pass('MV3 unpacked extension and exact worker',{workerUrl:worker.url(),userAgent:await page.evaluate(()=>navigator.userAgent)});
 assert.equal(await page.evaluate(()=>chrome.runtime.id),id);assert.ok(await page.locator('#simpleTargetUrl').isVisible());
 assert.equal((await page.evaluate(()=>chrome.sidePanel.getOptions({}))).path,'sidepanel.html');pass('Sidepanel document and API');

 // Let first-run onboarding finish, then close through its real button.
 await page.waitForTimeout(500);
 const close=page.locator('#onboardingCloseBtn');if(await close.isVisible())await close.click();
 if(browserName==='chrome'){
   const panels=await page.evaluate(()=>chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}));
   assert.ok(panels.some(c=>c.documentUrl===`chrome-extension://${id}/sidepanel.html`));
   pass('Native Chrome toolbar click opens SIDE_PANEL',panels);
 }else if(browserName!=='chromium'){
   await page.evaluate(async()=>{const w=await chrome.windows.getCurrent();const b=document.createElement('button');b.id='runtimeOpenSidePanel';b.textContent='Open native Side Panel';b.onclick=()=>chrome.sidePanel.open({windowId:w.id});document.body.prepend(b);});
   await page.locator('#runtimeOpenSidePanel').click();
   const panels=await until(()=>page.evaluate(async()=>{const c=await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']});return c.length&&c;}));
   pass('Native Side Panel context opened',panels.map(c=>c.contextType));
   await page.evaluate(()=>document.getElementById('runtimeOpenSidePanel').remove());
 }

 const allIds=await page.locator('[id]').evaluateAll(es=>es.map(e=>e.id));assert.equal(new Set(allIds).size,allIds.length);pass('No duplicate DOM IDs');
 const missing=await page.evaluate(()=>fieldIds.filter(id=>!document.getElementById(id)));assert.deepEqual(missing,[]);pass('All persisted field IDs exist');
 const ticket=page.locator('#simpleTicketPlatformQuickPick button');const shops=page.locator('#simpleShoppingPlatformQuickPick button');
 assert.ok(await ticket.count()>0);assert.ok(await shops.count()>0);pass('Ticket and shopping platform selectors populated');
 // Actual platform buttons must open their catalog destination in a real tab.
 // Fixture only the network response; preserve real UI click, chrome.tabs and URL.
 for(const group of ['simpleTicketPlatformQuickPick','simpleShoppingPlatformQuickPick']){
   const button=page.locator(`#${group} button`).first();
   const platformId=await button.getAttribute('data-platform-id');
   const platform=await page.evaluate(id=>QBA_PLATFORM_CATALOG.list().find(p=>p.id===id),platformId);
   const routePattern=new URL(platform.homepage).origin+'/**';
   await context.route(routePattern,r=>r.fulfill({body:'<title>Platform destination fixture</title>'}));
   await button.click();
   const tab=await until(()=>page.evaluate(async url=>(await chrome.tabs.query({})).find(t=>(t.pendingUrl||t.url)===url),platform.homepage));
   assert.equal(await page.locator('#simpleTargetUrl').inputValue(),platform.homepage);
   pass('Platform button opens destination: '+platformId,{tabId:tab.id,url:tab.pendingUrl||tab.url,network:'fixture'});
   await page.evaluate(id=>chrome.tabs.remove(id),tab.id);
 }
 await page.locator('#simpleTargetUrl').fill('https://tixcraft.com/activity/detail/runtime');
 await page.locator('#simpleTargetUrl').press('Tab');
 await until(async()=>/tixcraft|拓元/i.test(await page.locator('#simplePlatformState').innerText()));
 pass('Changed URL detects ticket platform');
 // Use actual controls, including blur-triggered save.
 await page.locator('#simpleTargetUrl').fill('https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=123456&token=REMOVE');
 await page.locator('#simpleQuantity').fill('2');await page.locator('#simpleQuantity').press('Tab');
 await until(async()=>/momo/i.test(await page.locator('#simplePlatformState').innerText()));pass('Pasted momo URL platform detection');
 await page.locator('#openAdvancedBtn').click();
 await page.locator('#priorities').fill('Blue\nXL');await page.locator('#priorities').press('Tab');
 const parts=await page.evaluate(()=>localDateParts(new Date(Date.now()+7200000)));
 await page.locator('#saleDate').fill(parts.date);await page.locator('#saleTime').fill(parts.time);await page.locator('#saleTime').press('Tab');
 for(const lead of [60,180,300,600,900,1800,3600]){
   await page.locator('#missionLeadSec').selectOption(String(lead));await page.locator('#armMissionBtn').click();
   const m=await until(async()=>{const m=await local('qbaArmedMission');return m?.leadSec===lead&&m;});
   assert.equal(m.saleTimeTs-m.startAt,lead*1000);
   assert.equal(m.config.quantity,2);assert.ok(m.config.priorities.includes('Blue'));
   const alarm=await page.evaluate(()=>chrome.alarms.get('qbaScheduledMission'));assert.equal(alarm.scheduledTime,m.startAt);
   assert.ok(m.targetUrl.includes('i_code=123456'));assert.ok(!m.targetUrl.includes('REMOVE'));
   await page.locator('#disarmMissionBtn').click();await until(async()=>!(await local('qbaArmedMission')));
   assert.equal(await page.evaluate(()=>chrome.alarms.get('qbaScheduledMission')),undefined);
   pass(`UI set/cancel ${lead/60}-minute reminder`);
 }
 await page.reload();await until(async()=>(await msg('QBA_SELF_TEST_PING')).ok);
 assert.equal(await page.locator('#quantity').inputValue(),'2');assert.equal(await page.locator('#missionLeadSec').inputValue(),'3600');pass('UI values persist after page reload');
 const samples=[
 ['https://user:secret@www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=123456&code=EVENT&key=SIZE&token=x&access_token=x&refresh_token=x&auth=x&authorization=x&session=x&sessionid=x&sid=x&jwt=x&otp=x&password=x&api_key=x&username=x#token=x','https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=123456&code=EVENT&key=SIZE'],
 ['https://example.com/item?sku=blue#details','https://example.com/item?sku=blue#details'],
 ['https://example.com/item#access_token%3DSECRET','https://example.com/item']
 ];
 for(const [input,expected]of samples){assert.equal(await page.evaluate(x=>QBA_PLATFORM_CATALOG.sanitizeTargetUrl(x),input),expected);const r=await arm(input,60,60000);assert.equal((await local('qbaArmedMission')).targetUrl,expected);assert.ok(r.ok);await msg('QBA_DISARM_MISSION');}pass('Functional queries survive; sensitive URL values removed');
 const url='https://example.com/quickbuy-runtime?item=one';
 // A local response avoids contacting a checkout platform. Chrome tabs and alarms stay real.
 await context.route('https://example.com/**',route=>route.fulfill({body:'<title>QuickBuy runtime fixture</title><h1>Manual checkout only</h1>'}));
 let r=await arm(url,3600,4000);assert.ok(r.ok);const firstLaunch=await waitLaunched(r.mission);
 const firstTab=await until(()=>page.evaluate(async id=>{try{return await chrome.tabs.get(id)}catch(_){return null}},firstLaunch.tabId));
 assert.equal(await page.evaluate(x=>QBA_PLATFORM_CATALOG.sanitizeTargetUrl(x),firstTab.pendingUrl||firstTab.url||''),url);
 pass('60-minute lead real alarm fires and opens target',{tabId:firstLaunch.tabId,url:firstTab.pendingUrl||firstTab.url||''});
 r=await arm(url,60,4000);const secondLaunch=await waitLaunched(r.mission);
 const secondTab=await until(()=>page.evaluate(async id=>{try{return await chrome.tabs.get(id)}catch(_){return null}},secondLaunch.tabId));
 assert.equal(await page.evaluate(x=>QBA_PLATFORM_CATALOG.sanitizeTargetUrl(x),secondTab.pendingUrl||secondTab.url||''),url);
 assert.equal(secondLaunch.tabId,firstLaunch.tabId);
 pass('Second alarm reuses exact target tab',{tabId:secondLaunch.tabId});
 r=await arm('https://example.com/cancelled',60,3000);await msg('QBA_DISARM_MISSION');await page.waitForTimeout(4500);assert.ok(!(await page.evaluate(()=>chrome.tabs.query({}))).some(t=>t.url.includes('/cancelled')));pass('Cancelled reminder stays cancelled past due time');
 r=await arm('https://example.com/expired',60,60000);
 await page.evaluate(async()=>{const {qbaArmedMission:m}=await chrome.storage.local.get('qbaArmedMission');m.saleTimeTs=Date.now()-10000;m.startAt=Date.now()-20000;m.graceMs=0;await chrome.storage.local.set({qbaArmedMission:m});await chrome.alarms.create('qbaScheduledMission',{when:Date.now()+1000});});
 await until(async()=>(await local('qbaLastMissionResult'))?.state==='missed');assert.ok(!(await page.evaluate(()=>chrome.tabs.query({}))).some(t=>t.url.includes('/expired')));pass('Real overdue alarm fails closed beyond grace');
 // Close all extension documents, then watch worker lifecycle from an ordinary tab.
 // No runtime/storage/evaluate polling is allowed until the alarm observation ends.
 const observerPage=await context.newPage();await observerPage.goto('about:blank');
 const observer=await context.newCDPSession(observerPage);
 const lifecycle=[],workerStates=new Map();
 observer.on('ServiceWorker.workerVersionUpdated',e=>{for(const v of e.versions){workerStates.set(v.versionId,v);lifecycle.push({at:Date.now(),...v});}});
 observer.on('ServiceWorker.workerErrorReported',e=>report.errors.push(JSON.stringify(e)));
 await observer.send('ServiceWorker.enable');
 const wakeUrl='https://example.com/alarm-only-wakeup';
 r=await arm(wakeUrl,60,12000);const waking=r.mission;
 const {targetInfos}=await observer.send('Target.getTargets');
 for(const t of targetInfos.filter(t=>t.url.startsWith(`chrome-extension://${id}/`)&&t.type!=='service_worker'))await observer.send('Target.closeTarget',{targetId:t.targetId});
 await new Promise(resolve=>setTimeout(resolve,500));
 await observer.send('ServiceWorker.stopAllWorkers');
 await until(()=>[...workerStates.values()].some(v=>v.scriptURL===`chrome-extension://${id}/background.js`&&v.runningStatus==='stopped'));
 const stoppedAt=Date.now();assert.ok(stoppedAt<waking.startAt);
 // Observe only browser page URLs and already-delivered CDP events.
 await until(()=>context.pages().some(p=>p.url()===wakeUrl),30000);
 const observedAt=Date.now();
 const earlyWake=lifecycle.filter(v=>v.at>stoppedAt&&v.at<waking.startAt&&v.scriptURL===`chrome-extension://${id}/background.js`&&v.runningStatus==='running');
 assert.deepEqual(earlyWake,[],'Worker restarted before the alarm deadline');
 assert.ok(observedAt>=waking.startAt);
 fs.writeFileSync(path.join(out,'alarm-wakeup-lifecycle.json'),JSON.stringify({mission:waking.id,scheduledTime:waking.startAt,stoppedAt,observedAt,lifecycle},null,2));
 await restorePanel();
 assert.equal((await local('qbaLastMissionResult')).id,waking.id);
 assert.equal((await local('qbaLastMissionResult')).reason,'alarm:scheduled');
 pass('Real alarm alone wakes stopped worker',{stoppedAt,scheduledTime:waking.startAt,observedAt});
 await observer.detach();await observerPage.close();

 r=await arm('https://example.com/old-build',60,2500);
 await page.evaluate(async()=>{const {qbaArmedMission:m}=await chrome.storage.local.get('qbaArmedMission');m.buildId='obsolete-runtime-test';await chrome.storage.local.set({qbaArmedMission:m});});
 await page.waitForTimeout(4000);
 assert.equal(await local('qbaArmedMission'),undefined);
 assert.equal(await page.evaluate(()=>chrome.alarms.get('qbaScheduledMission')),undefined);
 assert.ok(!(await page.evaluate(()=>chrome.tabs.query({}))).some(t=>(t.pendingUrl||t.url).includes('/old-build')));
 pass('Old build ID real alarm fails closed and clears task/alarm');

 const a=await arm('https://example.com/replaced-A',60,3000);
 const b=await arm('https://example.com/replacement-B',60,7500);
 assert.equal((await local('qbaArmedMission')).id,b.mission.id);
 const replacementAlarms=await page.evaluate(()=>chrome.alarms.getAll());
 assert.deepEqual(replacementAlarms.filter(a=>a.name==='qbaScheduledMission').map(a=>a.scheduledTime),[b.mission.startAt]);
 await page.waitForTimeout(Math.max(0,a.mission.startAt-Date.now()+700));
 assert.ok(Date.now()<b.mission.startAt,'A checkpoint must precede B deadline');
 assert.ok(!(await page.evaluate(()=>chrome.tabs.query({}))).some(t=>/replaced-A|replacement-B/.test(t.pendingUrl||t.url)));
 const replaced=await waitLaunched(b.mission);assert.ok(replaced.at>=b.mission.startAt);
 await page.waitForTimeout(1500);
 const replacementTabs=await page.evaluate(()=>chrome.tabs.query({}));
 assert.equal(replacementTabs.filter(t=>(t.pendingUrl||t.url).includes('/replacement-B')).length,1);
 assert.ok(!replacementTabs.some(t=>(t.pendingUrl||t.url).includes('/replaced-A')));
 assert.equal(await local('qbaArmedMission'),undefined);
 assert.equal(await page.evaluate(()=>chrome.alarms.get('qbaScheduledMission')),undefined);
 assert.deepEqual(await local('qbaLastMissionResult'),replaced);
 pass('Replacement B suppresses A and fires once at its own deadline',{a:a.mission.startAt,b:b.mission.startAt,launched:replaced.at});
 // Force an actual service-worker stop, then wake it via runtime; state is read from storage.
 r=await arm(url,60,60000);
 await cdp.send('ServiceWorker.stopAllWorkers');await until(async()=>(await msg('QBA_SELF_TEST_PING')).ok);
 assert.equal((await msg('QBA_GET_ARMED_MISSION')).mission.id,r.mission.id);assert.ok(await page.evaluate(()=>chrome.alarms.get('qbaScheduledMission')));pass('Worker stopped and restarted with task intact');
 // Real browser process restart, same profile, not a page reload.
 await context.close();await open();assert.equal((await msg('QBA_GET_ARMED_MISSION')).mission.id,r.mission.id);pass('Browser restart retains valid future reminder');await msg('QBA_DISARM_MISSION');
 // Reload extension itself, then navigate a fresh extension document.
 r=await arm(url,60,60000);
 await page.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(),50);});await new Promise(r=>setTimeout(r,1500));await restorePanel();await until(async()=>(await msg('QBA_SELF_TEST_PING')).ok);
 const reloadResult=await msg('QBA_GET_ARMED_MISSION');assert.ok(!reloadResult.mission||reloadResult.mission.id===r.mission.id);await msg('QBA_DISARM_MISSION');pass('Extension reload never executes future task early');
 assert.equal((await msg('QBA_UNKNOWN_TEST')).ok,false);assert.equal((await msg('QBA_LAUNCH_ARMED_MISSION_NOW')).ok,false);pass('Unknown messages and early manual launch fail closed');
 // Concurrent reconciliation/cancel must not recreate the cancelled alarm.
 for(let i=0;i<10;i++){await arm(url,60,60000);await Promise.all([msg('QBA_RUN_MAINTENANCE'),msg('QBA_DISARM_MISSION')]);assert.equal(await local('qbaArmedMission'),undefined);assert.equal(await page.evaluate(()=>chrome.alarms.get('qbaScheduledMission')),undefined);}pass('Maintenance/cancel race regression');
 const integrity=await page.evaluate(()=>verifyBuildManifest());assert.ok(integrity.ok,JSON.stringify(integrity.mismatches));pass('Loaded source build hashes verified');
 await page.screenshot({path:path.join(out,'final.png'),fullPage:true});
 assert.deepEqual(report.errors,[]);pass('No captured console or page runtime errors');report.result='PASS';
 }catch(error){if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});report.result='FAIL';report.failure=error.stack;console.error(error);process.exitCode=1;}finally{saveChromeState('finished');if(context)await context.close().catch(()=>{});saveChromeState('closed');fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));fs.rmSync(profile,{recursive:true,force:true,maxRetries:3});}})();
