// Real browser/extension integration tests. Never mock chrome.* or invoke alarm handlers.
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const ext=path.resolve('windows/QuickBuy-Extension');
const manifest=JSON.parse(fs.readFileSync(path.join(ext,'manifest.json')));
const id=[...crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
const browserName=process.env.QBA_BROWSER||'chromium';
const out=path.resolve('runtime-results',browserName);fs.mkdirSync(out,{recursive:true});
const report={browser:browserName,os:os.platform(),commit:process.env.GITHUB_SHA||'local',extensionId:id,checks:[],errors:[],limitations:['Sidepanel document and sidePanel API are tested; native toolbar docking still needs visual acceptance.','60-minute lead is tested with sale time 60 minutes ahead; this is not a 60-minute wall-clock soak.']};
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'quickbuy-runtime-'));
let context,page,worker,cdp;
function pass(name,detail){report.checks.push({name,result:'PASS',detail});console.log('PASS '+name);}
async function until(fn,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,150));}throw Error('Condition timed out');}
async function msg(type,data={}){return page.evaluate(async x=>chrome.runtime.sendMessage(x),{type,...data});}
async function local(key){return page.evaluate(async key=>(await chrome.storage.local.get(key))[key],key);}
async function open(){
 context=await chromium.launchPersistentContext(profile,{channel:browserName,headless:browserName==='chromium',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--enable-unsafe-extension-debugging'],viewport:{width:520,height:1000}});
 context.on('console',m=>{if(m.type()==='error'&&m.location().url.startsWith(`chrome-extension://${id}/`))report.errors.push(m.text());});
 context.on('weberror',e=>report.errors.push(e.error().stack));
 // Official builds may reject load-extension. Ask the browser's documented CDP unpacked loader as a second path.
 if(!context.serviceWorkers().some(w=>w.url()===`chrome-extension://${id}/background.js`)){
   const session=await context.newCDPSession(context.pages()[0]);
   try{await session.send('Extensions.loadUnpacked',{path:ext});}catch(error){console.log('CDP unpacked loader: '+error.message);}
   await session.detach();
 }
 if(browserName==='chrome' && !context.serviceWorkers().some(w=>w.url()===`chrome-extension://${id}/background.js`)){
   const settings=await context.newPage();await settings.goto('chrome://extensions/');
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
   await settings.close();
 }
 worker=await until(()=>context.serviceWorkers().find(w=>w.url()===`chrome-extension://${id}/background.js`),20000);
 page=await context.newPage();await page.goto(`chrome-extension://${id}/sidepanel.html`);
 await page.locator('#simpleTargetUrl').waitFor();
 await until(async()=>(await msg('QBA_SELF_TEST_PING')).ok);
 cdp=await context.newCDPSession(page);cdp.on('ServiceWorker.workerErrorReported',e=>report.errors.push(JSON.stringify(e)));await cdp.send('ServiceWorker.enable');
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
 if(browserName!=='chromium'){
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
 let r=await arm(url,3600,4000);assert.ok(r.ok);await waitLaunched(r.mission);
 let tabs=await page.evaluate(()=>chrome.tabs.query({}));assert.equal(tabs.filter(t=>t.url==='https://example.com/quickbuy-runtime?item=one').length,1);pass('60-minute lead real alarm fires and opens target');
 r=await arm(url,60,4000);await waitLaunched(r.mission);tabs=await page.evaluate(()=>chrome.tabs.query({}));assert.equal(tabs.filter(t=>t.url=== 'https://example.com/quickbuy-runtime?item=one').length,1);pass('Second alarm reuses exact target tab');
 r=await arm('https://example.com/cancelled',60,3000);await msg('QBA_DISARM_MISSION');await page.waitForTimeout(4500);assert.ok(!(await page.evaluate(()=>chrome.tabs.query({}))).some(t=>t.url.includes('/cancelled')));pass('Cancelled reminder stays cancelled past due time');
 r=await arm('https://example.com/expired',60,60000);
 await page.evaluate(async()=>{const {qbaArmedMission:m}=await chrome.storage.local.get('qbaArmedMission');m.saleTimeTs=Date.now()-10000;m.startAt=Date.now()-20000;m.graceMs=0;await chrome.storage.local.set({qbaArmedMission:m});await chrome.alarms.create('qbaScheduledMission',{when:Date.now()+1000});});
 await until(async()=>(await local('qbaLastMissionResult'))?.state==='missed');assert.ok(!(await page.evaluate(()=>chrome.tabs.query({}))).some(t=>t.url.includes('/expired')));pass('Real overdue alarm fails closed beyond grace');
 // Force an actual service-worker stop, then wake it via runtime; state is read from storage.
 r=await arm(url,60,60000);
 await cdp.send('ServiceWorker.stopAllWorkers');await until(async()=>(await msg('QBA_SELF_TEST_PING')).ok);
 assert.equal((await msg('QBA_GET_ARMED_MISSION')).mission.id,r.mission.id);assert.ok(await page.evaluate(()=>chrome.alarms.get('qbaScheduledMission')));pass('Worker stopped and restarted with task intact');
 // Real browser process restart, same profile, not a page reload.
 await context.close();await open();assert.equal((await msg('QBA_GET_ARMED_MISSION')).mission.id,r.mission.id);pass('Browser restart retains valid future reminder');await msg('QBA_DISARM_MISSION');
 // Reload extension itself, then navigate a fresh extension document.
 r=await arm(url,60,60000);
 await page.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(),50);});await new Promise(r=>setTimeout(r,1500));page=await context.newPage();await page.goto(`chrome-extension://${id}/sidepanel.html`);await until(async()=>(await msg('QBA_SELF_TEST_PING')).ok);
 const reloadResult=await msg('QBA_GET_ARMED_MISSION');assert.ok(!reloadResult.mission||reloadResult.mission.id===r.mission.id);await msg('QBA_DISARM_MISSION');pass('Extension reload never executes future task early');
 assert.equal((await msg('QBA_UNKNOWN_TEST')).ok,false);assert.equal((await msg('QBA_LAUNCH_ARMED_MISSION_NOW')).ok,false);pass('Unknown messages and early manual launch fail closed');
 // Concurrent reconciliation/cancel must not recreate the cancelled alarm.
 for(let i=0;i<10;i++){await arm(url,60,60000);await Promise.all([msg('QBA_RUN_MAINTENANCE'),msg('QBA_DISARM_MISSION')]);assert.equal(await local('qbaArmedMission'),undefined);assert.equal(await page.evaluate(()=>chrome.alarms.get('qbaScheduledMission')),undefined);}pass('Maintenance/cancel race regression');
 const integrity=await page.evaluate(()=>verifyBuildManifest());assert.ok(integrity.ok,JSON.stringify(integrity.mismatches));pass('Loaded source build hashes verified');
 await page.screenshot({path:path.join(out,'final.png'),fullPage:true});
 assert.deepEqual(report.errors,[]);pass('No captured console or page runtime errors');report.result='PASS';
 }catch(error){if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});report.result='FAIL';report.failure=error.stack;console.error(error);process.exitCode=1;}finally{if(context)await context.close().catch(()=>{});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));fs.rmSync(profile,{recursive:true,force:true,maxRetries:3});}})();
