/* QuickBuy Sync Core v1 — local-first, transport-agnostic settings sync.
 * Intentionally excludes credentials, payment data, cookies/tokens and runtime sessions.
 */
(() => {
  'use strict';
  const VERSION = 1;
  const MAX_JOURNAL = 200;
  const SAFE_KEYS = new Set([
    'qbaTaskTemplates','qbaRulePacks','qbaPlatformProfiles','qbaRuleBackups',
    'qbaPlatformProfileBackups','qbaSiteProfiles','qbaProfileLabCases','qbaCustomShortcutsV1','qbaMobilePrepV1'
  ]);
  const BLOCKED_KEY_PATTERNS = [
    /password/i,/passwd/i,/otp/i,/cvv/i,/cvc/i,/card/i,/cookie/i,/session/i,
    /token/i,/secret/i,/auth/i,/credential/i,/paymentdata/i,/^profile(?:Name|Email|Phone|Address)$/i,/qbaFields/i,
    /qbaArmedMission/i,/qbaRunArchives/i,/qbaActiveRecoveryStub/i
  ];

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function nowIso() { return new Date().toISOString(); }
  function isPlain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isBlockedKey(k) { return BLOCKED_KEY_PATTERNS.some(rx => rx.test(String(k || ''))); }
  const SENSITIVE_QUERY_KEY = /^(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?(?:[_-]?token)?|session(?:[_-]?(?:id|key|token))?|sid|jwt|otp|password|passwd|cvv|cvc|api[_-]?key|apikey|secret|client[_-]?secret)$/i;
  const TRACKING_QUERY_KEY = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|igshid|share_channel_code)$/i;
  function sanitizeSyncUrl(raw) {
    try {
      const catalogSanitizer = globalThis.QBA_PLATFORM_CATALOG?.sanitizeTargetUrl;
      if (typeof catalogSanitizer === 'function') return catalogSanitizer(raw);
      const u = new URL(String(raw || '').trim());
      if (!/^https?:$/.test(u.protocol)) return '';
      for (const key of [...u.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEY.test(key) || TRACKING_QUERY_KEY.test(key)) u.searchParams.delete(key);
      }
      if (/(?:^|[#&?])(token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?(?:[_-]?token)?|session(?:[_-]?(?:id|key|token))?|sid|jwt|otp|password|passwd|api[_-]?key|apikey|secret|client[_-]?secret)=/i.test(String(u.hash || ''))) u.hash = '';
      u.username = ''; u.password = '';
      return u.toString();
    } catch (_) { return ''; }
  }
  function sanitizeDeep(value, depth = 0) {
    if (depth > 16) return null;
    if (Array.isArray(value)) return value.slice(0, 1000).map(v => sanitizeDeep(v, depth + 1));
    if (!isPlain(value)) {
      if (typeof value === 'string') return value.slice(0, 200000);
      if (['number','boolean'].includes(typeof value) || value == null) return value;
      return null;
    }
    const out = {};
    for (const [k,v] of Object.entries(value)) {
      if (isBlockedKey(k)) continue;
      if (/^(?:targetUrl|url)$/i.test(k) && typeof v === 'string') {
        out[k] = sanitizeSyncUrl(v);
        continue;
      }
      out[k] = sanitizeDeep(v, depth + 1);
    }
    return out;
  }
  function safeSnapshot(all = {}) {
    const data = {};
    for (const key of SAFE_KEYS) if (Object.prototype.hasOwnProperty.call(all, key)) data[key] = sanitizeDeep(all[key]);
    return data;
  }
  function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (isPlain(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stableStringify(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(String(text || ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
  }
  async function fingerprint(data) { return sha256Hex(stableStringify(data)); }
  function makeDeviceId() {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return 'qbd_' + [...b].map(x => x.toString(16).padStart(2,'0')).join('');
  }
  function normalizeState(raw = {}) {
    return {
      protocol: VERSION,
      deviceId: /^qbd_[a-f0-9]{32}$/.test(String(raw.deviceId || '')) ? raw.deviceId : makeDeviceId(),
      deviceName: String(raw.deviceName || '').slice(0,80),
      revision: Math.max(0, Number(raw.revision || 0) | 0),
      lastExportAt: Number(raw.lastExportAt || 0),
      lastImportAt: Number(raw.lastImportAt || 0),
      lastFingerprint: /^[a-f0-9]{64}$/.test(String(raw.lastFingerprint || '')) ? raw.lastFingerprint : '',
      conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.slice(0,50) : [],
      journal: Array.isArray(raw.journal) ? raw.journal.slice(0,MAX_JOURNAL) : []
    };
  }
  function appendJournal(state, entry) {
    state.journal = [{ at: Date.now(), ...entry }, ...(state.journal || [])].slice(0,MAX_JOURNAL);
    return state;
  }
  async function createBundle(all, stateRaw, appVersion = '') {
    const state = normalizeState(stateRaw);
    const data = safeSnapshot(all);
    const fp = await fingerprint(data);
    const revision = state.lastFingerprint === fp ? state.revision : state.revision + 1;
    const bundle = {
      format: 'quickbuy-sync-bundle', protocol: VERSION, appVersion: String(appVersion || ''),
      exportedAt: nowIso(), source: { deviceId: state.deviceId, deviceName: state.deviceName },
      revision, fingerprint: fp, data
    };
    state.revision = revision; state.lastFingerprint = fp; state.lastExportAt = Date.now();
    appendJournal(state, { kind:'export', revision, fingerprint:fp });
    return { bundle, state };
  }
  function validateBundle(bundle) {
    if (!isPlain(bundle) || bundle.format !== 'quickbuy-sync-bundle' || Number(bundle.protocol) !== VERSION) throw new Error('同步檔格式或版本不支援。');
    if (!isPlain(bundle.source) || !/^qbd_[a-f0-9]{32}$/.test(String(bundle.source.deviceId || ''))) throw new Error('同步檔缺少有效裝置 ID。');
    if (!isPlain(bundle.data)) throw new Error('同步檔資料格式錯誤。');
    for (const key of Object.keys(bundle.data)) if (!SAFE_KEYS.has(key) || isBlockedKey(key)) throw new Error(`同步檔包含不允許欄位：${key}`);
    return true;
  }
  function mergeArrayById(local = [], remote = [], idKey = 'id') {
    const map = new Map();
    for (const item of [...(Array.isArray(local)?local:[]), ...(Array.isArray(remote)?remote:[])]) {
      if (!isPlain(item)) continue;
      const id = String(item[idKey] || '').trim();
      if (!id) continue;
      map.set(id, sanitizeDeep(item));
    }
    return [...map.values()];
  }
  function mergeShortcutArray(local = [], remote = []) {
    const map = new Map();
    const add = (raw, source) => {
      if (!isPlain(raw)) return;
      const item = sanitizeDeep(raw);
      const url = String(item.url || '').trim();
      const fallbackId = String(item.id || '').trim();
      const key = url ? `url:${url}` : (fallbackId ? `id:${fallbackId}` : '');
      if (!key) return;
      const prev = map.get(key);
      if (!prev) { map.set(key, { item, source }); return; }
      const prevTime = Number(prev.item.updatedAt || prev.item.lastUsedAt || prev.item.createdAt || 0);
      const nextTime = Number(item.updatedAt || item.lastUsedAt || item.createdAt || 0);
      const newer = nextTime >= prevTime ? item : prev.item;
      const older = newer === item ? prev.item : item;
      map.set(key, {
        source: nextTime >= prevTime ? source : prev.source,
        item: { ...older, ...newer, id: String(prev.item.id || item.id || '').slice(0,80), pinned: !!(prev.item.pinned || item.pinned) }
      });
    };
    for (const x of Array.isArray(local)?local:[]) add(x,'local');
    for (const x of Array.isArray(remote)?remote:[]) add(x,'remote');
    return [...map.values()].map(x=>x.item).slice(0,24);
  }
  function mergeData(localAll, remoteData) {
    const patch = {};
    const conflicts = [];
    for (const key of SAFE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(remoteData, key)) continue;
      const local = localAll[key]; const remote = sanitizeDeep(remoteData[key]);
      if (Array.isArray(remote)) {
        if (key === 'qbaCustomShortcutsV1') patch[key] = mergeShortcutArray(local, remote);
        else {
          const idKey = key === 'qbaProfileLabCases' ? 'caseId' : (key.includes('Backups') ? 'backupId' : 'id');
          patch[key] = mergeArrayById(local, remote, idKey);
        }
      } else if (isPlain(remote)) {
        const safeLocal = isPlain(local) ? sanitizeDeep(local) : {};
        if (key === 'qbaMobilePrepV1') {
          const localAt = Number(safeLocal.updatedAt || 0);
          const remoteAt = Number(remote.updatedAt || 0);
          patch[key] = remoteAt >= localAt ? { ...safeLocal, ...remote } : safeLocal;
        } else {
          patch[key] = { ...safeLocal, ...remote };
        }
      } else conflicts.push({ key, reason:'unsupported-shape' });
    }
    return { patch, conflicts };
  }
  async function importBundle(localAll, stateRaw, bundle) {
    validateBundle(bundle);
    const state = normalizeState(stateRaw);
    const actualFp = await fingerprint(safeSnapshot(bundle.data));
    if (actualFp !== String(bundle.fingerprint || '')) throw new Error('同步檔完整性驗證失敗。');
    if (bundle.source.deviceId === state.deviceId && Number(bundle.revision || 0) <= state.revision) {
      appendJournal(state, { kind:'import-skip', reason:'same-device-old-revision', revision:Number(bundle.revision||0) });
      return { patch:{}, state, conflicts:[], skipped:true };
    }
    const { patch, conflicts } = mergeData(localAll, bundle.data);
    state.lastImportAt = Date.now();
    state.conflicts = [...conflicts, ...(state.conflicts || [])].slice(0,50);
    appendJournal(state, { kind:'import', sourceDeviceId:bundle.source.deviceId, revision:Number(bundle.revision||0), conflicts:conflicts.length });
    return { patch, state, conflicts, skipped:false };
  }

  self.QBASyncCore = Object.freeze({ VERSION, SAFE_KEYS:[...SAFE_KEYS], normalizeState, safeSnapshot, createBundle, validateBundle, importBundle, fingerprint });
})();
