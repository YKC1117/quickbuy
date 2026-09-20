const $ = (id) => document.getElementById(id);
const fieldIds = [
  "targetUrl", "saleDate", "saleTime", "quantity", "maxPrice", "intervalMs", "priorities",
  "purchaseSelector", "quantitySelector", "priceSelector", "profileName", "profileEmail", "profilePhone", "profileAddress", "operationMode", "profileScope", "platformProfileMode", "ruleMode", "soundMode", "missionLeadSec", "missionGraceSec", 
];

let currentTabId = null;
let running = false;
let currentStatus = "IDLE";
let logs = [];
let countdownTimer = null;
let telemetryTimer = null;
let networkTimer = null;
let latestNetworkSample = null;
let networkSamples = [];
let replayEvents = [];
let lastAlertCode = "";
let lastNetworkQuality = "none";
let lastNetworkAlertAt = 0;
let networkAutoDisabled = false;
let clockOffsetMs = 0;
let clockSyncedAt = 0;
let clockRttMs = 0;
let clockJitterMs = 0;
let clockUncertaintyMs = 0;
let clockQuality = "none";
let clockSamples = 0;
let clockSyncOk = false;
let lastPreflightResult = null;
let lastRehearsalResult = null;
let lastRehearsalAt = 0;
let lastPreflightAt = 0;
let pageTransitions = [];
let lastDebugScan = null;
let lastDebugDelta = null;
let profileBuilderDraft = null;
let profileBuilderValidationResult = null;
let profileBuilderSourceScan = null;
let profileLabLastResults = [];
let lastReleaseSelfTest = null;
const QBA_PROFILE_LAB_LIMIT = 16;
const QBA_PROFILE_LAB_HTML_MAX = 180000;
const QBA_APP_VERSION = "1.0.0";
const QBA_BUILD_ID = "2026-09-20.windows-runtime.1";
const QBA_STORAGE_SCHEMA = 3;
const QBA_RUN_ARCHIVE_LIMIT = 30;
const QBA_REPAIR_RECOVERY_LIMIT = 3;
const QBA_STORAGE_QUOTA_FALLBACK = 10 * 1024 * 1024;

function formatBytes(bytes = 0) {
  const n = Math.max(0, Number(bytes || 0));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function getStorageUsage() {
  let bytes = 0;
  try {
    if (typeof chrome.storage.local.getBytesInUse === "function") bytes = Number(await chrome.storage.local.getBytesInUse(null) || 0);
    else {
      const raw = await chrome.storage.local.get(null);
      bytes = new Blob([JSON.stringify(raw)]).size;
    }
  } catch (_) {
    try { bytes = new Blob([JSON.stringify(await chrome.storage.local.get(null))]).size; } catch (_) { bytes = 0; }
  }
  const quota = Number(chrome.storage.local.QUOTA_BYTES || QBA_STORAGE_QUOTA_FALLBACK);
  const pct = quota > 0 ? Math.max(0, Math.min(100, bytes / quota * 100)) : 0;
  return { bytes, quota, pct };
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function verifyBuildManifest() {
  const manifestUrl = chrome.runtime.getURL("BUILD_MANIFEST.json");
  const build = await fetch(manifestUrl, { cache: "no-store" }).then(r => { if (!r.ok) throw new Error(`BUILD_MANIFEST HTTP ${r.status}`); return r.json(); });
  if (build?.version !== QBA_APP_VERSION || build?.buildId !== QBA_BUILD_ID || !build?.files || typeof build.files !== "object") throw new Error("BUILD_MANIFEST 版本或格式不一致。");
  const mismatches = [];
  for (const [name, expected] of Object.entries(build.files)) {
    const response = await fetch(chrome.runtime.getURL(name), { cache: "no-store" });
    if (!response.ok) { mismatches.push(`${name}:missing`); continue; }
    const actual = await sha256Hex(await response.arrayBuffer());
    if (actual !== String(expected).toLowerCase()) mismatches.push(`${name}:hash`);
  }
  return { ok: mismatches.length === 0, checked: Object.keys(build.files).length, mismatches, build };
}

function localDateParts(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` };
}

function speak(text) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-TW";
    u.rate = 1;
    u.volume = 1;
    speechSynthesis.speak(u);
  } catch (_) {}
}


function soundMode() { return $("soundMode")?.value || "voice"; }
function playTone(kind = "info") {
  if (soundMode() === "silent") return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const plan = kind === "urgent" ? [[880,0],[660,.14],[880,.28]] : kind === "success" ? [[660,0],[880,.16]] : kind === "warn" ? [[520,0],[420,.18]] : [[620,0]];
    for (const [freq, delay] of plan) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(.0001, ctx.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(.12, ctx.currentTime + delay + .015);
      g.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + delay + .12);
      o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime + delay); o.stop(ctx.currentTime + delay + .14);
    }
    setTimeout(() => ctx.close().catch(() => {}), 900);
  } catch (_) {}
}
function alertForStatus(code, text) {
  if (!code || code === lastAlertCode || soundMode() === "silent") return;
  lastAlertCode = code;
  if (code === "QUEUE_WAIT") playTone("info");
  else if (["NEED_USER","SITE_CHANGED","AUTO_PAUSED","RATE_GUARD","PRICE_BLOCK"].includes(code)) playTone("urgent");
  else if (code === "FINAL_CONFIRM") playTone("success");
  else if (code === "RECOVERING") playTone("warn");
  else if (code === "WORKING" && currentStatus === "WAITING") playTone("success");
  if (soundMode() === "voice" && ["NEED_USER","FINAL_CONFIRM","PRICE_BLOCK","SITE_CHANGED","AUTO_PAUSED"].includes(code)) {
    speak(code === "FINAL_CONFIRM" ? "已到最後確認步驟，請你接手。" : (text || "QuickBuy 需要你接手。"));
  }
}

function setStatus(code, text) {
  currentStatus = code;
  $("statusText").textContent = text;
  const dot = $("statusDot");
  dot.className = `status-dot ${code.toLowerCase().replaceAll("_", "-")}`;
  const needUser = ["NEED_USER", "FINAL_CONFIRM", "PRICE_BLOCK", "SITE_CHANGED", "AUTO_PAUSED", "RATE_GUARD"].includes(code);
  $("resumeBtn").disabled = !running || !needUser;
  if ($("liveStatusBadge")) {
    $("liveStatusBadge").textContent = code === "RECOVERING" ? "自動恢復中" : code === "QUEUE_WAIT" ? "官方排隊中" : code === "FINAL_CONFIRM" ? "最後確認" : code === "NEED_USER" ? "需要你接手" : (text || code);
    $("liveStatusBadge").className = `live-status-badge ${code.toLowerCase().replaceAll("_", "-")}`;
    $("liveStatusText").textContent = text || code;
    $("liveResumeBtn").disabled = !running || !needUser;
    $("liveStopBtn").disabled = !running;
  }
}

function addLog(message, level = "info", ts = Date.now(), persist = false) {
  logs.unshift({ message, level, ts });
  logs = logs.slice(0, 200);
  renderLogs();
  if (persist && currentTabId) {
    chrome.runtime.sendMessage({ type: "QBA_LOCAL_LOG", tabId: currentTabId, message, level, ts }).catch(() => {});
  }
}

function renderLogs() {
  const box = $("logBox");
  if (!logs.length) { box.innerHTML = '<div class="log empty">尚無紀錄</div>'; return; }
  box.innerHTML = "";
  for (const item of logs) {
    const row = document.createElement("div");
    row.className = `log ${item.level || "info"}`;
    const t = new Date(item.ts).toLocaleTimeString("zh-TW", { hour12: false });
    const time = document.createElement("span"); time.className = "time"; time.textContent = t;
    const msg = document.createElement("span"); msg.textContent = item.message;
    row.append(time, msg);
    box.appendChild(row);
  }
}


function formatClock(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("zh-TW", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function readinessFromPreflight(res) {
  if (!res?.items?.length) return null;
  const fail = res.items.filter(x => x.level === "fail").length;
  const warn = res.items.filter(x => x.level === "warn").length;
  const score = Math.max(0, Math.min(100, 100 - fail * 30 - warn * 6));
  return { score, fail, warn };
}

function renderReadiness(res = lastPreflightResult, at = lastPreflightAt) {
  const info = readinessFromPreflight(res);
  const scoreEl = $("readinessScore");
  const bar = $("readinessBar");
  if (!scoreEl || !bar) return;
  if (!info) {
    scoreEl.textContent = "—";
    bar.style.width = "0%";
    $("readinessText").textContent = "尚未執行開賣前健檢";
    $("lastPreflightText").textContent = "尚未執行";
    if ($("liveReadiness")) $("liveReadiness").textContent = "—";
    return;
  }
  scoreEl.textContent = String(info.score);
  if ($("liveReadiness")) $("liveReadiness").textContent = `${info.score}/100`;
  bar.style.width = `${info.score}%`;
  $("readinessText").textContent = info.fail ? `有 ${info.fail} 個必修正項目` : info.warn ? `可執行，但有 ${info.warn} 個提醒` : "健檢完整通過";
  $("lastPreflightText").textContent = at ? formatClock(at) : "剛剛";
}

function healthText(key, item) {
  const labels = { purchase: "購買", quantity: "數量", price: "價格" };
  const map = { unset: "未設定", ok: "正常", missing: "找不到", hidden: "目前隱藏", invalid: "格式錯誤" };
  return `${labels[key]}：${map[item?.state] || "未知"}`;
}

function renderSelectorHealth(health) {
  for (const [key, id] of [["purchase","healthPurchase"],["quantity","healthQuantity"],["price","healthPrice"]]) {
    const el = $(id);
    if (!el) continue;
    const item = health?.[key] || { state: "unset" };
    el.textContent = healthText(key, item);
    el.className = `health ${item.state || "unset"}`;
    el.title = item.configured ? `找到 ${item.count || 0} 個；可見 ${item.visible || 0} 個` : "未指定，會使用專用規則或通用辨識";
  }
}

function renderTransitions(items = pageTransitions) {
  const box = $("stateTimeline");
  if (!box) return;
  box.innerHTML = "";
  const rows = (Array.isArray(items) ? items : []).slice(0, 6);
  if (!rows.length) {
    box.innerHTML = '<div class="timeline-empty">尚無狀態變化</div>';
    return;
  }
  for (const item of rows) {
    const row = document.createElement("div");
    row.className = "timeline-row";
    const time = document.createElement("time");
    time.textContent = formatClock(item.ts);
    const body = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = item.label || item.phase || "狀態更新";
    const small = document.createElement("small");
    try { small.textContent = new URL(item.url || "").pathname || "/"; } catch (_) { small.textContent = item.url || ""; }
    body.append(title, small);
    row.append(time, body);
    box.appendChild(row);
  }
}

function applyPageState(item) {
  if (!item) return;
  const label = item.label || item.phase || "未知";
  $("pagePhaseText").textContent = label;
  if ($("livePhase")) $("livePhase").textContent = label;
  if (item.selectorHealth) renderSelectorHealth(item.selectorHealth);
}

async function refreshMissionCenter() {
  try {
    if (running && currentTabId) {
      const [ping, snap] = await Promise.all([
        chrome.runtime.sendMessage({ type: "QBA_PING_SESSION", tabId: currentTabId }).catch(() => null),
        chrome.runtime.sendMessage({ type: "QBA_GET_SNAPSHOT", tabId: currentTabId }).catch(() => null)
      ]);
      if (ping?.pagePhase) applyPageState({ ...ping.pagePhase, selectorHealth: ping.selectorHealth });
      if (snap?.runtime?.pageState) applyPageState(snap.runtime.pageState);
      if (snap?.runtime?.transitions) {
        pageTransitions = snap.runtime.transitions.slice(0, 100);
        renderTransitions();
      }
      if (snap?.runtime?.events) { replayEvents = snap.runtime.events.slice(0, 500); renderReplay(replayEvents, Number(snap?.session?.startedAt || 0)); }
      if (snap?.runtime?.networkSamples?.length) { networkSamples = snap.runtime.networkSamples.slice(0,120); renderNetwork(networkSamples[0]); }
    }
    renderReadiness();
  } catch (_) {}
}


const taskFieldIds = ["targetUrl","saleDate","saleTime","quantity","maxPrice","intervalMs","priorities","purchaseSelector","quantitySelector","priceSelector","operationMode","profileScope","platformProfileMode","ruleMode"];
async function getTasks() {
  const { qbaTaskTemplates = [] } = await chrome.storage.local.get("qbaTaskTemplates");
  return Array.isArray(qbaTaskTemplates) ? qbaTaskTemplates : [];
}
async function refreshTaskTemplates(selectedId = "") {
  const tasks = await getTasks();
  const sel = $("taskSelect");
  $("taskCountBadge").textContent = `${tasks.length} 任務`;
  sel.innerHTML = "";
  if (!tasks.length) {
    const o=document.createElement("option"); o.value=""; o.textContent="尚無任務模板"; sel.appendChild(o);
    $("loadTaskBtn").disabled=true; $("deleteTaskBtn").disabled=true; $("taskMeta").textContent="尚未選取任務"; return;
  }
  for (const t of tasks.sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0))) {
    const o=document.createElement("option"); o.value=t.id; o.textContent=`${t.name} · ${t.fields?.saleDate || "未定日期"} ${t.fields?.saleTime || ""}`.trim(); sel.appendChild(o);
  }
  if (selectedId && tasks.some(t=>t.id===selectedId)) sel.value=selectedId;
  $("loadTaskBtn").disabled=false; $("deleteTaskBtn").disabled=false;
  updateTaskMeta();
}
async function updateTaskMeta() {
  const tasks=await getTasks(), id=$("taskSelect")?.value || "", t=tasks.find(x=>x.id===id);
  if (!t) { $("taskMeta").textContent="尚未選取任務"; return; }
  let host=""; try { host=new URL(t.fields?.targetUrl||"").hostname; } catch (_) {}
  $("taskMeta").textContent=`${host || "未指定網站"} · 更新 ${new Date(t.updatedAt).toLocaleString("zh-TW",{hour12:false})} · 不含個人資料`;
  if (!$("taskName").value.trim()) $("taskName").value=t.name || "";
}
async function saveTaskTemplate() {
  const tasks=await getTasks();
  let name=$("taskName").value.trim();
  if (!name) {
    let host="任務"; try { host=new URL($("targetUrl").value.trim()).hostname; } catch (_) {}
    name=`${host} ${$("saleDate").value || "未定日期"}`;
    $("taskName").value=name;
  }
  const fields=Object.fromEntries(taskFieldIds.map(id=>[id,$(id).value]));
  const selected=$("taskSelect").value;
  let task=tasks.find(t=>t.id===selected) || tasks.find(t=>t.name===name);
  const now=Date.now();
  if (task) { task.name=name; task.fields=fields; task.updatedAt=now; }
  else { task={id:`task-${now}-${Math.random().toString(36).slice(2,7)}`,name,fields,createdAt:now,updatedAt:now}; tasks.unshift(task); }
  await chrome.storage.local.set({qbaTaskTemplates:tasks.slice(0,50)});
  await refreshTaskTemplates(task.id); addLog(`已儲存任務模板：${name}（不含個人資料）。`,"success");
}
async function loadTaskTemplate() {
  const tasks=await getTasks(), task=tasks.find(t=>t.id===$("taskSelect").value);
  if (!task) return;
  for (const id of taskFieldIds) if (id in (task.fields||{})) $(id).value=task.fields[id];
  $("taskName").value=task.name || "";
  clockOffsetMs=0; clockSyncOk=false; renderClockState(false,"任務已載入 · 建議重新同步網站時間");
  await saveFields(); await updateProfileLabel(); await updateRuleState(); await updateTaskMeta(); updateCountdown();
  addLog(`已載入任務模板：${task.name}`,"success");
}
async function deleteTaskTemplate() {
  const id=$("taskSelect").value; if (!id) return;
  const tasks=await getTasks(), task=tasks.find(t=>t.id===id);
  await chrome.storage.local.set({qbaTaskTemplates:tasks.filter(t=>t.id!==id)});
  $("taskName").value=""; await refreshTaskTemplates(); addLog(`已刪除任務模板：${task?.name || id}`,"warn");
}

function networkQuality(sample) {
  if (!sample?.ok) return {label:"連線異常", cls:"bad"};
  if (Number(sample.status) === 429) return {label:"探測受限", cls:"bad"};
  if (Number(sample.status) >= 500) return {label:"網站異常", cls:"bad"};
  const r=Number(sample.rttMs||0);
  if (r <= 300) return {label:"良好", cls:"good"};
  if (r <= 800) return {label:"普通", cls:"fair"};
  return {label:"偏慢", cls:"bad"};
}
function renderNetwork(sample=latestNetworkSample) {
  latestNetworkSample=sample || null;
  const state=$("networkState"), ms=$("networkRttText"), summary=$("networkStateText"), live=$("liveNetwork");
  if (!sample) {
    if(state){state.textContent="尚未測試 · 執行中每 10 秒低頻檢查一次"; state.className="clock-state";} if(ms)ms.textContent="—"; if(summary)summary.textContent="尚未測試"; if(live)live.textContent="未測"; return;
  }
  const q=networkQuality(sample), text=sample.ok ? `${q.label} · HTTP ${sample.status || "—"} · ${sample.rttMs} ms` : `異常 · ${sample.error || "無法連線"}`;
  if(state){state.textContent=text; state.className=`clock-state ${q.cls}`;} if(ms)ms.textContent=sample.ok?`${sample.rttMs} ms`:"失敗"; if(summary)summary.textContent=q.label; if(live)live.textContent=sample.ok?`${sample.rttMs} ms`:"異常";
}
async function probeNetwork(silent=false) {
  if (silent && networkAutoDisabled) return latestNetworkSample;
  const url=$("targetUrl").value.trim() || (await getActiveTab(false))?.url || "";
  if (!/^https?:/i.test(url)) { if(!silent)addLog("請先指定 http/https 目標網站。","warn"); return null; }
  try {
    const granted = await ensurePermission(url);
    if (!granted) throw new Error("沒有取得此網站的連線測試權限。");
    const res=await chrome.runtime.sendMessage({type:"QBA_NETWORK_PROBE",url,tabId:currentTabId});
    if (!res?.sample) throw new Error(res?.error || "網路測試失敗");
    const prevQuality = lastNetworkQuality;
    networkSamples=[res.sample,...networkSamples].slice(0,120); renderNetwork(res.sample);
    const q=networkQuality(res.sample); lastNetworkQuality=q.cls;
    if (Number(res.sample.status) === 429) {
      networkAutoDisabled = true;
      $("networkState").textContent = `探測受限 · HTTP 429 · 已停止自動網路探測`;
    }
    const now=Date.now();
    if (silent && q.cls === "bad" && (prevQuality !== "bad" || now-lastNetworkAlertAt > 60000)) {
      lastNetworkAlertAt=now;
      const msg=Number(res.sample.status)===429 ? "目標網站回覆 HTTP 429，QuickBuy 已停止自動網路探測，避免增加網站負擔。" : `目標網站連線異常或偏慢：${res.sample.ok ? `${res.sample.rttMs} ms / HTTP ${res.sample.status}` : (res.sample.error || "無法連線")}`;
      addLog(msg,"warn",now,true); playTone("urgent"); if(soundMode()==="voice") speak("目標網站連線異常，請注意網路狀態。");
      chrome.runtime.sendMessage({type:"QBA_NOTIFY",title:"QuickBuy 網路提醒",message:msg}).catch(()=>{});
    } else if (silent && prevQuality === "bad" && q.cls !== "bad") {
      addLog(`目標網站連線已恢復：${res.sample.rttMs} ms。`,"success",now,true); playTone("success");
    }
    if (!silent) { networkAutoDisabled = Number(res.sample.status)===429; addLog(res.sample.ok?`目標網站回應 ${res.sample.rttMs} ms。`:`目標網站連線異常：${res.sample.error || "未知"}`,q.cls==="bad"?"warn":"success"); }
    return res.sample;
  } catch(error) { const sample={ok:false,error:error.message,at:Date.now()}; const prevQuality=lastNetworkQuality; lastNetworkQuality="bad"; renderNetwork(sample); if(!silent)addLog(`網路測試失敗：${error.message}`,"error"); else if(prevQuality!=="bad"){ addLog(`目標網站網路測試失敗：${error.message}`,"warn",Date.now(),true); playTone("urgent"); } return sample; }
}

function renderReplay(events=replayEvents, startedAt=0) {
  const box=$("replayTimeline"), summary=$("replaySummary"); if(!box||!summary)return;
  const list=(events||[]).filter(e=>!startedAt || Number(e.ts||0)>=startedAt).sort((a,b)=>Number(b.ts||0)-Number(a.ts||0));
  if(!list.length){box.innerHTML='<div class="timeline-empty">啟動任務後會開始記錄</div>';summary.textContent="尚無本次任務事件";return;}
  const first=list[list.length-1], last=list[0], duration=Math.max(0,Number(last.ts||0)-Number(first.ts||0));
  const fmtDur=duration<1000?`${duration} ms`:duration<60000?`${(duration/1000).toFixed(1)} 秒`:`${Math.floor(duration/60000)}分 ${Math.floor((duration%60000)/1000)}秒`;
  summary.textContent=`${list.length} 個事件 · 跨度 ${fmtDur} · ${new Date(first.ts).toLocaleTimeString("zh-TW",{hour12:false})} → ${new Date(last.ts).toLocaleTimeString("zh-TW",{hour12:false})}`;
  box.innerHTML="";
  for(const e of list.slice(0,40)){
    const row=document.createElement("div"); row.className="replay-row";
    const time=document.createElement("time"); time.textContent=new Date(e.ts).toLocaleTimeString("zh-TW",{hour12:false});
    const kind=document.createElement("span"); kind.className=`replay-kind ${e.kind||"log"}`; kind.textContent=({status:"狀態",page:"頁面",network:"網路",log:"紀錄",session:"任務"})[e.kind]||e.kind||"事件";
    const txt=document.createElement("b"); txt.textContent=e.message || e.label || e.code || "事件";
    row.append(time,kind,txt); box.appendChild(row);
  }
}
async function refreshReplay() {
  if(!currentTabId){renderReplay([]);return;}
  const snap=await chrome.runtime.sendMessage({type:"QBA_GET_SNAPSHOT",tabId:currentTabId}).catch(()=>null);
  replayEvents=snap?.runtime?.events || replayEvents;
  networkSamples=snap?.runtime?.networkSamples || networkSamples;
  if(networkSamples.length) renderNetwork(networkSamples[0]);
  renderReplay(replayEvents, Number(snap?.session?.startedAt || snap?.runtime?.sessionStartedAt || 0));
}
async function exportReplay() {
  const snap=currentTabId?await chrome.runtime.sendMessage({type:"QBA_GET_SNAPSHOT",tabId:currentTabId}).catch(()=>null):null;
  const startedAt=Number(snap?.session?.startedAt || snap?.runtime?.sessionStartedAt || 0); const events=(snap?.runtime?.events||replayEvents).filter(e=>!startedAt||Number(e.ts||0)>=startedAt);
  const safe=sanitizeDiagnosticExport({app:"QuickBuy",version:QBA_APP_VERSION,exportedAt:new Date().toISOString(),sessionStartedAt:startedAt||null,targetUrl:safeUrlForExport($("targetUrl").value.trim()),events});
  downloadJson(`QuickBuy回放_${new Date().toISOString().replace(/[:.]/g,"-")}.json`,safe); addLog("已下載本次實戰回放（URL token / 個資已去識別化）。","success");
}

async function getRuleBackups() {
  const { qbaRuleBackups = [] } = await chrome.storage.local.get("qbaRuleBackups");
  return Array.isArray(qbaRuleBackups) ? qbaRuleBackups : [];
}

function stableRule(rule) {
  if (!rule) return "";
  const copy = JSON.parse(JSON.stringify(rule));
  delete copy.importedAt;
  delete copy.backupAt;
  return JSON.stringify(copy);
}

async function backupRule(rule, reason = "手動備份") {
  if (!rule || rule.builtin) return false;
  const backups = await getRuleBackups();
  const fingerprint = stableRule(rule);
  const latestSame = backups.find(x => x.ruleId === rule.id && stableRule(x.rule) === fingerprint);
  if (latestSame && Date.now() - Number(latestSame.savedAt || 0) < 30000) return false;
  backups.unshift({
    backupId: `${rule.id}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    ruleId: rule.id,
    name: rule.name,
    version: rule.version,
    reason,
    savedAt: Date.now(),
    rule: JSON.parse(JSON.stringify(rule))
  });
  await chrome.storage.local.set({ qbaRuleBackups: backups.slice(0, 40) });
  return true;
}

async function refreshRuleBackups() {
  const select = $("ruleBackupSelect");
  const count = $("ruleBackupCount");
  if (!select || !count) return;
  const backups = await getRuleBackups();
  count.textContent = `${backups.length} 備份`;
  select.innerHTML = "";
  if (!backups.length) {
    const opt = document.createElement("option"); opt.value = ""; opt.textContent = "尚無規則備份"; select.appendChild(opt);
    $("restoreRuleBackupBtn").disabled = true;
    return;
  }
  for (const b of backups) {
    const opt = document.createElement("option");
    opt.value = b.backupId;
    opt.textContent = `${b.name || b.ruleId} v${b.version || "?"} · ${new Date(b.savedAt).toLocaleString("zh-TW", { hour12:false })} · ${b.reason || "備份"}`;
    select.appendChild(opt);
  }
  $("restoreRuleBackupBtn").disabled = !select.value;
}

async function backupCurrentRule() {
  try {
    const url = await effectiveUrl();
    const rules = await getUserRules();
    const resolved = QBA_RULES.resolve(url, rules, "auto");
    if (resolved?.source !== "custom" || !resolved.rule) throw new Error("目前網站沒有專用規則可以備份。");
    await backupRule(resolved.rule, "手動備份");
    await refreshRuleBackups();
    addLog(`已備份規則：${resolved.rule.name} v${resolved.rule.version}`, "success");
  } catch (error) { addLog(error.message, "error"); }
}

async function restoreSelectedRuleBackup() {
  try {
    const id = $("ruleBackupSelect").value;
    if (!id) throw new Error("請先選擇要回復的規則版本。");
    const backups = await getRuleBackups();
    const backup = backups.find(x => x.backupId === id);
    if (!backup?.rule) throw new Error("找不到這份備份。");
    const rules = await getUserRules();
    const current = rules.find(r => r.id === backup.ruleId);
    if (current) await backupRule(current, "回復前自動備份");
    const restored = QBA_RULES.sanitizeRule(backup.rule);
    restored.importedAt = Date.now();
    const next = new Map(rules.map(r => [r.id, r]));
    next.set(restored.id, restored);
    await chrome.storage.local.set({ qbaRulePacks: [...next.values()].slice(0, 50) });
    await updateRuleState();
    await refreshRuleBackups();
    addLog(`已回復規則：${restored.name} v${restored.version}`, "success");
  } catch (error) { addLog(`規則回復失敗：${error.message}`, "error"); }
}

async function persistPreflight(res, at = Date.now()) {
  lastPreflightResult = res;
  lastPreflightAt = at;
  await chrome.storage.local.set({ qbaLastPreflight: { at, result: res } });
  renderReadiness(res, at);
}

async function restorePreflight() {
  try {
    const { qbaLastPreflight } = await chrome.storage.local.get("qbaLastPreflight");
    if (qbaLastPreflight?.result) {
      lastPreflightResult = qbaLastPreflight.result;
      lastPreflightAt = Number(qbaLastPreflight.at || 0);
      renderReadiness(lastPreflightResult, lastPreflightAt);
    }
  } catch (_) {}
}

