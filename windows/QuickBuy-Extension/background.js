importScripts("platform-catalog.js");
const QBA_APP_VERSION = "1.0.0";
const QBA_BUILD_ID = "2026-09-20.windows-runtime.1";
const QBA_STORAGE_SCHEMA = 3;
const QBA_ARCHIVE_LIMIT = 30;
const QBA_RECOVERY_STUB_KEY = "qbaActiveRecoveryStub";
const QBA_LOCAL_LIMITS = Object.freeze({
  qbaTaskTemplates: 50, qbaRulePacks: 50, qbaPlatformProfiles: 50, qbaRuleBackups: 40,
  qbaPlatformProfileBackups: 30, qbaRunArchives: 30, qbaProfileLabCases: 16, qbaRepairRecoveryPoints: 3
});


const QBA_MAINTENANCE_ALARM = "qbaLifecycleMaintenance";
const QBA_MAINTENANCE_PERIOD_MIN = 1;
const QBA_SCHEDULE_ALARM = "qbaScheduledMission";
const QBA_ARMED_MISSION_KEY = "qbaArmedMission";
const QBA_LAST_MISSION_RESULT_KEY = "qbaLastMissionResult";

async function ensureMaintenanceAlarm() {
  try {
    const existing = await chrome.alarms.get(QBA_MAINTENANCE_ALARM);
    if (!existing || Number(existing.periodInMinutes || 0) !== QBA_MAINTENANCE_PERIOD_MIN) {
      await chrome.alarms.clear(QBA_MAINTENANCE_ALARM);
      chrome.alarms.create(QBA_MAINTENANCE_ALARM, { periodInMinutes: QBA_MAINTENANCE_PERIOD_MIN });
    }
    return true;
  } catch (_) { return false; }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === QBA_MAINTENANCE_ALARM) void runBackgroundMaintenance("alarm:lifecycle");
  if (alarm?.name === QBA_SCHEDULE_ALARM) void launchArmedMission("alarm:scheduled");
});

// v2.7: serialize lifecycle/runtime/archive mutations so near-simultaneous messages cannot overwrite each other.
const qbaLockTails = new Map();
async function withQbaLock(key, task) {
  const previous = qbaLockTails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  qbaLockTails.set(key, tail);
  await previous.catch(() => {});
  try { return await task(); }
  finally {
    release();
    if (qbaLockTails.get(key) === tail) qbaLockTails.delete(key);
  }
}

function newRunId(tabId, startedAt) {
  try { return crypto.randomUUID(); }
  catch (_) { return `run-${startedAt}-${tabId}-${Math.random().toString(36).slice(2, 12)}`; }
}


chrome.runtime.onInstalled.addListener((details) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void ensureMaintenanceAlarm();
  void ensureArmedMissionAlarm().catch(() => {});
  void runBackgroundMaintenance(`onInstalled:${details?.reason || "unknown"}`);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void ensureMaintenanceAlarm();
  void ensureArmedMissionAlarm().catch(() => {});
  void runBackgroundMaintenance("onStartup");
});

void ensureMaintenanceAlarm();
void ensureArmedMissionAlarm().catch(() => {});

async function normalizeLocalStorageShape() {
  const all = await chrome.storage.local.get(null);
  const patch = {};
  for (const [key, limit] of Object.entries(QBA_LOCAL_LIMITS)) {
    const value = all[key];
    if (value == null) continue;
    patch[key] = Array.isArray(value) ? value.slice(0, limit) : [];
  }
  if (all.qbaSiteProfiles != null && (!all.qbaSiteProfiles || typeof all.qbaSiteProfiles !== "object" || Array.isArray(all.qbaSiteProfiles))) patch.qbaSiteProfiles = {};
  patch.qbaStorageSchema = QBA_STORAGE_SCHEMA;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

async function reconcileOrphanSessions() {
  const sessions = await getSessionEntries();
  let removed = 0;
  for (const session of sessions) {
    try {
      await chrome.tabs.get(session.tabId);
      try { await chrome.tabs.update(session.tabId, { autoDiscardable: false }); } catch (_) {}
    } catch (_) {
      await archiveAndClearSession(session.tabId, "orphan_session_cleanup", session.runId || "");
      removed++;
    }
  }
  return { active: Math.max(0, sessions.length - removed), removed };
}

async function runBackgroundMaintenance(reason = "manual") {
  const startedAt = Date.now();
  try {
    await ensureMaintenanceAlarm();
    await ensureArmedMissionAlarm();
    await normalizeLocalStorageShape();
    const sessionResult = await reconcileOrphanSessions();
    const interruptedRecovery = await reconcileInterruptedRecovery(reason);
    await syncKeepAwake();
    const sessions = await getSessionEntries();
    let staleHeartbeats = 0;
    for (const session of sessions) {
      const key = runtimeKey(session.tabId);
      const stored = await chrome.storage.session.get(key);
      const hbAt = Number(stored[key]?.heartbeatAt || 0);
      if (hbAt && Date.now() - hbAt > 120000) staleHeartbeats++;
    }
    const result = { ok: true, version: QBA_APP_VERSION, schemaVersion: QBA_STORAGE_SCHEMA, reason, activeSessions: sessionResult.active, orphanSessionsRemoved: sessionResult.removed, interruptedRecoveryArchived: Boolean(interruptedRecovery?.archived), interruptionReason: interruptedRecovery?.reason || "", staleHeartbeats, lifecycleAlarm: true, startedAt, finishedAt: Date.now() };
    await chrome.storage.local.set({ qbaLastMaintenance: result });
    return result;
  } catch (error) {
    const result = { ok: false, version: QBA_APP_VERSION, schemaVersion: QBA_STORAGE_SCHEMA, reason, error: error?.message || String(error), startedAt, finishedAt: Date.now() };
    try { await chrome.storage.local.set({ qbaLastMaintenance: result }); } catch (_) {}
    return result;
  }
}

function sanitizeArchiveUrl(urlString = "") {
  try {
    const u = new URL(urlString);
    if (!/^https?:$/.test(u.protocol)) return "";
    return `${u.origin}${u.pathname || "/"}`;
  } catch (_) { return ""; }
}

function sanitizeMissionTargetUrl(urlString = "") {
  return QBA_PLATFORM_CATALOG.sanitizeTargetUrl(urlString);
}

function redactSensitiveRuntimeText(value = "") {
  let text = String(value ?? "");
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, match => sanitizeArchiveUrl(match) || "[REDACTED_URL]");
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
  text = text.replace(/(?:\+?886[-\s]?)?0?9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, "[REDACTED_PHONE]");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]");
  text = text.replace(/\b(token|session|sessionid|auth|access[_-]?token|refresh[_-]?token|code)=([^\s&]+)/gi, "$1=[REDACTED]");
  return text.slice(0, 2000);
}

