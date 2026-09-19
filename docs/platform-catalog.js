(() => {
  const REVIEWED_AT = "2026-09-18";
  const CATALOG_VERSION = "1.6.0";

  const PLATFORM_CATALOG = [
    {
      id: "era-ticket", category:"ticket", categoryLabel:"售票",
      name: "年代售票", shortName: "年代",
      hosts: ["ticket.com.tw", "www.ticket.com.tw"], homepage: "https://ticket.com.tw/",
      officialFlow: ["會員 / 登入", "活動", "場次", "區域 / 座位", "票種 / 數量", "購物車", "取票 / 付款", "訂單確認"],
      statusModel: ["LOGIN", "EVENT", "SESSION", "AREA", "QUANTITY", "CART", "CHECKOUT", "SUCCESS", "UNKNOWN"],
      mobileNote: "行動端實際流程需依活動頁驗證。", researchStatus: "public-flow", liveDryRunStatus: "pending",
      notes: "已建立公開流程模型；真實活動 DOM 仍需逐站乾跑驗證。"
    },
    {
      id: "tixcraft", category:"ticket", categoryLabel:"售票",
      name: "拓元售票 TixCraft", shortName: "拓元",
      hosts: ["tixcraft.com", "*.tixcraft.com"], homepage: "https://tixcraft.com/",
      officialFlow: ["會員登入", "活動", "立即購票", "場次", "選位 / 區域", "票種 / 張數", "付款 / 取票", "訂單確認"],
      statusModel: ["LOGIN", "EVENT", "SALE_ENTRY", "SESSION", "AREA", "QUANTITY", "CHECKOUT", "SUCCESS", "QUEUE", "UNKNOWN"],
      mobileNote: "官方支援手機購票；避免多視窗 / 多裝置同時送出購票操作。", researchStatus: "official-flow", liveDryRunStatus: "pending",
      notes: "維持單一 Active 任務；跨裝置只同步設定。"
    },
    {
      id: "kktix", category:"ticket", categoryLabel:"售票",
      name: "KKTIX", shortName: "KKTIX",
      hosts: ["kktix.com", "*.kktix.com", "kktix.cc", "*.kktix.cc"], homepage: "https://kktix.com/",
      officialFlow: ["活動", "票種 / 張數", "條款", "表單", "付款", "完成"],
      statusModel: ["EVENT", "QUANTITY", "TERMS", "FORM", "CHECKOUT", "SUCCESS", "LOGIN", "QUEUE", "UNKNOWN"],
      mobileNote: "實際活動可能有會員碼、表單或驗證差異。", researchStatus: "official-flow", liveDryRunStatus: "pending",
      notes: "未知頁面一律 UNKNOWN；驗證與付款確認交由使用者完成。"
    },
    {
      id: "ticketplus", category:"ticket", categoryLabel:"售票",
      name: "Ticket Plus 遠大售票", shortName: "Ticket Plus",
      hosts: ["ticketplus.com.tw", "www.ticketplus.com.tw"], homepage: "https://ticketplus.com.tw/",
      officialFlow: ["活動", "票種 / 張數", "訂單保留", "資料", "付款", "結果"],
      statusModel: ["EVENT", "QUANTITY", "HOLD", "FORM", "CHECKOUT", "SUCCESS", "FAIL_DIALOG", "QUEUE", "UNKNOWN"],
      mobileNote: "不同活動頁面元件可能不同，需逐活動乾跑。", researchStatus: "public-flow+oss-cases", liveDryRunStatus: "pending",
      notes: "回歸重點：FAIL_DIALOG 不得誤判成 QUEUE；等待狀態必須有 timeout。"
    },
    {
      id: "kham", category:"ticket", categoryLabel:"售票",
      name: "寬宏售票 KHAM", shortName: "寬宏",
      hosts: ["kham.com.tw", "www.kham.com.tw"], homepage: "https://kham.com.tw/",
      officialFlow: ["會員登入", "活動", "配位 / 選位", "票種 / 張數", "付款 / 取票", "3D 驗證", "訂單確認"],
      statusModel: ["LOGIN", "EVENT", "AREA", "QUANTITY", "CHECKOUT", "NEED_USER", "SUCCESS", "UNKNOWN"],
      mobileNote: "iOS 登入 / 購票需額外驗證相容性。", researchStatus: "official-flow", liveDryRunStatus: "pending",
      notes: "3D Secure / 銀行驗證屬 NEED_USER；不自動處理。"
    },
    {
      id: "ibon-ticket", category:"ticket", categoryLabel:"售票",
      name: "ibon 售票", shortName: "ibon",
      hosts: ["ticket.ibon.com.tw"], homepage: "https://ticket.ibon.com.tw/",
      officialFlow: ["活動", "場次 / 票種", "張數", "取票 / 付款", "驗證", "結果"],
      statusModel: ["EVENT", "SESSION", "QUANTITY", "DELIVERY", "CHECKOUT", "NEED_USER", "SUCCESS", "UNKNOWN"],
      mobileNote: "活動流程可能依主辦設定不同；真實活動頁仍需乾跑。", researchStatus: "public-flow+existing-semantic", liveDryRunStatus: "pending",
      notes: "驗證碼 / OTP / Queue 維持人工處理與安全停手。"
    },
    {
      id:"shopee-tw", category:"shopping", categoryLabel:"購物",
      name:"蝦皮購物 Shopee", shortName:"蝦皮",
      hosts:["shopee.tw","*.shopee.tw","tw.shp.ee","*.shp.ee","shope.ee","*.shope.ee"], homepage:"https://shopee.tw/",
      officialFlow:["首頁 / 搜尋","商品頁","規格 / 數量","購物車","結帳","登入 / 驗證","付款確認"],
      statusModel:["HOME","SEARCH","PRODUCT","VARIANT","CART","CHECKOUT","NEED_USER","UNKNOWN"],
      mobileNote:"目前提供平台辨識、快捷入口與狀態模型；App / Web 實際頁面差異需另外驗證。",
      researchStatus:"launcher-model",liveDryRunStatus:"pending",
      notes:"不自動送出訂單、不自動付款、不處理 CAPTCHA / OTP 或反機器人繞過。"
    },
    {
      id:"momo", category:"shopping", categoryLabel:"購物",
      name:"momo 購物網", shortName:"momo",
      hosts:["momoshop.com.tw","*.momoshop.com.tw"], homepage:"https://www.momoshop.com.tw/",
      officialFlow:["首頁 / 搜尋","商品頁","規格 / 數量","購物車","結帳","登入 / 驗證","付款確認"],
      statusModel:["HOME","SEARCH","PRODUCT","VARIANT","CART","CHECKOUT","NEED_USER","UNKNOWN"],
      mobileNote:"目前提供快捷與辨識；不同活動 / 限量頁需逐頁驗證。",
      researchStatus:"launcher-model",liveDryRunStatus:"pending",
      notes:"只協助準備、辨識與提醒；最終訂單與付款由使用者確認。"
    },
    {
      id:"pchome-24h", category:"shopping", categoryLabel:"購物",
      name:"PChome 24h購物", shortName:"PChome",
      hosts:["24h.pchome.com.tw","*.pchome.com.tw"], homepage:"https://24h.pchome.com.tw/",
      officialFlow:["首頁 / 搜尋","商品頁","規格 / 數量","購物車","結帳","登入 / 驗證","付款確認"],
      statusModel:["HOME","SEARCH","PRODUCT","VARIANT","CART","CHECKOUT","NEED_USER","UNKNOWN"],
      mobileNote:"目前提供快捷與平台辨識；實際商品頁與活動頁需乾跑。",
      researchStatus:"launcher-model",liveDryRunStatus:"pending",
      notes:"不自動送單或付款；驗證與風控頁面一律 NEED_USER。"
    },
    {
      id:"books-tw", category:"shopping", categoryLabel:"購物",
      name:"博客來", shortName:"博客來",
      hosts:["books.com.tw","www.books.com.tw"], homepage:"https://www.books.com.tw/",
      officialFlow:["首頁 / 搜尋","商品頁","規格 / 數量","購物車","結帳","登入 / 驗證","付款確認"],
      statusModel:["HOME","SEARCH","PRODUCT","VARIANT","CART","CHECKOUT","NEED_USER","UNKNOWN"],
      mobileNote:"目前提供快捷與辨識；限量商品頁需個別驗證。",
      researchStatus:"launcher-model",liveDryRunStatus:"pending",
      notes:"最終購買與付款維持人工確認。"
    }
  ];

  function cleanHost(value) { return String(value || "").trim().toLowerCase().replace(/^www\./, ""); }
  function hostMatches(hostname, pattern) {
    const host = cleanHost(hostname), p = cleanHost(pattern);
    if (!host || !p) return false;
    if (p.startsWith("*.")) { const base = p.slice(2); return host === base || host.endsWith(`.${base}`); }
    return host === p;
  }
  function normalizeUrlInput(raw) {
    let text = String(raw || "").trim();
    if (!text) return "";
    const embedded = text.match(/https?:\/\/[^\s<>"'，。！？；、）】》]+/i);
    if (embedded) text = embedded[0];
    else if (/^[\w.-]+\.[a-z]{2,}(?:[\/:?#].*)?$/i.test(text)) text = "https://" + text;
    text = text.replace(/[\)\]\}>,，。！？；、」』】》]+$/g, "");
    try {
      const u = new URL(text);
      if (!/^https?:$/.test(u.protocol)) return "";
      u.username = "";
      u.password = "";
      return u.toString();
    } catch (_) { return ""; }
  }
  const SENSITIVE_QUERY_KEY = /^(?:token|access_token|refresh_token|auth|authorization|session|sessionid|sid|jwt|otp|password|passwd|cvv|cvc|api[_-]?key|apikey)$/i;
  const TRACKING_QUERY_KEY = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|igshid|share_channel_code)$/i;
  function sanitizeTargetUrl(raw) {
    const normalized = normalizeUrlInput(raw);
    if (!normalized) return "";
    try {
      const u = new URL(normalized);
      for (const key of [...u.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEY.test(key) || TRACKING_QUERY_KEY.test(key)) u.searchParams.delete(key);
      }
      const hash = String(u.hash || "");
      if (/(?:^|[#&?])(token|access_token|refresh_token|auth|authorization|session|sessionid|sid|jwt|otp|password|passwd|api[_-]?key|apikey)=/i.test(hash)) u.hash = "";
      u.username = "";
      u.password = "";
      return u.toString();
    } catch (_) { return ""; }
  }
  function detect(urlString) {
    const normalized = normalizeUrlInput(urlString);
    if (!normalized) return null;
    let url; try { url = new URL(normalized); } catch (_) { return null; }
    return PLATFORM_CATALOG.find(p => p.hosts.some(h => hostMatches(url.hostname, h))) || null;
  }
  function statusLabel(platform) {
    if (!platform) return "未辨識平台";
    if (platform.liveDryRunStatus === "verified") return "已驗證";
    if (platform.category === "shopping") return "快捷辨識已建模";
    if (String(platform.researchStatus).includes("official")) return "流程已建模";
    return "公開資料已建模";
  }
  function compact(platform) {
    if (!platform) return null;
    return { id:platform.id, category:platform.category||"ticket", categoryLabel:platform.categoryLabel||(platform.category==="shopping"?"購物":"售票"), name:platform.name, shortName:platform.shortName, hosts:[...platform.hosts], homepage:platform.homepage||"", status:statusLabel(platform), researchStatus:platform.researchStatus, liveDryRunStatus:platform.liveDryRunStatus, reviewedAt:REVIEWED_AT, mobileNote:platform.mobileNote, notes:platform.notes, phases:[...platform.officialFlow] };
  }
  function list(category="") { const rows=PLATFORM_CATALOG.map(compact); return category ? rows.filter(x=>x.category===category) : rows; }
  function regressionCases() {
    return [
      { id:"ticketplus-failure-not-queue", platform:"ticketplus", input:"訂單失敗 / 請重新嘗試", expected:"FAIL_DIALOG", rule:"失敗彈窗不得當成排隊狀態" },
      { id:"queue-needs-timeout", platform:"generic", input:"Waiting Room / 排隊中", expected:"QUEUE", rule:"等待流程必須可停止且有 timeout" },
      { id:"unknown-fail-closed", platform:"generic", input:"無法辨識的頁面", expected:"UNKNOWN", rule:"UNKNOWN 不猜測、不執行高風險動作" },
      { id:"kham-3ds-needs-user", platform:"kham", input:"3D Secure / 銀行驗證", expected:"NEED_USER", rule:"外部付款驗證必須人工完成" },
      { id:"challenge-needs-user", platform:"generic", input:"CAPTCHA / OTP", expected:"NEED_USER", rule:"安全驗證不自動繞過" },
      { id:"shopping-checkout-human-confirm", platform:"shopping", input:"送出訂單 / 付款確認", expected:"NEED_USER", rule:"購物平台最終送單與付款維持人工確認" }
    ];
  }
  globalThis.QBA_PLATFORM_CATALOG = Object.freeze({ VERSION:CATALOG_VERSION, REVIEWED_AT, normalizeUrlInput, sanitizeTargetUrl, detect, list, compact, statusLabel, regressionCases });
})();
