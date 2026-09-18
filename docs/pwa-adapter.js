(() => {
  'use strict';
  const LEGACY_KEY='quickbuy:pwa-storage:v1';
  const DB_NAME='quickbuy-pwa';
  const DB_VERSION=1;
  const STORE='state';
  const ROOT_KEY='root';
  let dbPromise=null;
  let writeQueue=Promise.resolve();

  const legacyLoad=()=>{try{return JSON.parse(localStorage.getItem(LEGACY_KEY)||'{}')||{};}catch(_){return {};}};
  const legacySave=o=>{try{localStorage.setItem(LEGACY_KEY,JSON.stringify(o||{}));}catch(_){}};

  function openDb(){
    if(!('indexedDB' in globalThis)) return Promise.resolve(null);
    if(dbPromise) return dbPromise;
    dbPromise=new Promise(resolve=>{
      let req;
      try{req=indexedDB.open(DB_NAME,DB_VERSION);}catch(_){resolve(null);return;}
      req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE);};
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>resolve(null);
      req.onblocked=()=>resolve(null);
    });
    return dbPromise;
  }

  async function idbRead(){
    const db=await openDb();
    if(!db) return null;
    return new Promise(resolve=>{
      try{
        const tx=db.transaction(STORE,'readonly');
        const req=tx.objectStore(STORE).get(ROOT_KEY);
        req.onsuccess=()=>resolve(req.result && typeof req.result==='object' ? req.result : null);
        req.onerror=()=>resolve(null);
      }catch(_){resolve(null);}
    });
  }

  async function idbWrite(value){
    const db=await openDb();
    if(!db) return false;
    return new Promise(resolve=>{
      try{
        const tx=db.transaction(STORE,'readwrite');
        tx.objectStore(STORE).put(value||{},ROOT_KEY);
        tx.oncomplete=()=>resolve(true);
        tx.onerror=()=>resolve(false);
        tx.onabort=()=>resolve(false);
      }catch(_){resolve(false);}
    });
  }

  let migrated=false;
  async function load(){
    const fromDb=await idbRead();
    if(fromDb){migrated=true;return {...fromDb};}
    const legacy=legacyLoad();
    if(!migrated && Object.keys(legacy).length){migrated=true;await idbWrite(legacy);}
    return {...legacy};
  }

  async function save(next){
    const clean=next&&typeof next==='object'?next:{};
    legacySave(clean);
    const ok=await idbWrite(clean);
    if(ok)migrated=true;
    return ok;
  }

  function mutate(fn){
    const task=writeQueue.then(async()=>{const all=await load();const next=fn({...all})||all;await save(next);});
    writeQueue=task.catch(()=>{});
    return task;
  }

  const storage={local:{
    async get(keys=null){
      const all=await load();
      if(keys==null)return {...all};
      if(typeof keys==='string')return {[keys]:all[keys]};
      if(Array.isArray(keys))return Object.fromEntries(keys.map(k=>[k,all[k]]));
      if(typeof keys==='object')return Object.fromEntries(Object.entries(keys).map(([k,d])=>[k,all[k]===undefined?d:all[k]]));
      return {};
    },
    async set(items){await mutate(all=>({...all,...(items||{})}));},
    async remove(keys){await mutate(all=>{for(const k of (Array.isArray(keys)?keys:[keys]))delete all[k];return all;});},
    async clear(){await mutate(()=>({}));}
  }};

  globalThis.QBA_PWA=true;
  globalThis.QBA_PWA_API={
    storage,
    tabs:{
      async query(){return[];},
      async create({url}){window.open(url,'_blank','noopener,noreferrer');},
      async update(_id,{url}){window.open(url,'_blank','noopener,noreferrer');}
    },
    permissions:{async request(){return true;}}
  };
})();