function sanitizeStatusForArchive(status) {
  if (!status || typeof status !== "object") return null;
  return {
    code: String(status.code || "").slice(0, 80),
    message: redactSensitiveRuntimeText(status.message || ""),
    ts: Number(status.ts || 0),
    challengeType: status.challengeType ? String(status.challengeType).slice(0, 80) : null,
    buttonText: status.buttonText ? redactSensitiveRuntimeText(status.buttonText).slice(0, 200) : null
  };
}

function sanitizeRuntimeEventForArchive(event) {
  if (!event || typeof event !== "object") return null;
  const out = { ts: Number(event.ts || 0) };
  for (const key of ["kind", "level", "code"]) if (event[key] != null) out[key] = String(event[key]).slice(0, 80);
  for (const key of ["message", "label", "title"]) if (event[key] != null) out[key] = redactSensitiveRuntimeText(event[key]).slice(0, 1000);
  if (event.url) out.url = sanitizeArchiveUrl(event.url);
  return out;
}

function sanitizeNetworkSampleForArchive(sample) {
  if (!sample || typeof sample !== "object") return null;
  return {
    at: Number(sample.at || 0),
    status: Number(sample.status || 0),
    rttMs: Math.max(0, Number(sample.rttMs || 0)),
    ok: Boolean(sample.ok),
    error: sample.error ? redactSensitiveRuntimeText(sample.error).slice(0, 500) : ""
  };
}

function sanitizeMetaForArchive(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const out = {};
  for (const key of ["id", "name", "version", "source", "score", "matches", "conflicts"]) {
    if (meta[key] == null) continue;
    if (["score", "matches", "conflicts"].includes(key)) out[key] = Number(meta[key] || 0);
    else out[key] = String(meta[key]).slice(0, 160);
  }
  if (Array.isArray(meta.capabilities)) out.capabilities = meta.capabilities.slice(0, 30).map(x => String(x).slice(0, 80));
  return Object.keys(out).length ? out : null;
}

function sanitizePageStateForArchive(state) {
  if (!state || typeof state !== "object") return null;
  return {
    ...state,
    url: sanitizeArchiveUrl(state.url || ""),
    title: redactSensitiveRuntimeText(state.title || "").slice(0, 300)
  };
}

function sanitizeArchiveConfig(config = {}) {
  return {
    targetUrl: sanitizeArchiveUrl(config.targetUrl || ""),
    targetOrigin: config.targetOrigin || "",
    saleTimeTs: Number(config.saleTimeTs || 0),
    quantity: Number(config.quantity || 1),
    maxPrice: Number(config.maxPrice || 0),
    maxTotal: Number(config.maxTotal || 0),
    fulfillmentPreset: ["ibon_pickup","ibon_pickup_pay"].includes(config.fulfillmentPreset) ? config.fulfillmentPreset : "",
    intervalMs: Number(config.intervalMs || 1500),
    operationMode: "live",
    ruleMode: config.ruleMode || "auto",
    platformProfileMode: config.platformProfileMode || "auto",
    priorities: Array.isArray(config.priorities) ? config.priorities.slice(0, 30) : [],
    platformProfileMeta: sanitizeMetaForArchive(config.platformProfileMeta),
    siteRuleMeta: sanitizeMetaForArchive(config.siteRuleMeta)
  };
}

async function writeRecoveryStub(tabId, config, startedAt, patch = {}) {
  if (!tabId || !startedAt) return;
  return withQbaLock("recovery-stub", async () => {
    const local = await chrome.storage.local.get(QBA_RECOVERY_STUB_KEY);
    const prev = local[QBA_RECOVERY_STUB_KEY];
    const same = prev && Number(prev.tabId) === Number(tabId) && Number(prev.startedAt) === Number(startedAt) && (!config?.runId || !prev.runId || prev.runId === config.runId);
    const stub = {
      schemaVersion: QBA_STORAGE_SCHEMA,
      appVersion: QBA_APP_VERSION,
      tabId: Number(tabId),
      runId: String(config?.runId || (same ? prev?.runId : "") || ""),
      startedAt: Number(startedAt),
      lastSeenAt: Date.now(),
      config: sanitizeArchiveConfig(config || prev?.config || {}),
      lastStatus: same ? (prev.lastStatus || null) : null,
      lastPageState: same ? (prev.lastPageState || null) : null,
      ...patch
    };
    if (stub.lastPageState) stub.lastPageState = sanitizePageStateForArchive(stub.lastPageState);
    await chrome.storage.local.set({ [QBA_RECOVERY_STUB_KEY]: stub });
  });
}

async function clearRecoveryStub(tabId, startedAt = 0, runId = "") {
  return withQbaLock("recovery-stub", async () => {
    const local = await chrome.storage.local.get(QBA_RECOVERY_STUB_KEY);
    const stub = local[QBA_RECOVERY_STUB_KEY];
    if (!stub) return false;
    if (tabId && Number(stub.tabId) !== Number(tabId)) return false;
    if (startedAt && Number(stub.startedAt) !== Number(startedAt)) return false;
    if (runId && stub.runId && String(stub.runId) !== String(runId)) return false;
    await chrome.storage.local.remove(QBA_RECOVERY_STUB_KEY);
    return true;
  });
}

