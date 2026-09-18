/* QuickBuy Sync Provider v1 — zero-knowledge relay transport.
 * Stores only encrypted envelopes remotely. Relay credentials stay local to each device.
 */
(() => {
  'use strict';
  const VERSION = 1;
  const CONFIG_KEY = 'qbaSyncProviderConfig';
  const STATE_KEY = 'qbaSyncProviderState';
  const ROOM_RX = /^[A-Za-z0-9_-]{16,96}$/;
  const KEY_RX = /^[A-Za-z0-9_-]{24,160}$/;
  const enc = new TextEncoder();

  function b64url(bytes) {
    let s=''; for (let i=0;i<bytes.length;i+=0x8000) s += String.fromCharCode(...bytes.subarray(i,i+0x8000));
    return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function randomToken(bytes=24){ const u=new Uint8Array(bytes); crypto.getRandomValues(u); return b64url(u); }
  function normalizeEndpoint(raw='') {
    const u = new URL(String(raw||'').trim());
    if (!/^https?:$/.test(u.protocol)) throw new Error('Relay Endpoint 只支援 http/https。');
    if (u.username || u.password || u.search || u.hash) throw new Error('Relay Endpoint 不可包含帳密、query 或 hash。');
    if (u.pathname !== '/' && u.pathname !== '') u.pathname = u.pathname.replace(/\/+$/,'');
    else u.pathname = '';
    return u.toString().replace(/\/$/,'');
  }
  function normalizeConfig(raw={}) {
    let endpoint=''; try { endpoint = raw.endpoint ? normalizeEndpoint(raw.endpoint) : ''; } catch (_) {}
    return {
      protocol: VERSION,
      enabled: !!raw.enabled,
      endpoint,
      roomId: ROOM_RX.test(String(raw.roomId||'')) ? String(raw.roomId) : '',
      accessKey: KEY_RX.test(String(raw.accessKey||'')) ? String(raw.accessKey) : '',
      pollSeconds: Math.min(300, Math.max(15, Number(raw.pollSeconds||30)|0))
    };
  }
  function validateConfig(c) {
    c=normalizeConfig(c);
    if (!c.endpoint) throw new Error('請設定 Relay Endpoint。');
    if (!ROOM_RX.test(c.roomId)) throw new Error('Room ID 無效。');
    if (!KEY_RX.test(c.accessKey)) throw new Error('Relay Access Key 無效。');
    return c;
  }
  function makePairing() { return { roomId: randomToken(18), accessKey: randomToken(32) }; }
  function normalizeState(raw={}) { return { etag:String(raw.etag||'').slice(0,160), lastPullAt:Number(raw.lastPullAt||0), lastPushAt:Number(raw.lastPushAt||0), lastHealthAt:Number(raw.lastHealthAt||0), lastError:String(raw.lastError||'').slice(0,500) }; }
  function pathFor(c){ return `${c.endpoint}/v1/envelopes/${encodeURIComponent(c.roomId)}`; }
  function headers(c, extra={}) { return { 'X-QuickBuy-Relay-Key': c.accessKey, 'X-QuickBuy-Relay-Version': String(VERSION), ...extra }; }
  async function parseError(res){ let txt=''; try{txt=(await res.text()).slice(0,500);}catch(_){} return txt || `${res.status} ${res.statusText}`; }
  async function health(config) {
    const c=validateConfig(config), res=await fetch(`${c.endpoint}/v1/health`, {method:'GET',cache:'no-store'});
    if(!res.ok) throw new Error(`Relay health 失敗：${await parseError(res)}`);
    const data=await res.json(); if(data?.service!=='quickbuy-sync-relay') throw new Error('Relay 回應不是 QuickBuy Sync Relay。');
    return data;
  }
  async function pull(config) {
    const c=validateConfig(config), res=await fetch(pathFor(c), {method:'GET',headers:headers(c),cache:'no-store'});
    if(res.status===404) return {found:false,envelope:null,etag:''};
    if(!res.ok) throw new Error(`Relay Pull 失敗：${await parseError(res)}`);
    const envelope=await res.json();
    if(!envelope || typeof envelope!=='object') throw new Error('Relay 回傳封包格式錯誤。');
    return {found:true,envelope,etag:String(res.headers.get('ETag')||'')};
  }
  async function push(config,envelope,etag='') {
    const c=validateConfig(config); if(!envelope || typeof envelope!=='object') throw new Error('缺少加密同步封包。');
    const body=JSON.stringify(envelope); if(enc.encode(body).length>256*1024) throw new Error('加密同步封包超過 256 KB Relay 上限。');
    const h=headers(c, {'Content-Type':'application/json'}); if(etag) h['If-Match']=etag;
    const res=await fetch(pathFor(c), {method:'PUT',headers:h,body,cache:'no-store'});
    if(res.status===412) return {ok:false,conflict:true,etag:String(res.headers.get('ETag')||'')};
    if(!res.ok) throw new Error(`Relay Push 失敗：${await parseError(res)}`);
    return {ok:true,conflict:false,etag:String(res.headers.get('ETag')||'')};
  }
  async function requestOriginPermission(endpoint) {
    const api=globalThis.chrome || globalThis.browser; if(!api?.permissions?.request) return true;
    const u=new URL(normalizeEndpoint(endpoint)); const origin=`${u.protocol}//${u.host}/*`;
    return api.permissions.request({origins:[origin]});
  }
  self.QBASyncProvider=Object.freeze({VERSION,CONFIG_KEY,STATE_KEY,normalizeConfig,validateConfig,normalizeState,makePairing,health,pull,push,requestOriginPermission});
})();