function getSaleTimeTs() {
  const d = $("saleDate").value;
  const t = $("saleTime").value;
  if (!d || !t) return 0;
  const date = new Date(`${d}T${t}`);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function collectConfig() {
  return {
    targetUrl: QBA_PLATFORM_CATALOG.sanitizeTargetUrl($("targetUrl").value),
    saleTimeTs: getSaleTimeTs(),
    quantity: Number($("quantity").value || 1),
    maxPrice: Number($("maxPrice").value || 0),
    intervalMs: Number($("intervalMs").value || 1500),
    operationMode: $("operationMode").value === "dry" ? "dry" : "live",
    ruleMode: $("ruleMode")?.value || "auto",
    platformProfileMode: $("platformProfileMode")?.value || "auto",
    clockOffsetMs,
    clockMeta: { syncedAt: clockSyncedAt, rttMs: clockRttMs, jitterMs: clockJitterMs, uncertaintyMs: clockUncertaintyMs, quality: clockQuality, samples: clockSamples },
    targetOrigin: (() => { try { const u = $("targetUrl").value.trim(); return u ? new URL(u).origin : ""; } catch (_) { return ""; } })(),
    priorities: $("priorities").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
    purchaseSelector: $("purchaseSelector").value.trim(),
    quantitySelector: $("quantitySelector").value.trim(),
    priceSelector: $("priceSelector").value.trim(),
    profile: {
      name: $("profileName").value.trim(),
      email: $("profileEmail").value.trim(),
      phone: $("profilePhone").value.trim(),
      address: $("profileAddress").value.trim()
    }
  };
}


function formatMissionTime(ts) {
  if (!Number(ts)) return "—";
  return new Date(Number(ts)).toLocaleString("zh-TW", { hour12:false });
}

async function refreshArmedMission() {
  const res = await chrome.runtime.sendMessage({ type:"QBA_GET_ARMED_MISSION" }).catch(() => null);
  const mission = res?.mission || null;
  const last = res?.lastResult || null;
  const badge = $("armedMissionBadge"), box = $("armedMissionState"), disarm = $("disarmMissionBtn");
  if (!badge || !box || !disarm) return;
  if (mission) {
    badge.textContent = "已設定";
    badge.className = "rule-count good";
    box.textContent = `預計 ${formatMissionTime(mission.startAt)} 開啟目標頁 · 開賣 ${formatMissionTime(mission.saleTimeTs)}`;
    disarm.disabled = false;
  } else {
    badge.textContent = "未設定";
    badge.className = "rule-count neutral";
    disarm.disabled = true;
    if (last?.state === "launched") box.textContent = `最近提醒已執行${last.at ? ` · ${formatMissionTime(last.at)}` : ""}`;
    else if (last?.state === "missed") box.textContent = "最近提醒已逾時，未自動開啟頁面。";
    else box.textContent = "尚未設定開賣提醒";
  }
}


async function armCurrentMission() {
  const btn = $("armMissionBtn");
  try {
    if (btn) { btn.disabled = true; btn.textContent = "設定中…"; }
    await saveFields();
    const cfg = collectConfig();
    if (!cfg.targetUrl || !/^https?:/i.test(cfg.targetUrl)) throw new Error("請先設定有效的目標網站。");
    if (!cfg.saleTimeTs || cfg.saleTimeTs <= Date.now()) throw new Error("請先設定未來的開賣時間。");
    const leadSec = Math.max(30, Number($("missionLeadSec")?.value || 300));
    const graceSec = Math.max(0, Number($("missionGraceSec")?.value || 120));
    const res = await chrome.runtime.sendMessage({ type:"QBA_ARM_MISSION", config:cfg, leadSec, graceSec });
    if (!res?.ok) throw new Error(res?.error || "提醒設定失敗。");
    addLog(`開賣提醒已設定：${formatMissionTime(res.mission?.startAt)} 開啟目標頁。`, "success");
    await refreshArmedMission();
  } catch (error) {
    addLog(`設定提醒失敗：${error.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "設定開賣提醒"; }
  }
}

async function disarmCurrentMission() {
  const res = await chrome.runtime.sendMessage({ type:"QBA_DISARM_MISSION" }).catch(error => ({ ok:false, error:error.message }));
  if (res?.ok) addLog(res.hadMission ? "已取消開賣提醒。" : "目前沒有已設定的提醒。", "warn");
  else addLog(`取消提醒失敗：${res?.error || "未知錯誤"}`, "error");
  await refreshArmedMission();
}


async function getUserRules() {
  const { qbaRulePacks = [] } = await chrome.storage.local.get("qbaRulePacks");
  return Array.isArray(qbaRulePacks) ? qbaRulePacks : [];
}

async function getPlatformProfiles() {
  const { qbaPlatformProfiles = [] } = await chrome.storage.local.get("qbaPlatformProfiles");
  return Array.isArray(qbaPlatformProfiles) ? qbaPlatformProfiles : [];
}

async function getPlatformProfileBackups() {
  const { qbaPlatformProfileBackups = [] } = await chrome.storage.local.get("qbaPlatformProfileBackups");
  return Array.isArray(qbaPlatformProfileBackups) ? qbaPlatformProfileBackups : [];
}

function stablePlatformProfile(profile) {
  if (!profile) return "";
  const copy = JSON.parse(JSON.stringify(profile));
  delete copy.importedAt; delete copy.backupAt;
  return JSON.stringify(copy);
}

async function backupPlatformProfile(profile, reason = "自動備份") {
  if (!profile) return false;
  const backups = await getPlatformProfileBackups();
  const fingerprint = stablePlatformProfile(profile);
  const recent = backups.find(x => x.profileId === profile.id && stablePlatformProfile(x.profile) === fingerprint);
  if (recent && Date.now() - Number(recent.savedAt || 0) < 30000) return false;
  backups.unshift({
    backupId: `${profile.id}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    profileId: profile.id, name: profile.name, version: profile.version, reason, savedAt: Date.now(),
    profile: JSON.parse(JSON.stringify(profile))
  });
  await chrome.storage.local.set({ qbaPlatformProfileBackups: backups.slice(0, 30) });
  return true;
}

async function resolvePlatformProfile(url, mode = null) {
  if (!globalThis.QBA_PROFILES || !url || !/^https?:/i.test(url)) return { profile:null, score:-Infinity, matches:[] };
  const profiles = await getPlatformProfiles();
  return QBA_PROFILES.resolve(url, profiles, mode || $("platformProfileMode")?.value || "auto");
}

async function refreshPlatformProfileBackups() {
  const select = $("platformProfileBackupSelect"), count = $("platformProfileBackupCount");
  if (!select || !count) return;
  const backups = await getPlatformProfileBackups();
  count.textContent = `${backups.length} 備份`;
  select.innerHTML = "";
  if (!backups.length) {
    const o=document.createElement("option"); o.value=""; o.textContent="尚無 Profile 備份"; select.appendChild(o);
    $("restorePlatformProfileBackupBtn").disabled = true; return;
  }
  for (const b of backups) {
    const o=document.createElement("option"); o.value=b.backupId;
    o.textContent=`${b.name || b.profileId} v${b.version || "?"} · ${new Date(b.savedAt).toLocaleString("zh-TW",{hour12:false})} · ${b.reason || "備份"}`;
    select.appendChild(o);
  }
  $("restorePlatformProfileBackupBtn").disabled = !select.value;
}

async function refreshPlatformProfileCenter(preferredId = "") {
  const profiles = globalThis.QBA_PROFILES ? QBA_PROFILES.normalizeCatalog(await getPlatformProfiles()) : [];
  const sel=$("platformProfileSelect"), count=$("platformProfileCount");
  if (!sel || !count) return;
  const enabled=profiles.filter(p=>p.enabled!==false).length;
  count.textContent=`${enabled}/${profiles.length} Profile`; count.className=`rule-count ${enabled?"active":""}`;
  const before=preferredId || sel.value; sel.innerHTML="";
  if (!profiles.length) {
    const o=document.createElement("option");o.value="";o.textContent="尚無 Profile";sel.appendChild(o);
  } else {
    for (const p of profiles.sort((a,b)=>String(a.name).localeCompare(String(b.name),"zh-Hant"))) {
      const o=document.createElement("option");o.value=p.id;o.textContent=`${p.enabled===false?"⏸ ":""}${p.name} v${p.version}`;sel.appendChild(o);
    }
  }
  let url=""; try { url=await effectiveUrl(); } catch (_) {}
  const resolved = url ? QBA_PROFILES.resolve(url, profiles, $("platformProfileMode")?.value || "auto") : {profile:null,matches:[]};
  if (before && profiles.some(p=>p.id===before)) sel.value=before;
  else if (resolved.profile) sel.value=resolved.profile.id;
  const selected=profiles.find(p=>p.id===sel.value) || null;
  const has=!!selected;
  $("exportPlatformProfileBtn").disabled=!has; $("togglePlatformProfileBtn").disabled=!has; $("deletePlatformProfileBtn").disabled=!has;
  if (has) {
    $("platformProfileMeta").textContent=`v${selected.version} · ${selected.enabled!==false?"啟用":"停用"} · P${selected.priority}`;
    $("platformProfileCapabilities").textContent=(selected.capabilities||[]).join(" / ") || "未標示";
    $("togglePlatformProfileBtn").textContent=selected.enabled===false?"啟用 Profile":"停用 Profile";
  } else {
    $("platformProfileMeta").textContent="—"; $("platformProfileCapabilities").textContent="—"; $("togglePlatformProfileBtn").textContent="停用 / 啟用";
  }
  const state=$("platformProfileState"), conflict=$("platformProfileConflicts");
  if ($("platformProfileMode")?.value === "off") {
    state.textContent="Profile 已關閉 · 使用原本規則鏈"; state.className="profile-state generic";
    conflict.textContent="Profile 模式已關閉"; conflict.className="profile-conflict";
  } else if (resolved.profile) {
    state.textContent=`${new URL(url).hostname} · ${resolved.profile.name} v${resolved.profile.version}`; state.className="profile-state custom";
    if ((resolved.matches||[]).length > 1) {
      conflict.textContent=`⚠️ 同時命中 ${resolved.matches.length} 個 Profile；已依網域/路徑精準度與 priority 選用「${resolved.profile.name}」。`; conflict.className="profile-conflict warn";
    } else { conflict.textContent="Profile 唯一命中，沒有衝突。"; conflict.className="profile-conflict good"; }
  } else {
    state.textContent = url && /^https?:/i.test(url) ? `${new URL(url).hostname} · 沒有匹配 Profile` : "尚未指定網站"; state.className="profile-state";
    conflict.textContent="沒有匹配 Profile，會回退到專用規則 / 網站設定檔 / 通用辨識。"; conflict.className="profile-conflict";
  }
}

async function exportPlatformProfileTemplate() {
  try {
    const url=await effectiveUrl(); const profile=QBA_PROFILES.makeTemplate(url);
    downloadJson(`QuickBuy_Profile範本_${profile.match.hosts[0].replace(/[^a-z0-9.-]/gi,"-")}.json`,{app:"QuickBuy",schemaVersion:1,profiles:[profile]});
    addLog("已產生平台 Profile 範本；只包含宣告式設定，不含可執行 JavaScript。","success");
  } catch (error) { addLog(error.message,"error"); }
}

async function importPlatformProfile(file) {
  try {
    const data=JSON.parse(await file.text()); const pack=QBA_PROFILES.validatePack(data); const current=await getPlatformProfiles();
    const map=new Map(current.map(p=>[p.id,p]));
    for (const p of pack.profiles) { const old=map.get(p.id); if(old) await backupPlatformProfile(old,"匯入新版前自動備份"); map.set(p.id,{...p,importedAt:Date.now()}); }
    await chrome.storage.local.set({qbaPlatformProfiles:[...map.values()].slice(0,50)});
    await refreshPlatformProfileCenter(pack.profiles[0]?.id || ""); await refreshPlatformProfileBackups(); await updateRuleState();
    addLog(`已匯入 ${pack.profiles.length} 個平台 Profile${pack.profiles.some(p=>current.some(x=>x.id===p.id))?"；舊版已放入保險箱":""}。`,"success");
  } catch (error) { addLog(`Profile 匯入失敗：${error.message}`,"error"); } finally { if($("platformProfileImportFile")) $("platformProfileImportFile").value=""; }
}

async function exportSelectedPlatformProfile() {
  const profiles=await getPlatformProfiles(), p=profiles.find(x=>x.id===$("platformProfileSelect").value);
  if(!p) return addLog("請先選擇 Profile。","warn");
  const safe=QBA_PROFILES.sanitizeProfile(p);
  downloadJson(`QuickBuy_Profile_${safe.id}_${safe.version}.json`,{app:"QuickBuy",schemaVersion:1,profiles:[safe]});
  addLog(`已匯出 Profile：${safe.name} v${safe.version}`,"success");
}

async function toggleSelectedPlatformProfile() {
  try {
    const id=$("platformProfileSelect").value, profiles=await getPlatformProfiles(), idx=profiles.findIndex(p=>p.id===id);
    if(idx<0) throw new Error("請先選擇 Profile。");
    await backupPlatformProfile(profiles[idx], profiles[idx].enabled===false?"啟用前備份":"停用前備份");
    profiles[idx]={...profiles[idx],enabled:profiles[idx].enabled===false,importedAt:Date.now()};
    await chrome.storage.local.set({qbaPlatformProfiles:profiles}); await refreshPlatformProfileCenter(id); await refreshPlatformProfileBackups(); await updateRuleState();
    addLog(`${profiles[idx].enabled!==false?"已啟用":"已停用"} Profile：${profiles[idx].name}`,profiles[idx].enabled!==false?"success":"warn");
  } catch(error){ addLog(error.message,"error"); }
}

async function deleteSelectedPlatformProfile() {
  try {
    const id=$("platformProfileSelect").value, profiles=await getPlatformProfiles(), p=profiles.find(x=>x.id===id); if(!p) throw new Error("請先選擇 Profile。");
    await backupPlatformProfile(p,"刪除前自動備份"); await chrome.storage.local.set({qbaPlatformProfiles:profiles.filter(x=>x.id!==id)});
    await refreshPlatformProfileCenter(); await refreshPlatformProfileBackups(); await updateRuleState(); addLog(`已刪除 Profile：${p.name}；版本已保留在保險箱。`,"warn");
  } catch(error){addLog(error.message,"error");}
}

async function restoreSelectedPlatformProfileBackup() {
  try {
    const id=$("platformProfileBackupSelect").value; if(!id) throw new Error("請先選擇要回復的 Profile 版本。");
    const backups=await getPlatformProfileBackups(), b=backups.find(x=>x.backupId===id); if(!b?.profile) throw new Error("找不到這份 Profile 備份。");
    const profiles=await getPlatformProfiles(), current=profiles.find(x=>x.id===b.profileId); if(current) await backupPlatformProfile(current,"回復前自動備份");
    const restored=QBA_PROFILES.sanitizeProfile(b.profile); restored.importedAt=Date.now(); const map=new Map(profiles.map(x=>[x.id,x])); map.set(restored.id,restored);
    await chrome.storage.local.set({qbaPlatformProfiles:[...map.values()].slice(0,50)}); await refreshPlatformProfileCenter(restored.id); await refreshPlatformProfileBackups(); await updateRuleState();
    addLog(`已回復 Profile：${restored.name} v${restored.version}`,"success");
  } catch(error){addLog(`Profile 回復失敗：${error.message}`,"error");}
}

async function attachSiteRule(config, urlString = "") {
  const url = urlString || config?.targetUrl || await effectiveUrl();
  if (!url || !/^https?:/i.test(url) || !globalThis.QBA_RULES) return config;
  if (globalThis.QBA_PROFILES && (config.platformProfileMode || "auto") !== "off") {
    const profiles = await getPlatformProfiles();
    const pr = QBA_PROFILES.resolve(url, profiles, config.platformProfileMode || "auto");
    if (pr?.profile) {
      config.siteRule = pr.profile.rule || null;
      config.siteRuleMeta = { id: pr.profile.id, name: pr.profile.name, version: pr.profile.version, source: "profile", score: pr.score, matches: pr.matches?.length || 1 };
      config.platformProfileMeta = { id: pr.profile.id, name: pr.profile.name, version: pr.profile.version, capabilities: pr.profile.capabilities || [], conflicts: Math.max(0,(pr.matches?.length || 1)-1) };
      return config;
    }
  }
  const rules = await getUserRules();
  const resolved = QBA_RULES.resolve(url, rules, config.ruleMode || "auto");
  config.siteRule = resolved?.rule || null;
  config.siteRuleMeta = resolved?.rule ? { id: resolved.rule.id, name: resolved.rule.name, version: resolved.rule.version, source: resolved.source, score: resolved.score } : null;
  config.platformProfileMeta = null;
  return config;
}

async function updateRuleState() {
  const stateEl = $("ruleState");
  const countEl = $("ruleCountBadge");
  if (!stateEl || !countEl || !globalThis.QBA_RULES) return;
  const rules = await getUserRules();
  const enabled = rules.filter(r => r?.enabled !== false).length;
  countEl.textContent = `${enabled} 專用`;
  countEl.className = `rule-count ${enabled ? "active" : ""}`;
  try {
    const url = await effectiveUrl();
    if (!url || !/^https?:/i.test(url)) {
      stateEl.textContent = "尚未指定網站 · 將使用通用辨識";
      stateEl.className = "profile-state generic";
      return;
    }
    const profileResolved = globalThis.QBA_PROFILES ? await resolvePlatformProfile(url) : {profile:null};
    if (profileResolved?.profile) {
      stateEl.textContent = `${new URL(url).hostname} · 由 Profile「${profileResolved.profile.name}」接管`;
      stateEl.className = "profile-state custom";
    } else {
      const mode = $("ruleMode")?.value || "auto";
      const resolved = QBA_RULES.resolve(url, rules, mode);
      const rule = resolved?.rule;
      if (resolved?.source === "custom" && rule) {
        stateEl.textContent = `${new URL(url).hostname} · ${rule.name} v${rule.version}`;
        stateEl.className = "profile-state custom";
      } else {
        stateEl.textContent = `${new URL(url).hostname} · QuickBuy 通用辨識`;
        stateEl.className = "profile-state generic";
      }
    }
  } catch (_) {
    stateEl.textContent = "網址格式尚未完成 · 通用辨識";
    stateEl.className = "profile-state generic";
  }
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportRuleTemplate() {
  try {
    const url = await effectiveUrl();
    const rule = QBA_RULES.makeTemplate(url);
    downloadJson(`QuickBuy規則範本_${rule.match.hosts[0].replace(/[^a-z0-9.-]/gi,"-")}.json`, { app: "QuickBuy", schemaVersion: 1, rules: [rule] });
    addLog("已產生宣告式規則範本。規則檔不包含可執行 JavaScript。", "success");
  } catch (error) { addLog(error.message, "error"); }
}

async function importRulePack(file) {
  try {
    const data = JSON.parse(await file.text());
    const pack = QBA_RULES.validatePack(data);
    const current = await getUserRules();
    const map = new Map(current.map(r => [r.id, r]));
    for (const rule of pack.rules) {
      const previous = map.get(rule.id);
      if (previous) await backupRule(previous, "匯入新版前自動備份");
      map.set(rule.id, { ...rule, importedAt: Date.now() });
    }
    const merged = [...map.values()].slice(0, 50);
    await chrome.storage.local.set({ qbaRulePacks: merged });
    addLog(`已匯入 ${pack.rules.length} 組專用規則；舊版本已自動保留。`, "success");
    await updateRuleState();
    await refreshRuleBackups();
  } catch (error) { addLog(`規則匯入失敗：${error.message}`, "error"); }
}

async function deleteCurrentRule() {
  try {
    const url = await effectiveUrl();
    if (!url || !/^https?:/i.test(url)) throw new Error("請先指定網站。");
    const current = await getUserRules();
    const resolved = QBA_RULES.resolve(url, current, "auto");
    if (resolved?.source !== "custom" || !resolved.rule) {
      addLog("目前網站正在使用通用辨識，沒有專用規則可移除。", "warn");
      return;
    }
    await backupRule(resolved.rule, "刪除前自動備份");
    const next = current.filter(r => r.id !== resolved.rule.id);
    await chrome.storage.local.set({ qbaRulePacks: next });
    addLog(`已移除專用規則：${resolved.rule.name}；舊版本已放入保險箱。`, "warn");
    await updateRuleState();
    await refreshRuleBackups();
  } catch (error) { addLog(error.message, "error"); }
}

let qbaFieldsSaveTail = Promise.resolve();
async function saveFields() {
  const data = {};
  for (const id of fieldIds) data[id] = $(id).value;
  data.targetUrl = QBA_PLATFORM_CATALOG.sanitizeTargetUrl(data.targetUrl);
  qbaFieldsSaveTail = qbaFieldsSaveTail.catch(() => {}).then(() => chrome.storage.local.set({ qbaFields: data }));
  await qbaFieldsSaveTail;
  updateProfileLabel();
  refreshPlatformProfileCenter();
  updateRuleState();
}

async function loadFields() {
  const { qbaFields } = await chrome.storage.local.get("qbaFields");
  if (qbaFields) {
    for (const id of fieldIds) if (id in qbaFields) $(id).value = qbaFields[id];
  } else {
    const now = localDateParts();
    $("saleDate").value = now.date;
    $("saleTime").value = "12:00:00";
  }
}


const sensitiveFieldIds = new Set(["profileName", "profileEmail", "profilePhone", "profileAddress"]);

function safeUrlForExport(urlString = "") {
  try { const u = new URL(urlString); return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname || "/"}` : ""; }
  catch (_) { return ""; }
}

const qbaExportForbiddenKeys = new Set([
  "profileName", "profileEmail", "profilePhone", "profileAddress", "password", "passwd", "otp", "cvv", "cvc", "cardNumber", "creditCard", "authorization"
]);

function redactSensitiveText(value = "") {
  let text = String(value ?? "");
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, match => safeUrlForExport(match) || "[REDACTED_URL]");
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
  text = text.replace(/(?:\+?886[-\s]?)?0?9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, "[REDACTED_PHONE]");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]");
  text = text.replace(/\b(token|session|sessionid|auth|access[_-]?token|refresh[_-]?token|code)=([^\s&]+)/gi, "$1=[REDACTED]");
  return text;
}

function sanitizeDiagnosticExport(value, key = "", depth = 0) {
  if (depth > 12) return null;
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  const keyLower = String(key || "").toLowerCase();
  if (qbaExportForbiddenKeys.has(key) || /^(password|passwd|otp|cvv|cvc|cardnumber|creditcard|authorization)$/i.test(keyLower)) return undefined;
  if (typeof value === "string") {
    if (/(^|_)(url|href|src|action)$/i.test(key) || /url$/i.test(key) || keyLower === "targeturl") return safeUrlForExport(value) || redactSensitiveText(value);
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) return value.map((x, i) => sanitizeDiagnosticExport(x, String(i), depth + 1)).filter(x => x !== undefined);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (qbaExportForbiddenKeys.has(k) || /^(password|passwd|otp|cvv|cvc|cardnumber|creditcard|authorization)$/i.test(k)) continue;
      const next = sanitizeDiagnosticExport(v, k, depth + 1);
      if (next !== undefined) out[k] = next;
    }
    return out;
  }
  return null;
}

function safeStoredFields(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) if (!sensitiveFieldIds.has(key)) out[key] = value;
  if (out.targetUrl) out.targetUrl = QBA_PLATFORM_CATALOG.sanitizeTargetUrl(out.targetUrl);
  return out;
}

function sanitizeArchiveForExport(item = {}) {
  const copy = JSON.parse(JSON.stringify(item || {}));
  if (copy.config?.targetUrl) copy.config.targetUrl = safeUrlForExport(copy.config.targetUrl);
  if (copy.finalPageState?.url) copy.finalPageState.url = safeUrlForExport(copy.finalPageState.url);
  if (Array.isArray(copy.transitions)) copy.transitions = copy.transitions.map(x => ({...x, url: safeUrlForExport(x?.url || "")}));
  return sanitizeDiagnosticExport(copy);
}

async function migrateStorageV2() {
  const all = await chrome.storage.local.get(null);
  if (Number(all.qbaStorageSchema || 0) >= QBA_STORAGE_SCHEMA) return false;
  const patch = { qbaStorageSchema: QBA_STORAGE_SCHEMA, qbaMigratedAt: Date.now() };
  if (!Array.isArray(all.qbaTaskTemplates)) patch.qbaTaskTemplates = [];
  if (!Array.isArray(all.qbaRulePacks)) patch.qbaRulePacks = [];
  if (!Array.isArray(all.qbaPlatformProfiles)) patch.qbaPlatformProfiles = [];
  if (!Array.isArray(all.qbaRunArchives)) patch.qbaRunArchives = [];
  if (!all.qbaSiteProfiles || typeof all.qbaSiteProfiles !== "object" || Array.isArray(all.qbaSiteProfiles)) patch.qbaSiteProfiles = {};
  await chrome.storage.local.set(patch);
  return true;
}


async function getSyncState() {
  const { qbaSyncState = {} } = await chrome.storage.local.get('qbaSyncState');
  const state = QBASyncCore.normalizeState(qbaSyncState || {});
  if (!qbaSyncState?.deviceId) await chrome.storage.local.set({ qbaSyncState: state });
  return state;
}
function shortDeviceId(id='') { return String(id).replace(/^qbd_/,'').slice(0,8) || '—'; }
function fmtSyncTime(ts=0) { return Number(ts||0) ? new Date(Number(ts)).toLocaleString('zh-TW',{hour12:false}) : '尚未'; }
function syncJournalLabel(entry={}) {
  const labels={export:'匯出同步封包',import:'匯入同步封包','import-skip':'略過舊 Revision'};
  return labels[String(entry.kind||'')] || String(entry.kind||'同步活動');
}
function renderSyncJournal(state={}) {
  const rows=Array.isArray(state.journal)?state.journal.slice(0,6):[];
  if ($('syncJournalCount')) $('syncJournalCount').textContent=String(Array.isArray(state.journal)?state.journal.length:0);
  if ($('syncLastAction')) $('syncLastAction').textContent=rows[0]?`${syncJournalLabel(rows[0])} · ${fmtSyncTime(rows[0].at)}`:'尚未';
  const remote=rows.find(x=>x?.sourceDeviceId);
  if ($('syncLastRemote')) $('syncLastRemote').textContent=remote?.sourceDeviceId?shortDeviceId(remote.sourceDeviceId):'—';
  const host=$('syncActivityList'); if(!host) return;
  host.innerHTML=rows.length?rows.map(x=>`<div class="sync-activity-row"><i>${x.kind==='import'?'↓':x.kind==='export'?'↑':'•'}</i><span>${escapeHtml(syncJournalLabel(x))}${x.sourceDeviceId?` · ${escapeHtml(shortDeviceId(x.sourceDeviceId))}`:''}</span><b>${escapeHtml(fmtSyncTime(x.at))}</b></div>`).join(''):'<div class="preflight-empty">尚無同步活動</div>';
}
async function clearSyncConflicts(){
  const state=await getSyncState(); state.conflicts=[]; state.journal=[{at:Date.now(),kind:'conflicts-cleared'},...(state.journal||[])].slice(0,200); await chrome.storage.local.set({qbaSyncState:state}); await refreshSyncCenter('衝突紀錄已清除；同步資料本身未刪除。');
}
async function refreshSyncCenter(message='') {
  const state = await getSyncState();
  if ($('syncDeviceName')) $('syncDeviceName').textContent = state.deviceName || '未命名';
  if ($('syncDeviceId')) $('syncDeviceId').textContent = shortDeviceId(state.deviceId);
  if ($('syncRevision')) $('syncRevision').textContent = String(state.revision || 0);
  if ($('syncLastExport')) $('syncLastExport').textContent = fmtSyncTime(state.lastExportAt);
  if ($('syncLastImport')) $('syncLastImport').textContent = fmtSyncTime(state.lastImportAt);
  if ($('syncConflictCount')) $('syncConflictCount').textContent = String((state.conflicts||[]).length);
  if ($('syncClearConflictBtn')) $('syncClearConflictBtn').disabled = !(state.conflicts||[]).length;
  renderSyncJournal(state);
  if ($('syncDeviceNameInput') && document.activeElement !== $('syncDeviceNameInput')) $('syncDeviceNameInput').value = state.deviceName || '';
  if ($('syncStateBadge')) { $('syncStateBadge').textContent = (state.conflicts||[]).length ? `衝突 ${(state.conflicts||[]).length}` : '本機模式'; $('syncStateBadge').className = `rule-count ${(state.conflicts||[]).length?'warn':'neutral'}`; }
  if (message && $('syncStatusBox')) $('syncStatusBox').innerHTML = `<div class="preflight-empty">${escapeHtml(message)}</div>`;
  return state;
}
async function saveSyncDeviceName() {
  const state = await getSyncState();
  state.deviceName = String($('syncDeviceNameInput')?.value || '').trim().slice(0,80);
  await chrome.storage.local.set({qbaSyncState:state});
  await refreshSyncCenter('裝置名稱已儲存。'); addLog('已更新跨裝置同步的裝置名稱。','success');
}
async function exportSyncBundle() {
  try {
    const passphrase = String($('syncPassphrase')?.value || '');
    if (passphrase.length < 10) throw new Error('請先輸入至少 10 個字元的同步密語。');
    const all = await chrome.storage.local.get(null), state = await getSyncState();
    const result = await QBASyncCore.createBundle(all, state, QBA_APP_VERSION);
    const envelope = await QBASyncCrypto.encryptBundle(result.bundle, passphrase);
    await chrome.storage.local.set({qbaSyncState:result.state});
    downloadJson(`QuickBuy加密同步封包_${(result.state.deviceName||shortDeviceId(result.state.deviceId)).replace(/[^\w\-\u4e00-\u9fff]+/g,'_')}_${new Date().toISOString().slice(0,10)}.json`, envelope);
    await refreshSyncCenter(`加密同步封包已建立 · Revision ${result.bundle.revision} · Fingerprint ${result.bundle.fingerprint.slice(0,12)}…`);
    addLog('已匯出跨裝置安全同步封包。','success');
  } catch(error) { addLog(`同步封包匯出失敗：${error.message}`,'error'); }
}
async function importSyncBundle(file) {
  try {
    const raw = JSON.parse(await file.text());
    const passphrase = String($('syncPassphrase')?.value || '');
    const bundle = raw?.format === QBASyncCrypto.FORMAT ? await QBASyncCrypto.decryptEnvelope(raw, passphrase) : raw;
    const all = await chrome.storage.local.get(null), state = await getSyncState();
    const result = await QBASyncCore.importBundle(all, state, bundle);
    await createRepairRecoveryPoint('跨裝置同步匯入前自動復原點');
    if (Object.keys(result.patch).length) await chrome.storage.local.set({...result.patch,qbaStorageSchema:QBA_STORAGE_SCHEMA});
    await chrome.storage.local.set({qbaSyncState:result.state});
    await refreshTaskTemplates(); await refreshPlatformProfileCenter(); await refreshPlatformProfileBackups(); await refreshProfileLabProfiles(); await updateRuleState(); await refreshRuleBackups();
    await refreshSyncCenter(result.skipped ? '同裝置較舊 Revision，已安全略過。' : `同步封包已合併；衝突 ${result.conflicts.length}。`);
    addLog(result.skipped?'同步封包版本未更新，已略過。':`已合併跨裝置同步封包；衝突 ${result.conflicts.length}。`, result.conflicts.length?'warn':'success');
  } catch(error) { addLog(`同步封包匯入失敗：${error.message}`,'error'); }
  finally { if ($('syncImportFile')) $('syncImportFile').value=''; }
}


async function getSyncProviderConfig() {
  const raw = await chrome.storage.local.get([QBASyncProvider.CONFIG_KEY, QBASyncProvider.STATE_KEY]);
  return {
    config: QBASyncProvider.normalizeConfig(raw[QBASyncProvider.CONFIG_KEY] || {}),
    providerState: QBASyncProvider.normalizeState(raw[QBASyncProvider.STATE_KEY] || {})
  };
}
async function refreshSyncProvider(message='') {
  const {config, providerState} = await getSyncProviderConfig();
  if ($('syncRelayEndpoint') && document.activeElement !== $('syncRelayEndpoint')) $('syncRelayEndpoint').value = config.endpoint || '';
  if ($('syncRelayRoom') && document.activeElement !== $('syncRelayRoom')) $('syncRelayRoom').value = config.roomId || '';
  if ($('syncRelayKey') && document.activeElement !== $('syncRelayKey')) $('syncRelayKey').value = config.accessKey || '';
  if ($('syncRelayRoomPreview')) $('syncRelayRoomPreview').textContent = config.roomId ? `${config.roomId.slice(0,8)}…${config.roomId.slice(-4)}` : '—';
  const last = Math.max(providerState.lastPullAt||0, providerState.lastPushAt||0);
  if ($('syncCloudLast')) $('syncCloudLast').textContent = fmtSyncTime(last);
  if ($('syncCloudBadge')) {
    $('syncCloudBadge').textContent = config.endpoint && config.roomId && config.accessKey ? (providerState.lastError ? '需檢查' : '已設定') : '未設定';
    $('syncCloudBadge').className = `rule-count ${providerState.lastError ? 'warn' : (config.endpoint ? 'good':'neutral')}`;
  }
  if (message) await refreshSyncCenter(message);
}
async function saveSyncProviderConfig() {
  try {
    const draft = QBASyncProvider.validateConfig({
      enabled:true,
      endpoint:String($('syncRelayEndpoint')?.value||'').trim(),
      roomId:String($('syncRelayRoom')?.value||'').trim(),
      accessKey:String($('syncRelayKey')?.value||'').trim(),
      pollSeconds:30
    });
    const granted = await QBASyncProvider.requestOriginPermission(draft.endpoint);
    if (!granted) throw new Error('未授權 Relay 網域存取權限。');
    await chrome.storage.local.set({[QBASyncProvider.CONFIG_KEY]:draft});
    await refreshSyncProvider('Relay 設定已保存在本裝置；不會放進跨裝置同步資料。');
    addLog('已儲存零知識 Relay Provider 設定。','success');
  } catch(error) { addLog(`Relay 設定失敗：${error.message}`,'error'); await refreshSyncCenter(`Relay 設定失敗：${error.message}`); }
}
async function generateSyncProviderPair() {
  const pair = QBASyncProvider.makePairing();
  if ($('syncRelayRoom')) $('syncRelayRoom').value = pair.roomId;
  if ($('syncRelayKey')) $('syncRelayKey').value = pair.accessKey;
  await refreshSyncCenter('已產生新的 Room ID / Relay Access Key；請儲存後再在其他裝置輸入相同資料。');
}
async function testSyncProvider() {
  try {
    const draft = QBASyncProvider.validateConfig({
      enabled:true, endpoint:String($('syncRelayEndpoint')?.value||'').trim(),
      roomId:String($('syncRelayRoom')?.value||'').trim(), accessKey:String($('syncRelayKey')?.value||'').trim()
    });
    const granted = await QBASyncProvider.requestOriginPermission(draft.endpoint); if(!granted) throw new Error('未授權 Relay 網域。');
    const h = await QBASyncProvider.health(draft);
    const {providerState} = await getSyncProviderConfig(); providerState.lastHealthAt=Date.now(); providerState.lastError='';
    await chrome.storage.local.set({[QBASyncProvider.STATE_KEY]:providerState});
    await refreshSyncProvider(`Relay 正常 · protocol ${h.protocol ?? '?'} · uptime ${Math.round(Number(h.uptimeSec||0))}s`);
    addLog('零知識 Relay 健康檢查 PASS。','success');
  } catch(error) {
    const {providerState}=await getSyncProviderConfig(); providerState.lastError=String(error.message||error).slice(0,500);
    await chrome.storage.local.set({[QBASyncProvider.STATE_KEY]:providerState});
    await refreshSyncProvider(`Relay 測試失敗：${error.message}`); addLog(`Relay 測試失敗：${error.message}`,'error');
  }
}
async function cloudSyncPull() {
  try {
    const passphrase=String($('syncPassphrase')?.value||''); if(passphrase.length<10) throw new Error('請先輸入同步密語。');
    const {config,providerState}=await getSyncProviderConfig(); const c=QBASyncProvider.validateConfig(config);
    const granted=await QBASyncProvider.requestOriginPermission(c.endpoint); if(!granted) throw new Error('未授權 Relay 網域。');
    const remote=await QBASyncProvider.pull(c);
    if(!remote.found){ await refreshSyncProvider('Relay Room 尚無同步資料；可先由任一裝置 Push。'); return; }
    const bundle=await QBASyncCrypto.decryptEnvelope(remote.envelope,passphrase);
    const all=await chrome.storage.local.get(null), state=await getSyncState();
    const result=await QBASyncCore.importBundle(all,state,bundle);
    await createRepairRecoveryPoint('Relay Pull 前自動復原點');
    if(Object.keys(result.patch).length) await chrome.storage.local.set({...result.patch,qbaStorageSchema:QBA_STORAGE_SCHEMA});
    await chrome.storage.local.set({qbaSyncState:result.state});
    providerState.etag=remote.etag||''; providerState.lastPullAt=Date.now(); providerState.lastError='';
    await chrome.storage.local.set({[QBASyncProvider.STATE_KEY]:providerState});
    await refreshTaskTemplates(); await refreshPlatformProfileCenter(); await refreshPlatformProfileBackups(); await refreshProfileLabProfiles(); await updateRuleState(); await refreshRuleBackups();
    await refreshSyncProvider(result.skipped?'Relay Pull：遠端 Revision 無需更新。':`Relay Pull 完成；衝突 ${result.conflicts.length}。`);
    addLog('跨裝置 Relay Pull 完成。', result.conflicts.length?'warn':'success');
  } catch(error){ const {providerState}=await getSyncProviderConfig(); providerState.lastError=String(error.message||error).slice(0,500); await chrome.storage.local.set({[QBASyncProvider.STATE_KEY]:providerState}); await refreshSyncProvider(`Relay Pull 失敗：${error.message}`); addLog(`Relay Pull 失敗：${error.message}`,'error'); }
}
async function cloudSyncPush() {
  try {
    const passphrase=String($('syncPassphrase')?.value||''); if(passphrase.length<10) throw new Error('請先輸入同步密語。');
    const {config,providerState}=await getSyncProviderConfig(); const c=QBASyncProvider.validateConfig(config);
    const granted=await QBASyncProvider.requestOriginPermission(c.endpoint); if(!granted) throw new Error('未授權 Relay 網域。');
    const all=await chrome.storage.local.get(null), state=await getSyncState(), created=await QBASyncCore.createBundle(all,state,QBA_APP_VERSION);
    const env=await QBASyncCrypto.encryptBundle(created.bundle,passphrase);
    let pushed=await QBASyncProvider.push(c,env,providerState.etag||'');
    if(pushed.conflict){
      const remote=await QBASyncProvider.pull(c);
      if(remote.found){
        const rb=await QBASyncCrypto.decryptEnvelope(remote.envelope,passphrase);
        const merged=await QBASyncCore.importBundle(all,state,rb);
        if(Object.keys(merged.patch).length) await chrome.storage.local.set(merged.patch);
        await chrome.storage.local.set({qbaSyncState:merged.state});
        throw new Error('雲端已有較新版本，已先安全 Pull 合併；請檢查後再 Push。');
      }
      throw new Error('雲端版本衝突，請先 Pull。');
    }
    await chrome.storage.local.set({qbaSyncState:created.state});
    providerState.etag=pushed.etag||''; providerState.lastPushAt=Date.now(); providerState.lastError='';
    await chrome.storage.local.set({[QBASyncProvider.STATE_KEY]:providerState});
    await refreshSyncProvider(`Relay Push 完成 · Revision ${created.bundle.revision} · 僅上傳 AES-GCM 密文。`);
    addLog('跨裝置 Relay Push 完成。','success');
  } catch(error){ const {providerState}=await getSyncProviderConfig(); providerState.lastError=String(error.message||error).slice(0,500); await chrome.storage.local.set({[QBASyncProvider.STATE_KEY]:providerState}); await refreshSyncProvider(`Relay Push 失敗：${error.message}`); addLog(`Relay Push 失敗：${error.message}`,'error'); }
}

async function getRunArchives() {
  const { qbaRunArchives = [] } = await chrome.storage.local.get("qbaRunArchives");
  return Array.isArray(qbaRunArchives) ? qbaRunArchives : [];
}

async function refreshArchives(selectedId = "") {
  const archives = await getRunArchives();
  const sel = $("archiveSelect");
  if (!sel) return;
  sel.innerHTML = "";
  if (!archives.length) {
    const o=document.createElement("option"); o.value=""; o.textContent="尚無封存紀錄"; sel.appendChild(o);
    $("archiveMeta").textContent="尚未選取封存"; $("exportArchiveBtn").disabled=true; $("deleteArchiveBtn").disabled=true;
  } else {
    for (const a of archives.sort((x,y)=>Number(y.endedAt||0)-Number(x.endedAt||0))) {
      const o=document.createElement("option"); o.value=a.archiveId;
      let host=""; try { host=new URL(a.config?.targetUrl||"").hostname; } catch (_) {}
      o.textContent=`${new Date(a.startedAt).toLocaleString("zh-TW",{hour12:false})} · ${host || "任務"}`; sel.appendChild(o);
    }
    if (selectedId && archives.some(a=>a.archiveId===selectedId)) sel.value=selectedId;
    $("exportArchiveBtn").disabled=false; $("deleteArchiveBtn").disabled=false;
    updateArchiveMeta();
  }
  if ($("archiveCountText")) $("archiveCountText").textContent=`${archives.length} / ${QBA_RUN_ARCHIVE_LIMIT}`;
}

async function updateArchiveMeta() {
  const archives=await getRunArchives(), item=archives.find(a=>a.archiveId===$("archiveSelect")?.value);
  if (!item) { $("archiveMeta").textContent="尚未選取封存"; return; }
  const sec=Math.round(Number(item.durationMs||0)/1000);
  let host=""; try { host=new URL(item.config?.targetUrl||"").hostname; } catch (_) {}
  $("archiveMeta").textContent=`${host || "未知網站"} · ${sec} 秒 · ${item.events?.length || 0} 事件 · ${item.reason || "stopped"} · 不含個資`;
}

async function exportSelectedArchive() {
  const item=(await getRunArchives()).find(a=>a.archiveId===$("archiveSelect").value);
  if (!item) return;
  downloadJson(`QuickBuy封存_${new Date(item.startedAt).toISOString().replace(/[:.]/g,"-")}.json`, { app:"QuickBuy", version:QBA_APP_VERSION, exportedAt:new Date().toISOString(), archive:sanitizeArchiveForExport(item) });
  addLog("已匯出選取任務封存。","success");
}

async function deleteSelectedArchive() {
  const id=$("archiveSelect").value; if(!id)return;
  const archives=await getRunArchives();
  await chrome.storage.local.set({qbaRunArchives:archives.filter(a=>a.archiveId!==id)});
  await refreshArchives(); addLog("已刪除選取任務封存。","warn");
}

function integrityRow(level, label, message) { return { level, label, message }; }

async function inspectStorageIntegrity() {
  const all=await chrome.storage.local.get(null), items=[];
  const schema=Number(all.qbaStorageSchema||0);
  items.push(integrityRow(schema===QBA_STORAGE_SCHEMA?"pass":"warn","資料結構版本",schema===QBA_STORAGE_SCHEMA?`Schema ${schema} 正常`:`目前 Schema ${schema||"舊版"}，可執行安全修復 / 遷移`));
  const arrayChecks=[
    ["qbaTaskTemplates",50,"任務模板"],["qbaRulePacks",50,"專用規則"],["qbaPlatformProfiles",50,"平台 Profile"],["qbaRuleBackups",40,"規則備份"],["qbaPlatformProfileBackups",30,"Profile 備份"],["qbaRunArchives",30,"任務封存"],["qbaProfileLabCases",QBA_PROFILE_LAB_LIMIT,"Profile 測試案例"],["qbaRepairRecoveryPoints",QBA_REPAIR_RECOVERY_LIMIT,"修復復原點"]
  ];
  for(const [key,max,label] of arrayChecks){ const v=all[key]; if(v==null){items.push(integrityRow("info",label,"尚無資料")); continue;} if(!Array.isArray(v)) items.push(integrityRow("fail",label,"資料格式不是陣列")); else if(v.length>max) items.push(integrityRow("warn",label,`${v.length} 筆超過上限 ${max}，可安全裁切`)); else items.push(integrityRow("pass",label,`${v.length} 筆`)); }
  const tasks=Array.isArray(all.qbaTaskTemplates)?all.qbaTaskTemplates:[];
  const taskSensitive=tasks.some(t=>Object.keys(t?.fields||{}).some(k=>sensitiveFieldIds.has(k)));
  items.push(integrityRow(taskSensitive?"warn":"pass","模板個資隔離",taskSensitive?"發現舊模板含個資欄位，安全修復可移除":"任務模板未保存個資欄位"));
  if(all.qbaSiteProfiles!=null && (typeof all.qbaSiteProfiles!=="object" || Array.isArray(all.qbaSiteProfiles))) items.push(integrityRow("fail","網站設定檔","資料格式錯誤")); else items.push(integrityRow("pass","網站設定檔",`${Object.keys(all.qbaSiteProfiles||{}).length} 組`));
  const rules=Array.isArray(all.qbaRulePacks)?all.qbaRulePacks:[], profiles=Array.isArray(all.qbaPlatformProfiles)?all.qbaPlatformProfiles:[];
  let badRules=0,badProfiles=0;
  for(const r of rules){ try{QBA_RULES.sanitizeRule(r);}catch(_){badRules++;} }
  for(const pr of profiles){ try{QBA_PROFILES.sanitizeProfile(pr);}catch(_){badProfiles++;} }
  items.push(integrityRow(badRules?"fail":"pass","規則可解析性",badRules?`${badRules} 筆無法解析`:"全部可解析"));
  items.push(integrityRow(badProfiles?"fail":"pass","Profile 可解析性",badProfiles?`${badProfiles} 筆無法解析`:"全部可解析"));
  const usage=await getStorageUsage();
  items.push(integrityRow(usage.pct>=90?"fail":usage.pct>=70?"warn":"pass","Storage 容量",`${formatBytes(usage.bytes)} / ${formatBytes(usage.quota)}（${usage.pct.toFixed(1)}%）${usage.pct>=90?"，空間接近上限":usage.pct>=70?"，建議清理舊測試案例 / 封存":""}`));
  const fails=items.filter(x=>x.level==="fail").length,warns=items.filter(x=>x.level==="warn").length;
  return {ok:fails===0,items,fails,warns,summary:fails?`${fails} 個錯誤、${warns} 個提醒`:warns?`沒有錯誤，${warns} 個可修復提醒`:"資料一致性完整通過"};
}

function renderIntegrity(res) {
  const box=$("integrityResult"); if(!box)return; box.innerHTML="";
  const sum=document.createElement("div"); sum.className=`check-summary ${res?.fails?"fail":"ok"}`; sum.textContent=res?.summary||"檢查完成"; box.appendChild(sum);
  for(const item of res?.items||[]){ const row=document.createElement("div"); row.className=`check-row ${item.level}`; const icon=document.createElement("span"); icon.className="check-icon"; icon.textContent=item.level==="pass"?"✓":item.level==="fail"?"✕":item.level==="warn"?"!":"i"; const txt=document.createElement("div"); const b=document.createElement("b"); b.textContent=item.label; const m=document.createElement("div"); m.textContent=item.message; txt.append(b,m); row.append(icon,txt); box.appendChild(row); }
  const badge=$("systemHealthBadge"); if(badge){ badge.textContent=res?.fails?`${res.fails} 錯誤`:res?.warns?`${res.warns} 提醒`:"正常"; badge.className=`rule-count ${res?.fails?"bad":res?.warns?"warn":"good"}`; }
  if($("consistencyState")) $("consistencyState").textContent=res?.fails?`${res.fails} 錯誤`:res?.warns?`${res.warns} 提醒`:"正常";
}

async function runIntegrityCheck() { const res=await inspectStorageIntegrity(); renderIntegrity(res); await refreshArchives(); addLog(`資料一致性：${res.summary}。`,res.fails?"error":res.warns?"warn":"success"); return res; }

async function getRepairRecoveryPoints() {
  const { qbaRepairRecoveryPoints = [] } = await chrome.storage.local.get("qbaRepairRecoveryPoints");
  return Array.isArray(qbaRepairRecoveryPoints) ? qbaRepairRecoveryPoints.slice(0, QBA_REPAIR_RECOVERY_LIMIT) : [];
}

async function buildRepairRecoverySnapshot() {
  const all = await chrome.storage.local.get(null);
  const data = {
    qbaFields: safeStoredFields(all.qbaFields || {}),
    qbaTaskTemplates: (Array.isArray(all.qbaTaskTemplates) ? all.qbaTaskTemplates : []).map(t => ({...t, fields: safeStoredFields(t?.fields || {})})).slice(0, 50),
    qbaSiteProfiles: (all.qbaSiteProfiles && typeof all.qbaSiteProfiles === "object" && !Array.isArray(all.qbaSiteProfiles)) ? all.qbaSiteProfiles : {},
    qbaRulePacks: Array.isArray(all.qbaRulePacks) ? all.qbaRulePacks.slice(0, 50) : [],
    qbaPlatformProfiles: Array.isArray(all.qbaPlatformProfiles) ? all.qbaPlatformProfiles.slice(0, 50) : [],
    qbaRuleBackups: Array.isArray(all.qbaRuleBackups) ? all.qbaRuleBackups.slice(0, 40) : [],
    qbaPlatformProfileBackups: Array.isArray(all.qbaPlatformProfileBackups) ? all.qbaPlatformProfileBackups.slice(0, 30) : [],
    qbaCustomShortcutsV1: safeShortcutListForBackup(all.qbaCustomShortcutsV1),
    qbaPlatformLauncherPrefsV1: safeLauncherPrefsForBackup(all.qbaPlatformLauncherPrefsV1),
    qbaMobilePrepV1: safeMobilePrepForBackup(all.qbaMobilePrepV1)
  };
  return sanitizeDiagnosticExport(data);
}

async function createRepairRecoveryPoint(reason = "手動建立") {
  const points = await getRepairRecoveryPoints();
  const snapshot = await buildRepairRecoverySnapshot();
  const fingerprint = await QBASyncCore.fingerprint(snapshot);
  const point = { id: `recovery-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, at: Date.now(), reason, schemaVersion: QBA_STORAGE_SCHEMA, fingerprint, snapshot };
  const next = [point, ...points].slice(0, QBA_REPAIR_RECOVERY_LIMIT);
  await chrome.storage.local.set({ qbaRepairRecoveryPoints: next });
  await refreshRecoveryMeta();
  addLog(`已建立本機復原點：${reason}。`, "success");
  return point;
}

async function restoreLatestRepairRecoveryPoint() {
  try {
    const points = await getRepairRecoveryPoints();
    const point = points[0];
    if (!point?.snapshot) throw new Error("目前沒有可回復的修復前復原點。");
    if (point.fingerprint) { const actual=await QBASyncCore.fingerprint(point.snapshot); if (actual!==point.fingerprint) throw new Error("復原點完整性驗證失敗，為避免覆蓋資料已停止回復。"); }
    const cur = await chrome.storage.local.get(null), d = point.snapshot || {};
    const currentFields = cur.qbaFields || {}, incomingFields = safeStoredFields(d.qbaFields || {}), nextFields = {...currentFields, ...incomingFields};
    for (const id of sensitiveFieldIds) if (id in currentFields) nextFields[id] = currentFields[id];
    await chrome.storage.local.set({
      qbaStorageSchema: QBA_STORAGE_SCHEMA,
      qbaFields: nextFields,
      qbaTaskTemplates: Array.isArray(d.qbaTaskTemplates) ? d.qbaTaskTemplates.slice(0,50) : [],
      qbaSiteProfiles: (d.qbaSiteProfiles && typeof d.qbaSiteProfiles === "object" && !Array.isArray(d.qbaSiteProfiles)) ? d.qbaSiteProfiles : {},
      qbaRulePacks: QBA_RULES.normalizeCatalog(Array.isArray(d.qbaRulePacks) ? d.qbaRulePacks : []).slice(0,50),
      qbaPlatformProfiles: QBA_PROFILES.normalizeCatalog(Array.isArray(d.qbaPlatformProfiles) ? d.qbaPlatformProfiles : []).slice(0,50),
      qbaRuleBackups: Array.isArray(d.qbaRuleBackups) ? d.qbaRuleBackups.slice(0,40) : [],
      qbaPlatformProfileBackups: Array.isArray(d.qbaPlatformProfileBackups) ? d.qbaPlatformProfileBackups.slice(0,30) : [],
      qbaCustomShortcutsV1: safeShortcutListForBackup(d.qbaCustomShortcutsV1),
      qbaPlatformLauncherPrefsV1: safeLauncherPrefsForBackup(d.qbaPlatformLauncherPrefsV1),
      qbaMobilePrepV1: safeMobilePrepForBackup(d.qbaMobilePrepV1)
    });
    await loadFields(); await refreshTaskTemplates(); await refreshPlatformProfileCenter(); await refreshProfileLabProfiles(); await updateRuleState(); await refreshRuleBackups(); await refreshArchives(); await globalThis.QBA_PLATFORM_LAUNCHER?.refreshLibrary?.();
    await runIntegrityCheck();
    addLog(`已回復最近復原點：${point.reason} · ${new Date(point.at).toLocaleString("zh-TW",{hour12:false})}；目前個資欄位保留不覆蓋。`, "success");
    return {ok:true, point};
  } catch (error) { addLog(`復原點回復失敗：${error.message}`, "error"); return {ok:false,error:error.message||String(error)}; }
}

async function refreshRecoveryMeta() {
  const points = await getRepairRecoveryPoints();
  if ($("recoveryCountText")) $("recoveryCountText").textContent = `${points.length} / ${QBA_REPAIR_RECOVERY_LIMIT}`;
  if ($("restoreRecoveryBtn")) $("restoreRecoveryBtn").disabled = !points.length;
}

async function safeRepairStorage() {
  await createRepairRecoveryPoint("安全修復前自動復原點");
  const all=await chrome.storage.local.get(null), patch={qbaStorageSchema:QBA_STORAGE_SCHEMA,qbaMigratedAt:Date.now()};
  const tasks=(Array.isArray(all.qbaTaskTemplates)?all.qbaTaskTemplates:[]).slice(0,50).map(t=>({...t,fields:Object.fromEntries(Object.entries(t?.fields||{}).filter(([k])=>!sensitiveFieldIds.has(k)))}));
  patch.qbaTaskTemplates=tasks;
  patch.qbaRulePacks=QBA_RULES.normalizeCatalog(Array.isArray(all.qbaRulePacks)?all.qbaRulePacks:[]).slice(0,50);
  patch.qbaPlatformProfiles=QBA_PROFILES.normalizeCatalog(Array.isArray(all.qbaPlatformProfiles)?all.qbaPlatformProfiles:[]).slice(0,50);
  patch.qbaRuleBackups=(Array.isArray(all.qbaRuleBackups)?all.qbaRuleBackups:[]).slice(0,40);
  patch.qbaPlatformProfileBackups=(Array.isArray(all.qbaPlatformProfileBackups)?all.qbaPlatformProfileBackups:[]).slice(0,30);
  patch.qbaRunArchives=(Array.isArray(all.qbaRunArchives)?all.qbaRunArchives:[]).slice(0,QBA_RUN_ARCHIVE_LIMIT);
  patch.qbaProfileLabCases=(Array.isArray(all.qbaProfileLabCases)?all.qbaProfileLabCases:[]).map(x=>{try{return sanitizeProfileLabCase(x);}catch(_){return null;}}).filter(Boolean).slice(0,QBA_PROFILE_LAB_LIMIT);
  patch.qbaSiteProfiles=(all.qbaSiteProfiles && typeof all.qbaSiteProfiles==="object" && !Array.isArray(all.qbaSiteProfiles))?all.qbaSiteProfiles:{};
  await chrome.storage.local.set(patch);
  addLog("已完成安全修復：只正規化資料、裁切超量紀錄並移除舊模板中的個資欄位。","success");
  await refreshTaskTemplates(); await refreshPlatformProfileCenter(); await refreshRuleBackups(); await refreshArchives(); return runIntegrityCheck();
}

function safeShortcutListForBackup(items = []) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(items) ? items : []).slice(0, 24)) {
    const url = safeUrlForExport(raw?.url || "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      id: String(raw?.id || `qbs_${Date.now().toString(36)}_${out.length}`).slice(0, 80),
      name: String(raw?.name || "我的網站").replace(/\s+/g, " ").trim().slice(0, 40) || "我的網站",
      url,
      category: ["ticket","shop","event","other"].includes(String(raw?.category || "")) ? String(raw.category) : "other",
      pinned: !!raw?.pinned,
      createdAt: Number(raw?.createdAt || 0),
      lastUsedAt: Number(raw?.lastUsedAt || 0),
      updatedAt: Number(raw?.updatedAt || raw?.createdAt || 0)
    });
  }
  return out;
}