async function reconcileInterruptedRecovery(reason = "maintenance") {
  const local = await chrome.storage.local.get([QBA_RECOVERY_STUB_KEY, "qbaRunArchives"]);
  const stub = local[QBA_RECOVERY_STUB_KEY];
  if (!stub || !Number(stub.startedAt)) return { archived: false, reason: "no_stub" };
  const sessions = await getSessionEntries();
  const stillActive = sessions.some(x => Number(x.tabId) === Number(stub.tabId) && Number(x.startedAt) === Number(stub.startedAt));
  if (stillActive) return { archived: false, reason: "session_still_active" };

  const endedAt = Date.now();
  let interruptionReason = "session_storage_interrupted";
  if (String(reason).startsWith("onStartup")) interruptionReason = "browser_restart_interrupted";
  else if (String(reason).startsWith("onInstalled:update")) interruptionReason = "extension_update_interrupted";
  else if (String(reason).startsWith("onInstalled")) interruptionReason = "extension_reload_interrupted";

  const archives = Array.isArray(local.qbaRunArchives) ? local.qbaRunArchives : [];
  const stubRunId = String(stub.runId || "");
  const archiveId = `run-${Number(stub.startedAt)}-${Number(stub.tabId || 0)}${stubRunId ? `-${stubRunId.slice(0, 12)}` : ""}`;
  const item = {
    schemaVersion: QBA_STORAGE_SCHEMA,
    archiveId,
    runId: stubRunId,
    tabId: Number(stub.tabId || 0),
    reason: interruptionReason,
    startedAt: Number(stub.startedAt),
    endedAt,
    durationMs: Math.max(0, endedAt - Number(stub.startedAt)),
    config: sanitizeArchiveConfig(stub.config || {}),
    finalStatus: sanitizeStatusForArchive(stub.lastStatus) || { code: "INTERRUPTED", message: "任務因瀏覽器或擴充功能重新啟動而中斷，未自動恢復 Live 操作。", ts: endedAt },
    finalPageState: sanitizePageStateForArchive(stub.lastPageState),
    transitions: stub.lastPageState ? [sanitizePageStateForArchive(stub.lastPageState)].filter(Boolean) : [],
    events: [{ kind: "session", message: "任務因瀏覽器或擴充功能重新啟動而中斷；基於安全考量未自動恢復 Live 操作。", ts: endedAt }],
    networkSamples: []
  };
  await withQbaLock("archives", async () => {
    const fresh = await chrome.storage.local.get("qbaRunArchives");
    const current = Array.isArray(fresh.qbaRunArchives) ? fresh.qbaRunArchives : archives;
    const next = [item, ...current.filter(x => x?.archiveId !== archiveId)].slice(0, QBA_ARCHIVE_LIMIT);
    await chrome.storage.local.set({ qbaRunArchives: next, qbaStorageSchema: QBA_STORAGE_SCHEMA });
  });
  await clearRecoveryStub(Number(stub.tabId || 0), Number(stub.startedAt), stubRunId);
  return { archived: true, reason: interruptionReason, archiveId };
}

async function archiveSession(tabId, reason = "stopped") {
  if (!tabId) return null;
  const sKey = sessionKey(tabId), rKey = runtimeKey(tabId);
  const stored = await chrome.storage.session.get([sKey, rKey]);
  const session = stored[sKey] || null;
  const runtime = stored[rKey] || null;
  if (!session && !runtime) return null;
  const startedAt = Number(session?.startedAt || runtime?.sessionStartedAt || 0);
  if (!startedAt) return null;
  const runId = String(session?.runId || runtime?.runId || "");
  const endedAt = Date.now();
  const item = {
    schemaVersion: QBA_STORAGE_SCHEMA,
    archiveId: `run-${startedAt}-${tabId}${runId ? `-${runId.slice(0, 12)}` : ""}`,
    runId,
    tabId,
    reason,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    config: sanitizeArchiveConfig(session?.config || {}),
    finalStatus: sanitizeStatusForArchive(runtime?.status),
    finalPageState: sanitizePageStateForArchive(runtime?.pageState),
    transitions: Array.isArray(runtime?.transitions) ? runtime.transitions.slice(0, 100).map(sanitizePageStateForArchive).filter(Boolean) : [],
    events: Array.isArray(runtime?.events) ? runtime.events.slice(0, 500).map(sanitizeRuntimeEventForArchive).filter(Boolean) : [],
    networkSamples: Array.isArray(runtime?.networkSamples) ? runtime.networkSamples.slice(0, 120).map(sanitizeNetworkSampleForArchive).filter(Boolean) : []
  };
  await withQbaLock("archives", async () => {
    const local = await chrome.storage.local.get(["qbaRunArchives"]);
    const archives = Array.isArray(local.qbaRunArchives) ? local.qbaRunArchives : [];
    const next = [item, ...archives.filter(x => x?.archiveId !== item.archiveId)].slice(0, QBA_ARCHIVE_LIMIT);
    await chrome.storage.local.set({ qbaRunArchives: next, qbaStorageSchema: QBA_STORAGE_SCHEMA });
  });
  await clearRecoveryStub(tabId, startedAt, runId);
  return item;
}

async function archiveAndClearSession(tabId, reason = "stopped", expectedRunId = "") {
  if (!tabId) return { archived: null, cleared: false };
  return withQbaLock(`runtime:${tabId}`, async () => {
    const active = await getActiveSessionForRun(tabId);
    if (expectedRunId && active?.runId && String(active.runId) !== String(expectedRunId)) return { archived: null, cleared: false, stale: true };
    const archived = await archiveSession(tabId, reason);
    await chrome.storage.session.remove([sessionKey(tabId), runtimeKey(tabId)]);
    focusWarnedTabs.delete(tabId);
    return { archived, cleared: true, runId: active?.runId || expectedRunId || "" };
  });
}

const focusWarnedTabs = new Set();

async function getSessionEntries() {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith("qbaSession_"))
    .map(([key, value]) => ({ tabId: Number(key.slice("qbaSession_".length)), ...value }))
    .filter(x => Number.isInteger(x.tabId));
}

async function stopOtherSessions(exceptTabId) {
  const sessions = await getSessionEntries();
  for (const session of sessions) {
    if (session.tabId === exceptTabId) continue;
    await archiveAndClearSession(session.tabId, "replaced_by_new_session", session.runId || "");
    try { await chrome.tabs.sendMessage(session.tabId, { type: "QBA_STOP", runId: session.runId || "" }); } catch (_) {}
    try { await chrome.tabs.update(session.tabId, { autoDiscardable: true }); } catch (_) {}
  }
}

async function getLatestActiveSession() {
  const sessions = await getSessionEntries();
  if (!sessions.length) return null;
  sessions.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
  const session = sessions[0];
  let tab = null;
  try { tab = await chrome.tabs.get(session.tabId); } catch (_) {}
  return { ...session, tab };
}

