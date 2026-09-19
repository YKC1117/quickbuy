import fs from 'node:fs';
import vm from 'node:vm';
import cryptoMod from 'node:crypto';

globalThis.crypto=cryptoMod.webcrypto;
globalThis.self=globalThis;

vm.runInThisContext(fs.readFileSync('docs/platform-catalog.js','utf8'),{filename:'platform-catalog.js'});
vm.runInThisContext(fs.readFileSync('docs/sync-core.js','utf8'),{filename:'sync-core.js'});

const core=globalThis.QBASyncCore;
if(!core) throw new Error('sync core missing');

const all={
  qbaMobilePrepV1:{
    quantity:2,
    keyword:'A區',
    targetUrl:'https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=123456&token=secret&utm_source=share#section',
    updatedAt:100
  },
  qbaCustomShortcutsV1:[
    {
      id:'momo-1',
      name:'momo 商品',
      url:'https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=987654&session=secret',
      category:'shop',
      updatedAt:100
    }
  ]
};

const state=core.normalizeState({deviceName:'test'});
const {bundle}=await core.createBundle(all,state,'test');

const prep=bundle.data.qbaMobilePrepV1;
if(prep.targetUrl!=='https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=123456#section'){
  throw new Error('sync prep URL broken: '+prep.targetUrl);
}
const shortcut=bundle.data.qbaCustomShortcutsV1?.[0];
if(shortcut?.url!=='https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=987654'){
  throw new Error('sync shortcut URL broken: '+shortcut?.url);
}
if(JSON.stringify(bundle).includes('secret')) throw new Error('sensitive URL values leaked into bundle');
if(JSON.stringify(bundle).includes('utm_source')) throw new Error('tracking URL values leaked into bundle');

console.log('SYNC_FUNCTIONAL_URL_PASS');
console.log(JSON.stringify({prepQueryPreserved:true,shortcutQueryPreserved:true,sensitiveRemoved:true}));
