(() => {
  if ('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
  const standalone=window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone===true;
  const set=(id,text)=>{const el=document.getElementById(id);if(el)el.textContent=text;};

  async function shareQuickBuy(){
    const payload={title:'QuickBuy',text:'票券・限量商品・快速準備助手',url:location.href.split('#')[0]};
    try{
      if(navigator.share){await navigator.share(payload);return;}
      await navigator.clipboard?.writeText?.(payload.url);
      const toast=document.getElementById('mobileToast');if(toast){toast.textContent='QuickBuy 連結已複製';toast.className='mobile-toast show good';setTimeout(()=>toast.className='mobile-toast',1600);}
    }catch(e){if(e?.name!=='AbortError'){try{await navigator.clipboard?.writeText?.(payload.url);}catch(_){}}}
  }
  document.addEventListener('DOMContentLoaded',()=>{
    set('mobileCurrentTitle','目前 QuickBuy 目標');
    const current=document.getElementById('mobileCurrentUrl'); if(current&&!current.textContent.trim())current.textContent='—';
    const access=document.getElementById('mobileAccessChip'); if(access){access.classList.add('good');const s=access.querySelector('small');if(s)s.textContent=standalone?'主畫面模式':'Safari 網頁模式';}
    const help=document.getElementById('mobilePermissionHelp'); if(help)help.hidden=false;
    const status=document.getElementById('status'); if(status)status.textContent='QuickBuy 1.0 採本機優先；不設定同步也能使用。';
    document.getElementById('shareQuickBuyBtn')?.addEventListener('click',shareQuickBuy);
    document.getElementById('showInstallGuideBtn')?.addEventListener('click',()=>{const o=document.getElementById('mobileOnboarding');if(o)o.hidden=false;});
    document.getElementById('openTutorial')?.addEventListener('click',()=>window.QBShowTutorial?.());
    document.getElementById('closeTutorial')?.addEventListener('click',()=>window.QBHideTutorial?.());
    
  });
})();