async function syncClockFromSite(url) {
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) return { ok: false, error: "只支援 http / https 網站校時。" };
  const rootUrl = `${target.origin}/`;
  const samples = [];
  let lastError = "網站沒有提供可用的時間資訊。";

  const sampleOnce = async (requestUrl, method = "HEAD") => {
    const t0 = Date.now();
    const response = await fetch(requestUrl, { method, cache: "no-store", credentials: "include", redirect: "follow" });
    const t1 = Date.now();
    const dateHeader = response.headers.get("date");
    if (!dateHeader) throw new Error("網站回應沒有 Date 標頭。");
    const serverMs = Date.parse(dateHeader);
    if (!Number.isFinite(serverMs)) throw new Error("網站時間格式無法辨識。");
    const midpoint = (t0 + t1) / 2;
    return {
      offsetMs: Math.round(serverMs - midpoint),
      rttMs: t1 - t0,
      serverDate: dateHeader,
      finalUrl: response.url || requestUrl,
      method
    };
  };

  for (let i = 0; i < 5; i++) {
    try { samples.push(await sampleOnce(rootUrl, "HEAD")); }
    catch (error) { lastError = error?.message || "網站時間同步失敗。"; }
  }

  if (!samples.length) {
    try { samples.push(await sampleOnce(rootUrl, "GET")); }
    catch (error) { lastError = error?.message || "網站時間同步失敗。"; }
  }
  if (!samples.length) return { ok: false, error: lastError };

  const fastest = [...samples].sort((a, b) => a.rttMs - b.rttMs).slice(0, Math.min(3, samples.length));
  const offsets = fastest.map(x => x.offsetMs).sort((a, b) => a - b);
  const medianOffset = offsets[Math.floor(offsets.length / 2)];
  const minRtt = Math.min(...samples.map(x => x.rttMs));
  const jitterMs = offsets.length > 1 ? Math.max(...offsets) - Math.min(...offsets) : 0;
  // HTTP Date 通常只有整秒粒度；為避免假裝毫秒級精準，至少保留約 ±1 秒的不確定度。
  const uncertaintyMs = Math.round(1000 + minRtt / 2 + jitterMs / 2);
  const quality = samples.length >= 3 && uncertaintyMs <= 1250 ? "good" : samples.length >= 2 && uncertaintyMs <= 1800 ? "fair" : "low";
  const best = [...samples].sort((a, b) => a.rttMs - b.rttMs)[0];
  return {
    ok: true,
    offsetMs: medianOffset,
    rttMs: minRtt,
    jitterMs,
    uncertaintyMs,
    quality,
    samples: samples.length,
    serverDate: best.serverDate,
    finalUrl: best.finalUrl,
    method: best.method
  };
}


function scheduledMissionSummary(mission = {}) {
  if (!mission || typeof mission !== "object") return null;
  return {
    id: String(mission.id || ""),
    state: String(mission.state || "armed"),
    armedAt: Number(mission.armedAt || 0),
    startAt: Number(mission.startAt || 0),
    saleTimeTs: Number(mission.saleTimeTs || 0),
    graceMs: Number(mission.graceMs || 0),
    targetUrl: sanitizeArchiveUrl(mission.targetUrl || ""),
    operationMode: String(mission.config?.operationMode || "")
  };
}

async function getArmedMission() {
  const local = await chrome.storage.local.get([QBA_ARMED_MISSION_KEY, QBA_LAST_MISSION_RESULT_KEY]);
  const mission = local[QBA_ARMED_MISSION_KEY] || null;
  return { mission, summary: scheduledMissionSummary(mission), lastResult: local[QBA_LAST_MISSION_RESULT_KEY] || null };
}

async function ensureArmedMissionAlarm() {
  return withQbaLock("scheduled-mission", async () => {
    const { mission } = await getArmedMission();
    if (!mission) { await chrome.alarms.clear(QBA_SCHEDULE_ALARM); return false; }
    if (mission.state !== "armed" || mission.buildId !== QBA_BUILD_ID ||
        !Number.isFinite(mission.startAt) || !Number.isFinite(mission.saleTimeTs) ||
        !Number.isFinite(mission.graceMs) || !sanitizeMissionTargetUrl(mission.targetUrl)) {
      await chrome.storage.local.remove(QBA_ARMED_MISSION_KEY);
      await chrome.alarms.clear(QBA_SCHEDULE_ALARM);
      await chrome.storage.local.set({ [QBA_LAST_MISSION_RESULT_KEY]: { id:mission.id, state:"disarmed", reason:"incompatible_or_interrupted_task", at:Date.now() } });
      return false;
    }
    if (Date.now() > mission.saleTimeTs + mission.graceMs) {
      await chrome.storage.local.remove(QBA_ARMED_MISSION_KEY);
      await chrome.alarms.clear(QBA_SCHEDULE_ALARM);
      await chrome.storage.local.set({ [QBA_LAST_MISSION_RESULT_KEY]: { id:mission.id, state:"missed", reason:"late_beyond_grace", at:Date.now() } });
      return false;
    }
    const alarm = await chrome.alarms.get(QBA_SCHEDULE_ALARM);
    if (!alarm || Math.abs(alarm.scheduledTime - mission.startAt) > 1000) {
      await chrome.alarms.create(QBA_SCHEDULE_ALARM, { when:Math.max(Date.now()+1000, mission.startAt) });
    }
    return true;
  });
}

async function armScheduledMission(payload = {}) {
  return withQbaLock("scheduled-mission", async () => {
    const config = payload?.config || {};
    const safeTargetUrl = sanitizeMissionTargetUrl(String(config.targetUrl || ""));
    if (!safeTargetUrl) return { ok:false, error:"目標網址無效。" };
    const target = new URL(safeTargetUrl);
    const saleTimeTs = Number(config.saleTimeTs || 0);
    if (!Number.isFinite(saleTimeTs) || saleTimeTs <= Date.now()) return { ok:false, error:"開賣時間必須在未來。" };
    const leadSec = Number(payload.leadSec ?? 300);
    if (![60,180,300,600,900,1800,3600].includes(leadSec)) return { ok:false, error:"提醒時間無效。" };
    const graceSec = Number(payload.graceSec ?? 120);
    if (!Number.isFinite(graceSec) || graceSec < 0 || graceSec > 900) return { ok:false, error:"寬限時間無效。" };
    const startAt = Math.max(Date.now() + 1000, saleTimeTs - leadSec * 1000);
    const old = (await getArmedMission()).mission;
    const mission = {
      id: (() => { try { return crypto.randomUUID(); } catch (_) { return `reminder-${Date.now()}-${Math.random().toString(36).slice(2,10)}`; } })(),
      state:"armed", buildId:QBA_BUILD_ID, leadSec, armedAt:Date.now(), startAt, saleTimeTs, graceMs:graceSec*1000,
      targetUrl: safeTargetUrl,
      config: { targetUrl: safeTargetUrl, saleTimeTs, quantity:Number(config.quantity||1), priorities:Array.isArray(config.priorities)?config.priorities.slice(0,30):[] }
    };
    await chrome.storage.local.set({ [QBA_ARMED_MISSION_KEY]: mission });
    await chrome.alarms.create(QBA_SCHEDULE_ALARM, { when:startAt });
    return { ok:true, mission:scheduledMissionSummary(mission), replacedMission:old ? scheduledMissionSummary(old) : null };
  });
}

async function disarmScheduledMission(reason = "manual_disarm") {
  return withQbaLock("scheduled-mission", async () => {
    const { mission } = await getArmedMission();
    await chrome.alarms.clear(QBA_SCHEDULE_ALARM);
    await chrome.storage.local.remove(QBA_ARMED_MISSION_KEY);
    if (mission) await chrome.storage.local.set({ [QBA_LAST_MISSION_RESULT_KEY]: { id:mission.id, state:"disarmed", reason, at:Date.now(), targetUrl:sanitizeArchiveUrl(mission.targetUrl || "") } });
    return { ok:true, hadMission:Boolean(mission), mission: mission ? scheduledMissionSummary(mission) : null };
  });
}

