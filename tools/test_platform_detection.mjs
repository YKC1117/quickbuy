import fs from 'node:fs';
import vm from 'node:vm';

const code=fs.readFileSync('docs/platform-catalog.js','utf8');
vm.runInThisContext(code,{filename:'platform-catalog.js'});
const c=globalThis.QBA_PLATFORM_CATALOG;
if(!c) throw new Error('catalog missing');

const cases=[
  ['https://shopee.tw/product/1/2','shopee-tw'],
  ['https://s.shopee.tw/8pkNX1SYJF?share_channel_code=6','shopee-tw'],
  ['https://tw.shp.ee/AbCdEf','shopee-tw'],
  ['https://shope.ee/AbCdEf','shopee-tw'],
  ['蝦皮分享給你：https://tw.shp.ee/AbCdEf 這個商品','shopee-tw'],
  ['商品連結 https://s.shopee.tw/8pkNX1SYJF?share_channel_code=6，快來看看','shopee-tw'],
  ['https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=123','momo'],
  ['https://s.momoshop.com.tw/s/abc123','momo'],
  ['https://24h.pchome.com.tw/prod/ABC123','pchome-24h'],
  ['https://www.books.com.tw/products/0010123456','books-tw'],
  ['https://tixcraft.com/activity/detail/26_test','tixcraft'],
  ['https://abc.kktix.cc/events/demo','kktix'],
  ['https://ticketplus.com.tw/activity/123','ticketplus'],
  ['https://kham.com.tw/application/UTK02/UTK0201_.aspx','kham'],
  ['https://ticket.ibon.com.tw/ActivityInfo/Details/123','ibon-ticket'],
  ['https://ticket.com.tw/application/UTK02/UTK0201_.aspx','era-ticket']
];

for(const [input,expected] of cases){
  const got=c.detect(input)?.id||'';
  if(got!==expected) throw new Error(`detect failed: ${input} => ${got}, expected ${expected}`);
}

const normalized=c.normalizeUrlInput('蝦皮商品： https://tw.shp.ee/ABC123，分享給你');
if(normalized!=='https://tw.shp.ee/ABC123') throw new Error('share text URL extraction failed: '+normalized);

console.log('PLATFORM_URL_DETECTION_PASS');
console.log(JSON.stringify({cases:cases.length,shopeeAliases:true,shareTextExtraction:true}));


const momoRaw='https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=123456&utm_source=share&token=secret#section';
const momoSafe=c.sanitizeTargetUrl(momoRaw);
if(momoSafe!=='https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=123456#section'){
  throw new Error('momo functional query was not preserved safely: '+momoSafe);
}

const ticketRaw='https://ticketplus.com.tw/activity/123?eventId=456&session=secret&seat=A';
const ticketSafe=c.sanitizeTargetUrl(ticketRaw);
if(ticketSafe!=='https://ticketplus.com.tw/activity/123?eventId=456&seat=A'){
  throw new Error('ticket functional query was not preserved safely: '+ticketSafe);
}

const hashSensitive=c.sanitizeTargetUrl('https://example.com/item?id=9#access_token=secret');
if(hashSensitive!=='https://example.com/item?id=9'){
  throw new Error('sensitive hash was not removed: '+hashSensitive);
}

console.log('URL_SANITIZE_PASS');
console.log(JSON.stringify({functionalQueryPreserved:true,sensitiveParamsRemoved:true,trackingParamsRemoved:true}));


const expandedSensitive=c.sanitizeTargetUrl('https://example.com/item?i_code=123&eventId=456&seat=A&accessToken=one&session_id=two&auth_token=three&client_secret=four');
if(expandedSensitive!=='https://example.com/item?i_code=123&eventId=456&seat=A'){
  throw new Error('expanded sensitive query stripping failed: '+expandedSensitive);
}
console.log('EXPANDED_SENSITIVE_URL_PASS');
console.log(JSON.stringify({expandedSensitive:true,functionalParamsStillPreserved:true}));
