/* QuickBuy Sync Crypto v1 — client-side envelope encryption.
 * Passphrases are never persisted by this module.
 */
(() => {
  'use strict';
  const FORMAT='quickbuy-sync-envelope', VERSION=1, ITERATIONS=250000;
  const enc=new TextEncoder(), dec=new TextDecoder();
  const b64=u8=>{let s=''; for(let i=0;i<u8.length;i+=0x8000)s+=String.fromCharCode(...u8.subarray(i,i+0x8000)); return btoa(s);};
  const unb64=s=>{const raw=atob(String(s||'')),u=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)u[i]=raw.charCodeAt(i);return u;};
  async function key(pass,salt,it=ITERATIONS){
    if(String(pass||'').length<10) throw new Error('同步密語至少需要 10 個字元。');
    const base=await crypto.subtle.importKey('raw',enc.encode(String(pass)),{name:'PBKDF2'},false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:it},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  async function encryptBundle(bundle,passphrase){
    if(!bundle || bundle.format!=='quickbuy-sync-bundle') throw new Error('不是有效的 QuickBuy 同步封包。');
    const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),k=await key(passphrase,salt);
    const sourceHint=String(bundle.source?.deviceId||'').slice(0,12);
    const aad=enc.encode(`${FORMAT}|${VERSION}|${sourceHint}`), plain=enc.encode(JSON.stringify(bundle));
    const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},k,plain));
    return {format:FORMAT,version:VERSION,kdf:{name:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt:b64(salt)},cipher:{name:'AES-GCM',iv:b64(iv)},sourceHint,createdAt:new Date().toISOString(),payload:b64(cipher)};
  }
  async function decryptEnvelope(envelope,passphrase){
    if(!envelope || envelope.format!==FORMAT || Number(envelope.version)!==VERSION) throw new Error('不是支援的 QuickBuy 加密同步封包。');
    const it=Number(envelope.kdf?.iterations||0); if(it<100000 || it>1000000) throw new Error('同步封包 KDF 參數不安全或不支援。');
    if(envelope.kdf?.name!=='PBKDF2'||envelope.kdf?.hash!=='SHA-256'||envelope.cipher?.name!=='AES-GCM') throw new Error('同步封包加密演算法不支援。');
    const salt=unb64(envelope.kdf.salt),iv=unb64(envelope.cipher.iv),cipher=unb64(envelope.payload); if(salt.length!==16||iv.length!==12||cipher.length<16) throw new Error('同步封包加密參數損壞。');
    const k=await key(passphrase,salt,it),aad=enc.encode(`${FORMAT}|${VERSION}|${String(envelope.sourceHint||'')}`);
    let plain; try{plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad},k,cipher);}catch(_){throw new Error('同步密語錯誤或封包已被竄改。');}
    let bundle; try{bundle=JSON.parse(dec.decode(plain));}catch(_){throw new Error('解密後資料格式錯誤。');}
    if(String(bundle.source?.deviceId||'').slice(0,12)!==String(envelope.sourceHint||'')) throw new Error('同步封包來源驗證失敗。');
    return bundle;
  }
  self.QBASyncCrypto=Object.freeze({FORMAT,VERSION,ITERATIONS,encryptBundle,decryptEnvelope});
})();