async function findOrOpenMissionTab(targetUrl) {
  const safe = sanitizeMissionTargetUrl(targetUrl);
  if (!safe) return null;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => sanitizeMissionTargetUrl(t.pendingUrl || t.url || "") === safe);
  if (existing?.id) {
    try {
      const tab = await chrome.tabs.update(existing.id, { active:true });
      await chrome.windows.update(tab.windowId, { focused:true });
      return tab;
    } catch (_) { /* Closed between query and activation. */ }
  }
  return chrome.tabs.create({ url:safe, active:true });
}

async function launchArmedMission(reason = "scheduled") {
  return withQbaLock("scheduled-mission", async () => {
    const { mission } = await getArmedMission();
    if (!mission) return { ok:false, skipped:true, reason:"no_reminder" };
    if (mission.state !== "armed" || mission.buildId !== QBA_BUILD_ID ||
        !Number.isFinite(mission.startAt) || !Number.isFinite(mission.saleTimeTs) ||
        !Number.isFinite(mission.graceMs) || !sanitizeMissionTargetUrl(mission.targetUrl)) {
      await chrome.storage.local.remove(QBA_ARMED_MISSION_KEY);
      await chrome.alarms.clear(QBA_SCHEDULE_ALARM);
      return { ok:false, skipped:true, reason:"invalid_task" };
    }
    if (Date.now() < mission.startAt) return { ok:false, skipped:true, reason:"not_due" };
    const now = Date.now();
    const deadline = Number(mission.saleTimeTs || 0) + Math.max(0, Number(mission.graceMs || 0));
    await chrome.alarms.clear(QBA_SCHEDULE_ALARM);
    await chrome.storage.local.remove(QBA_ARMED_MISSION_KEY);
    if (deadline && now > deadline) {
      await chrome.storage.local.set({ [QBA_LAST_MISSION_RESULT_KEY]: { id:mission.id, state:"missed", reason:"late_beyond_grace", at:now, targetUrl:sanitizeArchiveUrl(mission.targetUrl || "") } });
      return { ok:false, skipped:true, reason:"late_beyond_grace" };
    }
    await chrome.storage.local.set({ [QBA_LAST_MISSION_RESULT_KEY]: { id:mission.id, state:"claimed", reason:"at_most_once", at:now } });
    let tab = null;
    try { tab = await findOrOpenMissionTab(mission.targetUrl); } catch (_) {}
    const result = { id:mission.id, state:tab?.id ? "launched" : "failed", reason, at:now, tabId:tab?.id || null, targetUrl:sanitizeArchiveUrl(mission.targetUrl || "") };
    await chrome.storage.local.set({ [QBA_LAST_MISSION_RESULT_KEY]: result });
    try {
      await chrome.notifications.create({ type:"basic", iconUrl:"icons/icon128.png", title:"QuickBuy 開賣提醒", message:"目標網站已開啟。請確認登入、票區／規格與網站驗證狀態。", priority:1 });
    } catch (_) {}
    return { ok:Boolean(tab?.id), mission:scheduledMissionSummary(mission), tabId:tab?.id || null };
  });
}

async function injectRunner(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["rules.js", "content.js"] });
    return true;
  } catch (error) {
    await emit({ type: "QBA_LOG", level: "error", message: `無法注入目前頁面：${error.message}` });
    return false;
  }
}

async function emit(payload) {
  try { await chrome.runtime.sendMessage(payload); } catch (_) {}
}

function sessionKey(tabId) { return `qbaSession_${tabId}`; }
function runtimeKey(tabId) { return `qbaRuntime_${tabId}`; }

async function hasAnyActiveSession() {
  const all = await chrome.storage.session.get(null);
  return Object.keys(all).some(k => k.startsWith("qbaSession_"));
}

async function syncKeepAwake() {
  try {
    if (await hasAnyActiveSession()) chrome.power.requestKeepAwake("system");
    else chrome.power.releaseKeepAwake();
  } catch (_) {}
}


function defaultRuntime() { return { logs: [], status: null, transitions: [], pageState: null, events: [], networkSamples: [], sessionStartedAt: 0, runId: "", heartbeatAt: 0, heartbeat: null, lastStatusTs: 0, lastPageStateTs: 0 }; }

function insertNewestFirst(list, item, limit = 500) {
  const next = [item, ...(Array.isArray(list) ? list : [])];
  next.sort((a, b) => Number(b?.ts || b?.at || 0) - Number(a?.ts || a?.at || 0));
  return next.slice(0, limit);
}

async function getActiveSessionForRun(tabId, runId = "") {
  if (!tabId) return null;
  const key = sessionKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const session = stored[key] || null;
  if (!session) return null;
  if (runId && String(session.runId || "") !== String(runId)) return null;
  return session;
}

async function mutateRuntime(tabId, mutator, expectedRunId = "") {
  if (!tabId) return { accepted: false };
  return withQbaLock(`runtime:${tabId}`, async () => {
    if (expectedRunId && !(await getActiveSessionForRun(tabId, expectedRunId))) return { accepted: false };
    const key = runtimeKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const rt = stored[key] || defaultRuntime();
    if (expectedRunId && rt.runId && String(rt.runId) !== String(expectedRunId)) return { accepted: false };
    if (expectedRunId && !rt.runId) rt.runId = expectedRunId;
    const value = await mutator(rt);
    await chrome.storage.session.set({ [key]: rt });
    return { accepted: true, runtime: rt, value };
  });
}
async function appendRuntimeEvent(tabId, event, runId = "") {
  return mutateRuntime(tabId, rt => {
    const safeEvent = sanitizeRuntimeEventForArchive({ ts: Number(event?.ts || Date.now()), ...(event || {}) });
    if (safeEvent) rt.events = insertNewestFirst(rt.events, safeEvent, 500);
  }, runId);
}

async function appendRuntimeLog(tabId, item, runId = "") {
  return mutateRuntime(tabId, rt => {
    const safeItem = {
      message: redactSensitiveRuntimeText(item?.message || ""),
      level: String(item?.level || "info").slice(0, 40),
      ts: Number(item?.ts || Date.now())
    };
    rt.logs = insertNewestFirst(rt.logs, safeItem, 200);
    rt.events = insertNewestFirst(rt.events, { kind:"log", message:safeItem.message, level:safeItem.level, ts:safeItem.ts }, 500);
  }, runId);
}

