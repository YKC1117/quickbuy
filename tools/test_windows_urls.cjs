const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
for(const f of ['platform-catalog.js','sync-core.js'])assert.equal(fs.readFileSync('docs/'+f,'utf8'),fs.readFileSync('windows/QuickBuy-Extension/'+f,'utf8'),f+' must be shared exactly');
for(const dir of ['docs','windows/QuickBuy-Extension']){
 const scope={URL};vm.createContext(scope);vm.runInContext(fs.readFileSync(dir+'/platform-catalog.js','utf8'),scope);
 const clean=scope.QBA_PLATFORM_CATALOG.sanitizeTargetUrl;
 const sensitive=['token','access_token','access-token','refresh_token','auth','authorization','session','sessionid','sid','jwt','otp','password','api_key','username'];
 for(const k of sensitive){const u=new URL(clean(`https://name:secret@www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=123456&code=EVENT&key=SIZE&${k}=SECRET#${k}%3DSECRET`));assert.equal(u.searchParams.get('i_code'),'123456');assert.equal(u.searchParams.get('code'),'EVENT');assert.equal(u.searchParams.get('key'),'SIZE');assert.ok(!u.href.includes('SECRET'));assert.equal(u.username,'');assert.equal(u.password,'');}
 assert.equal(clean('https://example.com/item?sku=blue#details'),'https://example.com/item?sku=blue#details');
}
console.log('PASS Windows/PWA functional URL parity and sensitive URL stripping');