function safeLauncherPrefsForBackup(raw = {}) {
  const valid = new Set((globalThis.QBA_PLATFORM_CATALOG?.list?.() || []).map(x => x.id));
  const recent = Array.isArray(raw?.recent) ? raw.recent.filter(id => typeof id === "string" && (!valid.size || valid.has(id))) : [];
  return { recent: [...new Set(recent)].slice(0, 6) };
}

function safeMobilePrepForBackup(raw = {}) {
  const quantity = Math.max(1, Math.min(10, Number(raw?.quantity || 1) | 0));
  const keyword = String(raw?.keyword || "").trim().slice(0, 80);
  const targetAt = String(raw?.targetAt || "").slice(0, 32);
  const platformId = String(raw?.platformId || "").slice(0, 80);
  const targetUrl = safeUrlForExport(raw?.targetUrl || "");
  return { quantity, keyword, targetAt, platformId, targetUrl, updatedAt: Number(raw?.updatedAt || 0) };
}

function mergeSafeShortcuts(current = [], incoming = []) {
  const merged = new Map();
  for (const item of [...safeShortcutListForBackup(current), ...safeShortcutListForBackup(incoming)]) {
    const old = merged.get(item.url);
    if (!old) { merged.set(item.url, item); continue; }
    const oldTs = Number(old.updatedAt || 0), newTs = Number(item.updatedAt || 0);
    const newer = newTs >= oldTs ? item : old;
    merged.set(item.url, { ...newer, id: old.id || item.id, pinned: !!old.pinned || !!item.pinned, createdAt: Math.min(...[old.createdAt,item.createdAt].map(Number).filter(x=>x>0)) || Number(newer.createdAt||0), updatedAt: Math.max(oldTs,newTs) });
  }
  return [...merged.values()].slice(0, 24);
}

async function buildSafeBackup() {
  const all=await chrome.storage.local.get(null);
  const payload=sanitizeDiagnosticExport({app:"QuickBuy",backupType:"safe-backup",version:QBA_APP_VERSION,schemaVersion:QBA_STORAGE_SCHEMA,exportedAt:new Date().toISOString(),data:{
    qbaFields:safeStoredFields(all.qbaFields||{}), qbaTaskTemplates:(Array.isArray(all.qbaTaskTemplates)?all.qbaTaskTemplates:[]).map(t=>({...t,fields:safeStoredFields(t.fields||{})})).slice(0,50),
    qbaSiteProfiles:all.qbaSiteProfiles||{}, qbaRulePacks:Array.isArray(all.qbaRulePacks)?all.qbaRulePacks:[], qbaPlatformProfiles:Array.isArray(all.qbaPlatformProfiles)?all.qbaPlatformProfiles:[],
    qbaRuleBackups:Array.isArray(all.qbaRuleBackups)?all.qbaRuleBackups:[], qbaPlatformProfileBackups:Array.isArray(all.qbaPlatformProfileBackups)?all.qbaPlatformProfileBackups:[], qbaRunArchives:(Array.isArray(all.qbaRunArchives)?all.qbaRunArchives:[]).map(sanitizeArchiveForExport), qbaProfileLabCases:(Array.isArray(all.qbaProfileLabCases)?all.qbaProfileLabCases:[]).map(x=>{try{return sanitizeProfileLabCase(x);}catch(_){return null;}}).filter(Boolean).slice(0,QBA_PROFILE_LAB_LIMIT),
    qbaCustomShortcutsV1:safeShortcutListForBackup(all.qbaCustomShortcutsV1), qbaPlatformLauncherPrefsV1:safeLauncherPrefsForBackup(all.qbaPlatformLauncherPrefsV1), qbaMobilePrepV1:safeMobilePrepForBackup(all.qbaMobilePrepV1)
  }});
  payload.integrity={algorithm:"SHA-256",fingerprint:await QBASyncCore.fingerprint(payload.data)};
  return payload;
}

async function exportSafeBackup() { const payload=await buildSafeBackup(); downloadJson(`QuickBuy安全備份_${new Date().toISOString().slice(0,10)}.json`,payload); const at=Date.now(), fingerprint=String(payload.integrity?.fingerprint||""); await chrome.storage.local.set({qbaLastBackupAt:at,qbaLastBackupFingerprint:fingerprint}); await refreshSystemMeta(); addLog("已下載安全備份（不含個人資料，SHA-256 完整性已建立）。","success"); return {ok:true,at,fingerprint}; }

async function importSafeBackup(file) {
  try{
    const payload=JSON.parse(await file.text()); if(payload?.app!=="QuickBuy" || payload?.backupType!=="safe-backup" || !payload.data) throw new Error("不是有效的 QuickBuy 安全備份。");
    if (payload.integrity?.fingerprint) { const actual=await QBASyncCore.fingerprint(payload.data); if(actual!==String(payload.integrity.fingerprint)) throw new Error("安全備份 SHA-256 完整性驗證失敗，已停止匯入。"); }
    await createRepairRecoveryPoint("匯入安全備份前自動復原點");
    const cur=await chrome.storage.local.get(null), d=payload.data, mergeById=(a,b,key)=>{const m=new Map(); for(const x of [...(a||[]),...(b||[])]) if(x&&x[key]) m.set(x[key],x); return [...m.values()];};
    const currentFields=cur.qbaFields||{}, incomingFields=safeStoredFields(d.qbaFields||{}), nextFields={...currentFields,...incomingFields};
    for(const id of sensitiveFieldIds) if(id in currentFields) nextFields[id]=currentFields[id];
    await chrome.storage.local.set({
      qbaStorageSchema:QBA_STORAGE_SCHEMA,qbaFields:nextFields,
      qbaTaskTemplates:mergeById(cur.qbaTaskTemplates,d.qbaTaskTemplates,"id").slice(0,50),
      qbaRulePacks:QBA_RULES.normalizeCatalog(mergeById(cur.qbaRulePacks,d.qbaRulePacks,"id")).slice(0,50),
      qbaPlatformProfiles:QBA_PROFILES.normalizeCatalog(mergeById(cur.qbaPlatformProfiles,d.qbaPlatformProfiles,"id")).slice(0,50),
      qbaRuleBackups:mergeById(cur.qbaRuleBackups,d.qbaRuleBackups,"backupId").slice(0,40),
      qbaPlatformProfileBackups:mergeById(cur.qbaPlatformProfileBackups,d.qbaPlatformProfileBackups,"backupId").slice(0,30),
      qbaRunArchives:mergeById(cur.qbaRunArchives,d.qbaRunArchives,"archiveId").slice(0,30),
      qbaProfileLabCases:mergeById(cur.qbaProfileLabCases,d.qbaProfileLabCases,"caseId").map(x=>{try{return sanitizeProfileLabCase(x);}catch(_){return null;}}).filter(Boolean).slice(0,QBA_PROFILE_LAB_LIMIT),
      qbaCustomShortcutsV1:mergeSafeShortcuts(cur.qbaCustomShortcutsV1,d.qbaCustomShortcutsV1),
      qbaPlatformLauncherPrefsV1:safeLauncherPrefsForBackup({recent:[...(d.qbaPlatformLauncherPrefsV1?.recent||[]),...(cur.qbaPlatformLauncherPrefsV1?.recent||[])]}),
      qbaMobilePrepV1:safeMobilePrepForBackup((Number(d.qbaMobilePrepV1?.updatedAt||0)>=Number(cur.qbaMobilePrepV1?.updatedAt||0))?d.qbaMobilePrepV1:cur.qbaMobilePrepV1),
      qbaSiteProfiles:{...(cur.qbaSiteProfiles||{}),...(d.qbaSiteProfiles||{})}, qbaLastPreflight:d.qbaLastPreflight||cur.qbaLastPreflight||null, qbaLastRehearsal:d.qbaLastRehearsal||cur.qbaLastRehearsal||null
    });
    await loadFields(); await refreshTaskTemplates(); await refreshPlatformProfileCenter(); await refreshProfileLabProfiles(); await updateRuleState(); await refreshRuleBackups(); await refreshArchives(); await globalThis.QBA_PLATFORM_LAUNCHER?.refreshLibrary?.(); await runIntegrityCheck();
    addLog("安全備份已合併復原；現有姓名 / Email / 電話 / 地址未被覆蓋。","success");
    return {ok:true};
  }catch(error){addLog(`備份復原失敗：${error.message}`,"error"); return {ok:false,error:error.message||String(error)};}
}

async function exportSupportBundle() {
  const integrity=await inspectStorageIntegrity(), backup=await buildSafeBackup(), archives=await getRunArchives();
  let diagnostic=null; if(currentTabId){ diagnostic=await chrome.runtime.sendMessage({type:"QBA_GET_SNAPSHOT",tabId:currentTabId}).catch(()=>null); }
  const labCases=await getProfileLabCases(); const labSummary=labCases.map(({caseId,profileId,name,expected,capturedAt,lastRunAt,lastScore,lastPass,truncated})=>({caseId,profileId,name,expected,capturedAt,lastRunAt,lastScore,lastPass,truncated}));
  const payload={app:"QuickBuy",bundleType:"support",version:QBA_APP_VERSION,schemaVersion:QBA_STORAGE_SCHEMA,exportedAt:new Date().toISOString(),userAgent:navigator.userAgent,integrity,safeBackup:{...backup.data,qbaProfileLabCases:undefined},profileLabSummary:labSummary,recentArchives:archives.slice(0,5).map(sanitizeArchiveForExport),activeRuntime:diagnostic?{status:diagnostic.runtime?.status||null,pageState:diagnostic.runtime?.pageState?{...diagnostic.runtime.pageState,url:safeUrlForExport(diagnostic.runtime.pageState.url||"")}:null,transitions:(diagnostic.runtime?.transitions||[]).slice(0,30).map(x=>({...x,url:safeUrlForExport(x?.url||"")})),events:(diagnostic.runtime?.events||[]).slice(0,100)}:null};
  downloadJson(`QuickBuy支援包_${new Date().toISOString().replace(/[:.]/g,"-")}.json`,sanitizeDiagnosticExport(payload)); addLog("已下載支援包（個資、URL token、授權資訊已去識別化）。","success");
}

async function refreshSystemMeta() {
  const all=await chrome.storage.local.get(["qbaStorageSchema","qbaLastBackupAt","qbaLastMaintenance"]), archives=await getRunArchives(), usage=await getStorageUsage();
  if($("schemaState")) $("schemaState").textContent=`Schema ${Number(all.qbaStorageSchema||0) || "舊版"}`;
  if($("archiveCountText")) $("archiveCountText").textContent=`${archives.length} / ${QBA_RUN_ARCHIVE_LIMIT}`;
  if($("lastBackupText")) $("lastBackupText").textContent=all.qbaLastBackupAt?new Date(all.qbaLastBackupAt).toLocaleString("zh-TW",{hour12:false}):"尚未備份";
  if($("storageUsageText")) {
    $("storageUsageText").textContent=`${formatBytes(usage.bytes)} / ${formatBytes(usage.quota)} (${usage.pct.toFixed(1)}%)`;
    $("storageUsageText").className = usage.pct >= 90 ? "storage-danger" : usage.pct >= 70 ? "storage-warn" : "";
  }
  if($("maintenanceState")) {
    const m=all.qbaLastMaintenance;
    $("maintenanceState").textContent=m?.ok?`${new Date(m.finishedAt||m.startedAt).toLocaleString("zh-TW",{hour12:false})}`:m?"維護失敗":"尚未執行";
    $("maintenanceState").title=m?`${m.reason||"maintenance"}${m.orphanSessionsRemoved?` · 清除孤兒工作階段 ${m.orphanSessionsRemoved}`:""}`:"";
  }
  await refreshRecoveryMeta();
}


function selfTestItem(level, label, message, code = "") { return { level, label, message, code }; }

function renderReleaseSelfTest(res) {
  const box = $("releaseSelfTestResult");
  if (!box) return;
  box.innerHTML = "";
  if (!res) {
    const empty=document.createElement("div"); empty.className="preflight-empty"; empty.textContent="尚未執行發版前自我檢測"; box.appendChild(empty);
    const card=document.querySelector(".rc-card"); if(card) card.dataset.rcState="untested";
    if ($("rcSelfTestBadge")) { $("rcSelfTestBadge").textContent="尚未檢測"; $("rcSelfTestBadge").className="rule-count neutral"; }
    if ($("rcStateText")) { $("rcStateText").textContent="尚未檢測"; $("rcStateText").className="rc-state neutral"; }
    if ($("rcBlockerCount")) $("rcBlockerCount").textContent="—";
    if ($("rcWarningCount")) $("rcWarningCount").textContent="—";
    if ($("rcLastRunText")) $("rcLastRunText").textContent="尚未執行";
    if ($("exportSelfTestBtn")) $("exportSelfTestBtn").disabled=true;
    return;
  }
  const blockers = Number(res.blockers || 0), warnings = Number(res.warnings || 0);
  const status = blockers ? "不可實站" : warnings ? "待 Runtime 驗收（有提醒）" : "待 Runtime 驗收";
  const summary = document.createElement("div");
  summary.className = `check-summary ${blockers ? "fail" : "ok"}`;
  summary.textContent = `${status} · ${res?.passed || 0} 通過 / ${warnings} 警告 / ${blockers} 阻斷`;
  box.appendChild(summary);
  for (const item of res?.items || []) {
    const row = document.createElement("div"); row.className = `check-row ${item.level}`;
    const icon = document.createElement("span"); icon.className = "check-icon"; icon.textContent = item.level === "pass" ? "✓" : item.level === "fail" ? "✕" : item.level === "warn" ? "!" : "i";
    const txt = document.createElement("div"); const b = document.createElement("b"); b.textContent = item.label; const m = document.createElement("div"); m.textContent = item.message; txt.append(b,m); row.append(icon,txt); box.appendChild(row);
  }
  const card=document.querySelector(".rc-card"); if(card) card.dataset.rcState=blockers?"blocked":warnings?"warning":"ready";
  if ($("rcSelfTestBadge")) { $("rcSelfTestBadge").textContent = status; $("rcSelfTestBadge").className = `rule-count ${blockers ? "bad" : warnings ? "warn" : "good"}`; }
  if ($("rcStateText")) { $("rcStateText").textContent = status; $("rcStateText").className = `rc-state ${blockers ? "bad" : warnings ? "warn" : "good"}`; }
  if ($("rcBlockerCount")) $("rcBlockerCount").textContent = String(blockers);
  if ($("rcWarningCount")) $("rcWarningCount").textContent = String(warnings);
  if ($("rcLastRunText")) $("rcLastRunText").textContent = res?.ranAt ? new Date(res.ranAt).toLocaleString("zh-TW",{hour12:false}) : "尚未執行";
  if ($("exportSelfTestBtn")) $("exportSelfTestBtn").disabled = !res;
}

function hasForbiddenKeys(value, forbidden) {
  const hits = [];
  const walk = (v, path = "") => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x,i)=>walk(x,`${path}[${i}]`));
    for (const [k,val] of Object.entries(v)) {
      const next = path ? `${path}.${k}` : k;
      if (forbidden.has(k)) hits.push(next);
      walk(val,next);
    }
  };
  walk(value); return hits;
}