async function setRuntimeStatus(tabId, status, runId = "") {
  const safeStatus = sanitizeStatusForArchive(status) || { code: "", message: "", ts: Date.now(), challengeType: null, buttonText: null };
  const result = await mutateRuntime(tabId, rt => {
    const incomingTs = Number(safeStatus.ts || Date.now());
    const currentTs = Number(rt.lastStatusTs || rt.status?.ts || 0);
    if (currentTs && incomingTs < currentTs) return { ignored: true, reason: "out_of_order_status", incomingTs, currentTs };
    rt.lastStatusTs = incomingTs;
    rt.status = safeStatus;
    const prev = (rt.events || [])[0];
    if (!prev || prev.kind !== "status" || prev.code !== safeStatus.code || prev.message !== safeStatus.message) rt.events = insertNewestFirst(rt.events, { kind:"status", code:safeStatus.code, message:safeStatus.message || safeStatus.code, ts:incomingTs }, 500);
    return { ignored: false };
  }, runId);
  if (!result.accepted || result.value?.ignored) return result;
  const activeSession = await getActiveSessionForRun(tabId, runId);
  if (activeSession?.startedAt) await writeRecoveryStub(tabId, activeSession.config, activeSession.startedAt, { lastStatus: safeStatus });
  return result;
}

async function appendPageState(tabId, pageState, runId = "") {
  let item = null, changed = false;
  const result = await mutateRuntime(tabId, rt => {
    item = {
      phase: String(pageState.phase || "UNKNOWN").slice(0, 80),
      label: redactSensitiveRuntimeText(pageState.label || pageState.phase || "未知").slice(0, 200),
      url: sanitizeArchiveUrl(pageState.url || ""),
      title: redactSensitiveRuntimeText(pageState.title || "").slice(0, 300),
      selectorHealth: pageState.selectorHealth || null,
      ts: Number(pageState.ts || Date.now())
    };
    const currentTs = Number(rt.lastPageStateTs || rt.pageState?.ts || 0);
    if (currentTs && item.ts < currentTs) return { ignored: true, reason: "out_of_order_page_state", incomingTs: item.ts, currentTs };
    rt.lastPageStateTs = item.ts;
    const prev = (rt.transitions || [])[0];
    const same = prev && prev.phase === item.phase && prev.url === item.url && JSON.stringify(prev.selectorHealth || null) === JSON.stringify(item.selectorHealth || null);
    rt.pageState = item;
    if (!same) {
      changed = true;
      rt.transitions = insertNewestFirst(rt.transitions, item, 100);
      rt.events = insertNewestFirst(rt.events, { kind:"page", label:item.label, message:`${item.label}${item.title ? ` · ${item.title}` : ""}`, ts:item.ts }, 500);
    }
  }, runId);
  if (!result.accepted || result.value?.ignored) return result;
  if (changed) {
    const activeSession = await getActiveSessionForRun(tabId, runId);
    if (activeSession?.startedAt) await writeRecoveryStub(tabId, activeSession.config, activeSession.startedAt, { lastPageState: item });
  }
  return result;
}

async function startSession(tabId, config) {
  return withQbaLock("lifecycle", async () => {
    if (!tabId) return { ok: false, error: "缺少目標分頁。" };

    // Starting again on the same tab is a new task: archive the previous run first.
    const existing = await getActiveSessionForRun(tabId);
    if (existing) {
      await archiveAndClearSession(tabId, "replaced_by_new_session", existing.runId || "");
      try { await chrome.tabs.sendMessage(tabId, { type: "QBA_STOP", runId: existing.runId || "" }); } catch (_) {}
    }

    await stopOtherSessions(tabId);
    const startedAt = Date.now();
    const runId = newRunId(tabId, startedAt);
    const runConfig = { ...(config || {}), runId, runStartedAt: startedAt };
    const runtime = defaultRuntime();
    runtime.sessionStartedAt = startedAt;
    runtime.runId = runId;
    runtime.events = [{ kind:"session", message:"開始新的 QuickBuy 任務", ts:startedAt }];
    await chrome.storage.session.set({
      [sessionKey(tabId)]: { config: runConfig, startedAt, runId },
      [runtimeKey(tabId)]: runtime
    });
    await writeRecoveryStub(tabId, runConfig, startedAt);
    try { chrome.power.requestKeepAwake("system"); } catch (_) {}
    try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch (_) {}

    const ok = await injectRunner(tabId);
    if (!ok) {
      await chrome.storage.session.remove([sessionKey(tabId), runtimeKey(tabId)]);
      await clearRecoveryStub(tabId, startedAt, runId);
      try { await chrome.tabs.update(tabId, { autoDiscardable: true }); } catch (_) {}
      await syncKeepAwake();
      return { ok: false, error: "無法在目前頁面啟動，請確認網站權限。" };
    }
    try {
      await chrome.tabs.sendMessage(tabId, { type: "QBA_START", config: runConfig });
      return { ok: true, runId };
    } catch (error) {
      await chrome.storage.session.remove([sessionKey(tabId), runtimeKey(tabId)]);
      await clearRecoveryStub(tabId, startedAt, runId);
      try { await chrome.tabs.update(tabId, { autoDiscardable: true }); } catch (_) {}
      await syncKeepAwake();
      return { ok: false, error: error.message };
    }
  });
}


async function stopSession(tabId) {
  return withQbaLock("lifecycle", async () => {
    const active = await getActiveSessionForRun(tabId);
    if (!active) {
      await syncKeepAwake();
      return { ok: true, alreadyStopped: true };
    }
    await archiveAndClearSession(tabId, "manual_stop", active.runId || "");
    try { await chrome.tabs.sendMessage(tabId, { type: "QBA_STOP", runId: active.runId || "" }); } catch (_) {}
    try { await chrome.tabs.update(tabId, { autoDiscardable: true }); } catch (_) {}
    await syncKeepAwake();
    return { ok: true, runId: active.runId || "" };
  });
}

async function getSnapshot(tabId) {
  const sKey = sessionKey(tabId);
  const rKey = runtimeKey(tabId);
  const stored = await chrome.storage.session.get([sKey, rKey]);
  return {
    ok: true,
    session: stored[sKey] || null,
    runtime: stored[rKey] || defaultRuntime()
  };
}

async function preflight(tabId, config) {
  const ok = await injectRunner(tabId);
  if (!ok) return { ok: false, error: "無法讀取目前頁面。" };
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "QBA_PREFLIGHT", config });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function rehearsal(tabId, config) {
  const ok = await injectRunner(tabId);
  if (!ok) return { ok: false, error: "無法讀取目前頁面。" };
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "QBA_REHEARSAL", config });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  await withQbaLock("lifecycle", async () => {
    const key = sessionKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const session = stored[key];
    if (!session) return;
    const expectedRunId = String(session.runId || "");
    const ok = await injectRunner(tabId);
    const current = await getActiveSessionForRun(tabId, expectedRunId);
    if (!current) return; // stopped/replaced while the page was loading
    if (!ok) {
      const msg = "目標頁面目前無法注入助手（可能切換到未授權網域），已停止自動操作。";
      await appendRuntimeLog(tabId, { message: msg, level: "warn", ts: Date.now() }, expectedRunId);
      await setRuntimeStatus(tabId, { code: "SITE_CHANGED", message: msg, ts: Date.now() }, expectedRunId);
      await emit({ type: "QBA_LOG", message: msg, level: "warn", ts: Date.now() });
      await emit({ type: "QBA_STATUS", code: "SITE_CHANGED", message: msg, ts: Date.now() });
      try { chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: "QuickBuy 已停止操作", message: msg, priority: 1 }); } catch (_) {}
      return;
    }
    try {
      await chrome.tabs.sendMessage(tabId, { type: "QBA_START", config: current.config, resumedAfterNavigation: true });
    } catch (_) {}
  });
});

chrome.tabs.onActivated.addListener(async ({ tabId: activatedTabId }) => {
  const sessions = await getSessionEntries();
  for (const session of sessions) {
    if (session.tabId === activatedTabId) {
      focusWarnedTabs.delete(session.tabId);
      continue;
    }
    const saleTs = Number(session.config?.saleTimeTs || 0);
    const adjustedNow = Date.now() + Number(session.config?.clockOffsetMs || 0);
    const remain = saleTs ? saleTs - adjustedNow : Infinity;
    if (remain <= 120000 && remain >= -300000 && !focusWarnedTabs.has(session.tabId)) {
      focusWarnedTabs.add(session.tabId);
      const msg = remain > 0 ? "距離開賣不到 2 分鐘，目標分頁目前在背景，建議切回目標頁。" : "目標分頁目前在背景，可能受到瀏覽器計時節流影響，建議切回目標頁。";
      await appendRuntimeLog(session.tabId, { message: msg, level: "warn", ts: Date.now() });
      await emit({ type: "QBA_LOG", message: msg, level: "warn", ts: Date.now() });
      try {
        chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: "QuickBuy 分頁提醒", message: msg, priority: 1 });
      } catch (_) {}
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await withQbaLock("lifecycle", async () => {
    const active = await getActiveSessionForRun(tabId);
    await archiveAndClearSession(tabId, "tab_closed", active?.runId || "");
    await syncKeepAwake();
  });
});