function unsafeExportUrls(value) {
  const hits = [];
  const walk = (v, path = "") => {
    if (typeof v === "string" && /^https?:\/\//i.test(v) && /[?#]/.test(v)) hits.push({path,value:v.slice(0,180)});
    else if (Array.isArray(v)) v.forEach((x,i)=>walk(x,`${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k,val] of Object.entries(v)) walk(val,path?`${path}.${k}`:k);
  };
  walk(value); return hits;
}

async function runReleaseSelfTest() {
  const btn=$("releaseSelfTestBtn"); if(btn){btn.disabled=true;btn.textContent="檢測中…";}
  const items=[];
  const add=(ok,label,passMessage,failMessage,levelOnFail="fail",code="")=>items.push(selfTestItem(ok?"pass":levelOnFail,label,ok?passMessage:failMessage,code));
  try {
    const manifest=chrome.runtime.getManifest();
    add(manifest.manifest_version===3 && manifest.version===QBA_APP_VERSION,"Manifest / 版本",`Manifest V3 · v${manifest.version} 一致`,`版本不一致：UI ${QBA_APP_VERSION} / Manifest ${manifest.version||"?"}`);
    const requiredPerms=["sidePanel","storage","scripting","tabs","notifications","power","alarms"];
    const missingPerms=requiredPerms.filter(x=>!(manifest.permissions||[]).includes(x));
    add(!missingPerms.length,"必要權限",missingPerms.length?"":`必要權限完整：${requiredPerms.join("、")}`,`缺少權限：${missingPerms.join("、")}`);
    const hosts=manifest.optional_host_permissions||[];
    add(hosts.includes("http://*/*")&&hosts.includes("https://*/*"),"網站授權策略","網站權限維持 optional host permission，安裝時不預先取得所有網站存取權。","optional host permission 設定不完整");
    const csp=manifest.content_security_policy?.extension_pages || "";
    add(csp.includes("script-src 'self'") && csp.includes("object-src 'self'") && !/unsafe-eval|unsafe-inline/i.test(csp),"Extension CSP","擴充功能頁面明確限制為本機 script / object，未允許 unsafe-eval / unsafe-inline。",`Extension CSP 不符合封版要求：${csp || "未設定"}`);
    const runtimeUrl=chrome.runtime.getURL("sidepanel.html");
    const realRuntime=!!chrome.runtime.id && /^chrome-extension:\/\//.test(runtimeUrl);
    add(realRuntime,"擴充功能執行環境",realRuntime?`已由 Chrome 擴充功能環境載入 · ${chrome.runtime.id}`:"",`目前不是正式 chrome-extension:// 執行環境，不能視為安裝驗收通過。`);
    const operationOptions=[...($("operationMode")?.options||[])].map(o=>o.value);
    add(operationOptions.includes("live") && operationOptions.includes("dry") && !operationOptions.includes("legacy-unattended"),"人工最終確認模式","正式版只提供正式模式與測試模式；沒有無人值守最終送單選項。","執行模式仍含自動最終送單入口。");

    const ping=await chrome.runtime.sendMessage({type:"QBA_SELF_TEST_PING"}).catch(e=>({ok:false,error:e.message}));
    add(!!ping?.ok && ping.version===QBA_APP_VERSION && ping.buildId===QBA_BUILD_ID,"背景 Service Worker",`背景程序回應正常 · v${ping?.version || "?"} · ${ping?.buildId || "?"}`,`背景程序未正常回應：${ping?.error || "版本 / buildId 不一致"}`);
    add(ping?.concurrencyGuard==="runid-lock-v1" && ping?.staleEventIsolation===true && ping?.atomicSessionCleanup===true && ping?.networkProbeRunIsolation===true && ping?.stoppedRuntimeIsolation===true,"競態 / 舊事件隔離",`全域任務鎖、每分頁 runtime 鎖、原子封存清除、網路探測 runId 隔離、停止後 runtime 隔離與舊事件隔離已啟用。`,`背景程序沒有回報 v3.4 競態 / 原子清理能力。`);
    add(ping?.monotonicRuntimeState===true && ping?.orderedRuntimeTimeline===true,"事件時序保護","狀態 / 頁面 / heartbeat 使用單調時間保護，log / event 時間軸依 timestamp 排序，延遲舊訊息不會覆寫或插到最前面。","背景程序沒有啟用完整事件時序保護。");
    add(ping?.runtimePrivacyRedaction===true,"執行期隱私去識別化","執行期 log / 頁面狀態 / 封存會清除 URL query、Email、電話與常見 token。","背景程序沒有啟用執行期隱私去識別化。");
    add(ping?.lifecycleAlarm===true && ping?.heartbeatTracking===true,"生命週期巡檢 / Heartbeat","每分鐘背景生命週期巡檢與內容頁 heartbeat 已啟用。","背景生命週期巡檢或 heartbeat 能力沒有啟用。");
    add(ping?.manualFinalConfirmation===true,"最終交易人工確認","背景核心明確回報 QuickBuy 1.0 的最後付款 / 下單必須人工確認。","背景核心沒有回報人工最終確認安全不變量。");
    add(ping?.scheduledAutopilotMission===false,"無人值守排程關閉","QuickBuy 1.0 已停用無人值守最終送單排程。","背景核心仍宣告無人值守送單排程可用。");
    const maintenance=await chrome.runtime.sendMessage({type:"QBA_RUN_MAINTENANCE",reason:"release_self_test"}).catch(e=>({ok:false,error:e.message}));
    add(!!maintenance?.ok && maintenance.version===QBA_APP_VERSION,"背景生命週期維護",maintenance?.ok?`維護正常 · 活動工作階段 ${maintenance.activeSessions||0} · 清除孤兒 ${maintenance.orphanSessionsRemoved||0}`:"",`背景維護失敗：${maintenance?.error || "沒有回應"}`);
    const usage=await getStorageUsage();
    items.push(selfTestItem(usage.pct>=90?"fail":usage.pct>=70?"warn":"pass","Storage 容量保護",`${formatBytes(usage.bytes)} / ${formatBytes(usage.quota)}（${usage.pct.toFixed(1)}%）${usage.pct>=90?"，接近 Chrome 上限":usage.pct>=70?"，建議清理舊案例 / 封存":""}`,"storage-quota"));
    try {
      const packageCheck=await verifyBuildManifest();
      add(packageCheck.ok,"套件 SHA-256 完整性",packageCheck.ok?`${packageCheck.checked} 個核心檔案雜湊全部一致。`:"",`套件檔案不一致：${packageCheck.mismatches.join("、")}`);
    } catch(error) {
      items.push(selfTestItem("fail","套件 SHA-256 完整性",`無法完成套件完整性驗證：${error?.message || error}`,"package-integrity"));
    }

    add(!!globalThis.QBA_RULES && !!globalThis.QBA_PROFILES,"規則 / Profile 模組","QBA_RULES 與 QBA_PROFILES 已載入。","規則或 Profile 模組沒有載入。");
    const platformCatalog = globalThis.QBA_PLATFORM_CATALOG;
    const platformRows = platformCatalog?.list?.() || [];
    const expectedPlatforms = ["era-ticket","tixcraft","kktix","ticketplus","kham","ibon-ticket"];
    const platformIds = new Set(platformRows.map(x=>x.id));
    add(!!platformCatalog && expectedPlatforms.every(id=>platformIds.has(id)),"熱門平台 Catalog",`已載入 ${platformRows.length} 個平台模型：年代、拓元、KKTIX、Ticket Plus、寬宏、ibon。`,`熱門平台 Catalog 缺失或不完整。`);
    const platformCases = platformCatalog?.regressionCases?.() || [];
    add(platformCases.length>=5 && platformCases.some(x=>x.expected==="FAIL_DIALOG") && platformCases.some(x=>x.expected==="UNKNOWN"),"平台回歸案例庫",`已載入 ${platformCases.length} 個公開案例，包含 failure-vs-queue 與 UNKNOWN fail-closed。`,`平台回歸案例庫不完整。`);
    add(platformRows.every(x=>!("selectors" in x) && !("script" in x)),"平台 Catalog 安全邊界","平台 Catalog 只包含流程 / 診斷資料，不帶可執行 script 或購買 selector。","平台 Catalog 含有不應存在的執行欄位。");
    if(globalThis.QBA_RULES){
      const raw={schemaVersion:1,id:"self-rule",name:"self-rule",version:"1.0.0",match:{hosts:["example.com"],pathPrefixes:["/"]},selectors:{purchase:["#buy"]},script:"alert(1)",evil:{script:"x"}};
      const safe=QBA_RULES.sanitizeRule(raw);
      add(!("script" in safe)&&!("evil" in safe)&&safe.selectors?.purchase?.[0]==="#buy","規則 sanitizer","未允許欄位 / script 已移除，合法 selector 保留。","規則 sanitizer 沒有正確隔離未知欄位。");
      let rejected=false; try{QBA_RULES.sanitizeRule({...raw,match:{hosts:["bad host !!!"]}});}catch(_){rejected=true;}
      add(rejected,"無效規則拒絕","無效 hostname 會拒絕匯入。","無效 hostname 沒有被拒絕。");
    }
    if(globalThis.QBA_PROFILES){
      const raw={schemaVersion:1,id:"self-profile",name:"self-profile",version:"1.0.0",match:{hosts:["example.com"],pathPrefixes:["/"]},rule:{selectors:{purchase:["#buy"]},script:"alert(1)"},script:"alert(2)"};
      const safe=QBA_PROFILES.sanitizeProfile(raw);
      add(!("script" in safe)&&!("script" in (safe.rule||{}))&&safe.rule?.selectors?.purchase?.[0]==="#buy","Profile sanitizer","Profile 不保留可執行 script 欄位。","Profile sanitizer 沒有正確移除 script。");
    }

    const scrubbed=safeUrlForExport("https://shop.example.com/ticket?id=123&token=SECRET#step2");
    add(scrubbed==="https://shop.example.com/ticket","URL 敏感參數清理",`query / hash 已移除：${scrubbed}`,`URL 清理結果不正確：${scrubbed}`);
    const safeFields=safeStoredFields({targetUrl:"https://shop.example.com/ticket?token=SECRET",profileName:"Test User",profileEmail:"test@example.com",profilePhone:"0912345678",profileAddress:"Secret",quantity:"2"});
    add(!hasForbiddenKeys(safeFields,sensitiveFieldIds).length && !/[?#]/.test(safeFields.targetUrl||"") && safeFields.quantity==="2","個資隔離函式","姓名 / Email / 電話 / 地址與 URL token 均未進入安全欄位。","safeStoredFields 發現敏感欄位或 URL token 殘留。");
    const exportProbe=sanitizeDiagnosticExport({targetUrl:"https://shop.example.com/ticket?token=SECRET#x",profileEmail:"test@example.com",authorization:"Bearer SHOULD_NOT_EXPORT",message:"聯絡 test@example.com / 0912345678 / https://shop.example.com/pay?session=ABC123#go",nested:{url:"https://shop.example.com/a?code=OTPSECRET",note:"token=XYZSECRET"}});
    const exportText=JSON.stringify(exportProbe);
    add(!/SECRET|test@example\.com|0912345678|SHOULD_NOT_EXPORT|[?]token=|[?]code=/i.test(exportText) && !hasForbiddenKeys(exportProbe,new Set(["profileEmail","authorization"])).length,"診斷匯出去識別化","診斷型匯出會統一移除 Email / 電話 / URL query / hash / token / authorization。",`診斷匯出去識別化失敗：${exportText.slice(0,220)}`);

    const tempKey=`__qba_rc_selftest_${Date.now()}`; const tempValue={nonce:Math.random().toString(36),ts:Date.now()};
    await chrome.storage.local.set({[tempKey]:tempValue}); const round=(await chrome.storage.local.get(tempKey))[tempKey]; await chrome.storage.local.remove(tempKey);
    add(round?.nonce===tempValue.nonce,"Storage 讀寫","chrome.storage.local 暫存寫入 / 讀回 / 清除正常。","chrome.storage.local 暫存讀寫失敗。");

    const ids=[...document.querySelectorAll("[id]")].map(x=>x.id), seen=new Set(), dups=[]; for(const id of ids){if(seen.has(id))dups.push(id);seen.add(id);}
    add(!dups.length,"DOM ID 唯一性",`${ids.length} 個 ID 無重複。`,`發現重複 ID：${[...new Set(dups)].join("、")}`);
    const critical=["startBtn","stopBtn","preflightBtn","rehearsalBtn","platformProfileSelect","profileBuilderScanBtn","profileLabRunAllBtn","integrityCheckBtn","createRecoveryBtn","restoreRecoveryBtn","exportSafeBackupBtn","releaseSelfTestBtn"];
    const missingDom=critical.filter(id=>!$(id)); add(!missingDom.length,"關鍵 UI 元件","關鍵控制項全部存在。",`缺少 UI：${missingDom.join("、")}`);
    const scriptSrc=[...document.scripts].map(x=>x.getAttribute("src")).filter(Boolean);
    add(["rules.js","profiles.js","platform-catalog.js","sidepanel.js"].every(x=>scriptSrc.includes(x)),"本機腳本來源","側邊欄只載入既定本機核心腳本與平台 Catalog。",`核心腳本載入不完整：${scriptSrc.join("、")}`);

    try {
      const [contentSource, backgroundSource] = await Promise.all([
        fetch(chrome.runtime.getURL("content.js"), { cache: "no-store" }).then(r => { if(!r.ok) throw new Error(`content.js HTTP ${r.status}`); return r.text(); }),
        fetch(chrome.runtime.getURL("background.js"), { cache: "no-store" }).then(r => { if(!r.ok) throw new Error(`background.js HTTP ${r.status}`); return r.text(); })
      ]);
      const contentMarkers = [
        'status("QUEUE_WAIT"', 'status("FINAL_CONFIRM"', 'status("PRICE_BLOCK"', 'status("SITE_CHANGED"',
        'recentActionCount() >= 8', 'state.clickCount >= 20', 'state.consecutiveErrors >= 3',
        'state.config.operationMode === "dry"', 'semanticSignature', 'navigationRecoveryUntil',
        'IBON_PAY_AT_STORE_RE', 'verifyFulfillmentPreset', 'fulfillmentPreset'
      ];
      const missingContent = contentMarkers.filter(x => !contentSource.includes(x));
      add(!missingContent.length,"頁面安全不變量",missingContent.length?"":`Queue / 驗證 / 付款 / 價格 / 節流 / 重載防重複等 ${contentMarkers.length} 項核心標記完整。`,`content.js 缺少安全標記：${missingContent.join("、")}`);
      add(!contentSource.includes("finalEl.click("),"最終按鈕不自動點擊","content.js 沒有自動點擊最終交易按鈕的程式路徑。","content.js 仍包含 finalEl.click()，正式版必須阻擋。");
      const backgroundMarkers = ['QBA_SELF_TEST_PING','QBA_RUN_MAINTENANCE','runBackgroundMaintenance','sanitizeArchiveUrl','archiveSession','QBA_RECOVERY_STUB_KEY','reconcileInterruptedRecovery','chrome.power.requestKeepAwake','chrome.tabs.onRemoved','withQbaLock','mutateRuntime','archiveAndClearSession','newRunId','redactSensitiveRuntimeText'];
      const missingBackground = backgroundMarkers.filter(x => !backgroundSource.includes(x));
      add(!missingBackground.length,"背景安全不變量",missingBackground.length?"":`封存、URL 清理、防睡眠與分頁關閉處理 ${backgroundMarkers.length} 項標記完整。`,`background.js 缺少安全標記：${missingBackground.join("、")}`);
    } catch(error) {
      items.push(selfTestItem("fail","核心來源完整性",`無法讀取本機核心檔案：${error?.message || error}`,"source-invariant"));
    }

    const integrity=await inspectStorageIntegrity();
    items.push(selfTestItem(integrity.fails?"fail":integrity.warns?"warn":"pass","本機資料一致性",integrity.summary,"storage-integrity"));
    const backup=await buildSafeBackup(); const forbidden=new Set(["profileName","profileEmail","profilePhone","profileAddress","password","otp","cvv","cardNumber"]);
    const keyHits=hasForbiddenKeys(backup,forbidden); const urlHits=unsafeExportUrls(backup);
    add(!keyHits.length,"安全備份欄位掃描","安全備份沒有禁止的個資 / 付款欄位 key。",`安全備份發現敏感 key：${keyHits.slice(0,6).join("、")}`);
    add(!urlHits.length,"安全備份 URL 掃描","安全備份中的 http(s) URL 沒有 query / hash token。",`安全備份仍有 ${urlHits.length} 個含 query/hash 的 URL。`);

    const session=await chrome.runtime.sendMessage({type:"QBA_GET_ACTIVE_SESSION"}).catch(()=>null);
    items.push(selfTestItem("pass","單一工作階段保護",session?.active?.tabId?`目前有 1 個活動工作階段（Tab ${session.active.tabId}）；背景核心採單一目標模式。`:`目前沒有活動工作階段；背景核心可正常查詢。`,"single-session"));
  } catch(error) {
    items.push(selfTestItem("fail","自我檢測執行器",`檢測程序發生例外：${error?.message || error}`,"self-test-exception"));
  }
  const blockers=items.filter(x=>x.level==="fail").length, warnings=items.filter(x=>x.level==="warn").length, passed=items.filter(x=>x.level==="pass").length;
  const res={app:"QuickBuy",version:QBA_APP_VERSION,buildId:QBA_BUILD_ID,kind:"release-self-test",ranAt:Date.now(),ok:blockers===0,blockers,warnings,passed,items};
  lastReleaseSelfTest=res;
  await chrome.storage.local.set({qbaLastSelfTest:{version:res.version,buildId:res.buildId,ranAt:res.ranAt,ok:res.ok,blockers,warnings,passed,items:res.items}});
  renderReleaseSelfTest(res);
  addLog(`發版前自我檢測：${blockers?`${blockers} 個阻斷問題`:`阻斷問題 0`}${warnings?`，${warnings} 個提醒`:""}。`,blockers?"error":warnings?"warn":"success");
  if(btn){btn.disabled=false;btn.textContent="執行完整自我檢測";}
  return res;
}

async function restoreReleaseSelfTest() {
  const {qbaLastSelfTest=null}=await chrome.storage.local.get("qbaLastSelfTest");
  if(qbaLastSelfTest?.version===QBA_APP_VERSION && qbaLastSelfTest?.buildId===QBA_BUILD_ID){lastReleaseSelfTest=qbaLastSelfTest;renderReleaseSelfTest(qbaLastSelfTest);} else renderReleaseSelfTest(null);
}

function exportReleaseSelfTest() {
  if(!lastReleaseSelfTest)return;
  const payload={app:"QuickBuy",reportType:"release-self-test",version:QBA_APP_VERSION,buildId:QBA_BUILD_ID,exportedAt:new Date().toISOString(),manifest:{version:chrome.runtime.getManifest().version,manifestVersion:chrome.runtime.getManifest().manifest_version,minimumChromeVersion:chrome.runtime.getManifest().minimum_chrome_version},result:lastReleaseSelfTest};
  downloadJson(`QuickBuy_發版自檢_${QBA_APP_VERSION}_${new Date().toISOString().replace(/[:.]/g,"-")}.json`,payload);
  addLog("已下載發版自我檢測報告。","success");
}

async function getActiveTab(assignCurrent = true) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (assignCurrent) currentTabId = tab?.id || null;
  return tab;
}

function originPattern(urlString) {
  const u = new URL(urlString);
  if (!/^https?:$/.test(u.protocol)) throw new Error("只支援 http / https 網頁。");
  return `${u.protocol}//${u.host}/*`;
}

function originKey(urlString) {
  const u = new URL(urlString);
  if (!/^https?:$/.test(u.protocol)) throw new Error("只支援 http / https 網頁。");
  return u.origin;
}

function normalizedPathPrefix(urlString) {
  const u = new URL(urlString);
  let path = u.pathname || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return path.replace(/\/{2,}/g, "/");
}

function profileStorageKey(urlString, scope = "path") {
  const u = new URL(urlString);
  return scope === "origin" ? `origin:${u.origin}` : `path:${u.origin}${normalizedPathPrefix(urlString)}`;
}

async function findBestProfile(urlString) {
  const u = new URL(urlString);
  const { qbaSiteProfiles = {} } = await chrome.storage.local.get("qbaSiteProfiles");
  const path = u.pathname || "/";
  const candidates = Object.entries(qbaSiteProfiles).filter(([key, value]) => {
    if (key === u.origin || key === `origin:${u.origin}`) return true; // v1.2 舊格式 + v1.3
    if (!key.startsWith(`path:${u.origin}`)) return false;
    const prefix = value?.pathPrefix || key.slice(`path:${u.origin}`.length) || "/";
    return prefix === "/" || path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
  }).map(([key, value]) => ({
    key,
    value: key === u.origin ? { ...value, scope: "origin", origin: u.origin, pathPrefix: "/", schemaVersion: 1 } : value,
    score: key.startsWith("path:") ? 10000 + (value?.pathPrefix || "").length : 1
  }));
  candidates.sort((a,b) => b.score - a.score || Number(b.value?.savedAt||0)-Number(a.value?.savedAt||0));
  return candidates[0] || null;
}

async function effectiveUrl() {
  const typed = $("targetUrl").value.trim();
  if (typed) return typed;
  if (running && currentTabId) {
    try { return (await chrome.tabs.get(currentTabId))?.url || ""; } catch (_) {}
  }
  const tab = await getActiveTab(false);
  return tab?.url || "";
}

function adjustedNow() { return Date.now() + Number(clockOffsetMs || 0); }

function renderClockState(ok = false, message = "尚未同步 · 使用電腦時間") {
  const el = $("clockState");
  if (el) {
    el.textContent = message;
    el.className = `clock-state ${ok && clockQuality !== "low" ? "good" : (clockSyncedAt ? "warn" : "")}`;
  }
  const qualityText = !ok ? "未同步" : clockQuality === "good" ? "較高" : clockQuality === "fair" ? "中等" : "偏低";
  if ($("clockQualityText")) $("clockQualityText").textContent = qualityText;
  if ($("liveClock")) $("liveClock").textContent = ok ? `${formatOffset(clockOffsetMs)} · ${qualityText}` : "Windows 本機";
}

function formatOffset(ms) {
  const sign = ms >= 0 ? "+" : "−";
  const abs = Math.abs(ms);
  return `${sign}${abs.toLocaleString()} ms`;
}

async function syncSiteClock(silent = false, forcedUrl = "") {
  const btn = $("syncClockBtn");
  if (btn) { btn.disabled = true; if (!silent) btn.textContent = "同步中…"; }
  try {
    const url = forcedUrl || await effectiveUrl();
    if (!url || !/^https?:/i.test(url)) throw new Error("請先設定有效的購買頁網址。");
    const granted = await ensurePermission(url);
    if (!granted) throw new Error("沒有取得此網站的讀取權限。");
    const res = await chrome.runtime.sendMessage({ type: "QBA_SYNC_CLOCK", url });
    if (!res?.ok) throw new Error(res?.error || "網站時間同步失敗。");
    clockOffsetMs = Number(res.offsetMs || 0);
    clockSyncedAt = Date.now();
    clockRttMs = Number(res.rttMs || 0);
    clockJitterMs = Number(res.jitterMs || 0);
    clockUncertaintyMs = Number(res.uncertaintyMs || 0);
    clockQuality = res.quality || "low";
    clockSamples = Number(res.samples || 1);
    clockSyncOk = true;
    const q = clockQuality === "good" ? "較高" : clockQuality === "fair" ? "中等" : "偏低";
    renderClockState(true, `已同步 · 差 ${formatOffset(clockOffsetMs)} · RTT ${clockRttMs} ms · 抖動 ${clockJitterMs} ms · 約 ±${clockUncertaintyMs} ms · ${q}`);
    if (!silent) addLog(`網站時間同步完成：${clockSamples} 次取樣，差 ${formatOffset(clockOffsetMs)}，RTT ${clockRttMs} ms，抖動 ${clockJitterMs} ms，估計不確定度約 ±${clockUncertaintyMs} ms（${q}）。`, clockQuality === "low" ? "warn" : "success");
    return true;
  } catch (error) {
    clockOffsetMs = 0;
    clockSyncedAt = Date.now();
    clockRttMs = 0;
    clockJitterMs = 0;
    clockUncertaintyMs = 0;
    clockQuality = "none";
    clockSamples = 0;
    clockSyncOk = false;
    renderClockState(false, `同步失敗 · 使用 Windows 時間`);
    if (!silent) addLog(`${error.message} 已改用 Windows 本機時間。`, "warn");
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "同步網站時間"; }
  }
}

async function ensurePermission(urlString) {
  const pattern = originPattern(urlString);
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const first = await chrome.tabs.get(tabId);
  if (first.status === "complete") return first;
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      try { resolve(await chrome.tabs.get(tabId)); } catch (_) { resolve(first); }
    };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    const timeout = setTimeout(finish, timeoutMs);
  });
}

async function navigateIfNeeded(tab, targetUrl) {
  if (!targetUrl) return tab;
  const target = new URL(targetUrl);
  const current = tab?.url ? new URL(tab.url) : null;
  if (!current || current.href !== target.href) {
    await chrome.tabs.update(tab.id, { url: target.href });
    addLog("已開啟目標頁面，載入完成後會自動接續。", "info");
    return waitForTabComplete(tab.id);
  }
  return tab;
}

async function ensureLiveReleaseGate(operationMode = "live") {
  if (operationMode !== "live") return { ok: true, skipped: true };
  let { qbaLastSelfTest = null } = await chrome.storage.local.get("qbaLastSelfTest");
  const current = qbaLastSelfTest?.version === QBA_APP_VERSION && qbaLastSelfTest?.buildId === QBA_BUILD_ID && qbaLastSelfTest?.ok === true && Number(qbaLastSelfTest?.blockers || 0) === 0 && Number(qbaLastSelfTest?.warnings || 0) === 0;
  if (!current) {
    addLog("正式模式啟動前需要目前版本的完整發版自我檢測；正在自動執行。", "info");
    const res = await runReleaseSelfTest();
    if (!res?.ok || Number(res.blockers || 0) > 0 || Number(res.warnings || 0) > 0) throw new Error(`正式模式安全門檻未通過：${res?.blockers || 0} 阻斷 / ${res?.warnings || 0} 警告。請先處理發版自檢紅黃項目。`);
    qbaLastSelfTest = res;
  }
  const packageCheck = await verifyBuildManifest();
  if (!packageCheck.ok) throw new Error(`正式模式已阻擋：核心套件 SHA-256 不一致（${packageCheck.mismatches.join("、")}）。`);
  const usage = await getStorageUsage();
  if (usage.pct >= 90) throw new Error(`正式模式已阻擋：Storage 已使用 ${usage.pct.toFixed(1)}%，請先清理舊案例 / 封存。`);
  const integrity = await inspectStorageIntegrity();
  if (integrity.fails || integrity.warns) throw new Error(`正式模式已阻擋：本機資料一致性仍有 ${integrity.fails} 錯誤 / ${integrity.warns} 提醒，請先執行安全修復或清理。`);
  const ping = await chrome.runtime.sendMessage({ type: "QBA_SELF_TEST_PING" }).catch(error => ({ ok: false, error: error?.message || String(error) }));
  if (!ping?.ok || ping.version !== QBA_APP_VERSION || ping.buildId !== QBA_BUILD_ID) throw new Error(`正式模式已阻擋：背景 Service Worker 無法確認目前版本 / 建置（${ping?.error || ping?.version || "無回應"} / ${ping?.buildId || "無 buildId"}）。`);
  return { ok: true, packageChecked: packageCheck.checked, storagePct: usage.pct };
}

async function start() {
  try {
    await saveFields();
    let tab = await getActiveTab(false);
    if (!tab?.id) throw new Error("找不到目前分頁。請先開啟購買頁。");

    await globalThis.QBA_PLATFORM_LAUNCHER?.adoptActiveIfSamePlatform?.(tab);
    const initial = collectConfig();
    await ensureLiveReleaseGate(initial.operationMode);
    const url = initial.targetUrl || tab.url;
    if (!url || !/^https?:/i.test(url)) throw new Error("請填入有效的購買頁網址。");
    if (initial.quantity < 1 || initial.quantity > 20) throw new Error("購買數量必須介於 1～20。");


    const granted = await ensurePermission(url);
    if (!granted) throw new Error("沒有取得此網站的操作權限。");

    if (initial.targetUrl) tab = await navigateIfNeeded(tab, initial.targetUrl);
    currentTabId = tab.id;
    if (!$("targetUrl").value.trim() && tab.url) $("targetUrl").value = tab.url;

    await syncSiteClock(true, tab.url || url);
    const cfg = collectConfig();
    cfg.targetUrl = tab.url || url;
    cfg.targetOrigin = new URL(cfg.targetUrl).origin;
    await attachSiteRule(cfg, cfg.targetUrl);

    const preflightRes = await chrome.runtime.sendMessage({ type: "QBA_PREFLIGHT_SESSION", tabId: currentTabId, config: cfg });
    renderPreflight(preflightRes);
    await persistPreflight(preflightRes);
    if (!preflightRes?.ok) throw new Error(preflightRes?.summary || preflightRes?.error || "開賣前健檢未通過，請先修正紅色項目。");
    if ((preflightRes?.items || []).some(x => x.level === "warn")) addLog(preflightRes.summary || "健檢有提醒，但可繼續待命。", "warn");

    const res = await chrome.runtime.sendMessage({ type: "QBA_START_SESSION", tabId: currentTabId, config: cfg });
    if (!res?.ok) throw new Error(res?.error || "啟動失敗");

    running = true;
    lastAlertCode = "";
    networkAutoDisabled = false;
    lastNetworkQuality = "none";
    $("startBtn").disabled = true;
    $("stopBtn").disabled = false;
    $("focusTargetBtn").disabled = false;
    setStatus("READY", "助手已啟動，正在監看目標分頁。");
    await refreshTelemetry();
    await probeNetwork(true);
    await refreshReplay();
    const ruleLabel = cfg.siteRuleMeta && cfg.siteRuleMeta.source !== "generic" ? `${cfg.siteRuleMeta.name} v${cfg.siteRuleMeta.version}` : "通用辨識";
    addLog(`開始待命。已鎖定單一目標分頁；規則：${ruleLabel}；${clockSyncOk ? `網站校時 ${formatOffset(clockOffsetMs)}` : "網站校時不可用，改用 Windows 時間"}。`, "success");
  } catch (error) {
    setStatus("ERROR", error.message);
    addLog(error.message, "error");
  }
}

async function stop() {
  if (currentTabId) await chrome.runtime.sendMessage({ type: "QBA_STOP_SESSION", tabId: currentTabId });
  running = false;
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  $("resumeBtn").disabled = true;
  $("focusTargetBtn").disabled = true;
  resetTelemetry();
  setStatus("IDLE", "已停止");
  addLog("已停止待命，系統防睡眠已解除。", "warn");
  await refreshArchives();
}

async function resume() {
  if (!currentTabId) return;
  const res = await chrome.runtime.sendMessage({ type: "QBA_RESUME_SESSION", tabId: currentTabId });
  if (res?.ok) {
    setStatus("WORKING", "已繼續執行。");
    $("resumeBtn").disabled = true;
  }
}

function updateCountdown() {
  const ts = getSaleTimeTs();
  let text = "尚未設定";
  let liveText = "--:--:--";
  if (ts) {
    let ms = ts - adjustedNow();
    if (ms <= 0) {
      text = "已開賣";
      liveText = "已開賣";
    } else {
      const days = Math.floor(ms / 86400000); ms %= 86400000;
      const h = Math.floor(ms / 3600000); ms %= 3600000;
      const m = Math.floor(ms / 60000); ms %= 60000;
      const sec = Math.floor(ms / 1000);
      const cs = Math.floor((ms % 1000) / 10);
      const p = n => String(n).padStart(2, "0");
      text = `${days ? days + "天 " : ""}${p(h)}:${p(m)}:${p(sec)}.${p(cs)}`;
      liveText = `${days ? days + "天 " : ""}${p(h)}:${p(m)}:${p(sec)}`;
    }
  }
  $("countdown").textContent = text;
  if ($("liveCountdown")) $("liveCountdown").textContent = liveText;
}

async function useCurrentPage() {
  const tab = await getActiveTab(false);
  if (tab?.url && /^https?:/i.test(tab.url)) {
    $("targetUrl").value = tab.url;
    await saveFields();
    await updateProfileLabel();
    await loadSiteProfile(true);
  }
}

async function pickSelector(targetKey) {
  try {
    const tab = await getActiveTab(false);
    if (!tab?.url || !/^https?:/i.test(tab.url)) throw new Error("請先開啟一般網站頁面。");
    const granted = await ensurePermission(tab.url);
    if (!granted) throw new Error("沒有取得目前網站權限。");
    const res = await chrome.runtime.sendMessage({ type: "QBA_PICK_SELECTOR", tabId: tab.id, targetKey });
    if (!res?.ok) throw new Error(res?.error || "無法啟動點選模式");
    addLog("請到網頁點一下目標元素；按 Esc 可取消。", "warn");
  } catch (error) { addLog(error.message, "error"); }
}

async function saveSiteProfile() {
  try {
    const url = await effectiveUrl();
    if (!/^https?:/i.test(url)) throw new Error("請先設定有效網站網址。");
    const scope = $("profileScope").value || "path";
    const key = profileStorageKey(url, scope);
    const { qbaSiteProfiles = {} } = await chrome.storage.local.get("qbaSiteProfiles");
    qbaSiteProfiles[key] = {
      schemaVersion: 2,
      scope,
      origin: new URL(url).origin,
      pathPrefix: scope === "path" ? normalizedPathPrefix(url) : "/",
      savedAt: Date.now(),
      priorities: $("priorities").value,
      purchaseSelector: $("purchaseSelector").value,
      quantitySelector: $("quantitySelector").value,
      priceSelector: $("priceSelector").value,
      intervalMs: $("intervalMs").value
    };
    await chrome.storage.local.set({ qbaSiteProfiles });
    addLog(`已儲存網站設定檔：${new URL(url).hostname} · ${scope === "path" ? "目前路徑" : "整個網域"}`, "success");
    await updateProfileLabel();
  } catch (error) { addLog(error.message, "error"); }
}