async function probeTargetNetwork(url, tabId=null, expectedRunId="") {
  let capturedRunId = String(expectedRunId || "");
  try {
    const u=new URL(url); if(!/^https?:$/.test(u.protocol)) throw new Error("只支援 http/https 網站。");
    const initialSession = tabId ? await getActiveSessionForRun(tabId, capturedRunId) : null;
    capturedRunId = String(initialSession?.runId || capturedRunId || "");
    const root=`${u.origin}/`, ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),5000), t0=performance.now();
    let response;
    try { response=await fetch(root,{method:"HEAD",cache:"no-store",credentials:"include",redirect:"follow",signal:ctl.signal}); }
    finally { clearTimeout(timer); }
    const sample={ok:true,status:response.status,rttMs:Math.max(0,Math.round(performance.now()-t0)),at:Date.now(),origin:u.origin,finalUrl:sanitizeArchiveUrl(response.url||root)};
    if(tabId && capturedRunId){ await mutateRuntime(tabId, rt=>{ rt.networkSamples=insertNewestFirst(rt.networkSamples,sample,120); rt.events=insertNewestFirst(rt.events,{kind:"network",message:`HTTP ${sample.status} · ${sample.rttMs} ms`,ts:sample.at},500); }, capturedRunId); }
    return {ok:true,sample};
  } catch(error) {
    const sample={ok:false,error:redactSensitiveRuntimeText(error?.name==="AbortError"?"逾時（5 秒）":(error?.message||"無法連線")),at:Date.now()};
    if(tabId && capturedRunId){ await mutateRuntime(tabId, rt=>{ rt.networkSamples=insertNewestFirst(rt.networkSamples,sample,120); rt.events=insertNewestFirst(rt.events,{kind:"network",message:`連線異常 · ${sample.error}`,ts:sample.at},500); }, capturedRunId); }
    return {ok:false,sample,error:sample.error};
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== "string") { sendResponse({ ok:false, error:"Invalid message" }); return; }
    const senderTabId = sender?.tab?.id || null;

    if (message.type === "QBA_LOG") {
      const runId = String(message.runId || "");
      const active = runId ? await getActiveSessionForRun(senderTabId, runId) : null;
      if (!active) { sendResponse({ ok: false, stale: true }); return; }
      const out = await appendRuntimeLog(senderTabId, {
        message: message.message,
        level: message.level || "info",
        ts: message.ts || Date.now()
      }, runId);
      sendResponse({ ok: Boolean(out?.accepted), stale: !out?.accepted });
      return;
    }

    if (message.type === "QBA_STATUS") {
      const runId = String(message.runId || "");
      const active = runId ? await getActiveSessionForRun(senderTabId, runId) : null;
      if (!active) { sendResponse({ ok: false, stale: true }); return; }
      const out = await setRuntimeStatus(senderTabId, {
        code: message.code,
        message: message.message,
        ts: message.ts || Date.now(),
        challengeType: message.challengeType || null,
        buttonText: message.buttonText || null
      }, runId);
      sendResponse({ ok: Boolean(out?.accepted && !out?.value?.ignored), stale: !out?.accepted, outOfOrder: Boolean(out?.value?.ignored) });
      return;
    }

    if (message.type === "QBA_PAGE_STATE") {
      const runId = String(message.runId || "");
      const active = runId ? await getActiveSessionForRun(senderTabId, runId) : null;
      if (!active) { sendResponse({ ok: false, stale: true }); return; }
      const out = await appendPageState(senderTabId, message, runId);
      sendResponse({ ok: Boolean(out?.accepted && !out?.value?.ignored), stale: !out?.accepted, outOfOrder: Boolean(out?.value?.ignored) });
      return;
    }

    if (message.type === "QBA_HEARTBEAT") {
      const runId = String(message.runId || "");
      const active = runId ? await getActiveSessionForRun(senderTabId, runId) : null;
      if (!active) { sendResponse({ ok: false, stale: true }); return; }
      const out = await mutateRuntime(senderTabId, rt => {
        const incomingTs = Number(message.ts || Date.now());
        const currentTs = Number(rt.heartbeatAt || 0);
        if (currentTs && incomingTs < currentTs) return { ignored: true, reason: "out_of_order_heartbeat", incomingTs, currentTs };
        rt.heartbeatAt = incomingTs;
        rt.heartbeat = {
          visible: Boolean(message.visible),
          lifecycle: String(message.lifecycle || "active").slice(0, 40),
          timerDriftMs: Math.max(0, Number(message.timerDriftMs || 0)),
          url: sanitizeArchiveUrl(message.url || ""),
          ts: rt.heartbeatAt
        };
        return { ignored: false };
      }, runId);
      sendResponse({ ok: Boolean(out?.accepted && !out?.value?.ignored), stale: !out?.accepted, outOfOrder: Boolean(out?.value?.ignored) });
      return;
    }

    if (message.type === "QBA_ARM_MISSION") {
      sendResponse(await armScheduledMission(message));
      return;
    }
    if (message.type === "QBA_DISARM_MISSION") {
      sendResponse(await disarmScheduledMission("manual_disarm"));
      return;
    }
    if (message.type === "QBA_GET_ARMED_MISSION") {
      const data = await getArmedMission();
      sendResponse({ ok:true, mission:data.summary, lastResult:data.lastResult });
      return;
    }
    if (message.type === "QBA_LAUNCH_ARMED_MISSION_NOW") {
      sendResponse({ ok:false, error:"請使用開賣提醒；不支援提前執行。" });
      return;
    }

    if (message.type === "QBA_START_SESSION") {
      sendResponse(await startSession(message.tabId, message.config));
      return;
    }
    if (message.type === "QBA_STOP_SESSION") {
      sendResponse(await stopSession(message.tabId));
      return;
    }
    if (message.type === "QBA_RESUME_SESSION") {
      try {
        const active = await getActiveSessionForRun(message.tabId);
        if (!active) { sendResponse({ ok: false, error: "目前沒有活動任務。" }); return; }
        await chrome.tabs.sendMessage(message.tabId, { type: "QBA_RESUME", runId: active.runId || "" });
        sendResponse({ ok: true, runId: active.runId || "" });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
      return;
    }
    if (message.type === "QBA_PICK_SELECTOR") {
      const ok = await injectRunner(message.tabId);
      if (!ok) { sendResponse({ ok: false }); return; }
      try {
        await chrome.tabs.sendMessage(message.tabId, { type: "QBA_PICK_SELECTOR", targetKey: message.targetKey });
        sendResponse({ ok: true });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
      return;
    }
    if (message.type === "QBA_PREFLIGHT_SESSION") {
      sendResponse(await preflight(message.tabId, message.config));
      return;
    }
    if (message.type === "QBA_REHEARSAL_SESSION") {
      sendResponse(await rehearsal(message.tabId, message.config));
      return;
    }
    if (message.type === "QBA_GET_SNAPSHOT") {
      sendResponse(await getSnapshot(message.tabId));
      return;
    }
    if (message.type === "QBA_CLEAR_LOGS") {
      const active = await getActiveSessionForRun(message.tabId);
      if (!active) { sendResponse({ ok: true, alreadyStopped: true }); return; }
      const out = await mutateRuntime(message.tabId, rt => { rt.logs = []; }, active.runId || "");
      sendResponse({ ok: Boolean(out?.accepted), stale: !out?.accepted });
      return;
    }
    if (message.type === "QBA_NETWORK_PROBE") {
      sendResponse(await probeTargetNetwork(message.url, message.tabId || senderTabId, message.runId || ""));
      return;
    }
    if (message.type === "QBA_SYNC_CLOCK") {
      sendResponse(await syncClockFromSite(message.url));
      return;
    }
    if (message.type === "QBA_GET_ACTIVE_SESSION") {
      sendResponse({ ok: true, active: await getLatestActiveSession() });
      return;
    }
    if (message.type === "QBA_SELF_TEST_PING") {
      const sessions = await getSessionEntries();
      const { qbaLastMaintenance = null } = await chrome.storage.local.get("qbaLastMaintenance");
      sendResponse({ ok: true, version: QBA_APP_VERSION, buildId: QBA_BUILD_ID, schemaVersion: QBA_STORAGE_SCHEMA, archiveLimit: QBA_ARCHIVE_LIMIT, activeSessions: sessions.length, maintenance: qbaLastMaintenance, concurrencyGuard: "runid-lock-v1", staleEventIsolation: true, monotonicRuntimeState: true, orderedRuntimeTimeline: true, runtimePrivacyRedaction: true, atomicSessionCleanup: true, networkProbeRunIsolation: true, stoppedRuntimeIsolation: true, lifecycleAlarm: true, heartbeatTracking: true, autopilotAtomicCompletion: false, manualFinalConfirmation: true, saleReminder: true, scheduledAutopilotMission: false, windowsCompanionPlan: false, windowsCompanionLocalhost: false, ts: Date.now() });
      return;
    }
    if (message.type === "QBA_RUN_MAINTENANCE") {
      sendResponse(await runBackgroundMaintenance(message.reason || "manual_message"));
      return;
    }
    if (message.type === "QBA_PING_SESSION") {
      try {
        const pong = await chrome.tabs.sendMessage(message.tabId, { type: "QBA_PING" });
        sendResponse({ ok: true, ...pong });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
      return;
    }
    if (message.type === "QBA_GET_DIAGNOSTICS") {
      try {
        const out = await chrome.tabs.sendMessage(message.tabId, { type: "QBA_DIAGNOSTICS" });
        sendResponse(out || { ok: false, error: "沒有診斷資料。" });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
      return;
    }
    if (message.type === "QBA_DEBUG_SCAN_SESSION") {
      const ok = await injectRunner(message.tabId);
      if (!ok) { sendResponse({ ok: false, error: "無法讀取目前頁面。" }); return; }
      try {
        const out = await chrome.tabs.sendMessage(message.tabId, { type: "QBA_DEBUG_SCAN", config: message.config || {} });
        sendResponse(out || { ok: false, error: "沒有除錯掃描結果。" });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
      return;
    }
    if (message.type === "QBA_FOCUS_TARGET") {
      try {
        const tab = await chrome.tabs.get(message.tabId);
        await chrome.tabs.update(message.tabId, { active: true });
        focusWarnedTabs.delete(message.tabId);
        sendResponse({ ok: true });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
      return;
    }
    if (message.type === "QBA_LOCAL_LOG") {
      const active = await getActiveSessionForRun(message.tabId);
      if (!active) { sendResponse({ ok: true, skipped: true, reason: "no_active_session" }); return; }
      const out = await appendRuntimeLog(message.tabId, { message: message.message, level: message.level || "info", ts: message.ts || Date.now() }, active.runId || "");
      sendResponse({ ok: Boolean(out?.accepted), stale: !out?.accepted });
      return;
    }
    if (message.type === "QBA_NOTIFY") {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: message.title || "QuickBuy 搶購助手",
        message: message.message || "需要你接手處理。",
        priority: 2
      });
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok:false, error:"Unsupported message" });
  })().catch(error => sendResponse({ ok:false, error:error?.message || String(error) }));
  return true;
});