async function loadSiteProfile(silent = false) {
  try {
    const url = await effectiveUrl();
    if (!/^https?:/i.test(url)) throw new Error("請先設定有效網站網址。");
    const match = await findBestProfile(url);
    if (!match) {
      if (!silent) addLog(`目前沒有 ${new URL(url).hostname} 可套用的網站設定檔。`, "warn");
      await updateProfileLabel();
      return false;
    }
    const p = match.value;
    for (const id of ["priorities", "purchaseSelector", "quantitySelector", "priceSelector", "intervalMs"]) {
      if (id in p) $(id).value = p[id];
    }
    $("profileScope").value = p.scope === "origin" ? "origin" : "path";
    await saveFields();
    if (!silent) addLog(`已套用網站設定檔：${new URL(url).hostname} · ${p.scope === "origin" ? "整個網域" : p.pathPrefix || "目前路徑"}`, "success");
    await updateProfileLabel();
    return true;
  } catch (error) {
    if (!silent) addLog(error.message, "error");
    return false;
  }
}

async function deleteSiteProfile() {
  try {
    const url = await effectiveUrl();
    if (!/^https?:/i.test(url)) throw new Error("請先設定有效網站網址。");
    const match = await findBestProfile(url);
    if (!match) { addLog("目前網站沒有可刪除的設定檔。", "warn"); return; }
    const { qbaSiteProfiles = {} } = await chrome.storage.local.get("qbaSiteProfiles");
    delete qbaSiteProfiles[match.key];
    await chrome.storage.local.set({ qbaSiteProfiles });
    addLog(`已刪除目前套用的網站設定檔：${new URL(url).hostname}`, "warn");
    await updateProfileLabel();
  } catch (error) { addLog(error.message, "error"); }
}

async function updateProfileLabel() {
  const el = $("siteProfileState");
  if (!el) return;
  try {
    const url = await effectiveUrl();
    if (!/^https?:/i.test(url)) { el.textContent = "尚未指定網站"; el.className = "profile-state"; return; }
    const match = await findBestProfile(url);
    if (match) {
      const p = match.value;
      el.textContent = `${new URL(url).hostname} · 已套用${p.scope === "origin" ? "網域" : "路徑"}規則${p.scope === "path" ? ` ${p.pathPrefix || "/"}` : ""}`;
      el.className = "profile-state saved";
    } else {
      el.textContent = `${new URL(url).hostname} · 尚未儲存設定檔`;
      el.className = "profile-state";
    }
  } catch (_) { el.textContent = "網址格式尚未完成"; el.className = "profile-state"; }
}

function resetTelemetry() {
  $("clickCountText").textContent = "0";
  $("priorityText").textContent = "—";
  $("visibilityText").textContent = "—";
  $("rateText").textContent = "0/8";
  if ($("recoveryText")) $("recoveryText").textContent = "0 次";
  if ($("livePriority")) $("livePriority").textContent = "—";
  $("targetLockText").textContent = "尚未鎖定";
  $("targetLock").className = "target-lock idle";
}

async function focusTarget() {
  if (!currentTabId) return;
  const res = await chrome.runtime.sendMessage({ type: "QBA_FOCUS_TARGET", tabId: currentTabId });
  if (!res?.ok) addLog(res?.error || "無法切回目標分頁。", "error");
}

async function refreshTelemetry() {
  if (!running || !currentTabId) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "QBA_PING_SESSION", tabId: currentTabId });
    const tab = await chrome.tabs.get(currentTabId);
    const active = await getActiveTab(false);
    $("clickCountText").textContent = String(res?.clickCount ?? 0);
    $("priorityText").textContent = res?.selectedPriority || "—";
    if ($("livePriority")) $("livePriority").textContent = res?.selectedPriority || "—";
    if ($("recoveryText")) $("recoveryText").textContent = `${Number(res?.recoveryCount || 0)} 次`;
    $("visibilityText").textContent = res?.visible ? "前景" : "背景";
    $("rateText").textContent = `${Number(res?.recentActionCount || 0)}/8`;
    $("targetLockText").textContent = tab?.title || new URL(tab?.url || res?.url || "https://invalid/").hostname;
    $("targetLock").className = `target-lock ${active?.id === currentTabId ? "locked" : "warning"}`;
    $("focusTargetBtn").disabled = false;
    if (res?.pagePhase) applyPageState({ ...res.pagePhase, selectorHealth: res.selectorHealth });
    if (res?.recoveringReason && currentStatus !== "RECOVERING") setStatus("RECOVERING", `自動恢復中：${res.recoveringReason}`);
  } catch (_) {
    $("visibilityText").textContent = "無回應";
    $("targetLock").className = "target-lock warning";
  }
}

function renderPreflight(res) {
  const box = $("preflightResult");
  box.innerHTML = "";
  if (!res?.ok && !res?.items) {
    box.innerHTML = `<div class="check-row fail"><span>✕</span><div>${escapeHtml(res?.error || "健檢失敗")}</div></div>`;
    return;
  }
  const summary = document.createElement("div");
  summary.className = `check-summary ${res.ok ? "ok" : "fail"}`;
  summary.textContent = res.summary || (res.ok ? "健檢完成" : "健檢未通過");
  box.appendChild(summary);

  for (const item of res.items || []) {
    const row = document.createElement("div");
    row.className = `check-row ${item.level}`;
    const icon = document.createElement("span");
    icon.className = "check-icon";
    icon.textContent = item.level === "pass" ? "✓" : item.level === "fail" ? "✕" : item.level === "warn" ? "!" : "i";
    const text = document.createElement("div");
    const b = document.createElement("b"); b.textContent = item.label;
    const m = document.createElement("div"); m.textContent = item.message;
    text.append(b, m);
    row.append(icon, text);
    box.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

async function runPreflight() {
  const btn = $("preflightBtn");
  btn.disabled = true;
  btn.textContent = "檢查中…";
  try {
    const tab = running && currentTabId ? await chrome.tabs.get(currentTabId).catch(() => null) : await getActiveTab(false);
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) throw new Error("請先開啟要搶購的網站頁面。");
    const granted = await ensurePermission(tab.url);
    if (!granted) throw new Error("沒有取得目前網站權限。");
    await globalThis.QBA_PLATFORM_LAUNCHER?.adoptActiveIfSamePlatform?.(tab);
    const cfg = collectConfig();
    cfg.targetUrl = cfg.targetUrl || tab.url;
    cfg.targetOrigin = new URL(tab.url).origin;
    await attachSiteRule(cfg, tab.url);
    const res = await chrome.runtime.sendMessage({ type: "QBA_PREFLIGHT_SESSION", tabId: tab.id, config: cfg });
    renderPreflight(res);
    await persistPreflight(res);
    addLog(res?.summary || "開賣前健檢完成。", res?.ok ? "success" : "error");
  } catch (error) {
    renderPreflight({ ok: false, error: error.message });
    addLog(error.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "檢查目前頁面";
  }
}


function renderRehearsal(res) {
  const box = $("rehearsalResult");
  box.innerHTML = "";
  if (!res?.steps) {
    const row = document.createElement("div");
    row.className = "check-row fail";
    row.textContent = res?.error || "演練失敗";
    box.appendChild(row);
    $("rehearsalScore").textContent = "—";
    return;
  }
  $("rehearsalScore").textContent = `${Number(res.score || 0)}/100`;
  $("rehearsalAt").textContent = formatClock(res.at || Date.now());
  const summary = document.createElement("div");
  summary.className = `check-summary ${res.ok ? "ok" : "fail"}`;
  summary.textContent = res.summary || "模擬演練完成";
  box.appendChild(summary);
  for (const item of res.steps) {
    const row = document.createElement("div");
    row.className = `check-row ${item.level}`;
    const icon = document.createElement("span");
    icon.className = "check-icon";
    icon.textContent = item.level === "pass" ? "✓" : item.level === "fail" ? "✕" : item.level === "warn" ? "!" : "i";
    const text = document.createElement("div");
    const b = document.createElement("b"); b.textContent = item.label;
    const m = document.createElement("div"); m.textContent = item.message;
    text.append(b, m); row.append(icon, text); box.appendChild(row);
  }
}

async function persistRehearsal(res) {
  lastRehearsalResult = res;
  lastRehearsalAt = Number(res?.at || Date.now());
  await chrome.storage.local.set({ qbaLastRehearsal: { at: lastRehearsalAt, result: res } });
}

async function restoreRehearsal() {
  try {
    const { qbaLastRehearsal } = await chrome.storage.local.get("qbaLastRehearsal");
    if (qbaLastRehearsal?.result) {
      lastRehearsalResult = qbaLastRehearsal.result;
      lastRehearsalAt = Number(qbaLastRehearsal.at || qbaLastRehearsal.result.at || 0);
      renderRehearsal(lastRehearsalResult);
    }
  } catch (_) {}
}

async function runRehearsal() {
  const btn = $("rehearsalBtn");
  btn.disabled = true; btn.textContent = "演練中…";
  try {
    const tab = running && currentTabId ? await chrome.tabs.get(currentTabId).catch(() => null) : await getActiveTab(false);
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) throw new Error("請先開啟要搶購的網站頁面。");
    const granted = await ensurePermission(tab.url);
    if (!granted) throw new Error("沒有取得目前網站權限。");
    const cfg = collectConfig();
    cfg.targetUrl = cfg.targetUrl || tab.url;
    cfg.targetOrigin = new URL(tab.url).origin;
    await attachSiteRule(cfg, tab.url);
    const res = await chrome.runtime.sendMessage({ type: "QBA_REHEARSAL_SESSION", tabId: tab.id, config: cfg });
    if (!res?.steps) throw new Error(res?.error || "模擬演練失敗。");
    renderRehearsal(res);
    await persistRehearsal(res);
    addLog(res.summary || "模擬演練完成。", res.ok ? (res.score >= 90 ? "success" : "warn") : "error");
  } catch (error) {
    renderRehearsal({ error: error.message });
    addLog(`模擬演練失敗：${error.message}`, "error");
  } finally { btn.disabled = false; btn.textContent = "執行演練"; }
}

function setLiveMode(enabled) {
  document.body.classList.toggle("live-mode", !!enabled);
  $("liveModePanel").setAttribute("aria-hidden", enabled ? "false" : "true");
  try { localStorage.setItem("qbaLiveMode", enabled ? "1" : "0"); } catch (_) {}
  updateCountdown();
  renderReadiness();
  renderClockState(clockSyncOk, $("clockState")?.textContent || undefined);
  if ($("liveStopBtn")) $("liveStopBtn").disabled = !running;
}


function builderSafeIdPart(value, max = 42) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "site";
}

function builderPathPrefix(url, scope = "path") {
  const u = new URL(url);
  if (scope === "origin") return "/";
  const path = u.pathname || "/";
  if (path === "/") return "/";
  if (path.endsWith("/")) return path;
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx + 1);
}

function builderProfileId(url, scope = "path") {
  const u = new URL(url);
  const prefix = builderPathPrefix(url, scope);
  return `platform-${builderSafeIdPart(u.hostname, 52)}-${scope === "origin" ? "site" : builderSafeIdPart(prefix.replaceAll("/", "-"), 30)}`.slice(0, 100);
}

function builderKindLabel(kind) { return debugKindLabel(kind); }

function builderCandidateFloor(kind, base) {
  const b = Math.max(60, Math.min(95, Number(base || 80)));
  if (kind === "purchase") return Math.max(80, b);
  if (["quantity","price"].includes(kind)) return Math.max(70, b - 8);
  if (["final","login","queue","captcha","otp"].includes(kind)) return Math.max(78, b - 2);
  return Math.max(72, b - 5);
}

function builderCandidateSafe(item) {
  if (!item?.selector || !item.visible) return false;
  if (["purchase","quantity","price"].includes(item.kind) && item.disabled) return false;
  return true;
}

function renderProfileBuilder() {
  const draft = profileBuilderDraft;
  const state = $("profileBuilderState");
  const list = $("profileBuilderSelectorList");
  if (!draft) {
    state.textContent = "尚未建立草稿";
    $("profileBuilderDraftMeta").textContent = "—";
    $("profileBuilderCaps").textContent = "—";
    $("profileBuilderSelectorCount").textContent = "0";
    $("profileBuilderValidation").textContent = "尚未驗證";
    $("profileBuilderWarnings").textContent = "先按「掃描產生草稿」。";
    $("profileBuilderWarnings").className = "profile-conflict";
    list.innerHTML = '<div class="timeline-empty">尚無 Profile 草稿</div>';
    $("profileBuilderValidateBtn").disabled = true;
    $("profileBuilderInstallBtn").disabled = true;
    $("profileBuilderExportBtn").disabled = true;
    return;
  }
  const selectors = draft.rule?.selectors || {};
  const rows = [];
  for (const kind of QBA_PROFILES.CAPABILITIES) {
    for (const selector of selectors[kind] || []) rows.push({kind,selector});
  }
  state.textContent = `${draft.name} v${draft.version}`;
  $("profileBuilderDraftMeta").textContent = `${draft.match.hosts.join(", ")} · ${draft.match.pathPrefixes.join(", ")}`;
  $("profileBuilderCaps").textContent = (draft.capabilities || []).map(builderKindLabel).join("、") || "無";
  $("profileBuilderSelectorCount").textContent = String(rows.length);
  $("profileBuilderValidation").textContent = profileBuilderValidationResult ? `${profileBuilderValidationResult.score}/100` : "尚未驗證";
  const warnings = profileBuilderValidationResult?.issues || draft.__builderWarnings || [];
  $("profileBuilderWarnings").textContent = warnings.length ? warnings.join("；") : "草稿已建立，請先執行乾跑驗證。";
  $("profileBuilderWarnings").className = `profile-conflict ${warnings.length ? "warn" : "good"}`;
  list.innerHTML = "";
  if (!rows.length) list.innerHTML = '<div class="timeline-empty">目前沒有可用 selector</div>';
  else for (const row of rows) {
    const el=document.createElement("div"); el.className="builder-selector-row";
    const kind=document.createElement("span"); kind.className="kind"; kind.textContent=builderKindLabel(row.kind);
    const code=document.createElement("code"); code.textContent=row.selector;
    const score=document.createElement("span"); score.className="score"; score.textContent="草稿";
    el.append(kind,code,score); list.appendChild(el);
  }
  $("profileBuilderValidateBtn").disabled = false;
  $("profileBuilderExportBtn").disabled = false;
  $("profileBuilderInstallBtn").disabled = !(profileBuilderValidationResult?.ok === true);
}

function resetProfileBuilder() {
  profileBuilderDraft = null;
  profileBuilderValidationResult = null;
  profileBuilderSourceScan = null;
  renderProfileBuilder();
}

async function scanBuildPlatformProfile() {
  const btn=$("profileBuilderScanBtn"); btn.disabled=true; btn.textContent="掃描中…";
  try {
    const tab = running && currentTabId ? await chrome.tabs.get(currentTabId).catch(()=>null) : await getActiveTab(false);
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) throw new Error("請先開啟要建立 Profile 的網站頁面。");
    const granted=await ensurePermission(tab.url); if(!granted) throw new Error("沒有取得目前網站權限。");
    const cfg=collectConfig(); cfg.targetUrl=tab.url; cfg.targetOrigin=new URL(tab.url).origin; cfg.ruleMode="generic"; cfg.siteRule=null; cfg.siteRuleMeta=null;
    const scan=await chrome.runtime.sendMessage({type:"QBA_DEBUG_SCAN_SESSION",tabId:tab.id,config:cfg});
    if(!scan?.ok) throw new Error(scan?.error || "頁面掃描失敗。");
    profileBuilderSourceScan=scan; profileBuilderValidationResult=null;
    const scope=$("profileBuilderScope").value || "path", minScore=Number($("profileBuilderScore").value || 80);
    const u=new URL(scan.url), prefix=builderPathPrefix(scan.url,scope), id=builderProfileId(scan.url,scope);
    const installed=await getPlatformProfiles();
    const existing=QBA_PROFILES.normalizeCatalog(installed).find(p=>p.id===id) || null;
    const base=existing ? JSON.parse(JSON.stringify(existing)) : QBA_PROFILES.makeTemplate(scan.url);
    base.id=id; base.name=$("profileBuilderName").value.trim() || existing?.name || `${u.hostname} Profile`;
    base.version=existing ? bumpRuleVersion(existing.version) : "1.0.0";
    base.enabled=true; base.priority=Math.max(-10000,Math.min(10000,Number($("profileBuilderPriority").value || existing?.priority || 250)));
    base.match={hosts:[u.hostname],pathPrefixes:[prefix]};
    base.rule=base.rule || {selectors:{},text:{}}; base.rule.selectors=base.rule.selectors || {}; base.rule.text=base.rule.text || {next:[],sold:[],final:[],login:[],queue:[]};
    const warnings=[];
    const sourceCandidates=(scan.candidates || []).filter(builderCandidateSafe);
    for(const kind of QBA_PROFILES.CAPABILITIES){
      const floor=builderCandidateFloor(kind,minScore);
      const picked=[];
      for(const item of sourceCandidates.filter(x=>x.kind===kind && x.score>=floor).sort((a,b)=>b.score-a.score || a.count-b.count)){
        if(!picked.includes(item.selector)) picked.push(item.selector);
        if(picked.length>=3) break;
      }
      const old=Array.isArray(base.rule.selectors[kind]) ? base.rule.selectors[kind] : [];
      base.rule.selectors[kind]=[...old,...picked].filter((x,i,a)=>x && a.indexOf(x)===i).slice(0,12);
    }
    const caps=QBA_PROFILES.CAPABILITIES.filter(k=>(base.rule.selectors[k]||[]).length);
    base.capabilities=caps;
    if(!(base.rule.selectors.purchase||[]).length) warnings.push("沒有找到高可信度的購買 / 下一步 selector");
    if(!(base.rule.selectors.final||[]).length) warnings.push("目前頁面沒有可見付款 / 最終確認 selector；仍會保留通用付款停手保護");
    if(!(base.rule.selectors.quantity||[]).length) warnings.push("目前頁面沒有數量欄位，可能在下一頁才出現");
    base.notes=`QuickBuy v2.1 Profile 建立精靈草稿：${new Date().toISOString()}。只包含宣告式 selector/文字，不執行任意 JavaScript。`;
    base.rule.version=base.version; base.rule.name=`${base.name} 內嵌規則`; base.rule.id=`profile-rule-${base.id}`;
    const safe=QBA_PROFILES.sanitizeProfile(base); safe.__builderWarnings=warnings;
    profileBuilderDraft=safe; profileBuilderDraft.__builderWarnings=warnings;
    if(!$("profileBuilderName").value.trim()) $("profileBuilderName").value=safe.name;
    renderProfileBuilder();
    addLog(`Profile 草稿已建立：${safe.name} v${safe.version}，共 ${caps.length} 種能力。`, warnings.length?"warn":"success");
  } catch(error){ addLog(`Profile 建立失敗：${error.message}`,"error"); resetProfileBuilder(); }
  finally { btn.disabled=false; btn.textContent="掃描產生草稿"; }
}

function profileBuilderOverlapIssues(profile) {
  const sel=profile?.rule?.selectors || {};
  const purchase=new Set(sel.purchase || []), dangerous=["final","login","queue","captcha","otp"];
  const issues=[];
  for(const kind of dangerous){
    for(const s of sel[kind] || []) if(purchase.has(s)) issues.push(`購買 selector 與${builderKindLabel(kind)} selector 重疊：${s}`);
  }
  return issues;
}

async function profileBuilderDomOverlapIssues(tabId, profile) {
  const selectors=profile?.rule?.selectors || {};
  const result=await chrome.scripting.executeScript({target:{tabId},func:(s)=>{
    const safeQuery=(selector)=>{try{return [...document.querySelectorAll(selector)]}catch(_){return []}};
    const purchase=[...new Set((s.purchase||[]).flatMap(safeQuery))];
    const danger=["final","login","queue","captcha","otp"];
    const rows=[];
    for(const kind of danger){
      const nodes=[...new Set((s[kind]||[]).flatMap(safeQuery))];
      for(const node of nodes){
        if(purchase.includes(node)) rows.push({kind,text:(node.innerText||node.value||node.getAttribute?.("aria-label")||node.tagName||"").trim().slice(0,90)});
      }
    }
    return rows;
  },args:[selectors]});
  const rows=result?.[0]?.result || [];
  return rows.map(x=>`購買 selector 與${builderKindLabel(x.kind)}實際命中同一元素${x.text?`「${x.text}」`:""}`);
}

async function validatePlatformProfileDraft() {
  if(!profileBuilderDraft) return;
  const btn=$("profileBuilderValidateBtn"); btn.disabled=true; btn.textContent="驗證中…";
  try {
    const tab=await getActiveTab(false); if(!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) throw new Error("請保持建立 Profile 的網站頁面開啟。");
    const draft=QBA_PROFILES.sanitizeProfile(profileBuilderDraft), issues=[...profileBuilderOverlapIssues(draft)];
    const domOverlap=await profileBuilderDomOverlapIssues(tab.id,draft).catch(()=>[]); issues.push(...domOverlap);
    const cfg=collectConfig(); cfg.targetUrl=tab.url; cfg.targetOrigin=new URL(tab.url).origin; cfg.operationMode="dry"; cfg.ruleMode="auto"; cfg.siteRule=draft.rule; cfg.siteRuleMeta={id:draft.id,name:draft.name,version:draft.version,source:"profile-builder"}; cfg.platformProfileMeta={id:draft.id,name:draft.name,version:draft.version,capabilities:draft.capabilities||[]};
    const [scan,rehearsal]=await Promise.all([
      chrome.runtime.sendMessage({type:"QBA_DEBUG_SCAN_SESSION",tabId:tab.id,config:cfg}),
      chrome.runtime.sendMessage({type:"QBA_REHEARSAL_SESSION",tabId:tab.id,config:cfg})
    ]);
    if(!scan?.ok) throw new Error(scan?.error || "selector 乾跑失敗。");
    const selectorRows=scan.ruleSelectors || [], total=selectorRows.length, okRows=selectorRows.filter(x=>x.state==="ok").length;
    const purchaseRows=selectorRows.filter(x=>x.kind==="purchase"), purchaseOk=purchaseRows.some(x=>x.state==="ok");
    if(!purchaseRows.length) issues.push("Profile 沒有購買 / 下一步 selector");
    else if(!purchaseOk) issues.push("購買 / 下一步 selector 在目前頁面沒有可見命中");
    const installed=await getPlatformProfiles(), catalog=[...installed.filter(p=>p.id!==draft.id),draft];
    const resolved=QBA_PROFILES.resolve(tab.url,catalog,"auto");
    if(resolved.profile?.id!==draft.id) issues.push(`目前網址會被另一個 Profile「${resolved.profile?.name || "未知"}」優先接管`);
    const missing=selectorRows.filter(x=>x.state==="missing"||x.state==="invalid").length;
    const hidden=selectorRows.filter(x=>x.state==="hidden").length;
    let score=100;
    if(!purchaseOk) score-=45;
    score-=Math.min(25,missing*4); score-=Math.min(10,hidden*2); score-=Math.min(40,profileBuilderOverlapIssues(draft).length*20);
    if(rehearsal?.score!=null) score=Math.min(score,Math.max(0,Number(rehearsal.score)));
    score=Math.max(0,Math.min(100,Math.round(score)));
    const ok=issues.length===0 && score>=70;
    profileBuilderValidationResult={ok,score,issues,totalSelectors:total,okSelectors:okRows,rehearsalScore:rehearsal?.score??null,validatedAt:Date.now()};
    profileBuilderDraft.__builderWarnings=profileBuilderDraft.__builderWarnings || [];
    renderProfileBuilder();
    $("profileBuilderWarnings").textContent=ok ? `乾跑通過：${okRows}/${total} 條 selector 可見命中；模擬演練 ${rehearsal?.score ?? "—"}/100。` : `乾跑未通過：${issues.join("；")}`;
    $("profileBuilderWarnings").className=`profile-conflict ${ok?"good":"warn"}`;
    addLog(ok ? `Profile 乾跑通過：${draft.name} ${score}/100。` : `Profile 乾跑未通過：${issues.join("；")}`, ok?"success":"warn");
  } catch(error){ profileBuilderValidationResult={ok:false,score:0,issues:[error.message]}; renderProfileBuilder(); addLog(`Profile 乾跑失敗：${error.message}`,"error"); }
  finally { btn.disabled=false; btn.textContent="乾跑驗證"; }
}

async function installPlatformProfileDraft() {
  try {
    if(!profileBuilderDraft || !profileBuilderValidationResult?.ok) throw new Error("請先完成並通過乾跑驗證。");
    const safe=QBA_PROFILES.sanitizeProfile(profileBuilderDraft), profiles=QBA_PROFILES.normalizeCatalog(await getPlatformProfiles());
    const old=profiles.find(p=>p.id===safe.id); if(old) await backupPlatformProfile(old,"Profile 建立精靈安裝新版前備份");
    const map=new Map(profiles.map(p=>[p.id,p])); map.set(safe.id,{...safe,importedAt:Date.now()});
    await chrome.storage.local.set({qbaPlatformProfiles:[...map.values()].slice(0,50)});
    $("platformProfileMode").value="auto"; await saveFields(); await refreshPlatformProfileCenter(safe.id); await refreshPlatformProfileBackups(); await refreshProfileLabProfiles(safe.id); await updateRuleState();
    addLog(`已安裝 Profile：${safe.name} v${safe.version}。`,"success");
  } catch(error){ addLog(`Profile 安裝失敗：${error.message}`,"error"); }
}

function exportPlatformProfileBuilderDraft() {
  try {
    if(!profileBuilderDraft) throw new Error("尚未建立 Profile 草稿。");
    const safe=QBA_PROFILES.sanitizeProfile(profileBuilderDraft);
    downloadJson(`QuickBuy_Profile草稿_${safe.id}_${safe.version}.json`,{app:"QuickBuy",schemaVersion:1,profiles:[safe]});
    addLog(`已下載 Profile 草稿：${safe.name} v${safe.version}。`,"success");
  } catch(error){ addLog(`Profile 草稿下載失敗：${error.message}`,"error"); }
}


function profileLabExpectedLabel(value) {
  return ({purchase:"可購買",sold:"售完",queue:"Queue",login:"登入",captcha:"CAPTCHA",otp:"OTP",final:"最後付款",neutral:"一般頁面"})[value] || value || "未知";
}

function profileLabRedactText(value = "") {
  return String(value || "")
    .replace(/[A-Z][12]\d{8}/gi, "[id]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?\d[\s().-]*){8,}/g, "[phone]")
    .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g, "[token]")
    .slice(0, QBA_PROFILE_LAB_HTML_MAX);
}

function sanitizeProfileLabHtml(html = "") {
  const doc = new DOMParser().parseFromString(`<body>${String(html || "").slice(0, QBA_PROFILE_LAB_HTML_MAX * 2)}</body>`, "text/html");
  doc.querySelectorAll("script,style,noscript,iframe,object,embed,canvas,video,audio,source,picture,svg,link,meta").forEach(el => el.remove());
  const safeAttrs = new Set(["id","class","role","type","name","aria-label","aria-labelledby","aria-describedby","placeholder","title","disabled","hidden","selected","checked","min","max","step","for"]);
  const safeData = /^(data-testid|data-test|data-qa|data-cy|data-action|data-role|data-state|data-status|data-type)$/;
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (!safeAttrs.has(n) && !safeData.test(n)) el.removeAttribute(attr.name);
      else el.setAttribute(attr.name, profileLabRedactText(attr.value).slice(0, 240));
    }
    if (["INPUT","TEXTAREA"].includes(el.tagName)) { el.removeAttribute("value"); if(el.tagName === "TEXTAREA") el.textContent = ""; }
  }
  for (const node of [...doc.body.childNodes]) { /* force parser cleanup before serialization */ void node; }
  return profileLabRedactText(doc.body.innerHTML).slice(0, QBA_PROFILE_LAB_HTML_MAX);
}

function sanitizeProfileLabCase(raw = {}) {
  const expected = ["purchase","sold","queue","login","captcha","otp","final","neutral"].includes(raw.expected) ? raw.expected : "neutral";
  const caseId = String(raw.caseId || `case-${Date.now()}-${Math.random().toString(36).slice(2,8)}`).replace(/[^a-zA-Z0-9._-]/g,"-").slice(0,100);
  const profileId = String(raw.profileId || "").replace(/[^a-zA-Z0-9._-]/g,"-").slice(0,100);
  if (!profileId) throw new Error("測試案例缺少 profileId。");
  const safeUrl = safeUrlForExport(raw.url || "");
  return {
    caseId, profileId,
    name: profileLabRedactText(raw.name || profileLabExpectedLabel(expected)).slice(0,100),
    expected,
    url: safeUrl,
    capturedAt: Number(raw.capturedAt || Date.now()),
    html: sanitizeProfileLabHtml(raw.html || ""),
    truncated: !!raw.truncated,
    lastRunAt: Number(raw.lastRunAt || 0),
    lastScore: Number.isFinite(Number(raw.lastScore)) ? Math.max(0,Math.min(100,Number(raw.lastScore))) : null,
    lastPass: typeof raw.lastPass === "boolean" ? raw.lastPass : null
  };
}

async function getProfileLabCases() {
  const { qbaProfileLabCases = [] } = await chrome.storage.local.get("qbaProfileLabCases");
  const out=[];
  for(const raw of Array.isArray(qbaProfileLabCases)?qbaProfileLabCases:[]) { try { out.push(sanitizeProfileLabCase(raw)); } catch(_) {} }
  return out.slice(0,QBA_PROFILE_LAB_LIMIT);
}

async function saveProfileLabCases(cases) {
  const safe=[];
  for(const raw of Array.isArray(cases)?cases:[]) { try { safe.push(sanitizeProfileLabCase(raw)); } catch(_) {} if(safe.length>=QBA_PROFILE_LAB_LIMIT) break; }
  await chrome.storage.local.set({qbaProfileLabCases:safe});
  return safe;
}

async function refreshProfileLabProfiles(preferId = "") {
  const sel=$("profileLabProfileSelect"); if(!sel) return;
  const profiles=QBA_PROFILES.normalizeCatalog(await getPlatformProfiles());
  const old=preferId || sel.value || $("platformProfileSelect")?.value || "";
  sel.innerHTML="";
  if(!profiles.length){ const o=document.createElement("option"); o.value=""; o.textContent="尚無 Profile"; sel.appendChild(o); }
  else for(const p of profiles){ const o=document.createElement("option"); o.value=p.id; o.textContent=`${p.name} · v${p.version}${p.enabled?"":" · 已停用"}`; sel.appendChild(o); }
  if(old && profiles.some(p=>p.id===old)) sel.value=old;
  else {
    const url=await effectiveUrl().catch(()=>""); const hit=url?QBA_PROFILES.resolve(url,profiles,"auto").profile:null;
    if(hit) sel.value=hit.id;
  }
  await refreshProfileLabCases();
}

async function refreshProfileLabCases(selectedCaseId = "") {
  const profileId=$("profileLabProfileSelect")?.value || "";
  const cases=(await getProfileLabCases()).filter(c=>c.profileId===profileId).sort((a,b)=>b.capturedAt-a.capturedAt);
  const sel=$("profileLabCaseSelect"); if(!sel)return;
  sel.innerHTML="";
  if(!cases.length){ const o=document.createElement("option"); o.value=""; o.textContent="尚無案例"; sel.appendChild(o); }
  else for(const c of cases){ const o=document.createElement("option"); o.value=c.caseId; const status=c.lastPass===true?" ✓":c.lastPass===false?" ✕":""; o.textContent=`${c.name} · ${profileLabExpectedLabel(c.expected)}${status}`; sel.appendChild(o); }
  if(selectedCaseId && cases.some(c=>c.caseId===selectedCaseId)) sel.value=selectedCaseId;
  $("profileLabState").textContent=`${cases.length} 案例`;
  $("profileLabDeleteBtn").disabled=!cases.length;
  $("profileLabRunBtn").disabled=!cases.length;
  const chosen=cases.find(c=>c.caseId===sel.value) || cases[0];
  if(chosen){
    const last=chosen.lastRunAt?` · 上次 ${chosen.lastPass?"通過":"失敗"} ${chosen.lastScore ?? "—"}/100`:" · 尚未執行";
    $("profileLabMeta").textContent=`${profileLabExpectedLabel(chosen.expected)} · ${new Date(chosen.capturedAt).toLocaleString("zh-TW",{hour12:false})}${chosen.truncated?" · 快照已裁切":""}${last}`;
  } else $("profileLabMeta").textContent="尚未建立測試案例";
  if(!profileLabLastResults.length) renderProfileLabResults([]);
}

function profileLabFind(doc, selectors = []) {
  const elements=new Set(), invalid=[];
  for(const s of Array.isArray(selectors)?selectors:[]) {
    try { for(const el of doc.querySelectorAll(s)) elements.add(el); }
    catch(_) { invalid.push(s); }
  }
  return {count:elements.size,elements,invalid};
}

function profileLabTextHit(text, list = []) {
  const hay=String(text||"").toLowerCase().replace(/\s+/g," ");
  return (Array.isArray(list)?list:[]).some(x=>x && hay.includes(String(x).toLowerCase().replace(/\s+/g," ")));
}

function evaluateProfileLabCase(profile, item) {
  const safe=QBA_PROFILES.sanitizeProfile(profile), fixture=sanitizeProfileLabCase(item);
  const doc=new DOMParser().parseFromString(`<body>${fixture.html}</body>`,"text/html"), sel=safe.rule?.selectors||{}, txt=safe.rule?.text||{}, bodyText=doc.body?.textContent||"";
  const rows={}; const invalid=[];
  for(const kind of QBA_PROFILES.CAPABILITIES){ rows[kind]=profileLabFind(doc,sel[kind]||[]); invalid.push(...rows[kind].invalid.map(s=>`${kind}:${s}`)); }
  const signals={
    purchase:rows.purchase.count>0 || profileLabTextHit(bodyText,txt.next),
    sold:rows.sold.count>0 || profileLabTextHit(bodyText,txt.sold),
    final:rows.final.count>0 || profileLabTextHit(bodyText,txt.final),
    login:rows.login.count>0 || profileLabTextHit(bodyText,txt.login),
    queue:rows.queue.count>0 || profileLabTextHit(bodyText,txt.queue),
    captcha:rows.captcha.count>0,
    otp:rows.otp.count>0,
    quantity:rows.quantity.count>0,
    price:rows.price.count>0
  };
  const dangerous=["final","login","captcha","otp"], overlap=[];
  for(const kind of dangerous){ for(const el of rows.purchase.elements) if(rows[kind].elements.has(el)) { overlap.push(kind); break; } }
  let expectedOk=fixture.expected==="neutral" ? !signals.final&&!signals.login&&!signals.queue&&!signals.captcha&&!signals.otp : !!signals[fixture.expected];
  const unexpected=[];
  if(fixture.expected==="purchase") for(const kind of ["sold","final","login","queue","captcha","otp"]) if(signals[kind]) unexpected.push(kind);
  let score=100;
  if(!expectedOk) score-=45;
  score-=Math.min(30,invalid.length*10);
  score-=Math.min(40,overlap.length*20);
  score-=Math.min(30,unexpected.length*10);
  score=Math.max(0,score);
  const pass=expectedOk && !invalid.length && !overlap.length && !unexpected.length && score>=80;
  const detected=Object.entries(signals).filter(([,v])=>v).map(([k])=>k);
  const issues=[];
  if(!expectedOk) issues.push(`沒有偵測到預期狀態「${profileLabExpectedLabel(fixture.expected)}」`);
  if(invalid.length) issues.push(`selector 格式錯誤 ${invalid.length} 條`);
  if(overlap.length) issues.push(`購買 selector 與安全 selector 重疊：${overlap.map(profileLabExpectedLabel).join("、")}`);
  if(unexpected.length) issues.push(`可購買案例出現阻擋訊號：${unexpected.map(profileLabExpectedLabel).join("、")}`);
  return {caseId:fixture.caseId,name:fixture.name,expected:fixture.expected,pass,score,detected,issues,counts:Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,v.count])),ranAt:Date.now()};
}

function renderProfileLabResults(results = profileLabLastResults) {
  const box=$("profileLabResults"); if(!box)return; box.innerHTML="";
  if(!results.length){ box.innerHTML='<div class="timeline-empty">擷取案例後可離線重跑 Profile</div>'; return; }
  for(const r of results){
    const row=document.createElement("div"); row.className=`profile-lab-row ${r.pass?"pass":"fail"}`;
    const state=document.createElement("span"); state.className="state"; state.textContent=profileLabExpectedLabel(r.expected);
    const body=document.createElement("div"); const b=document.createElement("b"); b.textContent=r.name; const s=document.createElement("small"); s.textContent=r.issues?.length?r.issues.join("；"):`偵測：${(r.detected||[]).map(profileLabExpectedLabel).join("、") || "無"}`; body.append(b,s);
    const score=document.createElement("span"); score.className="score"; score.textContent=`${r.pass?"PASS":"FAIL"} ${r.score}/100`;
    row.append(state,body,score); box.appendChild(row);
  }
}

async function captureProfileLabCase() {
  try {
    const profileId=$("profileLabProfileSelect").value; if(!profileId) throw new Error("請先選擇一個 Profile。");
    const profiles=QBA_PROFILES.normalizeCatalog(await getPlatformProfiles()), profile=profiles.find(p=>p.id===profileId); if(!profile) throw new Error("找不到選取的 Profile。");
    const tab=await getActiveTab(false); if(!tab?.id || !/^https?:/i.test(tab.url||"")) throw new Error("請先開啟要建立案例的網站頁面。");
    if(!Number.isFinite(QBA_PROFILES.scoreProfile(profile,tab.url))) throw new Error("選取的 Profile 不適用目前頁面，請切到對應網站或選對 Profile。");
    if(!await ensurePermission(tab.url)) throw new Error("沒有取得目前網站權限。");
    const terms=[...Object.values(profile.rule?.text||{}).flat().filter(Boolean),"sold out","售完","已售完","queue","waiting room","排隊","login","登入","captcha","驗證碼","otp","付款","確認訂單","pay now"];
    const res=await chrome.scripting.executeScript({target:{tabId:tab.id},args:[terms,QBA_PROFILE_LAB_HTML_MAX],func:(terms,maxLen)=>{
      const redact=(value="")=>String(value||"")
        .replace(/[A-Z][12]\d{8}/gi,"[id]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[email]")
        .replace(/(?:\+?\d[\s().-]*){8,}/g,"[phone]")
        .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g,"[token]");
      const root=document.body?.cloneNode(true); if(!root)return {html:"",truncated:false,title:document.title||"",url:location.href};
      root.querySelectorAll("script,style,noscript,iframe,object,embed,canvas,video,audio,source,picture,svg,link,meta").forEach(el=>el.remove());
      const safeAttrs=new Set(["id","class","role","type","name","aria-label","aria-labelledby","aria-describedby","placeholder","title","disabled","hidden","selected","checked","min","max","step","for"]), safeData=/^(data-testid|data-test|data-qa|data-cy|data-action|data-role|data-state|data-status|data-type)$/;
      const keepTextTags=new Set(["BUTTON","A","LABEL","OPTION","H1","H2","H3","H4"]), lowerTerms=(terms||[]).map(x=>String(x).toLowerCase()).filter(Boolean);
      for(const el of root.querySelectorAll("*")){
        for(const attr of [...el.attributes]){const n=attr.name.toLowerCase(); if(!safeAttrs.has(n)&&!safeData.test(n))el.removeAttribute(attr.name); else el.setAttribute(attr.name,redact(attr.value).slice(0,240));}
        if(["INPUT","TEXTAREA"].includes(el.tagName)){el.removeAttribute("value"); if(el.tagName==="TEXTAREA")el.textContent="";}
      }
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); const nodes=[]; while(walker.nextNode())nodes.push(walker.currentNode);
      for(const node of nodes){ const parent=node.parentElement, raw=node.nodeValue||"", low=raw.toLowerCase(); const interactive=parent && (keepTextTags.has(parent.tagName)||parent.closest("button,a,label,[role=button],select")); const signal=lowerTerms.some(t=>t&&low.includes(t)); node.nodeValue=(interactive||signal)?redact(raw).slice(0,500):""; }
      let html=root.innerHTML, truncated=html.length>maxLen; if(truncated) html=html.slice(0,maxLen);
      return {html,truncated,title:redact(document.title||"").slice(0,160),url:location.href};
    }});
    const snap=res?.[0]?.result; if(!snap?.html) throw new Error("目前頁面沒有可保存的 DOM 結構。");
    let cases=await getProfileLabCases(); const profileCases=cases.filter(c=>c.profileId===profileId); if(profileCases.length>=8) throw new Error("這個 Profile 已有 8 個案例，請先刪除舊案例。");
    if(cases.length>=QBA_PROFILE_LAB_LIMIT) throw new Error(`測試案例已達總上限 ${QBA_PROFILE_LAB_LIMIT}。`);
    const expected=$("profileLabExpected").value, name=$("profileLabCaseName").value.trim() || `${profileLabExpectedLabel(expected)} · ${new Date().toLocaleString("zh-TW",{hour12:false})}`;
    const item=sanitizeProfileLabCase({profileId,name,expected,url:snap.url,capturedAt:Date.now(),html:snap.html,truncated:snap.truncated}); cases.unshift(item); await saveProfileLabCases(cases);
    $("profileLabCaseName").value=""; await refreshProfileLabCases(item.caseId); addLog(`已保存去識別化 Profile 測試案例：${item.name}。`,"success");
  } catch(error){ addLog(`Profile 案例擷取失敗：${error.message}`,"error"); }
}

async function runProfileLab(selectedOnly = false) {
  try {
    const profileId=$("profileLabProfileSelect").value; if(!profileId) throw new Error("請先選擇 Profile。");
    const profiles=QBA_PROFILES.normalizeCatalog(await getPlatformProfiles()), profile=profiles.find(p=>p.id===profileId); if(!profile) throw new Error("找不到選取的 Profile。");
    let cases=await getProfileLabCases(), targets=cases.filter(c=>c.profileId===profileId); if(selectedOnly){ const id=$("profileLabCaseSelect").value; targets=targets.filter(c=>c.caseId===id); }
    if(!targets.length) throw new Error("目前沒有可執行的測試案例。");
    const results=targets.map(c=>evaluateProfileLabCase(profile,c)); profileLabLastResults=results; renderProfileLabResults(results);
    const map=new Map(results.map(r=>[r.caseId,r])); cases=cases.map(c=>{const r=map.get(c.caseId); return r?{...c,lastRunAt:r.ranAt,lastScore:r.score,lastPass:r.pass}:c;}); await saveProfileLabCases(cases); await refreshProfileLabCases(selectedOnly?targets[0].caseId:"");
    const pass=results.filter(r=>r.pass).length; addLog(`Profile 驗證完成：${pass}/${results.length} 案例通過。`,pass===results.length?"success":"warn");
  } catch(error){ addLog(`Profile 驗證失敗：${error.message}`,"error"); }
}

async function deleteProfileLabCase() {
  const id=$("profileLabCaseSelect").value; if(!id)return; const cases=await getProfileLabCases(); await saveProfileLabCases(cases.filter(c=>c.caseId!==id)); profileLabLastResults=profileLabLastResults.filter(r=>r.caseId!==id); renderProfileLabResults(); await refreshProfileLabCases(); addLog("已刪除選取 Profile 測試案例。","warn");
}

async function exportProfileLabPack() {
  try { const profileId=$("profileLabProfileSelect").value; if(!profileId) throw new Error("請先選擇 Profile。"); const cases=(await getProfileLabCases()).filter(c=>c.profileId===profileId); if(!cases.length) throw new Error("目前 Profile 沒有測試案例。"); downloadJson(`QuickBuy_Profile測試_${profileId}_${new Date().toISOString().slice(0,10)}.json`,{app:"QuickBuy",packType:"profile-lab",version:QBA_APP_VERSION,exportedAt:new Date().toISOString(),profileId,cases}); addLog(`已匯出 ${cases.length} 個 Profile 測試案例。`,"success"); }
  catch(error){ addLog(`Profile 測試包匯出失敗：${error.message}`,"error"); }
}

async function importProfileLabPack(file) {
  try {
    const data=JSON.parse(await file.text()); if(data?.app!=="QuickBuy" || data?.packType!=="profile-lab" || !Array.isArray(data.cases)) throw new Error("不是有效的 Profile 測試包。");
    const profiles=QBA_PROFILES.normalizeCatalog(await getPlatformProfiles()), profileIds=new Set(profiles.map(p=>p.id)); const incoming=[];
    for(const raw of data.cases.slice(0,QBA_PROFILE_LAB_LIMIT)){ const item=sanitizeProfileLabCase(raw); if(profileIds.has(item.profileId)) incoming.push(item); }
    if(!incoming.length) throw new Error("測試包沒有對應目前已安裝 Profile 的有效案例。");
    const current=await getProfileLabCases(), map=new Map(current.map(c=>[c.caseId,c])); for(const c of incoming) map.set(c.caseId,c); await saveProfileLabCases([...map.values()]); await refreshProfileLabProfiles(incoming[0].profileId); addLog(`已匯入 ${incoming.length} 個去識別化 Profile 測試案例。`,"success");
  } catch(error){ addLog(`Profile 測試包匯入失敗：${error.message}`,"error"); }
}

function debugKindLabel(kind) {
  return ({ purchase:"購買", quantity:"數量", price:"價格", sold:"售完", final:"最終付款", login:"登入", queue:"Queue", captcha:"CAPTCHA", otp:"OTP" })[kind] || kind;
}

function renderDebugSignals(scan) {
  const box = $("debugSignals");
  box.innerHTML = "";
  if (!scan?.signals) {
    box.innerHTML = '<span class="debug-chip neutral">尚未掃描</span>';
    return;
  }
  const s = scan.signals;
  const chips = [
    [s.visible, "頁面前景", "頁面背景", s.visible ? "good" : "warn"],
    [!s.login, "無登入阻擋", "登入頁", s.login ? "warn" : "good"],
    [!s.queue, "非 Queue", "Queue 中", s.queue ? "warn" : "good"],
    [!s.challenge, "無驗證", s.challenge || "驗證", s.challenge ? "warn" : "good"],
    [!s.final, "未到付款", "已見付款鍵", s.final ? "bad" : "good"],
    [!s.soldText, "未見售完訊號", "頁面含售完訊號", s.soldText ? "warn" : "good"]
  ];
  for (const [ok, yes, no, cls] of chips) {
    const el = document.createElement("span");
    el.className = `debug-chip ${cls}`;
    el.textContent = ok ? yes : no;
    box.appendChild(el);
  }
}

function renderDebugRules(rows = []) {
  const box = $("debugRuleList");
  const summary = $("debugRuleSummary");
  box.innerHTML = "";
  if (!rows.length) {
    summary.textContent = "目前沒有專用 selector";
    box.innerHTML = '<div class="timeline-empty">目前使用通用辨識，或專用規則只有文字條件</div>';
    return;
  }
  const bad = rows.filter(x => x.state !== "ok").length;
  summary.textContent = bad ? `${bad}/${rows.length} 需注意` : `${rows.length}/${rows.length} 正常`;
  for (const item of rows.slice(0, 40)) {
    const row = document.createElement("div");
    row.className = `debug-rule-row ${item.state}`;
    const kind = document.createElement("span"); kind.className = "kind"; kind.textContent = debugKindLabel(item.kind);
    const code = document.createElement("code"); code.textContent = item.selector;
    const state = document.createElement("span"); state.className = "state";
    state.textContent = item.state === "ok" ? `正常 ${item.visible}/${item.count}` : item.state === "hidden" ? `隱藏 0/${item.count}` : item.state === "invalid" ? "格式錯誤" : "找不到";
    row.append(kind, code, state);
    box.appendChild(row);
  }
}

function applyDebugSelector(kind, selector) {
  const map = { purchase: "purchaseSelector", quantity: "quantitySelector", price: "priceSelector" };
  const id = map[kind];
  if (!id) return false;
  $(id).value = selector;
  saveFields();
  addLog(`已把候選 ${debugKindLabel(kind)} selector 套用到手動欄位。`, "success");
  renderSelectorHealth({
    purchase: { state: $("purchaseSelector").value ? "ok" : "unset", configured: !!$("purchaseSelector").value },
    quantity: { state: $("quantitySelector").value ? "ok" : "unset", configured: !!$("quantitySelector").value },
    price: { state: $("priceSelector").value ? "ok" : "unset", configured: !!$("priceSelector").value }
  });
  return true;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    addLog("selector 已複製到剪貼簿。", "success");
  } catch (_) {
    addLog("無法使用剪貼簿，請直接從除錯工作台複製 selector。", "warn");
  }
}

function renderDebugCandidates() {
  const box = $("debugCandidateList");
  box.innerHTML = "";
  const kind = $("debugKindFilter")?.value || "all";
  const rows = (lastDebugScan?.candidates || []).filter(x => kind === "all" || x.kind === kind);
  if (!rows.length) {
    box.innerHTML = '<div class="timeline-empty">這個類型目前沒有找到候選元素</div>';
    return;
  }
  for (const item of rows.slice(0, 50)) {
    const card = document.createElement("div"); card.className = "debug-candidate";
    const head = document.createElement("div"); head.className = "debug-candidate-head";
    const title = document.createElement("b"); title.textContent = `${debugKindLabel(item.kind)} · ${item.text || item.tag}`;
    const score = document.createElement("span"); score.className = "debug-score"; score.textContent = `穩定 ${item.score}`;
    head.append(title, score);
    const code = document.createElement("code"); code.textContent = item.selector;
    const meta = document.createElement("p");
    meta.textContent = `${item.reason} · 命中 ${item.count} · ${item.visible ? "可見" : "隱藏"}${item.disabled ? " · 已停用" : ""}`;
    const actions = document.createElement("div"); actions.className = "candidate-actions";
    if (["purchase","quantity","price"].includes(item.kind)) {
      const apply = document.createElement("button"); apply.className = "apply"; apply.textContent = "套用";
      apply.addEventListener("click", () => applyDebugSelector(item.kind, item.selector));
      actions.appendChild(apply);
    }
    const copy = document.createElement("button"); copy.className = "ghost"; copy.textContent = "複製 selector";
    copy.addEventListener("click", () => copyText(item.selector));
    actions.appendChild(copy);
    card.append(head, code, meta, actions);
    box.appendChild(card);
  }
}

function debugBaselineKey(url) {
  try { return `qbaDebugBaseline_${new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "-")}`; }
  catch (_) { return "qbaDebugBaseline_unknown"; }
}

async function compareAndStoreDebug(scan) {
  const key = debugBaselineKey(scan.url);
  const stored = await chrome.storage.session.get(key);
  const prev = stored[key] || null;
  const nowSet = new Set((scan.candidates || []).map(x => `${x.kind}|${x.selector}`));
  let delta = null;
  if (prev?.signatures) {
    const oldSet = new Set(prev.signatures);
    delta = {
      changed: prev.fingerprint !== scan.fingerprint,
      added: [...nowSet].filter(x => !oldSet.has(x)).length,
      removed: [...oldSet].filter(x => !nowSet.has(x)).length,
      previousFingerprint: prev.fingerprint
    };
  }
  await chrome.storage.session.set({ [key]: {
    fingerprint: scan.fingerprint,
    scannedAt: scan.scannedAt,
    signatures: [...nowSet].slice(0, 150)
  }});
  return delta;
}

function renderDebugOverview(scan, delta) {
  $("debugFingerprint").textContent = scan?.fingerprint || "—";
  const el = $("debugDelta");
  if (!delta) {
    el.textContent = "已建立比對基準";
    el.className = "same";
  } else if (!delta.changed) {
    el.textContent = "無明顯變更";
    el.className = "same";
  } else {
    el.textContent = `已變更 +${delta.added} / -${delta.removed}`;
    el.className = "changed";
  }
}

async function runDebugScan() {
  const btn = $("debugScanBtn");
  btn.disabled = true;
  btn.textContent = "掃描中…";
  try {
    const tab = running && currentTabId ? await chrome.tabs.get(currentTabId).catch(() => null) : await getActiveTab(false);
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) throw new Error("請先開啟要分析的網站頁面。");
    const granted = await ensurePermission(tab.url);
    if (!granted) throw new Error("沒有取得目前網站權限。");
    const cfg = collectConfig();
    cfg.targetUrl = cfg.targetUrl || tab.url;
    cfg.targetOrigin = new URL(tab.url).origin;
    await attachSiteRule(cfg, tab.url);
    const res = await chrome.runtime.sendMessage({ type: "QBA_DEBUG_SCAN_SESSION", tabId: tab.id, config: cfg });
    if (!res?.ok) throw new Error(res?.error || "除錯掃描失敗。");
    lastDebugScan = res;
    lastDebugDelta = await compareAndStoreDebug(res);
    renderDebugOverview(res, lastDebugDelta);
    renderDebugSignals(res);
    renderDebugRules(res.ruleSelectors || []);
    renderDebugCandidates();
    $("exportRepairDraftBtn").disabled = !(res.candidates || []).length;
    const total = (res.candidates || []).length;
    const broken = (res.ruleSelectors || []).filter(x => x.state !== "ok").length;
    addLog(`除錯掃描完成：找到 ${total} 個候選元素${broken ? `；${broken} 條專用 selector 需注意` : ""}。`, broken ? "warn" : "success");
  } catch (error) {
    addLog(`除錯掃描失敗：${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "掃描目前頁面";
  }
}

function bumpRuleVersion(version) {
  const m = String(version || "1.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : `${version || "1.0.0"}-repair`;
}

async function exportRepairDraft() {
  try {
    if (!lastDebugScan?.url) throw new Error("請先執行網站除錯掃描。");
    const brokenByKind = new Map();
    for (const row of lastDebugScan.ruleSelectors || []) {
      if (!brokenByKind.has(row.kind)) brokenByKind.set(row.kind, []);
      brokenByKind.get(row.kind).push(row.state !== "ok");
    }
    const kinds = ["purchase","quantity","price","sold","final","login","queue","captcha","otp"];
    const applyCandidates = (rule) => {
      rule.selectors = rule.selectors || {};
      for (const kind of kinds) {
        const current = Array.isArray(rule.selectors?.[kind]) ? rule.selectors[kind] : [];
        const kindRows = brokenByKind.get(kind) || [];
        const hasHealthy = kindRows.length && kindRows.some(x => x === false);
        if (hasHealthy) continue;
        const candidate = (lastDebugScan.candidates || []).find(x => x.kind === kind && x.visible && !x.disabled && x.score >= 70);
        if (!candidate) continue;
        rule.selectors[kind] = [candidate.selector, ...current.filter(x => x !== candidate.selector)].slice(0, 12);
      }
      return rule;
    };

    const profileResolved = globalThis.QBA_PROFILES ? await resolvePlatformProfile(lastDebugScan.url, "auto") : { profile:null };
    if (profileResolved?.profile) {
      const profile = JSON.parse(JSON.stringify(profileResolved.profile));
      profile.version = bumpRuleVersion(profile.version);
      profile.enabled = true;
      profile.rule = applyCandidates(profile.rule || { selectors:{}, text:{} });
      profile.rule.version = profile.version;
      profile.notes = `${String(profile.notes || "").trim()}\nQuickBuy v2.1 Profile 修復草稿：${new Date().toISOString()}。匯入前請確認 selector。`.trim();
      const safeProfile = QBA_PROFILES.sanitizeProfile(profile);
      downloadJson(`QuickBuy_Profile修復草稿_${new URL(lastDebugScan.url).hostname}_${safeProfile.version}.json`, { app:"QuickBuy", schemaVersion:1, profiles:[safeProfile] });
      addLog(`已產生 Profile 修復草稿：${safeProfile.name} v${safeProfile.version}。`, "success");
      return;
    }

    const rules = await getUserRules();
    const resolved = QBA_RULES.resolve(lastDebugScan.url, rules, "auto");
    let rule = resolved?.source === "custom" && resolved.rule ? JSON.parse(JSON.stringify(resolved.rule)) : QBA_RULES.makeTemplate(lastDebugScan.url);
    rule.version = bumpRuleVersion(rule.version);
    rule.enabled = true;
    rule.priority = Math.max(100, Number(rule.priority || 0));
    applyCandidates(rule);
    rule.notes = `${String(rule.notes || "").trim()}\nQuickBuy v2.1 除錯工作台修復草稿：${new Date().toISOString()}。匯入前請確認 selector。`.trim();
    const safe = QBA_RULES.sanitizeRule(rule);
    downloadJson(`QuickBuy修復草稿_${new URL(lastDebugScan.url).hostname}_${safe.version}.json`, { app:"QuickBuy", schemaVersion:1, rules:[safe] });
    addLog(`已產生規則修復草稿：${safe.name} v${safe.version}。`, "success");
  } catch (error) {
    addLog(`修復草稿產生失敗：${error.message}`, "error");
  }
}

function exportConfig() {
  const rawFields = Object.fromEntries(fieldIds.map(id => [id, $(id).value]));
  const payload = { app: "QuickBuy", version: 31, exportedAt: new Date().toISOString(), fields: safeStoredFields(rawFields) };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `QuickBuy設定_${new Date().toISOString().slice(0,10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportDiagnosticReport() {
  try {
    let snap = null;
    let diag = null;
    if (currentTabId) {
      snap = await chrome.runtime.sendMessage({ type: "QBA_GET_SNAPSHOT", tabId: currentTabId }).catch(() => null);
      diag = await chrome.runtime.sendMessage({ type: "QBA_GET_DIAGNOSTICS", tabId: currentTabId }).catch(() => null);
    }
    const cfg = collectConfig();
    await attachSiteRule(cfg).catch(() => cfg);
    const safeConfig = {
      targetUrl: safeUrlForExport(cfg.targetUrl),
      saleTimeTs: cfg.saleTimeTs,
      quantity: cfg.quantity,
      maxPrice: cfg.maxPrice,
      intervalMs: cfg.intervalMs,
      operationMode: cfg.operationMode,
      ruleMode: cfg.ruleMode,
      platformProfileMode: cfg.platformProfileMode,
      platformProfileMeta: cfg.platformProfileMeta || null,
      siteRuleMeta: cfg.siteRuleMeta || null,
      targetOrigin: cfg.targetOrigin,
      priorities: cfg.priorities,
      purchaseSelector: cfg.purchaseSelector,
      quantitySelector: cfg.quantitySelector,
      priceSelector: cfg.priceSelector,
      profileStored: {
        name: !!cfg.profile?.name,
        email: !!cfg.profile?.email,
        phone: !!cfg.profile?.phone,
        address: !!cfg.profile?.address
      }
    };
    const payload = {
      app: "QuickBuy",
      version: QBA_APP_VERSION,
      exportedAt: new Date().toISOString(),
      status: currentStatus,
      running,
      config: safeConfig,
      page: diag?.diagnostics || null,
      runtimeStatus: snap?.runtime?.status || null,
      pageState: snap?.runtime?.pageState || null,
      pageTransitions: (snap?.runtime?.transitions || pageTransitions).slice(0, 100),
      clock: { offsetMs: clockOffsetMs, rttMs: clockRttMs, jitterMs: clockJitterMs, uncertaintyMs: clockUncertaintyMs, quality: clockQuality, samples: clockSamples, syncedAt: clockSyncedAt },
      lastPreflight: lastPreflightResult ? { at: lastPreflightAt, result: lastPreflightResult } : null,
      lastRehearsal: lastRehearsalResult ? { at: lastRehearsalAt, result: lastRehearsalResult } : null,
      networkSamples: (snap?.runtime?.networkSamples || networkSamples).slice(0,120),
      replayEvents: (snap?.runtime?.events || replayEvents).slice(0,500),
      logs: (snap?.runtime?.logs?.length ? snap.runtime.logs : logs).slice(0, 200)
    };
    const safePayload = sanitizeDiagnosticExport(payload);
    const blob = new Blob([JSON.stringify(safePayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `QuickBuy診斷_${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    addLog("已匯出診斷報告（個資、URL token、授權資訊已去識別化）。", "success");
  } catch (error) { addLog(`診斷報告匯出失敗：${error.message}`, "error"); }
}

async function importConfig(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data?.fields) throw new Error("不是有效的 QuickBuy 設定檔。");
    for (const id of fieldIds) if (id in data.fields) $(id).value = data.fields[id];
    await saveFields();
    addLog("設定已匯入。", "success");
  } catch (error) { addLog(error.message, "error"); }
}

async function restoreSnapshot(tabId) {
  try {
    const snap = await chrome.runtime.sendMessage({ type: "QBA_GET_SNAPSHOT", tabId });
    if (snap?.runtime?.logs?.length) {
      logs = snap.runtime.logs.slice(0, 200);
      renderLogs();
    }
    if (snap?.runtime?.pageState) applyPageState(snap.runtime.pageState);
    if (snap?.runtime?.transitions?.length) {
      pageTransitions = snap.runtime.transitions.slice(0, 100);
      renderTransitions();
    }
    replayEvents = snap?.runtime?.events || [];
    networkSamples = snap?.runtime?.networkSamples || [];
    if (networkSamples.length) renderNetwork(networkSamples[0]);
    renderReplay(replayEvents, Number(snap?.session?.startedAt || snap?.runtime?.sessionStartedAt || 0));
    if (snap?.session) {
      running = true;
      clockOffsetMs = Number(snap.session.config?.clockOffsetMs || 0);
      const cm = snap.session.config?.clockMeta || {};
      clockSyncedAt = Number(cm.syncedAt || snap.session.startedAt || 0);
      clockRttMs = Number(cm.rttMs || 0);
      clockJitterMs = Number(cm.jitterMs || 0);
      clockUncertaintyMs = Number(cm.uncertaintyMs || 0);
      clockQuality = cm.quality || (clockOffsetMs ? "low" : "none");
      clockSamples = Number(cm.samples || 0);
      if (clockOffsetMs || clockSyncedAt) { clockSyncOk = true; renderClockState(true, `工作階段校時 · 差 ${formatOffset(clockOffsetMs)}${clockUncertaintyMs ? ` · 約 ±${clockUncertaintyMs} ms` : ""}`); }
      $("targetUrl").value = snap.session.config?.targetUrl || $("targetUrl").value;
      $("startBtn").disabled = true;
      $("stopBtn").disabled = false;
      const st = snap.runtime?.status;
      if (st?.code) setStatus(st.code, st.message || "工作階段仍在執行。");
      else setStatus("WORKING", "工作階段仍在執行。");
      $("focusTargetBtn").disabled = false;
      await refreshTelemetry();
    }
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "QBA_LOG") addLog(message.message, message.level, message.ts);
  if (message.type === "QBA_STATUS") {
    const previous = currentStatus;
    alertForStatus(message.code, message.message, previous);
    setStatus(message.code, message.message);
    replayEvents.unshift({ kind:"status", code:message.code, message:message.message || message.code, ts:message.ts || Date.now() });
    replayEvents = replayEvents.slice(0,500);
    renderReplay(replayEvents);
  }
  if (message.type === "QBA_PAGE_STATE") {
    const item = { phase: message.phase, label: message.label, url: message.url, title: message.title, selectorHealth: message.selectorHealth, ts: message.ts || Date.now() };
    applyPageState(item);
    const prev = pageTransitions[0];
    if (!prev || prev.phase !== item.phase || prev.url !== item.url || JSON.stringify(prev.selectorHealth || null) !== JSON.stringify(item.selectorHealth || null)) {
      pageTransitions.unshift(item);
      pageTransitions = pageTransitions.slice(0, 100);
      renderTransitions();
      replayEvents.unshift({kind:"page",label:item.label,message:`${item.label}${item.title ? ` · ${item.title}` : ""}`,ts:item.ts}); replayEvents=replayEvents.slice(0,500); renderReplay(replayEvents);
    }
  }
  if (message.type === "QBA_PICKED_SELECTOR") {
    const el = $(message.targetKey);
    if (el) {
      el.value = message.selector;
      saveFields();
      addLog(`已鎖定元素：${message.text || message.selector}`, "success");
    }
  }
});

chrome.tabs.onActivated.addListener(() => { if (running) refreshTelemetry(); });
chrome.tabs.onUpdated.addListener((tabId) => { if (running && tabId === currentTabId) refreshTelemetry(); });

function stopUiTimers() {
  if (countdownTimer) clearInterval(countdownTimer);
  if (telemetryTimer) clearInterval(telemetryTimer);
  if (networkTimer) clearInterval(networkTimer);
  countdownTimer = telemetryTimer = networkTimer = null;
}

function startUiTimers() {
  stopUiTimers();
  const hidden = document.visibilityState !== "visible";
  countdownTimer = setInterval(updateCountdown, hidden ? 1000 : 100);
  if (!hidden) {
    telemetryTimer = setInterval(refreshTelemetry, 1000);
    networkTimer = setInterval(() => { if (running) probeNetwork(true); }, 10000);
  }
}

document.addEventListener("visibilitychange", () => {
  startUiTimers();
  if (document.visibilityState === "visible") {
    updateCountdown();
    if (running) refreshTelemetry();
  }
});

(async function init() {
  const migrated = await migrateStorageV2();
  await loadFields();
  const sessionRes = await chrome.runtime.sendMessage({ type: "QBA_GET_ACTIVE_SESSION" }).catch(() => null);
  if (sessionRes?.active?.tabId) {
    currentTabId = sessionRes.active.tabId;
    await restoreSnapshot(currentTabId);
  } else {
    const tab = await getActiveTab(true);
    currentTabId = tab?.id || null;
  }
  await updateProfileLabel();
  await loadSiteProfile(true);
  await refreshPlatformProfileCenter();
  await refreshPlatformProfileBackups();
  await refreshProfileLabProfiles();
  renderProfileBuilder();
  await updateRuleState();
  await refreshRuleBackups();
  await refreshTaskTemplates();
  await refreshArmedMission();
  await refreshArchives();
  await refreshSystemMeta();
  await refreshSyncCenter(); await refreshSyncProvider();
  await restoreReleaseSelfTest();
  if (migrated) addLog("已完成 v2.0 本機資料結構遷移。", "success");
  renderReadiness();
  await restorePreflight();
  await restoreRehearsal();
  renderTransitions();
  try { if (localStorage.getItem("qbaLiveMode") === "1") setLiveMode(true); } catch (_) {}

  updateCountdown();
  startUiTimers();

  fieldIds.forEach(id => $(id).addEventListener("change", saveFields));
  $("priorities").addEventListener("input", saveFields);
  $("targetUrl").addEventListener("input", () => { updateProfileLabel(); refreshPlatformProfileCenter(); updateRuleState(); });
  $("targetUrl").addEventListener("change", () => { loadSiteProfile(true); refreshPlatformProfileCenter(); updateRuleState(); });
  $("startBtn").addEventListener("click", start);
  $("stopBtn").addEventListener("click", stop);
  $("resumeBtn").addEventListener("click", resume);
  $("useCurrentBtn").addEventListener("click", useCurrentPage);
  $("syncClockBtn").addEventListener("click", () => syncSiteClock(false));
  $("focusTargetBtn").addEventListener("click", focusTarget);
  $("preflightBtn").addEventListener("click", runPreflight);
  $("rehearsalBtn").addEventListener("click", runRehearsal);
  $("saveTaskBtn").addEventListener("click", saveTaskTemplate);
  $("loadTaskBtn").addEventListener("click", loadTaskTemplate);
  $("deleteTaskBtn").addEventListener("click", deleteTaskTemplate);
  $("taskSelect").addEventListener("change", async () => { $("loadTaskBtn").disabled = !$("taskSelect").value; $("deleteTaskBtn").disabled = !$("taskSelect").value; $("taskName").value = ""; await updateTaskMeta(); });
  $("armMissionBtn").addEventListener("click", armCurrentMission);
  $("disarmMissionBtn").addEventListener("click", disarmCurrentMission);
  $("networkTestBtn").addEventListener("click", () => probeNetwork(false));
  $("testSoundBtn").addEventListener("click", () => { playTone("urgent"); if (soundMode() === "voice") speak("QuickBuy 警報測試正常。需要你接手時會用這個方式提醒。" ); });
  $("refreshReplayBtn").addEventListener("click", refreshReplay);
  $("exportReplayBtn").addEventListener("click", exportReplay);
  $("liveModeBtn").addEventListener("click", () => setLiveMode(true));
  $("exitLiveModeBtn").addEventListener("click", () => setLiveMode(false));
  $("liveFocusBtn").addEventListener("click", focusTarget);
  $("liveResumeBtn").addEventListener("click", resume);
  $("liveStopBtn").addEventListener("click", stop);
  $("saveProfileBtn").addEventListener("click", saveSiteProfile);
  $("loadProfileBtn").addEventListener("click", () => loadSiteProfile(false));
  $("deleteProfileBtn").addEventListener("click", deleteSiteProfile);
  $("platformProfileMode").addEventListener("change", async () => { await saveFields(); await refreshPlatformProfileCenter(); await updateRuleState(); });
  $("platformProfileSelect").addEventListener("change", () => refreshPlatformProfileCenter($("platformProfileSelect").value));
  $("exportPlatformProfileTemplateBtn").addEventListener("click", exportPlatformProfileTemplate);
  $("platformProfileImportFile").addEventListener("change", e => e.target.files?.[0] && importPlatformProfile(e.target.files[0]));
  $("exportPlatformProfileBtn").addEventListener("click", exportSelectedPlatformProfile);
  $("togglePlatformProfileBtn").addEventListener("click", toggleSelectedPlatformProfile);
  $("deletePlatformProfileBtn").addEventListener("click", deleteSelectedPlatformProfile);
  $("restorePlatformProfileBackupBtn").addEventListener("click", restoreSelectedPlatformProfileBackup);
  $("platformProfileBackupSelect").addEventListener("change", e => { $("restorePlatformProfileBackupBtn").disabled = !e.target.value; });
  $("profileBuilderScanBtn").addEventListener("click", scanBuildPlatformProfile);
  $("profileBuilderValidateBtn").addEventListener("click", validatePlatformProfileDraft);
  $("profileBuilderInstallBtn").addEventListener("click", installPlatformProfileDraft);
  $("profileBuilderExportBtn").addEventListener("click", exportPlatformProfileBuilderDraft);
  $("profileBuilderResetBtn").addEventListener("click", resetProfileBuilder);
  $("profileBuilderName").addEventListener("input", () => { if(profileBuilderDraft){ profileBuilderDraft.name=$("profileBuilderName").value.trim() || profileBuilderDraft.name; profileBuilderDraft.rule.name=`${profileBuilderDraft.name} 內嵌規則`; profileBuilderValidationResult=null; renderProfileBuilder(); } });
  $("profileBuilderScope").addEventListener("change", resetProfileBuilder);
  $("profileBuilderScore").addEventListener("change", resetProfileBuilder);
  $("profileBuilderPriority").addEventListener("change", () => { if(profileBuilderDraft){ profileBuilderDraft.priority=Number($("profileBuilderPriority").value||250); profileBuilderValidationResult=null; renderProfileBuilder(); } });
  $("profileLabRefreshBtn").addEventListener("click", () => refreshProfileLabProfiles());
  $("profileLabProfileSelect").addEventListener("change", () => { profileLabLastResults=[]; renderProfileLabResults(); refreshProfileLabCases(); });
  $("profileLabCaseSelect").addEventListener("change", () => refreshProfileLabCases($("profileLabCaseSelect").value));
  $("profileLabCaptureBtn").addEventListener("click", captureProfileLabCase);
  $("profileLabRunBtn").addEventListener("click", () => runProfileLab(true));
  $("profileLabRunAllBtn").addEventListener("click", () => runProfileLab(false));
  $("profileLabDeleteBtn").addEventListener("click", deleteProfileLabCase);
  $("profileLabExportBtn").addEventListener("click", exportProfileLabPack);
  $("profileLabImportFile").addEventListener("change", e => e.target.files?.[0] && importProfileLabPack(e.target.files[0]));
  $("ruleMode").addEventListener("change", async () => { await saveFields(); await updateRuleState(); });
  $("exportRuleTemplateBtn").addEventListener("click", exportRuleTemplate);
  $("deleteRuleBtn").addEventListener("click", deleteCurrentRule);
  $("ruleImportFile").addEventListener("change", e => e.target.files?.[0] && importRulePack(e.target.files[0]));
  $("backupCurrentRuleBtn").addEventListener("click", backupCurrentRule);
  $("restoreRuleBackupBtn").addEventListener("click", restoreSelectedRuleBackup);
  $("ruleBackupSelect").addEventListener("change", e => { $("restoreRuleBackupBtn").disabled = !e.target.value; });
  $("refreshMissionBtn").addEventListener("click", refreshMissionCenter);
  $("debugScanBtn").addEventListener("click", runDebugScan);
  $("debugKindFilter").addEventListener("change", renderDebugCandidates);
  $("exportRepairDraftBtn").addEventListener("click", exportRepairDraft);
  $("integrityCheckBtn").addEventListener("click", runIntegrityCheck);
  $("safeRepairBtn").addEventListener("click", safeRepairStorage);
  $("createRecoveryBtn").addEventListener("click", () => createRepairRecoveryPoint("手動建立"));
  $("restoreRecoveryBtn").addEventListener("click", restoreLatestRepairRecoveryPoint);
  $("exportSafeBackupBtn").addEventListener("click", exportSafeBackup);
  $("safeBackupImportFile").addEventListener("change", e => e.target.files?.[0] && importSafeBackup(e.target.files[0]));
  $("exportSupportBundleBtn").addEventListener("click", exportSupportBundle);
  $("saveSyncDeviceBtn")?.addEventListener("click", saveSyncDeviceName);
  $("exportSyncBundleBtn")?.addEventListener("click", exportSyncBundle);
  $("syncImportFile")?.addEventListener("change", e => e.target.files?.[0] && importSyncBundle(e.target.files[0]));
  $("syncClearConflictBtn")?.addEventListener("click", clearSyncConflicts);
  $("syncRelayGenerateBtn")?.addEventListener("click", generateSyncProviderPair);
  $("syncRelaySaveBtn")?.addEventListener("click", saveSyncProviderConfig);
  $("syncRelayTestBtn")?.addEventListener("click", testSyncProvider);
  $("syncCloudPullBtn")?.addEventListener("click", cloudSyncPull);
  $("syncCloudPushBtn")?.addEventListener("click", cloudSyncPush);
  $("refreshArchivesBtn").addEventListener("click", refreshArchives);
  $("archiveSelect").addEventListener("change", updateArchiveMeta);
  $("exportArchiveBtn").addEventListener("click", exportSelectedArchive);
  $("deleteArchiveBtn").addEventListener("click", deleteSelectedArchive);
  $("releaseSelfTestBtn").addEventListener("click", runReleaseSelfTest);
  $("exportSelfTestBtn").addEventListener("click", exportReleaseSelfTest);
  document.querySelectorAll(".pick").forEach(btn => btn.addEventListener("click", () => pickSelector(btn.dataset.target)));
  $("clearLogBtn").addEventListener("click", async () => {
    logs = []; renderLogs();
    if (currentTabId) await chrome.runtime.sendMessage({ type: "QBA_CLEAR_LOGS", tabId: currentTabId });
  });
  $("exportBtn").addEventListener("click", exportConfig);
  $("exportReportBtn").addEventListener("click", exportDiagnosticReport);
  $("importFile").addEventListener("change", e => e.target.files?.[0] && importConfig(e.target.files[0]));
})();

/* Integrated trial quick-operate UI adapter. No purchase-engine logic lives here. */
(() => {
  const q = id => document.getElementById(id);
  const UI_STATE_KEY = "qbaSimpleUiState";
  let clickGuardUntil = 0;
  const copyValue = (src, dst) => { if (src && dst) dst.value = src.value ?? ""; };
  const fireInput = el => {
    if (!el) return;
    el.dispatchEvent(new Event("input", { bubbles:true }));
    el.dispatchEvent(new Event("change", { bubbles:true }));
  };
  const bindMirror = (simpleId, originalId) => {
    const s=q(simpleId), o=q(originalId); if (!s || !o) return;
    copyValue(o,s);
    s.addEventListener("input", () => { o.value=s.value; fireInput(o); });
    s.addEventListener("change", () => { o.value=s.value; fireInput(o); });
    o.addEventListener("input", () => copyValue(o,s));
    o.addEventListener("change", () => copyValue(o,s));
  };
  const persistUi = async patch => {
    try {
      const raw=await chrome.storage.local.get(UI_STATE_KEY);
      await chrome.storage.local.set({[UI_STATE_KEY]:{...(raw?.[UI_STATE_KEY]||{}),...patch,updatedAt:Date.now()}});
    } catch (_) {}
  };
  const showNotice = (text="", type="warn") => {
    const el=q("simpleNotice"); if (!el) return;
    el.hidden=!text; el.textContent=text; el.className=`simple-notice ${type}`;
  };
  const clearInvalid = () => document.querySelectorAll(".simple-invalid").forEach(el=>el.classList.remove("simple-invalid"));
  const validateSetup = (focus=false) => {
    clearInvalid();
    const fields=[
      ["simpleTargetUrl", v=>{ try { const u=new URL(v); return /^https?:$/.test(u.protocol); } catch { return false; } }, "請先設定正確的目標網址。"],
      ["simpleSaleDate", v=>!!v, "請先選擇開賣日期。"],
      ["simpleSaleTime", v=>!!v, "請先設定開賣時間。"],
      ["simpleQuantity", v=>Number.isFinite(Number(v)) && Number(v)>=1 && Number(v)<=20, "數量需為 1～20。"]
    ];
    for (const [id, ok, msg] of fields) {
      const el=q(id), value=(el?.value||"").trim();
      if (!ok(value)) {
        if (focus) el?.classList.add("simple-invalid");
        if (focus) { showNotice(msg,"warn"); el?.focus(); }
        return {ok:false,msg,id};
      }
    }
    const price=(q("simpleMaxPrice")?.value||"").trim();
    if (price && (!Number.isFinite(Number(price)) || Number(price)<0)) {
      const el=q("simpleMaxPrice"); if (focus) el?.classList.add("simple-invalid");
      if (focus) { showNotice("單價上限必須是 0 以上的數字。","warn"); el?.focus(); }
      return {ok:false,msg:"單價上限格式不正確",id:"simpleMaxPrice"};
    }
    return {ok:true};
  };
  const setupComplete = () => validateSetup(false).ok;
  const setMode = (advanced, persist=true) => {
    document.body.classList.toggle("advanced-active", !!advanced);
    document.body.classList.toggle("simple-active", !advanced);
    if (q("advancedWorkspace")) q("advancedWorkspace").hidden = !advanced;
    if (q("simpleWorkspace")) q("simpleWorkspace").hidden = !!advanced;
    if (q("uiModeToggleBtn")) q("uiModeToggleBtn").textContent = advanced ? "簡易模式" : "進階設定";
    if (persist) persistUi({advanced:!!advanced});
  };
  const setDot = (id, state) => { const el=q(id); if (el) el.className=`simple-dot ${state}`; };
  const renderSetupSummary = () => {
    const url=(q("simpleTargetUrl")?.value||"").trim(); let target="尚未設定";
    try { const u=new URL(url); target=u.hostname + (u.pathname && u.pathname!=="/" ? u.pathname : ""); } catch {}
    if (q("simpleSummaryTarget")) q("simpleSummaryTarget").textContent=target;
    const d=q("simpleSaleDate")?.value||"", t=q("simpleSaleTime")?.value||"";
    if (q("simpleSummaryTime")) q("simpleSummaryTime").textContent=(d&&t)?`${d.slice(5).replace("-","/")} ${t}`:"—";
    if (q("simpleSummaryQty")) q("simpleSummaryQty").textContent=q("simpleQuantity")?.value||"1";
    const valid=setupComplete();
    if (q("simplePreflightBtn")) q("simplePreflightBtn").disabled=!valid;
    const underlyingDisabled=!!q("startBtn")?.disabled;
    if (q("simpleStartBtn")) q("simpleStartBtn").disabled=!valid || underlyingDisabled;
    if (valid && q("simpleNotice")?.textContent?.startsWith("請先")) showNotice("");
  };
  const setSetupCollapsed = (collapsed, persist=true) => {
    const card=q("simpleSetupCard"); if(!card) return;
    const should=!!collapsed && setupComplete();
    card.classList.toggle("is-collapsed",should);
    q("simpleSetupFields")?.toggleAttribute("hidden",should);
    q("simpleSetupSummary")?.toggleAttribute("hidden",!should);
    q("simpleEditSetupBtn")?.toggleAttribute("hidden",!should);
    renderSetupSummary();
    if (persist) persistUi({setupCollapsed:should});
  };
  const syncStatus = () => {
    const countdown=q("countdown")?.textContent || "尚未設定";
    const status=q("statusText")?.textContent || "尚未啟動";
    const target=q("targetLockText")?.textContent || "尚未鎖定";
    const ready=q("readinessText")?.textContent || "尚未檢查";
    const pill=q("simpleStatePill");
    if (q("simpleCountdown")) q("simpleCountdown").textContent=countdown;
    if (q("simpleStatusText")) q("simpleStatusText").textContent=status;
    if (q("simpleTargetState")) q("simpleTargetState").textContent=target;
    if (q("simpleReadyState")) q("simpleReadyState").textContent=ready;
    const locked=target && !/尚未|未鎖定|—/.test(target); setDot("simpleTargetDot",locked?"good":"idle");
    const rn=Number(q("readinessScore")?.textContent||"");
    setDot("simpleReadyDot",Number.isFinite(rn)&&rn>=80?"good":(Number.isFinite(rn)&&rn>0?"warn":"idle"));
    const syncText=q("syncCloudBadge")?.textContent || q("syncStateBadge")?.textContent || "本機可用";
    const syncGood=/連線|ready|正常|已|本機可用/i.test(syncText);
    if (q("simpleSyncState")) q("simpleSyncState").textContent=syncGood?(/連線|ready|正常|已/i.test(syncText)?"已同步/可用":"本機可用"):"需檢查";
    setDot("simpleSyncDot",syncGood?"good":"warn");
    if (pill) {
      const dot=q("statusDot"), state=[...(dot?.classList||[])].find(x=>x!=="status-dot")||"idle";
      pill.className=`simple-state-pill ${state}`; pill.textContent=status;
    }
    const valid=setupComplete();
    if (q("simpleStartBtn") && q("startBtn")) q("simpleStartBtn").disabled=!valid || q("startBtn").disabled;
    if (q("simpleResumeBtn") && q("resumeBtn")) q("simpleResumeBtn").disabled=q("resumeBtn").disabled;
    if (q("simpleStopBtn") && q("stopBtn")) q("simpleStopBtn").disabled=q("stopBtn").disabled;
    if (/CAPTCHA|OTP|登入|Queue|驗證|人工/i.test(status) && !/完成|通過/i.test(status)) showNotice("需要你處理網站驗證；完成後按「我已完成驗證，繼續」。","warn");
  };
  const guardedClick = (button, fn, busyText) => {
    const now=Date.now(); if (now<clickGuardUntil) return;
    clickGuardUntil=now+700;
    const old=button?.textContent||"";
    if (button) { button.classList.add("is-busy"); if (busyText) button.textContent=busyText; }
    try { fn(); } finally { setTimeout(()=>{ if(button){button.classList.remove("is-busy"); button.textContent=old;} },700); }
  };
  const init = async () => {
    bindMirror("simpleTargetUrl","targetUrl"); bindMirror("simpleSaleDate","saleDate"); bindMirror("simpleSaleTime","saleTime"); bindMirror("simpleQuantity","quantity"); bindMirror("simpleMaxPrice","maxPrice");
    q("simpleUseCurrentBtn")?.addEventListener("click",()=>{ q("useCurrentBtn")?.click(); setTimeout(()=>{copyValue(q("targetUrl"),q("simpleTargetUrl"));renderSetupSummary();},180); });
    q("simpleEditSetupBtn")?.addEventListener("click",()=>{setSetupCollapsed(false); q("simpleTargetUrl")?.focus();});
    ["simpleTargetUrl","simpleSaleDate","simpleSaleTime","simpleQuantity","simpleMaxPrice"].forEach(id=>{
      q(id)?.addEventListener("input",()=>{showNotice("");renderSetupSummary();}); q(id)?.addEventListener("change",()=>{showNotice("");renderSetupSummary();});
    });
    q("simpleMaxPrice")?.addEventListener("keydown",ev=>{ if(ev.key==="Enter"&&setupComplete()){ev.preventDefault();setSetupCollapsed(true);q("simplePreflightBtn")?.focus();} });
    q("simpleQuantity")?.addEventListener("keydown",ev=>{ if(ev.key==="Enter"&&setupComplete()&&!(q("simpleMaxPrice")?.value||"").trim()){ev.preventDefault();setSetupCollapsed(true);q("simplePreflightBtn")?.focus();} });
    q("simplePreflightBtn")?.addEventListener("click",()=>{
      const v=validateSetup(true); if(!v.ok)return;
      const btn=q("simplePreflightBtn"); guardedClick(btn,()=>{setSetupCollapsed(true);q("preflightBtn")?.click();showNotice("正在檢查目前頁面…","good");},"檢查中…");
    });
    q("simpleStartBtn")?.addEventListener("click",()=>{
      const v=validateSetup(true); if(!v.ok)return;
      const btn=q("simpleStartBtn"); guardedClick(btn,()=>{
        setSetupCollapsed(true);
        const mode=q("operationMode"); if(mode&&mode.value!=="dry"&&mode.value!=="live"){mode.value="live";fireInput(mode);}
        q("startBtn")?.click(); showNotice("已進入待命；需要你處理時會直接提示。","good");
      },"啟動中…");
    });
    q("simpleResumeBtn")?.addEventListener("click",()=>guardedClick(q("simpleResumeBtn"),()=>q("resumeBtn")?.click(),"繼續中…"));
    q("simpleStopBtn")?.addEventListener("click",()=>guardedClick(q("simpleStopBtn"),()=>q("stopBtn")?.click(),"停止中…"));
    q("uiModeToggleBtn")?.addEventListener("click",()=>setMode(!document.body.classList.contains("advanced-active")));
    q("openAdvancedBtn")?.addEventListener("click",()=>setMode(true));
    ["countdown","statusText","targetLockText","readinessText","readinessScore","statusDot","syncCloudBadge","syncStateBadge"].forEach(id=>{const el=q(id);if(el)new MutationObserver(syncStatus).observe(el,{subtree:true,childList:true,characterData:true,attributes:true});});

    let saved={}; try { saved=(await chrome.storage.local.get(UI_STATE_KEY))?.[UI_STATE_KEY]||{}; } catch(_){}
    /* Always open in simple mode for the everyday workflow; advanced remains one tap away. */
    setMode(false,false); syncStatus();
    setTimeout(()=>{
      ["targetUrl","saleDate","saleTime","quantity","maxPrice"].forEach((id,i)=>copyValue(q(id),q(["simpleTargetUrl","simpleSaleDate","simpleSaleTime","simpleQuantity","simpleMaxPrice"][i])));
      renderSetupSummary(); setSetupCollapsed(setupComplete() && saved.setupCollapsed!==false,false); syncStatus();
    },350);
    document.addEventListener("keydown",ev=>{
      if(!document.body.classList.contains("simple-active")||ev.ctrlKey||ev.metaKey||ev.altKey)return;
      if(ev.key==="Escape"&&q("simpleSetupCard")?.classList.contains("is-collapsed")){setSetupCollapsed(false);q("simpleTargetUrl")?.focus();}
    });
  };
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true}); else init();
})();


/* QuickBuy UI */
(() => {
  const q = id => document.getElementById(id);
  const ONBOARDING_KEY = "qbaOnboardingState";
  const VERSION = QBA_APP_VERSION;
  const pages = [
    { title:"開始這裡", src:"開始這裡_QuickBuy.html", kind:"html" },
    { title:"分享與還原", kind:"share" }
  ];
  let pageIndex = 1;
  const setOpen = (el, open) => {
    if (!el) return;
    el.hidden = !open;
    el.setAttribute("aria-hidden", open ? "false" : "true");
    document.body.classList.toggle("guide-open", !!document.querySelector(".guide-modal:not([hidden])"));
  };
  const rememberIfRequested = async () => {
    if (!q("onboardingDontShow")?.checked) return;
    try { await chrome.storage.local.set({ [ONBOARDING_KEY]: { dismissed:true, dismissedAt:Date.now(), version:VERSION } }); } catch (_) {}
  };
  const renderTutorial = () => {
    const p = pages[pageIndex];
    if (!p) return;
    q("tutorialTitle").textContent = p.title;
    const imageMode=p.kind!=="share";
    if (q("tutorialImageWrap")) q("tutorialImageWrap").hidden=!imageMode;
    if (q("tutorialSharePanel")) q("tutorialSharePanel").hidden=imageMode;
    if (imageMode && q("tutorialImage")) {
      q("tutorialImage").src = p.src;
      q("tutorialImage").alt = `QuickBuy 使用說明：${p.title}`;
    }
    q("tutorialPageText").textContent = `${pageIndex + 1} / ${pages.length}`;
    q("tutorialPrevBtn").disabled = pageIndex <= 0;
    q("tutorialNextBtn").disabled = pageIndex >= pages.length - 1;
    q("tutorialInstallTab").classList.toggle("active", pageIndex === 0);
    q("tutorialQuickTab").classList.toggle("active", pageIndex === 1);
    q("tutorialShareTab")?.classList.toggle("active", pageIndex === 2);
    const wrap=q("tutorialImageWrap"); if (wrap) wrap.scrollTop=0;
  };
  const openTutorial = async index => {
    pageIndex = Math.max(0, Math.min(pages.length - 1, Number(index ?? 1)));
    await rememberIfRequested();
    setOpen(q("onboardingModal"), false);
    renderTutorial();
    setOpen(q("tutorialModal"), true);
  };
  const closeTutorial = () => setOpen(q("tutorialModal"), false);
  const closeOnboarding = async () => { await rememberIfRequested(); setOpen(q("onboardingModal"), false); };
  const initGuide = async () => {
    q("helpBtn")?.addEventListener("click", () => openTutorial(1));
    q("onboardingStartBtn")?.addEventListener("click", async()=>{try{const raw=await chrome.storage.local.get('qbaSimpleUiState');await chrome.storage.local.set({qbaSimpleUiState:{...(raw?.qbaSimpleUiState||{}),advanced:false,firstRunRecommended:true,updatedAt:Date.now()}});}catch(_){} await closeOnboarding(); setTimeout(()=>q('simplePlatformQuickPick')?.querySelector('button')?.focus?.(),80);});
    q("onboardingCloseBtn")?.addEventListener("click", closeOnboarding);
    q("onboardingInstallBtn")?.addEventListener("click", () => openTutorial(0));
    q("onboardingQuickBtn")?.addEventListener("click", () => openTutorial(1));
    q("onboardingCheckBtn")?.addEventListener("click", async()=>{
      const box=q("onboardingHealth"); if (!box) return; box.hidden=false; box.innerHTML='<div class="guide-health-row"><i>…</i><span>正在檢查安裝狀態</span><b>請稍候</b></div>';
      try {
        const rows=await globalThis.QBAFamilyPack?.runInstallCheck?.();
        box.innerHTML=(rows||[]).map(r=>`<div class="guide-health-row ${r.state||''}"><i>${r.state==='good'?'✓':r.state==='warn'?'!':'•'}</i><span>${escapeHtml(r.label||'檢查')}</span><b>${escapeHtml(r.text||'')}</b></div>`).join('') || '<div class="guide-health-row warn"><i>!</i><span>檢查模組尚未就緒</span><b>可直接開始</b></div>';
        const warns=(rows||[]).filter(r=>r.state==='warn').length; const start=q('onboardingStartBtn'); if(start) start.textContent=warns?'有提醒，仍可使用簡易模式':'體檢完成，開始使用';
      } catch(e) { box.innerHTML=`<div class="guide-health-row warn"><i>!</i><span>檢查失敗</span><b>${escapeHtml(e.message||'未知錯誤')}</b></div>`; }
    });
    q("onboardingImportBtn")?.addEventListener("click",()=>q("onboardingImportFile")?.click());
    q("onboardingImportFile")?.addEventListener("change",async ev=>{try{const r=await globalThis.QBAFamilyPack?.importPack?.(ev.target?.files?.[0]); const box=q("onboardingHealth"); if(box){box.hidden=false;box.innerHTML=`<div class="guide-health-row good"><i>✓</i><span>分享包匯入完成</span><b>${Number(r?.shortcuts||0)} 個快捷網站</b></div>`;}}catch(e){const box=q("onboardingHealth");if(box){box.hidden=false;box.innerHTML=`<div class="guide-health-row warn"><i>!</i><span>匯入失敗</span><b>${escapeHtml(e.message||'')}</b></div>`;}}finally{if(ev.target)ev.target.value='';}});
    q("tutorialCloseBtn")?.addEventListener("click", closeTutorial);
    q("tutorialInstallTab")?.addEventListener("click", () => { pageIndex=0; renderTutorial(); });
    q("tutorialQuickTab")?.addEventListener("click", () => { pageIndex=1; renderTutorial(); });
    q("tutorialShareTab")?.addEventListener("click", () => { pageIndex=2; renderTutorial(); });
    q("tutorialFamilyExportBtn")?.addEventListener("click",()=>{try{globalThis.QBAFamilyPack?.exportPack?.();}catch(e){addLog(`分享包建立失敗：${e.message}`,'error');}});
    q("tutorialFamilyImportBtn")?.addEventListener("click",()=>q("tutorialFamilyImportFile")?.click());
    q("tutorialFamilyImportFile")?.addEventListener("change",async ev=>{try{const r=await globalThis.QBAFamilyPack?.importPack?.(ev.target?.files?.[0]);addLog(`已匯入家人分享包：${Number(r?.shortcuts||0)} 個快捷網站。`,'success');}catch(e){addLog(`分享包匯入失敗：${e.message}`,'error');}finally{if(ev.target)ev.target.value='';}});
    q("tutorialSupportBtn")?.addEventListener("click",()=>exportSupportBundle());
    q("tutorialPrevBtn")?.addEventListener("click", () => { if(pageIndex>0){pageIndex--;renderTutorial();} });
    q("tutorialNextBtn")?.addEventListener("click", () => { if(pageIndex<pages.length-1){pageIndex++;renderTutorial();} });
    [q("onboardingModal"),q("tutorialModal")].forEach(modal => modal?.addEventListener("click", ev => {
      if (ev.target === modal) { if(modal===q("onboardingModal")) closeOnboarding(); else closeTutorial(); }
    }));
    document.addEventListener("keydown", ev => {
      if (ev.key !== "Escape") return;
      if (!q("tutorialModal")?.hidden) closeTutorial();
      else if (!q("onboardingModal")?.hidden) closeOnboarding();
    });
    try {
      const state=(await chrome.storage.local.get(ONBOARDING_KEY))?.[ONBOARDING_KEY] || {};
      if (!state.dismissed) setTimeout(() => { setOpen(q("onboardingModal"), true); setTimeout(()=>q("onboardingCheckBtn")?.click(),160); }, 220);
    } catch (_) { setTimeout(() => { setOpen(q("onboardingModal"), true); setTimeout(()=>q("onboardingCheckBtn")?.click(),160); }, 220); }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initGuide, {once:true}); else initGuide();
})();


/* 1.0 data center: health, safe backup/restore, one-click recovery, family sharing and support bundle. */
(() => {
  const q=id=>document.getElementById(id);
  const setOpen=(open)=>{const modal=q('dataCenterModal');if(!modal)return;modal.hidden=!open;modal.setAttribute('aria-hidden',open?'false':'true');document.body.classList.toggle('guide-open',!!document.querySelector('.guide-modal:not([hidden])'));};
  const notice=(text,kind='')=>{const el=q('dataCenterNotice');if(!el)return;el.hidden=!text;el.textContent=text||'';el.className=`simple-notice data-center-notice ${kind}`.trim();};
  const renderRows=rows=>{const box=q('dataCenterHealth');if(!box)return;box.hidden=false;box.innerHTML=(rows||[]).map(r=>`<div class="guide-health-row ${r.state||''}"><i>${r.state==='good'?'✓':r.state==='warn'?'!':'•'}</i><span>${escapeHtml(r.label||'檢查')}</span><b>${escapeHtml(r.text||'')}</b></div>`).join('')||'<div class="guide-health-row warn"><i>!</i><span>目前沒有檢查結果</span><b>請重新執行</b></div>';};
  async function refreshSummary(){
    try{
      const all=await chrome.storage.local.get(['qbaLastInstallCheck','qbaLastBackupAt','qbaLastBackupFingerprint','qbaRepairRecoveryPoints']);
      const c=all.qbaLastInstallCheck;
      if(q('dataInstallSummary')) q('dataInstallSummary').textContent=c?.at?`${Number(c.warn||0)===0?'正常':'有提醒'} · ${new Date(c.at).toLocaleString('zh-TW',{hour12:false})}`:'尚未檢查';
      if(q('dataBackupSummary')) q('dataBackupSummary').textContent=all.qbaLastBackupAt?new Date(all.qbaLastBackupAt).toLocaleString('zh-TW',{hour12:false}):'尚未備份';
      if(q('dataBackupFingerprint')) q('dataBackupFingerprint').textContent=all.qbaLastBackupFingerprint?`${String(all.qbaLastBackupFingerprint).slice(0,12)}…`:'尚未建立';
      const rp=Array.isArray(all.qbaRepairRecoveryPoints)?all.qbaRepairRecoveryPoints:[];
      if(q('dataRecoverySummary')) q('dataRecoverySummary').textContent=rp[0]?.at?new Date(rp[0].at).toLocaleString('zh-TW',{hour12:false}):'尚未建立';
      if(q('dataRecoveryRestoreBtn')) q('dataRecoveryRestoreBtn').disabled=!rp.length;
    }catch(_){ }
  }
  async function runCheck(){
    const box=q('dataCenterHealth');if(box){box.hidden=false;box.innerHTML='<div class="guide-health-row"><i>…</i><span>正在檢查</span><b>請稍候</b></div>';}
    notice('');
    try{const rows=await globalThis.QBAFamilyPack?.runInstallCheck?.();renderRows(rows);const warns=(rows||[]).filter(x=>x.state==='warn').length;notice(warns?`體檢完成：${warns} 項提醒；開賣提醒可選用。`:'體檢完成：目前狀態正常。',warns?'warn':'good');await refreshSummary();}
    catch(e){notice(`體檢失敗：${e.message||'未知錯誤'}`,'warn');}
  }
  async function openCenter(){setOpen(true);notice('');await refreshSummary();try{const c=(await chrome.storage.local.get('qbaLastInstallCheck'))?.qbaLastInstallCheck;if(c?.rows?.length)renderRows(c.rows);}catch(_){}}
  async function init(){
    q('dataCenterBtn')?.addEventListener('click',openCenter);
    q('dataCenterCloseBtn')?.addEventListener('click',()=>setOpen(false));
    q('dataCenterModal')?.addEventListener('click',e=>{if(e.target===q('dataCenterModal'))setOpen(false);});
    q('dataRunCheckBtn')?.addEventListener('click',runCheck);
    q('dataBackupBtn')?.addEventListener('click',async()=>{try{const r=await exportSafeBackup();notice('安全備份已下載；個人聯絡資料與敏感資訊未匯出。','good');await refreshSummary();return r;}catch(e){notice(`備份失敗：${e.message}`,'warn');}});
    q('dataRestoreBtn')?.addEventListener('click',()=>q('dataRestoreFile')?.click());
    q('dataRestoreFile')?.addEventListener('change',async e=>{try{const r=await importSafeBackup(e.target?.files?.[0]);notice(r?.ok?'安全備份已合併還原；匯入前復原點已自動建立。':`還原失敗：${r?.error||'未知錯誤'}`,r?.ok?'good':'warn');await refreshSummary();}finally{if(e.target)e.target.value='';}});
    q('dataRecoveryCreateBtn')?.addEventListener('click',async()=>{try{await createRepairRecoveryPoint('資料中心手動復原點');notice('復原點已建立。之後若設定變動不如預期，可從這裡一鍵回復。','good');await refreshSummary();}catch(e){notice(`建立復原點失敗：${e.message}`,'warn');}});
    q('dataRecoveryRestoreBtn')?.addEventListener('click',async()=>{try{const r=await restoreLatestRepairRecoveryPoint();notice(r?.ok?'已回復最近復原點；個人聯絡資料維持目前內容。':`回復失敗：${r?.error||'未知錯誤'}`,r?.ok?'good':'warn');await refreshSummary();}catch(e){notice(`回復失敗：${e.message}`,'warn');}});
    q('dataFamilyExportBtn')?.addEventListener('click',()=>{try{globalThis.QBAFamilyPack?.exportPack?.();notice('家人分享包已建立；只包含快捷網站與常用平台排序。','good');}catch(e){notice(`分享包建立失敗：${e.message}`,'warn');}});
    q('dataFamilyImportBtn')?.addEventListener('click',()=>q('dataFamilyImportFile')?.click());
    q('dataFamilyImportFile')?.addEventListener('change',async e=>{try{const r=await globalThis.QBAFamilyPack?.importPack?.(e.target?.files?.[0]);notice(`分享包匯入完成：${Number(r?.shortcuts||0)} 個快捷網站、${Number(r?.platforms||0)} 個常用平台。`,'good');}catch(err){notice(`分享包匯入失敗：${err.message}`,'warn');}finally{if(e.target)e.target.value='';}});
    q('dataSupportBtn')?.addEventListener('click',async()=>{try{await exportSupportBundle();notice('診斷支援包已下載；個資與網址敏感參數已去識別化。','good');}catch(e){notice(`診斷包建立失敗：${e.message}`,'warn');}});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!q('dataCenterModal')?.hidden)setOpen(false);});
    await refreshSummary();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();

/* QuickBuy UI */
(() => {
  const q = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const PLATFORM_PREFS_KEY = "qbaPlatformLauncherPrefsV1";
  const CUSTOM_SHORTCUTS_KEY = "qbaCustomShortcutsV1";
  let launcherPrefs = { recent: [] };
  let customShortcuts = [];
  let platformSearch = "";

  const SHORTCUT_CATEGORY_LABELS = Object.freeze({ticket:"售票",shop:"商城",event:"活動",other:"其他"});
  let customShortcutFilter = "all";
  let customShortcutSearch = "";
  let editingShortcutId = "";

  function sanitizeShortcutUrl(raw) {
    return QBA_PLATFORM_CATALOG.sanitizeTargetUrl(raw);
  }

  function normalizeShortcutCategory(value) {
    const v=String(value||"").trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(SHORTCUT_CATEGORY_LABELS,v) ? v : "other";
  }

  function inferShortcutCategory(url, title="") {
    try {
      const known=globalThis.QBA_PLATFORM_CATALOG?.detect?.(url);
      if (known) return known.category === "shopping" ? "shop" : "ticket";
      const u=new URL(url), text=`${u.hostname} ${u.pathname} ${title}`.toLowerCase();
      if (/(?:shop|store|mall|product|merch|goods|商品|商城|商店)/i.test(text)) return "shop";
      if (/(?:event|activity|show|expo|展覽|活動|展演)/i.test(text)) return "event";
    } catch (_) {}
    return "other";
  }

  function shortcutNameFallback(url, title="") {
    const clean=String(title||"").replace(/\s+/g," ").trim();
    if (clean) return clean.slice(0,40);
    try { return new URL(url).hostname.replace(/^www\./,"").slice(0,40); } catch (_) { return "我的網站"; }
  }

  function normalizeShortcut(raw={}) {
    const url=sanitizeShortcutUrl(raw.url);
    if (!url) return null;
    const id=String(raw.id||"").trim() || `qbs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    const category=normalizeShortcutCategory(raw.category || inferShortcutCategory(url,raw.name));
    return {
      id:id.slice(0,80),
      name:shortcutNameFallback(url,raw.name),
      url,
      category,
      pinned:!!raw.pinned,
      createdAt:Number(raw.createdAt||Date.now()),
      lastUsedAt:Number(raw.lastUsedAt||0),
      updatedAt:Number(raw.updatedAt||raw.createdAt||Date.now())
    };
  }

  async function loadCustomShortcuts() {
    try {
      const raw=(await chrome.storage.local.get(CUSTOM_SHORTCUTS_KEY))?.[CUSTOM_SHORTCUTS_KEY];
      customShortcuts=(Array.isArray(raw)?raw:[]).map(normalizeShortcut).filter(Boolean).slice(0,24);
    } catch (_) { customShortcuts=[]; }
    return customShortcuts;
  }

  async function saveCustomShortcuts() {
    customShortcuts=customShortcuts.map(normalizeShortcut).filter(Boolean).slice(0,24);
    try { await chrome.storage.local.set({[CUSTOM_SHORTCUTS_KEY]:customShortcuts}); } catch (_) {}
    renderCustomShortcuts();
  }

  function orderedCustomShortcuts() {
    const query=customShortcutSearch.trim().toLowerCase();
    return [...customShortcuts]
      .filter(item=>customShortcutFilter==="all" || item.category===customShortcutFilter)
      .filter(item=>!query || `${item.name} ${item.url} ${SHORTCUT_CATEGORY_LABELS[item.category]||""}`.toLowerCase().includes(query))
      .sort((a,b)=>Number(b.pinned)-Number(a.pinned) || Number(b.lastUsedAt||0)-Number(a.lastUsedAt||0) || Number(b.updatedAt||0)-Number(a.updatedAt||0));
  }

  function renderShortcutFilterState() {
    q("simpleShortcutFilters")?.querySelectorAll?.("button[data-shortcut-filter]").forEach(btn=>btn.classList.toggle("active",btn.dataset.shortcutFilter===customShortcutFilter));
  }

  function renderCustomShortcuts() {
    const host=q("simpleCustomShortcutList");
    if (!host) return;
    const rows=orderedCustomShortcuts();
    renderShortcutFilterState();
    if (!customShortcuts.length) { host.innerHTML='<div class="simple-custom-shortcut-empty">尚未收藏網站。可直接收藏目前分頁。</div>'; return; }
    if (!rows.length) { host.innerHTML='<div class="simple-custom-shortcut-empty">沒有符合目前搜尋 / 分類的快捷網站。</div>'; return; }
    host.innerHTML=rows.map(item=>{
      let display=item.url; try { const u=new URL(item.url); display=`${u.hostname}${u.pathname==='/'?'':u.pathname}`; } catch (_) {}
      const cat=SHORTCUT_CATEGORY_LABELS[item.category] || SHORTCUT_CATEGORY_LABELS.other;
      return `<div class="simple-custom-shortcut-card" data-shortcut-id="${esc(item.id)}">
        <button type="button" class="simple-custom-shortcut-open" data-action="open"><b>${esc(item.name)}</b><span class="shortcut-meta"><span class="shortcut-cat">${esc(cat)}</span><span class="shortcut-url">${esc(display)}</span></span></button>
        <button type="button" class="simple-custom-shortcut-tool" data-action="edit" title="編輯" aria-label="編輯">✎</button>
        <button type="button" class="simple-custom-shortcut-tool${item.pinned?' pinned':''}" data-action="pin" title="${item.pinned?'取消置頂':'置頂'}" aria-label="${item.pinned?'取消置頂':'置頂'}">★</button>
        <button type="button" class="simple-custom-shortcut-tool" data-action="delete" title="刪除" aria-label="刪除">×</button>
      </div>`;
    }).join("");
  }

  function showShortcutForm(prefill={}) {
    const form=q("simpleCustomShortcutForm"); if (!form) return;
    editingShortcutId=String(prefill.id||"");
    form.hidden=false;
    if (q("simpleCustomShortcutName")) q("simpleCustomShortcutName").value=String(prefill.name||"").slice(0,40);
    if (q("simpleCustomShortcutUrl")) q("simpleCustomShortcutUrl").value=String(prefill.url||"");
    if (q("simpleCustomShortcutCategory")) q("simpleCustomShortcutCategory").value=normalizeShortcutCategory(prefill.category||inferShortcutCategory(prefill.url||"",prefill.name||""));
    setTimeout(()=>q("simpleCustomShortcutName")?.focus(),20);
  }

  function hideShortcutForm() {
    editingShortcutId="";
    if (q("simpleCustomShortcutForm")) q("simpleCustomShortcutForm").hidden=true;
  }

  async function upsertShortcut({id="",name,url,title="",category=""}={}) {
    const safeUrl=sanitizeShortcutUrl(url);
    if (!safeUrl) throw new Error("請輸入有效的 http / https 網址。");
    const normalizedCategory=normalizeShortcutCategory(category || inferShortcutCategory(safeUrl,name||title));
    const byId=id ? customShortcuts.find(x=>x.id===id) : null;
    const existing=byId || customShortcuts.find(x=>x.url===safeUrl);
    if (existing) {
      const duplicate=customShortcuts.find(x=>x.id!==existing.id && x.url===safeUrl);
      if (duplicate) throw new Error("這個網址已經收藏過。請編輯原本項目。");
      existing.url=safeUrl;
      existing.name=shortcutNameFallback(safeUrl,name||title||existing.name);
      existing.category=normalizedCategory;
      existing.updatedAt=Date.now();
      if (!byId) existing.lastUsedAt=Date.now();
    } else {
      if (customShortcuts.length>=24) throw new Error("快捷網站最多 24 個，請先刪除不需要的項目。");
      customShortcuts.push(normalizeShortcut({name:name||title,url:safeUrl,category:normalizedCategory,lastUsedAt:Date.now(),updatedAt:Date.now()}));
    }
    await saveCustomShortcuts();
    return existing || customShortcuts.find(x=>x.url===safeUrl);
  }

  async function saveCurrentPageShortcut() {
    try {
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      const safeUrl=sanitizeShortcutUrl(tab?.url||"");
      if (!safeUrl) throw new Error("目前分頁不是可收藏的 http / https 網頁。");
      await upsertShortcut({url:safeUrl,title:tab?.title||"",category:inferShortcutCategory(safeUrl,tab?.title||"")});
      if (q("simpleNotice")) { q("simpleNotice").hidden=false; q("simpleNotice").textContent="已收藏目前頁面；其他裝置同步後也會看到。"; }
    } catch (e) {
      if (q("simpleNotice")) { q("simpleNotice").hidden=false; q("simpleNotice").textContent=`收藏失敗：${e.message}`; }
    }
  }

  async function openCustomShortcut(id) {
    const item=customShortcuts.find(x=>x.id===id); if (!item) return;
    item.lastUsedAt=Date.now(); await saveCustomShortcuts();
    writeTargetUrl(item.url); await refreshPlatformCompatibility();
    try { await chrome.tabs.create({url:item.url,active:true}); } catch (_) {}
  }

  function shortcutPackPayload() {
    return {
      format:"quickbuy-shortcuts-pack",version:1,exportedAt:new Date().toISOString(),
      shortcuts:customShortcuts.map(x=>({id:x.id,name:x.name,url:sanitizeShortcutUrl(x.url),category:normalizeShortcutCategory(x.category),pinned:!!x.pinned,createdAt:Number(x.createdAt||0),updatedAt:Number(x.updatedAt||0)})).filter(x=>x.url)
    };
  }

  function exportShortcutPack() {
    if (!customShortcuts.length) throw new Error("目前沒有可匯出的快捷網站。");
    downloadJson(`QuickBuy快捷網站_${new Date().toISOString().slice(0,10)}.json`,shortcutPackPayload());
  }

  async function importShortcutPack(file) {
    if (!file) return;
    if (file.size>128*1024) throw new Error("快捷網站匯入檔超過 128 KB。 ");
    const data=JSON.parse(await file.text());
    if (!data || data.format!=="quickbuy-shortcuts-pack" || Number(data.version)!==1 || !Array.isArray(data.shortcuts)) throw new Error("這不是 QuickBuy 快捷網站分享檔。");
    const incoming=data.shortcuts.slice(0,24).map(normalizeShortcut).filter(Boolean);
    const merged=new Map(customShortcuts.map(x=>[x.url,x]));
    for (const item of incoming) {
      const old=merged.get(item.url);
      merged.set(item.url,old ? {...old,...item,id:old.id,pinned:old.pinned||item.pinned,updatedAt:Math.max(Number(old.updatedAt||0),Number(item.updatedAt||0))} : item);
    }
    customShortcuts=[...merged.values()].slice(0,24);
    await saveCustomShortcuts();
    return incoming.length;
  }

  function familyPackPayload() {
    const validIds=new Set((globalThis.QBA_PLATFORM_CATALOG?.list?.()||[]).map(x=>x.id));
    return {
      format:"quickbuy-family-pack", version:1, appVersion:QBA_APP_VERSION, exportedAt:new Date().toISOString(),
      data:{
        launcherPrefs:{recent:(launcherPrefs.recent||[]).filter(id=>validIds.has(id)).slice(0,6)},
        shortcuts:shortcutPackPayload().shortcuts
      },
      privacy:"No credentials, payment data, cookies, tokens, personal profile fields or runtime mission data."
    };
  }

  function exportFamilyPack() {
    const payload=familyPackPayload();
    downloadJson(`QuickBuy家人分享包_${new Date().toISOString().slice(0,10)}.json`,payload);
    return payload;
  }

  async function importFamilyPack(file) {
    if (!file) throw new Error("請先選擇 QuickBuy 家人分享包。");
    if (file.size>256*1024) throw new Error("分享包超過 256 KB 安全上限。");
    const data=JSON.parse(await file.text());
    if (!data || data.format!=="quickbuy-family-pack" || Number(data.version)!==1 || !data.data) throw new Error("這不是有效的 QuickBuy 家人分享包。");
    const shortcuts=Array.isArray(data.data.shortcuts)?data.data.shortcuts:[];
    const incoming=shortcuts.slice(0,24).map(normalizeShortcut).filter(Boolean);
    const merged=new Map(customShortcuts.map(x=>[x.url,x]));
    for (const item of incoming) {
      const old=merged.get(item.url);
      merged.set(item.url,old?{...old,...item,id:old.id,pinned:old.pinned||item.pinned,updatedAt:Math.max(Number(old.updatedAt||0),Number(item.updatedAt||0))}:item);
    }
    customShortcuts=[...merged.values()].slice(0,24);
    const validIds=new Set((globalThis.QBA_PLATFORM_CATALOG?.list?.()||[]).map(x=>x.id));
    const remoteRecent=Array.isArray(data.data.launcherPrefs?.recent)?data.data.launcherPrefs.recent.filter(id=>validIds.has(id)).slice(0,6):[];
    launcherPrefs={recent:[...remoteRecent,...(launcherPrefs.recent||[]).filter(id=>!remoteRecent.includes(id)&&validIds.has(id))].slice(0,6)};
    await chrome.storage.local.set({[CUSTOM_SHORTCUTS_KEY]:customShortcuts,[PLATFORM_PREFS_KEY]:launcherPrefs});
    renderCustomShortcuts(); renderRecentPlatform(); renderQuickPick();
    return {shortcuts:incoming.length,platforms:remoteRecent.length};
  }

  async function runInstallCheck() {
    const rows=[];
    const manifest=chrome.runtime.getManifest?.()||{};
    rows.push({state:manifest.manifest_version===3?'good':'warn',label:'QuickBuy 擴充功能',text:`v${manifest.version||QBA_APP_VERSION}`});
    rows.push({state:chrome.sidePanel?'good':'warn',label:'瀏覽器 Side Panel',text:chrome.sidePanel?'可用':'不支援'});
    try { const key='qbaInstallProbe'; await chrome.storage.local.set({[key]:Date.now()}); const got=(await chrome.storage.local.get(key))?.[key]; await chrome.storage.local.remove(key); rows.push({state:got?'good':'warn',label:'本機資料儲存',text:got?'正常':'異常'}); } catch(_) { rows.push({state:'warn',label:'本機資料儲存',text:'無法寫入'}); }
    const catalogCount=globalThis.QBA_PLATFORM_CATALOG?.list?.()?.length||0;
    rows.push({state:catalogCount>=10?'good':'warn',label:'平台辨識資料',text:`${catalogCount} 個平台（售票 + 購物）`});
    try {
      const ping=await chrome.runtime.sendMessage({type:"QBA_SELF_TEST_PING"}).catch(()=>null);
      rows.push({state:ping?.ok && ping?.version===QBA_APP_VERSION && ping?.buildId===QBA_BUILD_ID?'good':'warn',label:'背景服務',text:ping?.ok?`v${ping.version||'?'} · ${ping.buildId||'build?'}`:'未回應'});
    } catch(_) { rows.push({state:'warn',label:'背景服務',text:'無法檢查'}); }
    try {
      const files=['開始這裡_QuickBuy.html'];
      const checks=await Promise.all(files.map(name=>fetch(chrome.runtime.getURL(name),{cache:'no-store'}).then(r=>r.ok).catch(()=>false)));
      rows.push({state:checks.every(Boolean)?'good':'warn',label:'內建教學',text:checks.every(Boolean)?'3 個入口正常':`${checks.filter(Boolean).length} / ${checks.length} 可讀`});
    } catch(_) { rows.push({state:'warn',label:'內建教學',text:'讀取失敗'}); }
    const summary={at:Date.now(),version:QBA_APP_VERSION,buildId:QBA_BUILD_ID,good:rows.filter(x=>x.state==='good').length,warn:rows.filter(x=>x.state==='warn').length,rows};
    try { await chrome.storage.local.set({qbaLastInstallCheck:summary}); } catch (_) {}
    return rows;
  }

  async function handleCustomShortcutAction(id,action) {
    const item=customShortcuts.find(x=>x.id===id); if (!item) return;
    if (action==="open") return openCustomShortcut(id);
    if (action==="edit") { showShortcutForm(item); return; }
    if (action==="pin") { item.pinned=!item.pinned; item.updatedAt=Date.now(); await saveCustomShortcuts(); return; }
    if (action==="delete") { customShortcuts=customShortcuts.filter(x=>x.id!==id); await saveCustomShortcuts(); }
  }

  async function loadLauncherPrefs() {
    try {
      const raw=(await chrome.storage.local.get(PLATFORM_PREFS_KEY))?.[PLATFORM_PREFS_KEY];
      const recent=Array.isArray(raw?.recent) ? raw.recent.filter(x=>typeof x==="string").slice(0,6) : [];
      launcherPrefs={recent};
    } catch (_) { launcherPrefs={recent:[]}; }
    return launcherPrefs;
  }

  async function rememberPlatform(platformId) {
    if (!platformId) return;
    const next=[platformId,...(launcherPrefs.recent||[]).filter(x=>x!==platformId)].slice(0,6);
    launcherPrefs={recent:next};
    try { await chrome.storage.local.set({[PLATFORM_PREFS_KEY]:launcherPrefs}); } catch (_) {}
  }

  async function clearRecentPlatforms() {
    launcherPrefs={recent:[]};
    try { await chrome.storage.local.remove(PLATFORM_PREFS_KEY); } catch (_) {}
    renderQuickPick();
    renderRecentPlatform();
  }

  function orderedCatalog(category="") {
    const rows=globalThis.QBA_PLATFORM_CATALOG?.list?.() || [];
    const rank=new Map((launcherPrefs.recent||[]).map((id,index)=>[id,index]));
    return [...rows].filter(x=>!category || x.category===category).sort((a,b)=>{
      const ar=rank.has(a.id)?rank.get(a.id):999, br=rank.has(b.id)?rank.get(b.id):999;
      return ar-br || rows.findIndex(x=>x.id===a.id)-rows.findIndex(x=>x.id===b.id);
    });
  }

  function renderRecentPlatform() {
    const row=q("simpleRecentPlatformRow"), name=q("simpleRecentPlatformName"), btn=q("simpleRecentPlatformBtn");
    if (!row || !name || !btn) return;
    const id=(launcherPrefs.recent||[])[0];
    const platform=(globalThis.QBA_PLATFORM_CATALOG?.list?.()||[]).find(p=>p.id===id);
    row.hidden=!platform;
    if (!platform) { btn.dataset.platformId=""; name.textContent="—"; return; }
    btn.dataset.platformId=platform.id;
    name.textContent=platform.name;
  }

  async function currentCandidateUrl() {
    const preferred = String(q("simpleTargetUrl")?.value || q("targetUrl")?.value || "").trim();
    try { const u = new URL(preferred); if (/^https?:$/.test(u.protocol)) return u.href; } catch (_) {}
    try {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      if (tab?.url && /^https?:/i.test(tab.url)) return tab.url;
    } catch (_) {}
    return "";
  }

  function sameUrlBase(a, b) {
    try {
      const x=new URL(a), y=new URL(b);
      const xp=(x.pathname||"/").replace(/\/+$/,"")||"/";
      const yp=(y.pathname||"/").replace(/\/+$/,"")||"/";
      return x.origin===y.origin && xp===yp;
    } catch (_) { return false; }
  }

  function writeTargetUrl(url) {
    const value=String(url||"").trim();
    [q("simpleTargetUrl"),q("targetUrl")].forEach(el=>{
      if (!el) return;
      el.value=value;
      el.dispatchEvent(new Event("input",{bubbles:true}));
      el.dispatchEvent(new Event("change",{bubbles:true}));
    });
  }

  async function adoptActiveIfSamePlatform(tab) {
    const mod=globalThis.QBA_PLATFORM_CATALOG;
    if (!mod || !tab?.url || !/^https?:/i.test(tab.url)) return false;
    const configured=String(q("simpleTargetUrl")?.value || q("targetUrl")?.value || "").trim();
    const selected=mod.detect?.(configured);
    const active=mod.detect?.(tab.url);
    if (!selected || !active || selected.id!==active.id || !selected.homepage) return false;
    if (!sameUrlBase(configured, selected.homepage) || sameUrlBase(tab.url, selected.homepage)) return false;
    writeTargetUrl(tab.url);
    return true;
  }

  async function syncTargetFromActivePlatform({allowBlank=true}={}) {
    const mod=globalThis.QBA_PLATFORM_CATALOG;
    if (!mod) return false;
    let tab=null;
    try { [tab]=await chrome.tabs.query({active:true,currentWindow:true}); } catch (_) { return false; }
    if (!tab?.url || !/^https?:/i.test(tab.url)) return false;
    const active=mod.detect?.(tab.url);
    if (!active) return false;
    const configured=String(q("simpleTargetUrl")?.value || q("targetUrl")?.value || "").trim();
    if (!configured && allowBlank) {
      writeTargetUrl(tab.url);
      await refreshPlatformCompatibility();
      return true;
    }
    const changed=await adoptActiveIfSamePlatform(tab);
    if (changed) await refreshPlatformCompatibility();
    return changed;
  }

  async function selectPlatform(platformId) {
    const mod=globalThis.QBA_PLATFORM_CATALOG;
    const platform=(mod?.list?.()||[]).find(p=>p.id===platformId);
    if (!platform?.homepage) return;
    let target=platform.homepage;
    try {
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      const active=mod.detect?.(tab?.url||"");
      if (active?.id===platform.id && tab?.url && /^https?:/i.test(tab.url)) target=tab.url;
    } catch (_) {}
    writeTargetUrl(target);
    await rememberPlatform(platform.id);
    renderRecentPlatform();
    renderQuickPick(platform.id);
    await refreshPlatformCompatibility();
    if (sameUrlBase(target, platform.homepage)) {
      try { await chrome.tabs.create({url:platform.homepage,active:true}); } catch (_) {}
    }
  }

  function renderQuickPick(activeId="") {
    const query=platformSearch.trim().toLowerCase();
    const newest=(launcherPrefs.recent||[])[0] || "";
    const renderGroup=(category,hostId,countId)=>{
      const host=q(hostId); if(!host) return;
      const all=orderedCatalog(category);
      const rows=all.filter(p=>!query || `${p.name} ${p.shortName} ${p.categoryLabel||''}`.toLowerCase().includes(query));
      if(q(countId)) q(countId).textContent=query?`${rows.length} / ${all.length}`:String(all.length);
      host.innerHTML=rows.length ? rows.map(p=>`<button type="button" data-platform-id="${esc(p.id)}" class="${p.id===activeId?'active':''}" title="開啟 ${esc(p.name)}"><span>${esc(p.shortName)}</span><small>${p.id===newest?'最近':'開官網'}</small></button>`).join("") : '<div class="simple-platform-empty">沒有符合搜尋的平台</div>';
    };
    renderGroup('ticket','simpleTicketPlatformQuickPick','simpleTicketPlatformCount');
    renderGroup('shopping','simpleShoppingPlatformQuickPick','simpleShoppingPlatformCount');
  }

  function setSimple(platform, hasUrl) {
    const label=q("simplePlatformState"), dot=q("simplePlatformDot");
    if (!label || !dot) return;
    if (!hasUrl) {
      label.textContent="等待網址";
      dot.className="simple-dot idle";
      return;
    }
    if (!platform) {
      label.textContent="通用辨識";
      dot.className="simple-dot warn";
      return;
    }
    label.textContent=`${platform.categoryLabel||"平台"} · ${platform.shortName} · ${platform.status}`;
    dot.className="simple-dot good";
  }

  function renderCatalog(activeId="") {
    const host=q("platformCompatCatalog");
    const catalog=globalThis.QBA_PLATFORM_CATALOG?.list?.() || [];
    if (!host) return;
    if (!catalog.length) { host.innerHTML='<div class="timeline-empty">平台 Catalog 未載入</div>'; return; }
    host.innerHTML=catalog.map(p=>{
      const active=p.id===activeId;
      const phases=(p.phases||[]).slice(0,5).join(" → ") + ((p.phases||[]).length>5 ? " …" : "");
      return `<div class="platform-compat-row${active?' active':''}">
        <div class="platform-compat-row-head"><b>${esc(p.categoryLabel||'平台')} · ${esc(p.name)}</b><em>${esc(active?'目前平台':p.status)}</em></div>
        <p>${esc(phases || '流程待補')} · 真站乾跑：${esc(p.liveDryRunStatus==='verified'?'已驗證':'待驗')}</p>
      </div>`;
    }).join("");
  }

  function renderRegression() {
    const host=q("platformRegressionList");
    const cases=globalThis.QBA_PLATFORM_CATALOG?.regressionCases?.() || [];
    if (q("platformRegressionCount")) q("platformRegressionCount").textContent=`${cases.length} 案例`;
    if (!host) return;
    host.innerHTML=cases.length ? cases.map(c=>`<div class="platform-regression-item"><b>${esc(c.expected)} · ${esc(c.rule)}</b><p>${esc(c.input)}</p></div>`).join("") : '<div class="timeline-empty">尚無案例</div>';
  }

  async function refreshPlatformCompatibility() {
    const mod=globalThis.QBA_PLATFORM_CATALOG;
    const url=await currentCandidateUrl();
    const platform=mod?.detect?.(url) || null;
    const info=platform ? mod.compact(platform) : null;
    setSimple(info, !!url);
    renderQuickPick(info?.id || "");
    renderCatalog(info?.id || "");
    renderRegression();

    if (q("platformCompatName")) q("platformCompatName").textContent=info?.name || (url ? "未列入平台 Catalog" : "—");
    if (q("platformCompatLevel")) q("platformCompatLevel").textContent=info?.status || (url ? "通用辨識" : "—");
    if (q("platformCompatPhases")) q("platformCompatPhases").textContent=info?.phases?.join(" → ") || "—";
    if (q("platformCompatMobile")) q("platformCompatMobile").textContent=info?.mobileNote || (url ? "依網站實際流程" : "—");
    if (q("platformCompatState")) {
      q("platformCompatState").textContent=info ? (info.category==="shopping" ? `${info.shortName} 已辨識 · 購物快捷 / 狀態模型可用 · 最終送單與付款人工確認` : `${info.shortName} 已辨識 · ${info.status} · 真站乾跑待驗`) : (url ? "目前網址使用 QuickBuy 通用辨識；尚未列入平台 Catalog。" : "等待目標網址");
      q("platformCompatState").className=`profile-state ${info?'good':''}`.trim();
    }
  }

  async function initPlatformCompatibility() {
    await loadLauncherPrefs();
    q("platformCompatRefreshBtn")?.addEventListener("click", refreshPlatformCompatibility);
    q("simplePlatformQuickPick")?.addEventListener("click", event=>{
      const btn=event.target?.closest?.("button[data-platform-id]");
      if (btn?.dataset?.platformId) selectPlatform(btn.dataset.platformId);
    });
    q("simpleRecentPlatformBtn")?.addEventListener("click", event=>{
      const id=event.currentTarget?.dataset?.platformId;
      if (id) selectPlatform(id);
    });
    q("simpleClearRecentPlatformBtn")?.addEventListener("click", clearRecentPlatforms);
    q("simplePlatformSearch")?.addEventListener("input",event=>{ platformSearch=String(event.target?.value||""); renderQuickPick(); });
    q("simpleSaveCurrentShortcutBtn")?.addEventListener("click", saveCurrentPageShortcut);
    q("simpleAddShortcutBtn")?.addEventListener("click",()=>showShortcutForm());
    q("simpleCustomShortcutCancelBtn")?.addEventListener("click",hideShortcutForm);
    q("simpleCustomShortcutSaveBtn")?.addEventListener("click",async()=>{
      try {
        await upsertShortcut({
          id:editingShortcutId,
          name:q("simpleCustomShortcutName")?.value||"",
          url:q("simpleCustomShortcutUrl")?.value||"",
          category:q("simpleCustomShortcutCategory")?.value||"other"
        });
        hideShortcutForm();
      } catch (e) {
        if (q("simpleNotice")) { q("simpleNotice").hidden=false; q("simpleNotice").textContent=`儲存失敗：${e.message}`; }
      }
    });
    q("simpleShortcutSearch")?.addEventListener("input",event=>{ customShortcutSearch=String(event.target?.value||""); renderCustomShortcuts(); });
    q("simpleShortcutFilters")?.addEventListener("click",event=>{
      const btn=event.target?.closest?.("button[data-shortcut-filter]"); if (!btn) return;
      customShortcutFilter=String(btn.dataset.shortcutFilter||"all"); renderCustomShortcuts();
    });
    q("simpleFamilyPackExportBtn")?.addEventListener("click",()=>{
      try { exportFamilyPack(); if(q("simpleNotice")){q("simpleNotice").hidden=false;q("simpleNotice").textContent="已建立安全家人分享包；不含帳密、付款資料、Cookie、Token 或執行任務。";} } catch (e) { if (q("simpleNotice")) { q("simpleNotice").hidden=false; q("simpleNotice").textContent=`分享失敗：${e.message}`; } }
    });
    q("simpleFamilyPackImportBtn")?.addEventListener("click",()=>q("simpleFamilyPackImportFile")?.click());
    q("simpleFamilyPackImportFile")?.addEventListener("change",async event=>{
      try { const r=await importFamilyPack(event.target?.files?.[0]); if(q("simpleNotice")){q("simpleNotice").hidden=false;q("simpleNotice").textContent=`分享包匯入完成：${Number(r.shortcuts||0)} 個快捷網站、${Number(r.platforms||0)} 個常用平台。`;} }
      catch(e){if(q("simpleNotice")){q("simpleNotice").hidden=false;q("simpleNotice").textContent=`分享包匯入失敗：${e.message}`;}}
      finally{if(event.target)event.target.value="";}
    });
    q("simpleShortcutExportBtn")?.addEventListener("click",()=>{
      try { exportShortcutPack(); } catch (e) { if (q("simpleNotice")) { q("simpleNotice").hidden=false; q("simpleNotice").textContent=`匯出失敗：${e.message}`; } }
    });
    q("simpleShortcutImportBtn")?.addEventListener("click",()=>q("simpleShortcutImportFile")?.click());
    q("simpleShortcutImportFile")?.addEventListener("change",async event=>{
      try {
        const count=await importShortcutPack(event.target?.files?.[0]);
        if (q("simpleNotice")) { q("simpleNotice").hidden=false; q("simpleNotice").textContent=`已匯入 ${count||0} 個快捷網站；重複網址已安全合併。`; }
      } catch (e) {
        if (q("simpleNotice")) { q("simpleNotice").hidden=false; q("simpleNotice").textContent=`匯入失敗：${e.message}`; }
      } finally { if (event.target) event.target.value=""; }
    });
    q("simpleCustomShortcutList")?.addEventListener("click",event=>{
      const card=event.target?.closest?.("[data-shortcut-id]");
      const btn=event.target?.closest?.("button[data-action]");
      if (card?.dataset?.shortcutId && btn?.dataset?.action) handleCustomShortcutAction(card.dataset.shortcutId,btn.dataset.action);
    });
    ["simpleTargetUrl","targetUrl"].forEach(id=>{
      q(id)?.addEventListener("input",()=>setTimeout(refreshPlatformCompatibility,60));
      q(id)?.addEventListener("change",()=>setTimeout(refreshPlatformCompatibility,60));
    });
    q("simpleUseCurrentBtn")?.addEventListener("click",()=>setTimeout(refreshPlatformCompatibility,260));
    let activeSyncTimer=0;
    const scheduleActiveSync=()=>{
      clearTimeout(activeSyncTimer);
      activeSyncTimer=setTimeout(()=>syncTargetFromActivePlatform({allowBlank:true}),180);
    };
    try {
      chrome.tabs.onActivated?.addListener?.(scheduleActiveSync);
      chrome.tabs.onUpdated?.addListener?.((tabId,changeInfo,tab)=>{
        if (tab?.active && (changeInfo.url || changeInfo.status==="complete")) scheduleActiveSync();
      });
    } catch (_) {}
    await loadCustomShortcuts();
    renderCustomShortcuts();
    renderRecentPlatform();
    renderQuickPick();
    renderCatalog();
    renderRegression();
    refreshPlatformCompatibility();
    setTimeout(()=>syncTargetFromActivePlatform({allowBlank:true}),220);
  }

  async function refreshLibrary(){
    await loadLauncherPrefs();
    await loadCustomShortcuts();
    renderCustomShortcuts();
    renderRecentPlatform();
    renderQuickPick();
    return {shortcuts:customShortcuts.length,recent:(launcherPrefs.recent||[]).length};
  }

  globalThis.QBA_PLATFORM_LAUNCHER=Object.freeze({selectPlatform,adoptActiveIfSamePlatform,syncTargetFromActivePlatform,refreshLibrary});
  globalThis.QBAFamilyPack=Object.freeze({exportPack:exportFamilyPack,importPack:importFamilyPack,runInstallCheck,familyPackPayload});
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPlatformCompatibility, {once:true}); else initPlatformCompatibility();
})();
