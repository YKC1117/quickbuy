(() => {
  if (window.__QBA_LOADED__) return;
  window.__QBA_LOADED__ = true;

  const state = {
    running: false,
    paused: false,
    config: null,
    timer: null,
    selectedPriority: null,
    clickedSignatures: new Set(),
    lastChallengeKey: "",
    lastStatus: "",
    pickerCleanup: null,
    clickCount: 0,
    consecutiveErrors: 0,
    visibilityWarned: false,
    actionTimes: [],
    lastActionAt: 0,
    queueSeen: false,
    lastPageStateKey: "",
    lastPagePhase: "UNKNOWN",
    recoveringReason: "",
    blankSince: 0,
    recoveryCount: 0,
    recentSignatureTimes: new Map(),
    navigationRecoveryUntil: 0,
    nextTickDueAt: 0,
    lastTimerDriftMs: 0,
    lastHeartbeatAt: 0,
    lastScheduledDelayMs: 0,
    lifecycle: "active",
    autoCommitSent: false,
    autoCommitAt: 0,
    awaitingConfirmation: false,
    confirmationStartedAt: 0,
    confirmationNotified: false,
    confirmationConfirmed: false,
    confirmationCandidateKey: "",
    confirmationCandidateSince: 0,
    confirmationCandidateHits: 0,
    confirmationBaselineHash: "",
    confirmationBaselineUrl: "",
    completionSent: false,
    checkoutAttempts: new Map()
  };

  const FINAL_RE = /(確認付款|立即付款|前往付款|付款完成|提交訂單|確認訂單|確認購買|完成訂購|完成訂單|place\s*order|pay\s*now|confirm\s*purchase|complete\s*purchase|submit\s*order)/i;
  const NEXT_RE = /(立即購買|我要購買|購買|選購|下一步|繼續|繼續購票|確認座位|加入購物車|放入購物車|checkout|continue|buy\s*now|add\s*to\s*cart|select\s*tickets?)/i;
  const SOLD_RE = /(售完|已售完|暫無庫存|缺貨|sold\s*out|out\s*of\s*stock|unavailable)/i;
  const CAPTCHA_RE = /(captcha|recaptcha|hcaptcha|turnstile|我不是機器人|機器人驗證|安全驗證|驗證您是人類|verify\s*you\s*are\s*human)/i;
  const OTP_RE = /(驗證碼|認證碼|一次性密碼|簡訊驗證|動態密碼|otp|one[-\s]*time\s*(code|password)|verification\s*code)/i;
  const QUEUE_RE = /(排隊中|等待室|正在排隊|等候進入|queue[- ]?it|waiting\s*room|you\s*are\s*in\s*line|please\s*wait.*queue)/i;
  const CONFIRM_SUCCESS_RE = /(?:訂單(?:已)?成立|訂購成功|購買成功|下單成功|付款成功|交易成功|order\s*(?:confirmed|complete|completed|successful)|purchase\s*(?:complete|successful)|thank\s*you\s*for\s*your\s*order)/i;
  const CONFIRM_REFERENCE_RE = /(?:訂單編號|訂購編號|交易編號|取票序號|取票號碼|取票代碼|繳費代碼|付款代碼|付款編號|order\s*(?:number|no\.?|id)|confirmation\s*(?:number|code)|pickup\s*(?:code|number)|payment\s*(?:code|number))/i;
  const CONFIRM_FAILURE_RE = /(?:付款(?:失敗|未完成|遭拒|被拒)|交易(?:失敗|未完成|遭拒|被拒)|訂單(?:建立|成立|送出|處理)?失敗|購買失敗|下單失敗|無法完成(?:付款|交易|訂單)|payment\s*(?:failed|declined|unsuccessful)|transaction\s*(?:failed|declined|unsuccessful)|order\s*(?:failed|declined|unsuccessful)|purchase\s*(?:failed|declined|unsuccessful)|unable\s+to\s+(?:complete|process)(?:\s+your)?\s+(?:payment|order|transaction)|sold\s*out|out\s*of\s*stock)/i;
  const CONFIRM_BODY_FAILURE_RE = /(?:付款(?:失敗|未完成|遭拒|被拒)|交易(?:失敗|未完成|遭拒|被拒)|訂單(?:建立|成立|送出|處理)?失敗|購買失敗|下單失敗|無法完成(?:付款|交易|訂單)|payment\s*(?:failed|declined|unsuccessful)|transaction\s*(?:failed|declined|unsuccessful)|order\s*(?:failed|declined|unsuccessful)|purchase\s*(?:failed|declined|unsuccessful)|unable\s+to\s+(?:complete|process)(?:\s+your)?\s+(?:payment|order|transaction))/i;

  function send(type, extra = {}) {
    try {
      const runId = String(state.config?.runId || "");
      chrome.runtime.sendMessage({ type, ...(runId ? { runId } : {}), ...extra }).catch(() => {});
    } catch (_) {}
  }

  function log(message, level = "info") {
    send("QBA_LOG", { message, level, ts: Date.now() });
  }

  function status(code, message, extra = {}) {
    const key = `${code}:${message}`;
    if (key === state.lastStatus && code === "WAITING") return;
    state.lastStatus = key;
    send("QBA_STATUS", { code, message, ts: Date.now(), ...extra });
  }

  function normText(el) {
    return (el?.innerText || el?.textContent || el?.value || el?.getAttribute?.("aria-label") || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && r.width > 2 && r.height > 2;
  }

  function isDisabled(el) {
    return !!(el.disabled || el.getAttribute("aria-disabled") === "true" || el.classList.contains("disabled"));
  }

  function clickableElements() {
    return [...document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"], label')]
      .filter(isVisible)
      .filter(el => !isDisabled(el));
  }

  function activeRule() {
    return state.config?.ruleMode === "generic" ? null : (state.config?.siteRule || null);
  }

  function ruleSelectors(kind) {
    const list = activeRule()?.selectors?.[kind];
    return Array.isArray(list) ? list.filter(Boolean) : [];
  }

  function ruleTexts(kind) {
    const list = activeRule()?.text?.[kind];
    return Array.isArray(list) ? list.map(x => String(x).trim().toLowerCase()).filter(Boolean) : [];
  }

  function queryRule(kind, { clickable = false } = {}) {
    for (const selector of ruleSelectors(kind)) {
      try {
        const nodes = [...document.querySelectorAll(selector)];
        const node = nodes.find(el => isVisible(el) && (!clickable || !isDisabled(el)));
        if (node) return node;
      } catch (_) {}
    }
    return null;
  }

  function matchesRuleSelector(el, kind) {
    if (!el?.matches) return false;
    return ruleSelectors(kind).some(selector => { try { return el.matches(selector); } catch (_) { return false; } });
  }

  function hasRuleText(kind, text) {
    const value = String(text || "").toLowerCase();
    return ruleTexts(kind).some(token => value.includes(token));
  }

  function isFinalText(text) { return FINAL_RE.test(text) || hasRuleText("final", text); }
  function isSoldText(text) { return SOLD_RE.test(text) || hasRuleText("sold", text); }
  function isNextText(text) { return NEXT_RE.test(text) || hasRuleText("next", text); }

  function isSoldElement(el) {
    if (!el) return false;
    if (isSoldText(normText(el)) || matchesRuleSelector(el, "sold")) return true;
    for (const selector of ruleSelectors("sold")) {
      try { if (el.closest?.(selector)) return true; } catch (_) {}
    }
    return false;
  }

  function ruleCoverage(ruleOverride = null) {
    const rule = ruleOverride || activeRule();
    if (!rule || rule.builtin) return { total: 0, visible: 0, kinds: [] };
    let total = 0, visible = 0;
    const kinds = [];
    for (const kind of ["purchase", "quantity", "price", "sold", "final", "login", "queue"]) {
      const selectors = Array.isArray(rule?.selectors?.[kind]) ? rule.selectors[kind].filter(Boolean) : [];
      if (!selectors.length) continue;
      total += selectors.length;
      let hit = false;
      for (const selector of selectors) {
        try {
          const nodes = [...document.querySelectorAll(selector)];
          hit = nodes.some(el => isVisible(el) && (!["purchase", "final"].includes(kind) || !isDisabled(el)));
          if (hit) break;
        } catch (_) {}
      }
      if (hit) visible += 1;
      kinds.push({ kind, selectors: selectors.length, visible: hit });
    }
    return { total, visible, kinds };
  }

  function signature(el) {
    const r = el.getBoundingClientRect();
    return `pos|${el.tagName}|${normText(el).slice(0, 80)}|${Math.round(r.x)}|${Math.round(r.y)}`;
  }

  function semanticSignature(el) {
    if (!el || !(el instanceof Element)) return "";
    const stableAttrs = ["id", "name", "data-testid", "data-test", "data-qa"]
      .map(name => [name, el.getAttribute?.(name)])
      .filter(([, value]) => value && String(value).trim());
    if (!stableAttrs.length) return "";
    const attrs = stableAttrs.map(([name, value]) => `${name}=${String(value).trim().slice(0, 120)}`).join("|");
    return `sem|${el.tagName}|${normText(el).slice(0, 80).toLowerCase()}|${attrs}`;
  }

  function restoreActionHistory() {
    try {
      const raw = JSON.parse(sessionStorage.getItem("__qba_action_times") || "[]");
      const now = Date.now();
      state.actionTimes = Array.isArray(raw) ? raw.map(Number).filter(t => Number.isFinite(t) && now - t < 10000) : [];
      state.lastActionAt = Number(sessionStorage.getItem("__qba_last_action_at") || 0) || 0;
    } catch (_) { state.actionTimes = []; state.lastActionAt = 0; }
  }

  function recordAction(now = Date.now()) {
    state.actionTimes = state.actionTimes.filter(t => now - t < 10000);
    state.actionTimes.push(now);
    state.lastActionAt = now;
    try {
      sessionStorage.setItem("__qba_action_times", JSON.stringify(state.actionTimes));
      sessionStorage.setItem("__qba_last_action_at", String(now));
    } catch (_) {}
  }

  function recentActionCount() {
    const now = Date.now();
    state.actionTimes = state.actionTimes.filter(t => now - t < 10000);
    return state.actionTimes.length;
  }

  function restoreRecentSignatures() {
    state.recentSignatureTimes.clear();
    try {
      const rows = JSON.parse(sessionStorage.getItem("__qba_recent_signatures") || "[]");
      const now = Date.now();
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.sig && Number(row.ts) > 0 && now - Number(row.ts) < 12000) state.recentSignatureTimes.set(String(row.sig), Number(row.ts));
      }
    } catch (_) {}
  }

  function persistRecentSignatures() {
    try {
      const now = Date.now();
      const rows = [...state.recentSignatureTimes.entries()]
        .filter(([, ts]) => now - Number(ts) < 12000)
        .slice(-20)
        .map(([sig, ts]) => ({ sig, ts }));
      sessionStorage.setItem("__qba_recent_signatures", JSON.stringify(rows));
    } catch (_) {}
  }

  function wasRecentlyClicked(sig) {
    const now = Date.now();
    for (const [key, ts] of [...state.recentSignatureTimes.entries()]) if (now - Number(ts) >= 12000) state.recentSignatureTimes.delete(key);
    const ts = state.recentSignatureTimes.get(sig);
    return !!ts && now - Number(ts) < 8000;
  }

  function recordRecentSignature(sig, now = Date.now()) {
    state.recentSignatureTimes.set(sig, now);
    persistRecentSignatures();
  }

  function enterRecovery(reason) {
    const next = String(reason || "頁面暫時不可用");
    if (state.recoveringReason === next) return;
    state.recoveringReason = next;
    state.recoveryCount += 1;
    try { sessionStorage.setItem("__qba_recovery_count", String(state.recoveryCount)); } catch (_) {}
    log(`進入自動恢復：${next}。不重新整理頁面，等待網站恢復。`, "warn");
    status("RECOVERING", `自動恢復中：${next}`);
    emitPageState(true);
  }

  function leaveRecovery() {
    if (!state.recoveringReason) return;
    const previous = state.recoveringReason;
    state.recoveringReason = "";
    state.blankSince = 0;
    log(`頁面已恢復：${previous}，重新辨識目前流程。`, "success");
    status("WORKING", "頁面已恢復，重新辨識目前流程。");
    emitPageState(true);
  }

  function recoveryGuard() {
    if (navigator.onLine === false) {
      enterRecovery("網路目前離線");
      return false;
    }
    const body = document.body;
    const textLen = (body?.innerText || "").replace(/\s+/g, "").length;
    const interactiveCount = document.querySelectorAll('button, a, input, select, textarea, [role="button"]').length;
    const visibleBodyChildren = body ? [...body.children].filter(el => !["SCRIPT","STYLE","NOSCRIPT"].includes(el.tagName) && isVisible(el)).length : 0;
    const looksBlank = document.readyState === "complete" && textLen < 2 && interactiveCount === 0 && visibleBodyChildren === 0;
    if (looksBlank) {
      if (!state.blankSince) state.blankSince = Date.now();
      if (Date.now() - state.blankSince >= 3000) enterRecovery("頁面載入不完整或暫時空白");
      return false;
    }
    state.blankSince = 0;
    leaveRecovery();
    return true;
  }

  function detectLoginPage() {
    const ruleNode = queryRule("login");
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 12000);
    const password = [...document.querySelectorAll('input[type="password"]')].find(isVisible);
    if (!ruleNode && !password && !hasRuleText("login", bodyText)) return null;
    return { type: "LOGIN", message: "偵測到登入 / 密碼頁，請你本人完成登入後再繼續。" };
  }

  function detectQueue() {
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 12000);
    const queueFrame = [...document.querySelectorAll("iframe")].some(f => isVisible(f) && /queue-it|waitingroom/i.test(`${f.src} ${f.title}`));
    return !!(queryRule("queue") || queueFrame || QUEUE_RE.test(bodyText) || hasRuleText("queue", bodyText));
  }

  function safeClick(el, reason) {
    if (!el || !isVisible(el) || isDisabled(el)) return false;
    state.paused = true;
    status("NEED_USER", "請自行確認並操作網站按鈕；QuickBuy 不自動點擊購買、送單或付款。");
    return false;
  }

  function detectChallenge() {
    const captchaFrames = [...document.querySelectorAll("iframe")].some(f => isVisible(f) && CAPTCHA_RE.test(`${f.src} ${f.title}`));
    const captchaNodes = !!queryRule("captcha") || [...document.querySelectorAll('[class*="captcha" i], [id*="captcha" i], [class*="turnstile" i], [id*="turnstile" i]')].some(isVisible);
    const otpInput = queryRule("otp") || [...document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i], input[id*="verification" i]')].find(isVisible);
    const paymentAuthInput = [...document.querySelectorAll('input[autocomplete="cc-csc"], input[name*="cvv" i], input[id*="cvv" i], input[name*="cvc" i], input[id*="cvc" i], input[name*="security-code" i], input[id*="security-code" i], input[name*="card-code" i], input[id*="card-code" i]')].find(isVisible);
    const visiblePrompt = [...document.querySelectorAll('label, p, div, span, h1, h2, h3')].filter(isVisible).slice(0, 2500).find(el => {
      const t = normText(el);
      return t.length > 0 && t.length < 180 && (CAPTCHA_RE.test(t) || OTP_RE.test(t));
    });

    if (captchaFrames || captchaNodes || (visiblePrompt && CAPTCHA_RE.test(normText(visiblePrompt)))) return { type: "CAPTCHA", message: "偵測到 CAPTCHA / 人機驗證，請你手動完成。" };
    if (otpInput || (visiblePrompt && OTP_RE.test(normText(visiblePrompt)))) return { type: "OTP", message: "偵測到 OTP / 簡訊或 Email 驗證碼，請你手動輸入。" };
    if (paymentAuthInput) return { type: "PAYMENT_AUTH", message: "偵測到 CVV/CVC / 卡片安全碼付款驗證欄位；QuickBuy 不保存或自動填寫此資訊。" };
    return null;
  }

  function pauseForChallenge(challenge) {
    const key = `${challenge.type}:${location.href}`;
    state.paused = true;
    if (state.lastChallengeKey !== key) {
      state.lastChallengeKey = key;
      log(challenge.message, "warn");
      status("NEED_USER", challenge.message, { challengeType: challenge.type });
      send("QBA_NOTIFY", { title: "QuickBuy 需要你接手", message: challenge.message });
    }
  }

  function pauseForFinal(el, text, reason = "") {
    state.paused = true;
    const suffix = reason ? `；${reason}` : "";
    log(`已抵達最後確認步驟，沒有自動點擊：「${text}」${suffix}`, "success");
    status("FINAL_CONFIRM", `已到付款 / 最終下單前${suffix}，請你確認後自行完成。`, { buttonText: text });
    send("QBA_NOTIFY", { title: "QuickBuy 已到最後一步", message: `付款 / 最終下單前已自動停止${suffix}。` });
    try {
      el.style.outline = "4px solid #ffb020";
      el.style.outlineOffset = "3px";
    } catch (_) {}
  }

  function configuredUniqueVisible(selector) {
    if (!selector) return { ok:false, reason:"未設定 selector", node:null, count:0 };
    try {
      const nodes = [...document.querySelectorAll(selector)];
      const visible = nodes.filter(el => isVisible(el) && !isDisabled(el));
      if (visible.length !== 1) return { ok:false, reason:`selector 必須唯一命中 1 個可見元素，目前為 ${visible.length}`, node:visible[0] || null, count:visible.length };
      return { ok:true, node:visible[0], count:1 };
    } catch (_) { return { ok:false, reason:"selector 格式無效", node:null, count:0 }; }
  }

  function readExactQuantity() {
    const check = configuredUniqueVisible(state.config?.quantitySelector || "");
    if (!check.ok) return { ok:false, reason:`數量欄位${check.reason}` };
    const el = check.node;
    const raw = el instanceof HTMLSelectElement ? (el.value || el.selectedOptions?.[0]?.textContent || "") : (el.value || normText(el));
    const n = Number(String(raw).match(/\d+/)?.[0] || 0);
    if (!Number.isFinite(n) || n < 1) return { ok:false, reason:"無法確認結帳數量" };
    return { ok:true, quantity:n, node:el };
  }

  function readCheckoutTotal() {
    const check = configuredUniqueVisible(state.config?.totalSelector || "");
    if (!check.ok) return { ok:false, reason:`總價欄位${check.reason}` };
    const nums = extractNumber(normText(check.node));
    if (!nums.length) return { ok:false, reason:"總價欄位無法解析金額" };
    const total = Math.max(...nums);
    if (!(total > 0)) return { ok:false, reason:"總價必須大於 0" };
    return { ok:true, total, node:check.node };
  }

  function optionControl(el) {
    if (!el) return null;
    if (el instanceof HTMLInputElement && ["checkbox","radio"].includes(el.type)) return el;
    if (el instanceof HTMLLabelElement && el.htmlFor) {
      try { const target=document.getElementById(el.htmlFor); if (target instanceof HTMLInputElement && ["checkbox","radio"].includes(target.type)) return target; } catch (_) {}
    }
    const nested=el.querySelector?.('input[type="checkbox"], input[type="radio"]');
    return nested || null;
  }

  function optionLooksSelected(el) {
    if (!el) return false;
    if (el instanceof HTMLOptionElement) return !!el.selected;
    const control=optionControl(el);
    if (control) return !!control.checked;
    const attrs=[el.getAttribute?.("aria-checked"),el.getAttribute?.("aria-selected"),el.getAttribute?.("aria-pressed"),el.getAttribute?.("data-selected")].map(x=>String(x||"").toLowerCase());
    if (attrs.includes("true") || attrs.includes("1")) return true;
    if (/(^|\s)(selected|active|checked|current)(\s|$)/i.test(String(el.className||""))) return true;
    return el.dataset?.qbaCheckoutDone === "1";
  }

  function checkoutContextText(el) {
    if (!el) return "";
    const control=optionControl(el);
    const label=control?.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`) : null;
    const wrappingLabel=el.closest?.("label") || control?.closest?.("label") || null;
    return [normText(el),normText(label),normText(wrappingLabel)].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
  }

  function validateCheckoutOption(kind, selector) {
    if (!selector) return { ok:true, configured:false, selected:true };
    const check=configuredUniqueVisible(selector);
    if (!check.ok) return { ok:false, configured:true, reason:`${kind} selector ${check.reason}` };
    const el=check.node;
    const text=checkoutContextText(el);
    const dangerous=/(刪除|delete|取消|cancel|登出|logout|退票|退款|refund|移除|remove)/i.test(text) || CAPTCHA_RE.test(text) || OTP_RE.test(text) || isFinalText(text);
    if (dangerous) return { ok:false, configured:true, reason:`${kind} selector 命中危險 / 最終交易元素：${text.slice(0,80)}` };
    if (kind === "terms") {
      const termsOk=/(同意|接受|agree|accept|terms|條款|規約|約款|privacy|隱私|policy)/i.test(text);
      if (!termsOk) return { ok:false, configured:true, reason:"條款 selector 周圍文字沒有可辨識的同意 / 條款語意" };
      if (!optionControl(el)) return { ok:false, configured:true, reason:"條款 selector 必須指向 checkbox / radio 或其 label" };
    }
    return { ok:true, configured:true, selected:optionLooksSelected(el), node:el, text };
  }

  const IBON_NAME_RE = /(?:7\s*[-‐‑‒–—－]?\s*(?:eleven|11)|7eleven|seven\s*[-‐‑‒–—－]?\s*eleven|ibon|統一超商)/i;
  const IBON_PICKUP_RE = /(?:取票|領票|票券取票|門市取票|門市領票|超商取票|超商領票|取貨|門市取貨|超商取貨|pickup)/i;
  const IBON_PAY_AT_STORE_RE = /(?:取票付款|取貨付款|門市付款|超商付款|到店付款|現場付款|現金付款|櫃檯付款|貨到付款|門市繳費|超商繳費|代碼繳費|門市代收|超商代收|ibon\s*(?:付款|繳費)|7\s*[-‐‑‒–—－]?\s*(?:eleven|11)\s*(?:付款|繳費)|cash\s*on\s*(?:delivery|pickup)|pay\s*(?:at|on)\s*(?:pickup|store|counter))/i;
  const ONLINE_PAY_RE = /(?:信用卡|刷卡|credit\s*card|debit\s*card|line\s*pay|apple\s*pay|google\s*pay|街口|jko|paypal|atm|轉帳|電子支付)/i;

  function fulfillmentPresetLabel(preset) {
    if (preset === "ibon_pickup") return "7-ELEVEN ibon 取票";
    if (preset === "ibon_pickup_pay") return "7-ELEVEN ibon 取票＋門市付款";
    return "";
  }

  function extendedCheckoutText(el) {
    if (!el) return "";
    const control=optionControl(el);
    const assocLabel=control?.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`) : null;
    const wrappingLabel=el.closest?.("label") || control?.closest?.("label") || null;
    const hosts=[el,assocLabel,wrappingLabel].filter(Boolean);
    const attrs=[el.getAttribute?.("aria-label"),el.getAttribute?.("title"),control?.getAttribute?.("aria-label"),control?.getAttribute?.("title")].filter(Boolean);
    const imageAlts=[];
    for (const host of hosts) {
      if (host instanceof HTMLImageElement && host.alt) imageAlts.push(host.alt);
      for (const img of host.querySelectorAll?.("img[alt]") || []) if (img.alt) imageAlts.push(img.alt);
      for (const node of host.querySelectorAll?.('[aria-label]') || []) { const v=node.getAttribute("aria-label"); if(v) attrs.push(v); }
    }
    const own=el instanceof HTMLOptionElement ? normText(el) : checkoutContextText(el);
    return [...new Set([own,...attrs,...imageAlts].filter(Boolean))].join(" ").replace(/\s+/g," ").trim();
  }

  function presetChoiceNodes() {
    const raw=[...document.querySelectorAll('input[type="radio"],input[type="checkbox"],button,[role="radio"],[role="option"],[role="button"],label,option')];
    const out=[], seen=new Set();
    for (const node of raw) {
      const control=optionControl(node);
      const canonical=control || node;
      if (seen.has(canonical)) continue;
      seen.add(canonical); out.push(node);
    }
    return out;
  }

  function presetNodeVisible(node) {
    if (node instanceof HTMLOptionElement) {
      const select=node.parentElement;
      return !!select && isVisible(select) && !node.disabled && !(select instanceof HTMLSelectElement && select.disabled);
    }
    return isVisible(node);
  }

  function presetCandidateSafe(node,text) {
    if (!node || !text) return false;
    if (/(刪除|delete|取消|cancel|登出|logout|退票|退款|refund|移除|remove)/i.test(text)) return false;
    if (CAPTCHA_RE.test(text) || OTP_RE.test(text) || isFinalText(text)) return false;
    return true;
  }

  function presetSemanticMatch(kind,preset,text,shippingText="") {
    const t=String(text||"");
    if (kind === "shipping") return IBON_NAME_RE.test(t) && IBON_PICKUP_RE.test(t);
    if (kind === "payment" && preset === "ibon_pickup_pay") {
      if (ONLINE_PAY_RE.test(t)) return false;
      return IBON_PAY_AT_STORE_RE.test(t) && (IBON_NAME_RE.test(t) || IBON_NAME_RE.test(shippingText));
    }
    return false;
  }

  function resolvePresetChoice(kind,preset,shippingCheck=null,configOverride=null) {
    if (!preset) return {ok:true,required:false,selected:true};
    if (kind === "payment" && preset !== "ibon_pickup_pay") return {ok:true,required:false,selected:true};
    if (kind === "payment" && shippingCheck?.ok && IBON_PAY_AT_STORE_RE.test(shippingCheck.text||"")) {
      return {ok:true,required:true,selected:!!shippingCheck.selected,node:shippingCheck.node,text:shippingCheck.text,combined:true,source:"combined"};
    }
    const cfg=configOverride || state.config || {};
    const selector=kind === "shipping" ? String(cfg.shippingSelector||"") : String(cfg.paymentSelector||"");
    if (selector) {
      const check=validateCheckoutOption(kind,selector);
      if (!check.ok) return {...check,required:true,source:"selector"};
      const text=extendedCheckoutText(check.node);
      if (!presetSemanticMatch(kind,preset,text,shippingCheck?.text||"")) {
        return {ok:false,required:true,reason:`${kind === "shipping" ? "配送 / 取票" : "付款"} selector 不符合 ${fulfillmentPresetLabel(preset)} 語意：${text.slice(0,100)}`,source:"selector"};
      }
      return {...check,required:true,text,source:"selector"};
    }
    const matches=[];
    for (const node of presetChoiceNodes()) {
      if (!presetNodeVisible(node)) continue;
      const text=extendedCheckoutText(node);
      if (!presetCandidateSafe(node,text)) continue;
      if (presetSemanticMatch(kind,preset,text,shippingCheck?.text||"")) matches.push({node,text,selected:optionLooksSelected(node)});
    }
    if (!matches.length) return {ok:false,required:true,reason:`找不到可唯一辨識的 ${fulfillmentPresetLabel(preset)} ${kind === "shipping" ? "取票 / 配送選項" : "門市付款選項"}`};
    if (matches.length > 1) return {ok:false,required:true,reason:`${fulfillmentPresetLabel(preset)} ${kind === "shipping" ? "取票 / 配送" : "門市付款"}出現 ${matches.length} 個候選；請手動指定 selector 以避免選錯`};
    return {ok:true,required:true,...matches[0],source:"auto"};
  }

  function checkoutAttemptKey(node,label="") {
    if (!node) return `checkout|${label}`;
    const semantic = semanticSignature(node);
    if (semantic) return `checkout|${semantic}`;
    if (node instanceof HTMLOptionElement) {
      const select=node.parentElement;
      return `checkout|option|${select?.id || select?.name || "select"}|${node.value || normText(node)}`;
    }
    return `checkout|${signature(node)}`;
  }

  function activateCheckoutChoice(node,label) {
    if (!node) return {acted:false,pending:false,exhausted:true,reason:"找不到選項元素"};
    if (optionLooksSelected(node)) return {acted:false,pending:false,exhausted:false,selected:true};
    const key=checkoutAttemptKey(node,label);
    const now=Date.now();
    const prev=state.checkoutAttempts.get(key) || {count:0,lastAt:0};
    if (prev.count >= 2) return {acted:false,pending:false,exhausted:true,reason:`${label}連續 2 次操作後仍未確認選取`};
    if (prev.lastAt && now - prev.lastAt < 1400) return {acted:false,pending:true,exhausted:false,reason:"等待網站更新選取狀態"};

    if (node instanceof HTMLOptionElement) {
      const select=node.parentElement;
      if (!(select instanceof HTMLSelectElement) || select.disabled || node.disabled) return {acted:false,pending:false,exhausted:true,reason:`${label}選項目前不可操作`};
      node.selected=true; select.value=node.value;
      select.dispatchEvent(new Event("input",{bubbles:true}));
      select.dispatchEvent(new Event("change",{bubbles:true}));
      try { node.dataset.qbaCheckoutDone="1"; select.dataset.qbaCheckoutDone="1"; } catch (_) {}
      state.checkoutAttempts.set(key,{count:prev.count+1,lastAt:now});
      log(`${label}：${normText(node) || node.value}`);
      return {acted:true,pending:false,exhausted:false};
    }

    // Checkout 選項允許最多一次受控重試；第二次前只解除該選項自己的防重複簽章，
    // 仍受 700ms、10 秒 8 次、總操作 20 次等全域安全限制。
    if (prev.count > 0) {
      const sig=signature(node), sem=semanticSignature(node);
      state.clickedSignatures.delete(sig);
      state.recentSignatureTimes.delete(sig);
      if (sem) state.recentSignatureTimes.delete(sem);
      persistRecentSignatures();
      log(`${label}尚未確認選取，進行第 ${prev.count+1} 次且最後一次安全重試。`,`warn`);
    }
    const acted=safeClick(node,label);
    if (acted) {
      state.checkoutAttempts.set(key,{count:prev.count+1,lastAt:now});
      return {acted:true,pending:false,exhausted:false};
    }
    if (state.paused) return {acted:false,pending:false,exhausted:true,reason:`${label}操作被安全機制暫停`};
    return {acted:false,pending:true,exhausted:false,reason:"受到操作節流，稍後重試"};
  }

  function queryConfigured(selector) {
    if (!selector) return null;
    try { return document.querySelector(selector); } catch (_) { return null; }
  }

  function inspectSelector(selector, label) {
    if (!selector) return { label, configured: false, valid: true, count: 0, visible: 0, state: "unset" };
    try {
      const nodes = [...document.querySelectorAll(selector)];
      const visible = nodes.filter(isVisible).length;
      return {
        label, configured: true, valid: true, count: nodes.length, visible,
        state: !nodes.length ? "missing" : visible ? "ok" : "hidden"
      };
    } catch (_) {
      return { label, configured: true, valid: false, count: 0, visible: 0, state: "invalid" };
    }
  }

  function selectorHealth() {
    return {
      purchase: inspectSelector(state.config?.purchaseSelector || "", "購買 / 下一步"),
      quantity: inspectSelector(state.config?.quantitySelector || "", "數量"),
      price: inspectSelector(state.config?.priceSelector || "", "價格"),
      ruleCoverage: ruleCoverage()
    };
  }

  function classifyPagePhase() {
    if (!state.running) return { phase: "IDLE", label: "未執行" };
    if (state.confirmationConfirmed) return { phase: "COMPLETED", label: "訂單已確認" };
    if (state.autoCommitSent && state.awaitingConfirmation) return { phase: "CONFIRMING", label: "送單後確認中" };
    if (state.recoveringReason) return { phase: "RECOVERING", label: "自動恢復中" };
    if (state.paused) {
      const challenge = detectChallenge();
      if (challenge?.type === "CAPTCHA") return { phase: "CAPTCHA", label: "等待 CAPTCHA" };
      if (challenge?.type === "OTP") return { phase: "OTP", label: "等待驗證碼" };
      if (detectLoginPage()) return { phase: "LOGIN", label: "等待登入" };
      if (findFinalAction()) return { phase: "FINAL", label: "最後確認" };
      return { phase: "PAUSED", label: "已暫停" };
    }
    if (!saleTimeReached()) return { phase: "PRE_SALE", label: "等待開賣" };
    if (detectLoginPage()) return { phase: "LOGIN", label: "等待登入" };
    if (detectQueue()) return { phase: "QUEUE", label: "官方排隊中" };
    const challenge = detectChallenge();
    if (challenge?.type === "CAPTCHA") return { phase: "CAPTCHA", label: "等待 CAPTCHA" };
    if (challenge?.type === "OTP") return { phase: "OTP", label: "等待驗證碼" };
    if (findFinalAction()) return { phase: "FINAL", label: "最後確認" };
    if (findNextAction()) return { phase: "ACTIONABLE", label: "可操作" };
    return { phase: "MONITORING", label: "監看中" };
  }

  function emitPageState(force = false) {
    if (!state.running) return;
    const info = classifyPagePhase();
    const health = selectorHealth();
    const healthKey = [health.purchase.state, health.quantity.state, health.price.state, health.ruleCoverage.visible].join("/");
    const key = `${info.phase}|${location.pathname}|${healthKey}`;
    state.lastPagePhase = info.phase;
    if (!force && key === state.lastPageStateKey) return;
    state.lastPageStateKey = key;
    send("QBA_PAGE_STATE", {
      phase: info.phase,
      label: info.label,
      url: location.href,
      title: document.title,
      selectorHealth: health,
      ts: Date.now()
    });
  }


  function choosePriority() {
    const priorities = Array.isArray(state.config.priorities) ? state.config.priorities.filter(Boolean) : [];
    if (!priorities.length || state.selectedPriority) return false;
    const elements = clickableElements();
    for (const keyword of priorities) {
      const k = keyword.trim().toLowerCase();
      const candidate = elements.find(el => {
        const text = normText(el).toLowerCase();
        return text.includes(k) && !isSoldElement(el);
      });
      if (candidate) {
        const acted = safeClick(candidate, `選擇順位 ${keyword}`);
        if (acted) {
          state.selectedPriority = keyword;
          try { sessionStorage.setItem("__qba_selected_priority", keyword); } catch (_) {}
          status("WORKING", `已選擇順位「${keyword}」。`);
          return true;
        }
        return false;
      }
    }
    return false;
  }

  function setNativeValue(el, value) {
    let proto = HTMLInputElement.prototype;
    if (el instanceof HTMLSelectElement) proto = HTMLSelectElement.prototype;
    else if (el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setQuantity() {
    const qty = Math.max(1, Math.min(20, Number(state.config.quantity || 1)));
    let el = queryConfigured(state.config.quantitySelector);
    if (!el) el = queryRule("quantity");
    if (!el) {
      el = document.querySelector('select[name*="qty" i], select[id*="qty" i], select[name*="quantity" i], input[name*="qty" i], input[id*="qty" i], input[name*="quantity" i]');
    }
    if (!el || el.dataset.qbaQtyDone === "1") return false;
    try {
      if (el instanceof HTMLSelectElement) {
        const option = [...el.options].find(o => Number((o.value || o.textContent).match(/\d+/)?.[0]) === qty);
        if (!option) return false;
        setNativeValue(el, option.value);
      } else {
        setNativeValue(el, qty);
      }
      el.dataset.qbaQtyDone = "1";
      log(`數量已設定為 ${qty}`);
      return true;
    } catch (_) { return false; }
  }

  function extractNumber(text) {
    const nums = String(text || "").replace(/,/g, "").match(/(?:NT\$|TWD|\$)?\s*(\d{2,7})(?:\.\d{1,2})?/gi) || [];
    return nums.map(s => Number(s.replace(/[^0-9.]/g, ""))).filter(Number.isFinite);
  }

  function checkPriceGuard() {
    const maxPrice = Number(state.config.maxPrice || 0);
    if (!maxPrice) return true;
    const el = queryConfigured(state.config.priceSelector) || queryRule("price");
    if (!el) return true;
    const prices = extractNumber(normText(el));
    if (!prices.length) return true;
    const price = Math.max(...prices);
    if (price > maxPrice) {
      state.paused = true;
      const msg = `價格 ${price.toLocaleString()} 超過上限 ${maxPrice.toLocaleString()}，已停止。`;
      log(msg, "error");
      status("PRICE_BLOCK", msg, { price, maxPrice });
      send("QBA_NOTIFY", { title: "QuickBuy 價格保護", message: msg });
      return false;
    }
    return true;
  }

  function findFieldByLabels(words) {
    const inputs = [...document.querySelectorAll("input, textarea")].filter(isVisible).filter(el => !el.disabled && el.type !== "password" && el.type !== "hidden");
    return inputs.find(el => {
      const id = el.id;
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const bag = [el.name, el.id, el.placeholder, el.autocomplete, el.getAttribute("aria-label"), label?.innerText].filter(Boolean).join(" ").toLowerCase();
      return words.some(w => bag.includes(w));
    });
  }

  function fillOne(value, words, mark) {
    if (!value) return false;
    const el = findFieldByLabels(words);
    if (!el || el.dataset[mark] === "1" || el.value) return false;
    try {
      setNativeValue(el, value);
      el.dataset[mark] = "1";
      return true;
    } catch (_) { return false; }
  }

  function fillProfile() {
    const p = state.config.profile || {};
    let changed = false;
    changed = fillOne(p.name, ["name", "姓名", "收件人"], "qbaName") || changed;
    changed = fillOne(p.email, ["email", "e-mail", "電子郵件", "信箱"], "qbaEmail") || changed;
    changed = fillOne(p.phone, ["phone", "mobile", "tel", "手機", "電話"], "qbaPhone") || changed;
    changed = fillOne(p.address, ["address", "地址", "street"], "qbaAddress") || changed;
    if (changed) log("已填入一般聯絡資料（不包含密碼、身分證、信用卡）。");
    return changed;
  }

  function findNextAction() {
    const custom = queryConfigured(state.config.purchaseSelector);
    if (custom && isVisible(custom) && !isDisabled(custom)) return custom;
    const ruleAction = queryRule("purchase", { clickable: true });
    if (ruleAction && !matchesRuleSelector(ruleAction, "final")) return ruleAction;
    const elements = clickableElements();
    return elements.find(el => {
      const text = normText(el);
      return isNextText(text) && !isFinalText(text) && !isSoldElement(el);
    });
  }

  function findFinalAction() {
    const configured = queryConfigured(state.config?.finalSelector || "");
    if (configured && isVisible(configured) && !isDisabled(configured)) return configured;
    const ruleAction = queryRule("final", { clickable: true });
    if (ruleAction) return ruleAction;
    return clickableElements().find(el => isFinalText(normText(el)));
  }

  function adjustedNow() {
    return Date.now() + Number(state.config?.clockOffsetMs || 0);
  }

  function saleTimeReached() {
    const t = Number(state.config.saleTimeTs || 0);
    return !t || adjustedNow() >= t;
  }

  function originGuard() {
    const expected = state.config?.targetOrigin;
    if (!expected || location.origin === expected) return true;
    state.paused = true;
    const msg = `頁面已離開原本網站（${expected} → ${location.origin}），已自動暫停。`;
    log(msg, "warn");
    status("SITE_CHANGED", msg, { url: location.href });
    send("QBA_NOTIFY", { title: "QuickBuy 網站已切換", message: "頁面已切換到其他網域，助手已停止自動操作，請你確認。" });
    return false;
  }

  function warnIfBackgroundNearSale() {
    const t = Number(state.config?.saleTimeTs || 0);
    if (!t || document.visibilityState === "visible") { state.visibilityWarned = false; return; }
    const remain = t - adjustedNow();
    if (remain <= 120000 && remain >= -300000 && !state.visibilityWarned) {
      state.visibilityWarned = true;
      const msg = "目標分頁目前在背景，接近開賣時可能受到瀏覽器計時節流影響，建議切回此頁。";
      log(msg, "warn");
      send("QBA_NOTIFY", { title: "QuickBuy 分頁提醒", message: msg });
    }
  }

  function loopDelay() {
    const base = Math.max(1000, Number(state.config.intervalMs || 1500));
    const jitter = Math.floor(Math.random() * Math.min(700, base * 0.35));
    return base + jitter;
  }

  function waitingDelayMs() {
    const saleTs = Number(state.config?.saleTimeTs || 0);
    if (!saleTs) return Math.min(1500, loopDelay());
    const remain = saleTs - adjustedNow();
    if (remain > 60 * 60 * 1000) return 15000;
    if (remain > 15 * 60 * 1000) return 8000;
    if (remain > 5 * 60 * 1000) return 4000;
    if (remain > 2 * 60 * 1000) return 2000;
    return Math.min(900, loopDelay());
  }

  function emitHeartbeat(force = false) {
    const now = Date.now();
    if (!force && now - state.lastHeartbeatAt < 30000) return;
    state.lastHeartbeatAt = now;
    send("QBA_HEARTBEAT", {
      ts: now,
      visible: document.visibilityState === "visible",
      lifecycle: state.lifecycle || "active",
      timerDriftMs: Math.round(state.lastTimerDriftMs || 0),
      url: location.href
    });
  }

  function pausedDelayMs() {
    return document.visibilityState === "visible" ? 3000 : 5000;
  }

  function scheduleTick(delayMs) {
    if (!state.running) return;
    clearTimeout(state.timer);
    const delay = Math.max(50, Number(delayMs || 0));
    state.lastScheduledDelayMs = delay;
    state.nextTickDueAt = Date.now() + delay;
    state.timer = setTimeout(() => {
      const now = Date.now();
      state.lastTimerDriftMs = Math.max(0, now - Number(state.nextTickDueAt || now));
      if (state.lastTimerDriftMs >= 1500) emitHeartbeat(true);
      tick();
    }, delay);
  }

  async function tick() {
    if (!state.running) return;
    emitHeartbeat(false);
    if (state.paused) {
      scheduleTick(pausedDelayMs());
      return;
    }

    try {
      if (!originGuard()) { scheduleTick(700); return; }
      if (!recoveryGuard()) { emitPageState(); scheduleTick(1000); return; }
      warnIfBackgroundNearSale();
      emitPageState();

      if (!saleTimeReached()) {
        status("WAITING", "待命中，等待開賣時間。", { saleTimeTs: state.config.saleTimeTs });
        state.consecutiveErrors = 0;
        scheduleTick(waitingDelayMs());
        return;
      }

      const login = detectLoginPage();
      if (login) {
        pauseForChallenge(login);
        scheduleTick(pausedDelayMs());
        return;
      }

      if (detectQueue()) {
        if (!state.queueSeen) {
          state.queueSeen = true;
          log("偵測到官方排隊 / Waiting Room，助手只等待，不嘗試繞過排隊。", "warn");
        }
        status("QUEUE_WAIT", "目前在官方排隊 / Waiting Room，等待網站放行。", { url: location.href });
        scheduleTick(Math.max(1200, loopDelay()));
        return;
      }
      state.queueSeen = false;

      const challenge = detectChallenge();
      if (challenge) {
        pauseForChallenge(challenge);
        scheduleTick(pausedDelayMs());
        return;
      }

      if (!checkPriceGuard()) {
        scheduleTick(pausedDelayMs());
        return;
      }

      // Never mutate an unknown page or any checkout/final-confirmation page.
      const phase = classifyPagePhase().phase;
      if (phase !== "ACTIONABLE") {
        state.paused = true;
        status("NEED_USER", "此頁面需要你確認，助手已停止操作。");
        scheduleTick(pausedDelayMs());
        return;
      }
      const finalBeforePrep = findFinalAction();
      if (finalBeforePrep) { pauseForFinal(finalBeforePrep, normText(finalBeforePrep)); return; }
      fillProfile();
      setQuantity();

      const finalAction = findFinalAction();
      if (finalAction) {
        pauseForFinal(finalAction, normText(finalAction), "QuickBuy 1.0 最終確認一律由你完成");
        scheduleTick(pausedDelayMs());
        return;
      }

      if (choosePriority()) {
        state.consecutiveErrors = 0;
        scheduleTick(loopDelay());
        return;
      }

      const next = findNextAction();
      if (next) {
        const acted = safeClick(next, "自動操作");
        if (acted) {
          status("WORKING", `已操作：${normText(next) || "下一步"}`);
          state.consecutiveErrors = 0;
          scheduleTick(loopDelay());
          return;
        }
        if (state.paused) {
          scheduleTick(pausedDelayMs());
          return;
        }
      }

      state.consecutiveErrors = 0;
      status("WAITING", "頁面已檢查，正在等待可操作項目。", { url: location.href });
      scheduleTick(loopDelay());
    } catch (error) {
      state.consecutiveErrors += 1;
      log(`頁面檢查發生錯誤（${state.consecutiveErrors}/3）：${error?.message || error}`, "error");
      if (state.consecutiveErrors >= 3) {
        state.paused = true;
        const msg = "頁面連續發生 3 次錯誤，已自動暫停，避免誤操作。";
        status("AUTO_PAUSED", msg, { url: location.href });
        send("QBA_NOTIFY", { title: "QuickBuy 已自動暫停", message: msg });
      }
      scheduleTick(state.paused ? pausedDelayMs() : 900);
    }
  }


  function selectorCheck(selector, label, required = false) {
    if (!selector) {
      return { level: required ? "warn" : "info", label, message: required ? `${label}尚未指定，將使用自動判斷。` : `${label}未指定。` };
    }
    try {
      const nodes = [...document.querySelectorAll(selector)];
      if (!nodes.length) return { level: "warn", label, message: `${label}找不到對應元素，可能是頁面尚未開賣或網站已改版。` };
      const visible = nodes.find(isVisible);
      if (!visible) return { level: "warn", label, message: `${label}有找到元素，但目前不可見。` };
      return { level: "pass", label, message: `${label}對應正常：${normText(visible).slice(0, 70) || selector}` };
    } catch (_) {
      return { level: "fail", label, message: `${label}的 CSS selector 格式無效。` };
    }
  }

  function preflight(config = {}) {
    const items = [];
    const saleTs = Number(config.saleTimeTs || 0);
    const now = Date.now() + Number(config.clockOffsetMs || 0);

    items.push({ level: "pass", label: "網頁", message: `目前頁面可讀取：${document.title || location.hostname}` });
    items.push({ level: location.protocol === "https:" ? "pass" : "warn", label: "連線", message: location.protocol === "https:" ? "目前是 HTTPS 網頁。" : "目前不是 HTTPS 網頁，請確認網址是否正確。" });

    if (config.targetOrigin && config.targetOrigin !== location.origin) items.push({ level: "fail", label: "網域", message: `目前頁面網域 ${location.origin} 與目標 ${config.targetOrigin} 不一致。` });
    else items.push({ level: "pass", label: "網域", message: `目標網域鎖定：${location.origin}` });

    const rule = config.siteRule;
    if (config.ruleMode === "generic" || !rule || rule.builtin) items.push({ level: "info", label: "規則", message: "目前使用 QuickBuy 通用辨識。" });
    else items.push({ level: "pass", label: "規則", message: `已命中專用規則：${rule.name || rule.id} v${rule.version || "1.0.0"}；找不到專用元素時仍會回退通用辨識。` });
    if (config.ruleMode !== "generic" && rule && !rule.builtin) {
      const coverage = ruleCoverage(rule);
      const matchedKinds = coverage.kinds.filter(x => x.visible).length;
      const definedKinds = coverage.kinds.length;
      items.push({
        level: matchedKinds ? "pass" : "warn",
        label: "規則命中",
        message: definedKinds ? `專用規則目前 ${matchedKinds}/${definedKinds} 類 selector 有可見命中；未命中的項目會回退通用辨識。` : "此專用規則目前只使用文字規則；未命中時會回退通用辨識。"
      });
    }

    const offset = Number(config.clockOffsetMs || 0);
    const clockMeta = config.clockMeta || {};
    if (clockMeta.syncedAt) {
      const quality = clockMeta.quality === "good" ? "較高" : clockMeta.quality === "fair" ? "中等" : "偏低";
      const level = clockMeta.quality === "low" ? "warn" : Math.abs(offset) <= 300000 ? "pass" : "warn";
      items.push({ level, label: "校時", message: `已套用網站時間校正 ${offset >= 0 ? "+" : ""}${offset} ms；${Number(clockMeta.samples || 0)} 次取樣，RTT ${Number(clockMeta.rttMs || 0)} ms，抖動 ${Number(clockMeta.jitterMs || 0)} ms，估計不確定度約 ±${Number(clockMeta.uncertaintyMs || 0)} ms（${quality}）。` });
    } else {
      items.push({ level: "warn", label: "校時", message: "目前使用 Windows 本機時間；建議開賣前先同步網站時間。" });
    }

    if (saleTs) {
      const diff = saleTs - now;
      if (diff > 0) items.push({ level: "pass", label: "時間", message: `開賣時間已設定，距離現在約 ${Math.max(1, Math.round(diff / 60000))} 分鐘。` });
      else items.push({ level: "warn", label: "時間", message: "設定的開賣時間已經到了或在過去，啟動後會立即開始檢查。" });
    } else {
      items.push({ level: "warn", label: "時間", message: "未設定開賣時間，啟動後會立即開始檢查。" });
    }

    const priorities = Array.isArray(config.priorities) ? config.priorities.filter(Boolean) : [];
    items.push({ level: priorities.length ? "pass" : "info", label: "順位", message: priorities.length ? `已設定 ${priorities.length} 個順位。` : "未設定順位，將直接尋找購買 / 下一步。" });

    const qty = Number(config.quantity || 1);
    items.push({ level: qty >= 1 && qty <= 20 ? "pass" : "fail", label: "數量", message: qty >= 1 && qty <= 20 ? `購買數量：${qty}` : "數量必須介於 1～20。" });

    const maxPrice = Number(config.maxPrice || 0);
    if (maxPrice > 0) items.push({ level: config.priceSelector ? "pass" : "warn", label: "價格保護", message: config.priceSelector ? `已設定單價上限 ${maxPrice.toLocaleString()}，並指定價格欄位。` : `已設定單價上限 ${maxPrice.toLocaleString()}，但尚未指定價格欄位；價格保護可能無法判斷。` });
    else items.push({ level: "info", label: "價格保護", message: "未設定價格上限。" });

    items.push(selectorCheck(config.purchaseSelector, "購買 / 下一步按鈕", false));
    items.push(selectorCheck(config.quantitySelector, "數量欄位", false));
    if (config.maxPrice > 0 || config.priceSelector) items.push(selectorCheck(config.priceSelector, "價格欄位", !!config.maxPrice));
    items.push({ level:"pass", label:"最終確認", message:"QuickBuy 1.0 一律在付款 / 最終下單前停止，由你確認並送出。" });

    const login = detectLoginPage();
    if (login) items.push({ level: "warn", label: "登入", message: login.message });
    else items.push({ level: "pass", label: "登入", message: "目前沒有偵測到需要輸入密碼的登入頁。" });

    if (detectQueue()) items.push({ level: "warn", label: "排隊", message: "目前偵測到官方排隊 / Waiting Room；助手會等待，不會繞過排隊。" });
    else items.push({ level: "pass", label: "排隊", message: "目前沒有偵測到 Waiting Room / Queue 頁。" });

    const challenge = detectChallenge();
    if (challenge) items.push({ level: "warn", label: "驗證", message: challenge.message });
    else items.push({ level: "pass", label: "驗證", message: "目前畫面沒有偵測到 CAPTCHA / OTP。" });

    const previousConfigForFinal = state.config;
    state.config = config || {};
    const finalAction = findFinalAction();
    if (finalAction) items.push({ level: "warn", label: "交易保護", message: `目前畫面已出現最終交易按鈕「${normText(finalAction).slice(0, 70)}」，正式執行時會停在這裡。` });
    else items.push({ level: "pass", label: "交易保護", message: "付款 / 最終下單保護已啟用。" });
    state.config = previousConfigForFinal;

    const hasFail = items.some(x => x.level === "fail");
    const warnCount = items.filter(x => x.level === "warn").length;
    return {
      ok: !hasFail,
      host: location.hostname,
      title: document.title,
      url: location.href,
      summary: hasFail ? "健檢未通過，請先修正紅色項目。" : warnCount ? `健檢可用，但有 ${warnCount} 個提醒。` : "健檢通過，可以待命。",
      items
    };
  }


  function rehearsal(config = {}) {
    const previousConfig = state.config;
    state.config = config || {};
    try {
      const steps = [];
      const add = (level, label, message, extra = {}) => steps.push({ level, label, message, ...extra });
      add("pass", "頁面", `可讀取目前頁面：${document.title || location.hostname}`);
      if (config.targetOrigin && config.targetOrigin !== location.origin) add("fail", "網域", `目前 ${location.origin} 與目標 ${config.targetOrigin} 不一致。`);
      else add("pass", "網域", `目前位於目標網域 ${location.origin}。`);

      const rule = activeRule();
      if (config.ruleMode === "generic" || !rule || rule.builtin) add("info", "規則", "演練使用 QuickBuy 通用辨識。");
      else {
        const coverage = ruleCoverage(rule);
        add(coverage.visible ? "pass" : "warn", "規則", `專用規則 ${rule.name || rule.id} v${rule.version || "1.0.0"}，目前 ${coverage.visible}/${coverage.total} 類 selector 有可見命中。`);
      }

      const health = selectorHealth();
      for (const [key, label] of [["purchase","購買 selector"],["quantity","數量 selector"],["price","價格 selector"]]) {
        const h = health[key];
        if (!h?.configured) continue;
        if (!h.valid) add("fail", label, "CSS selector 格式無效。");
        else if (!h.count) add("warn", label, "目前頁面找不到指定元素，可能尚未開賣或網站已改版。");
        else if (!h.visible) add("warn", label, `找到 ${h.count} 個元素，但目前都不可見。`);
        else add("pass", label, `找到 ${h.visible} 個可見元素。`);
      }

      const login = detectLoginPage();
      const queue = detectQueue();
      const challenge = detectChallenge();
      const finalAction = findFinalAction();
      if (login) add("warn", "登入", "目前需要先由你本人完成登入；助手不會填密碼。");
      else add("pass", "登入", "沒有偵測到密碼登入頁。");
      if (queue) add("warn", "Queue", "目前在官方排隊 / Waiting Room；正式執行只會等待網站放行。");
      else add("pass", "Queue", "目前沒有偵測到 Waiting Room。");
      if (challenge) add("warn", "驗證", `${challenge.type} 目前可見；正式執行會停住叫你接手。`);
      else add("pass", "驗證", "目前沒有 CAPTCHA / OTP 阻擋。");

      const priorities = Array.isArray(config.priorities) ? config.priorities.filter(Boolean) : [];
      let priorityHit = null;
      if (priorities.length) {
        const elements = clickableElements();
        for (const keyword of priorities) {
          const k = String(keyword).trim().toLowerCase();
          const candidate = elements.find(el => normText(el).toLowerCase().includes(k) && !isSoldElement(el));
          if (candidate) { priorityHit = { keyword, text: normText(candidate) }; break; }
        }
        if (priorityHit) add("pass", "順位", `目前可找到順位「${priorityHit.keyword}」：${priorityHit.text.slice(0,80)}`);
        else add("warn", "順位", `已設定 ${priorities.length} 個順位，但目前頁面尚未找到可用項目。`);
      } else add("info", "順位", "未設定順位，會直接找購買 / 下一步。");

      const qty = Math.max(1, Math.min(20, Number(config.quantity || 1)));
      const qtyEl = queryConfigured(config.quantitySelector) || queryRule("quantity") || document.querySelector('select[name*="qty" i], select[id*="qty" i], select[name*="quantity" i], input[name*="qty" i], input[id*="qty" i], input[name*="quantity" i]');
      if (qtyEl && isVisible(qtyEl)) {
        if (qtyEl instanceof HTMLSelectElement) {
          const option = [...qtyEl.options].find(o => Number((o.value || o.textContent).match(/\d+/)?.[0]) === qty);
          add(option ? "pass" : "warn", "數量", option ? `數量欄位可選 ${qty}。` : `找到數量欄位，但目前選項沒有 ${qty}。`);
        } else add("pass", "數量", `找到可輸入數量的欄位，目標數量 ${qty}。`);
      } else add("warn", "數量", `目前頁面沒有找到數量欄位；若網站在下一頁才選數量屬正常情況。`);

      const maxPrice = Number(config.maxPrice || 0);
      if (maxPrice > 0) {
        const priceEl = queryConfigured(config.priceSelector) || queryRule("price");
        if (!priceEl) add("warn", "價格保護", `已設定單價上限 ${maxPrice.toLocaleString()}，但目前找不到價格欄位。`);
        else {
          const prices = extractNumber(normText(priceEl));
          if (!prices.length) add("warn", "價格保護", "找到價格元素，但目前無法解析出數字。");
          else {
            const price = Math.max(...prices);
            add(price > maxPrice ? "fail" : "pass", "價格保護", price > maxPrice ? `目前價格 ${price.toLocaleString()} 高於上限 ${maxPrice.toLocaleString()}，正式模式會停止。` : `目前解析價格 ${price.toLocaleString()}，未超過上限 ${maxPrice.toLocaleString()}。`, { price, maxPrice });
          }
        }
      } else add("info", "價格保護", "未設定單價上限。");

      const next = findNextAction();
      if (next) add("pass", "下一步", `可辨識操作元素：「${normText(next).slice(0,90) || next.tagName}」。`);
      else if (login || queue || challenge || finalAction) add("info", "下一步", "目前被登入 / Queue / 驗證 / 最後確認階段擋住，未要求辨識下一步。");
      else add("warn", "下一步", "目前沒有找到購買 / 下一步按鈕；可能尚未開賣或需要更新 selector。");

      if (finalAction) add("pass", "交易停手", `已辨識最終交易按鈕「${normText(finalAction).slice(0,80)}」，正式執行會停在此處。`);
      else add("pass", "交易停手", "最終付款 / 下單保護已啟用，後續出現時會自動停手。");

      const fail = steps.filter(x => x.level === "fail").length;
      const warn = steps.filter(x => x.level === "warn").length;
      const score = Math.max(0, Math.min(100, 100 - fail * 25 - warn * 6));
      return {
        ok: fail === 0,
        score,
        summary: fail ? `演練發現 ${fail} 個必修正問題、${warn} 個提醒。` : warn ? `演練可用，但有 ${warn} 個提醒。` : "演練完整通過。",
        url: location.href,
        title: document.title,
        at: Date.now(),
        phase: queue ? "QUEUE" : login ? "LOGIN" : challenge?.type || (finalAction ? "FINAL" : next ? "ACTIONABLE" : "MONITORING"),
        priorityHit,
        steps
      };
    } finally {
      state.config = previousConfig;
    }
  }

  function start(config, resumedAfterNavigation = false) {
    clearTimeout(state.timer);
    state.running = true;
    state.paused = false;
    state.config = config || {};
    if (resumedAfterNavigation) {
      try { state.selectedPriority = sessionStorage.getItem("__qba_selected_priority") || null; } catch (_) { state.selectedPriority = null; }
      try { state.clickCount = Math.max(0, Number(sessionStorage.getItem("__qba_click_count") || 0)); } catch (_) { state.clickCount = 0; }
      try {
        state.autoCommitSent = sessionStorage.getItem("__qba_autocommit_sent") === "1";
        state.autoCommitAt = Number(sessionStorage.getItem("__qba_autocommit_at") || 0) || 0;
        state.confirmationStartedAt = state.autoCommitAt || 0;
        state.confirmationNotified = false;
        state.confirmationBaselineHash = sessionStorage.getItem("__qba_confirmation_baseline_hash") || "";
        state.confirmationBaselineUrl = sessionStorage.getItem("__qba_confirmation_baseline_url") || "";
        state.completionSent = false;
        resetConfirmationCandidate();
      } catch (_) { state.autoCommitSent = false; state.autoCommitAt = 0; state.awaitingConfirmation = false; state.confirmationStartedAt = 0; state.confirmationNotified = false; state.confirmationConfirmed = false; state.confirmationBaselineHash = ""; state.confirmationBaselineUrl = ""; state.completionSent = false; resetConfirmationCandidate(); }
    } else {
      state.selectedPriority = null;
      state.clickCount = 0;
      state.autoCommitSent = false;
      state.autoCommitAt = 0;
      state.awaitingConfirmation = false;
      state.confirmationStartedAt = 0;
      state.confirmationNotified = false;
      state.confirmationConfirmed = false;
      state.confirmationBaselineHash = "";
      state.confirmationBaselineUrl = "";
      state.completionSent = false;
      resetConfirmationCandidate();
      try {
        sessionStorage.removeItem("__qba_selected_priority");
        sessionStorage.setItem("__qba_click_count", "0");
        sessionStorage.removeItem("__qba_autocommit_sent");
        sessionStorage.removeItem("__qba_autocommit_at");
        sessionStorage.removeItem("__qba_confirmation_baseline_hash");
        sessionStorage.removeItem("__qba_confirmation_baseline_url");
      } catch (_) {}
    }
    state.clickedSignatures.clear();
    state.checkoutAttempts.clear();
    state.lastChallengeKey = "";
    state.consecutiveErrors = 0;
    state.visibilityWarned = false;
    state.queueSeen = false;
    state.lastPageStateKey = "";
    state.lastPagePhase = "UNKNOWN";
    state.recoveringReason = "";
    state.blankSince = 0;
    state.navigationRecoveryUntil = resumedAfterNavigation ? Date.now() + 5000 : 0;
    if (resumedAfterNavigation) {
      try { state.recoveryCount = Math.max(0, Number(sessionStorage.getItem("__qba_recovery_count") || 0)) + 1; sessionStorage.setItem("__qba_recovery_count", String(state.recoveryCount)); } catch (_) { state.recoveryCount += 1; }
    } else {
      state.recoveryCount = 0;
      try { sessionStorage.setItem("__qba_recovery_count", "0"); sessionStorage.removeItem("__qba_recent_signatures"); } catch (_) {}
    }
    restoreRecentSignatures();
    restoreActionHistory();
    state.nextTickDueAt = 0;
    state.lastTimerDriftMs = 0;
    state.lastHeartbeatAt = 0;
    state.lastScheduledDelayMs = 0;
    state.lifecycle = document.visibilityState === "visible" ? "active" : "hidden";
    emitHeartbeat(true);
    const ruleName = state.config?.siteRuleMeta && state.config.siteRuleMeta.source !== "generic" ? `${state.config.siteRuleMeta.name} v${state.config.siteRuleMeta.version}` : "QuickBuy 通用辨識";
    log(`${resumedAfterNavigation ? "頁面重新載入後已自動恢復" : "助手已啟動"}：${document.title} · 規則：${ruleName}`);
    status(resumedAfterNavigation ? "RECOVERING" : "READY", resumedAfterNavigation ? "頁面重新載入，已自動恢復工作階段並重新辨識。" : "助手已啟動並開始監看。", { url: location.href, rule: state.config?.siteRuleMeta || null });
    emitPageState(true);
    tick();
  }

  function stop() {
    state.running = false;
    state.paused = false;
    clearTimeout(state.timer);
    state.nextTickDueAt = 0;
    state.lastScheduledDelayMs = 0;
    state.lifecycle = "stopped";
    status("STOPPED", "助手已停止。", { url: location.href });
    log("助手已停止。", "warn");
  }

  function resume() {
    if (!state.running) return;
    state.paused = false;
    state.lastChallengeKey = "";
    state.clickedSignatures.clear();
    state.consecutiveErrors = 0;
    restoreActionHistory();
    status("WORKING", "已由你手動接管完成，繼續執行。", { url: location.href });
    log("手動驗證完成，繼續執行。", "success");
    emitPageState(true);
    scheduleTick(50);
  }

  function selectorFor(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const goodAttrs = ["data-testid", "data-test", "data-qa", "name"];
    for (const a of goodAttrs) {
      const v = el.getAttribute(a);
      if (v) return `${el.tagName.toLowerCase()}[${a}="${CSS.escape(v)}"]`;
    }
    const classes = [...el.classList].filter(c => /^[a-zA-Z_-][\w-]{1,40}$/.test(c)).slice(0, 2);
    if (classes.length) {
      const sel = `${el.tagName.toLowerCase()}.${classes.map(CSS.escape).join(".")}`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      const siblings = cur.parentElement ? [...cur.parentElement.children].filter(x => x.tagName === cur.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function enablePicker(targetKey) {
    if (state.pickerCleanup) state.pickerCleanup();
    let last;
    const onMove = (e) => {
      if (last) last.style.outline = last.dataset.qbaOldOutline || "";
      const el = e.target;
      if (!(el instanceof Element)) return;
      last = el;
      el.dataset.qbaOldOutline = el.style.outline || "";
      el.style.outline = "3px solid #5d7cff";
    };
    const cleanup = () => {
      document.removeEventListener("mouseover", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      if (last) last.style.outline = last.dataset.qbaOldOutline || "";
      state.pickerCleanup = null;
    };
    const onClick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const el = e.target;
      const selector = selectorFor(el);
      cleanup();
      send("QBA_PICKED_SELECTOR", { targetKey, selector, text: normText(el).slice(0, 120) });
    };
    const onKey = (e) => { if (e.key === "Escape") cleanup(); };
    document.addEventListener("mouseover", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    state.pickerCleanup = cleanup;
    log("元素選取模式已開啟：請到網頁點一下目標元素，Esc 可取消。", "warn");
  }

  document.addEventListener("visibilitychange", () => {
    state.lifecycle = document.visibilityState === "visible" ? "active" : "hidden";
    if (!state.running) return;
    if (document.visibilityState === "visible") {
      state.visibilityWarned = false;
      scheduleTick(60);
    } else {
      warnIfBackgroundNearSale();
    }
    emitHeartbeat(true);
    emitPageState(true);
  });

  window.addEventListener("pageshow", () => {
    state.lifecycle = "active";
    if (!state.running) return;
    emitHeartbeat(true);
    scheduleTick(80);
  });

  window.addEventListener("pagehide", () => {
    state.lifecycle = "pagehide";
    if (state.running) emitHeartbeat(true);
  });

  function candidateQuality(selector) {
    let score = 45;
    if (!selector) return 0;
    if (selector.startsWith("#")) score += 42;
    if (/\[data-(testid|test|qa)=/.test(selector)) score += 36;
    if (/\[name=/.test(selector)) score += 28;
    if (/nth-(child|of-type)/.test(selector)) score -= 22;
    if (selector.includes(" > ")) score -= Math.min(18, (selector.match(/ > /g) || []).length * 4);
    try {
      const count = document.querySelectorAll(selector).length;
      if (count === 1) score += 14;
      else if (count > 5) score -= 18;
      else if (count > 1) score -= 6;
    } catch (_) { return 0; }
    return Math.max(0, Math.min(100, score));
  }

  function hashText(input) {
    let h = 2166136261;
    const text = String(input || "");
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function inspectRuleSelectorsDetailed(rule = activeRule()) {
    if (!rule || rule.builtin) return [];
    const rows = [];
    for (const [kind, selectors] of Object.entries(rule.selectors || {})) {
      for (const selector of Array.isArray(selectors) ? selectors : []) {
        try {
          const nodes = [...document.querySelectorAll(selector)];
          const visible = nodes.filter(isVisible).length;
          rows.push({ kind, selector, count: nodes.length, visible, state: !nodes.length ? "missing" : visible ? "ok" : "hidden" });
        } catch (_) {
          rows.push({ kind, selector, count: 0, visible: 0, state: "invalid" });
        }
      }
    }
    return rows;
  }

  function debugScan(config = {}) {
    const previousConfig = state.config;
    state.config = { ...(state.config || {}), ...(config || {}) };
    try {
      const candidates = [];
      const seen = new Set();
      const add = (kind, el, reason, baseScore = 50) => {
        if (!el || !(el instanceof Element)) return;
        const selector = selectorFor(el);
        if (!selector) return;
        const key = `${kind}|${selector}`;
        if (seen.has(key)) return;
        seen.add(key);
        let count = 0;
        try { count = document.querySelectorAll(selector).length; } catch (_) {}
        const item = {
          kind,
          selector,
          text: normText(el).slice(0, 160),
          reason,
          score: Math.max(0, Math.min(100, Math.round((candidateQuality(selector) + baseScore) / 2))),
          count,
          visible: isVisible(el),
          disabled: isDisabled(el),
          tag: el.tagName.toLowerCase()
        };
        candidates.push(item);
      };

      const configured = [
        ["purchase", state.config?.purchaseSelector],
        ["quantity", state.config?.quantitySelector],
        ["price", state.config?.priceSelector]
      ];
      for (const [kind, selector] of configured) {
        if (!selector) continue;
        try { [...document.querySelectorAll(selector)].slice(0, 6).forEach(el => add(kind, el, "手動 selector 命中", 100)); } catch (_) {}
      }

      for (const kind of ["purchase", "quantity", "price", "sold", "final", "login", "queue", "captcha", "otp"]) {
        for (const selector of ruleSelectors(kind)) {
          try { [...document.querySelectorAll(selector)].slice(0, 8).forEach(el => add(kind, el, "專用規則 selector", 94)); } catch (_) {}
        }
      }

      for (const el of clickableElements().slice(0, 500)) {
        const text = normText(el);
        if (isFinalText(text)) add("final", el, "文字像付款 / 最終確認", 88);
        else if (isNextText(text) && !isSoldElement(el)) add("purchase", el, "文字像購買 / 下一步", 82);
        if (isSoldText(text) || isSoldElement(el)) add("sold", el, "文字或規則顯示售完", 78);
      }

      const qtyNodes = [...document.querySelectorAll('select[name*="qty" i], select[id*="qty" i], select[name*="quantity" i], input[name*="qty" i], input[id*="qty" i], input[name*="quantity" i], input[type="number"]')]
        .filter(isVisible).slice(0, 40);
      qtyNodes.forEach(el => add("quantity", el, "欄位名稱 / 類型像數量", 78));

      const priceNodes = [...document.querySelectorAll('[class*="price" i], [id*="price" i], [data-price], [itemprop="price"], [class*="amount" i], [id*="amount" i]')]
        .filter(isVisible).slice(0, 60);
      for (const el of priceNodes) {
        const text = normText(el);
        if (extractNumber(text).length || el.getAttribute("data-price")) add("price", el, "欄位名稱 / 內容像價格", 88);
      }

      [...document.querySelectorAll('input[type="password"]')].filter(isVisible).slice(0, 10).forEach(el => add("login", el, "可見密碼欄位", 92));
      [...document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i], input[id*="verification" i]')]
        .filter(isVisible).slice(0, 12).forEach(el => add("otp", el, "欄位像 OTP / 驗證碼", 92));
      [...document.querySelectorAll('[class*="captcha" i], [id*="captcha" i], [class*="turnstile" i], [id*="turnstile" i]')]
        .filter(isVisible).slice(0, 12).forEach(el => add("captcha", el, "頁面元素像 CAPTCHA", 92));

      const promptNodes = [...document.querySelectorAll('label, p, div, span, h1, h2, h3, h4')].filter(isVisible).slice(0, 1800);
      for (const el of promptNodes) {
        const text = normText(el);
        if (!text || text.length > 180) continue;
        if (QUEUE_RE.test(text)) add("queue", el, "文字像 Waiting Room / Queue", 82);
        if (CAPTCHA_RE.test(text)) add("captcha", el, "文字像 CAPTCHA / 人機驗證", 82);
        if (OTP_RE.test(text)) add("otp", el, "文字像 OTP / 驗證碼", 82);
        if (SOLD_RE.test(text)) add("sold", el, "文字像售完 / 缺貨", 76);
      }

      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 16000);
      const signals = {
        phase: classifyPagePhase(),
        login: !!detectLoginPage(),
        queue: !!detectQueue(),
        challenge: detectChallenge()?.type || null,
        final: !!findFinalAction(),
        soldText: SOLD_RE.test(bodyText),
        readyState: document.readyState,
        visible: document.visibilityState === "visible"
      };

      candidates.sort((a, b) => b.score - a.score || Number(b.visible) - Number(a.visible) || a.kind.localeCompare(b.kind));
      const trimmed = candidates.slice(0, 120);
      const fingerprintSource = trimmed.map(x => `${x.kind}|${x.selector}|${x.text}`).sort().join("\n") + `\n${location.pathname}`;
      return {
        ok: true,
        url: location.href,
        title: document.title,
        scannedAt: Date.now(),
        fingerprint: hashText(fingerprintSource),
        signals,
        candidates: trimmed,
        ruleSelectors: inspectRuleSelectorsDetailed(),
        counts: trimmed.reduce((acc, x) => { acc[x.kind] = (acc[x.kind] || 0) + 1; return acc; }, {})
      };
    } finally {
      state.config = previousConfig;
    }
  }

  function diagnostics() {
    return {
      url: location.href,
      origin: location.origin,
      title: document.title,
      readyState: document.readyState,
      visible: document.visibilityState === "visible",
      running: state.running,
      paused: state.paused,
      clickCount: state.clickCount,
      recentActionCount: recentActionCount(),
      selectedPriority: state.selectedPriority,
      recoveringReason: state.recoveringReason || null,
      recoveryCount: state.recoveryCount,
      lifecycle: state.lifecycle || "active",
      timerDriftMs: Math.round(state.lastTimerDriftMs || 0),
      lastScheduledDelayMs: Number(state.lastScheduledDelayMs || 0),
      lastHeartbeatAt: Number(state.lastHeartbeatAt || 0),
      rule: state.config?.siteRuleMeta || (state.config?.siteRule ? { id: state.config.siteRule.id, name: state.config.siteRule.name, version: state.config.siteRule.version } : null),
      ruleMode: state.config?.ruleMode || "auto",
      ruleCoverage: ruleCoverage(),
      pagePhase: classifyPagePhase(),
      selectorHealth: selectorHealth(),
      hasCaptchaOrOtp: !!detectChallenge(),
      hasLoginPassword: !!detectLoginPage(),
      inQueue: !!detectQueue(),
      hasFinalAction: !!findFinalAction(),
      configuredSelectors: {
        purchase: !!state.config?.purchaseSelector,
        quantity: !!state.config?.quantitySelector,
        price: !!state.config?.priceSelector
      }
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "QBA_START") {
      const incomingStartedAt = Number(message.config?.runStartedAt || 0);
      const currentStartedAt = Number(state.config?.runStartedAt || 0);
      if (state.running && incomingStartedAt && currentStartedAt && incomingStartedAt < currentStartedAt) { sendResponse({ ok: true, stale: true }); }
      else { const safeConfig = { ...(message.config || {}), operationMode: message.config?.operationMode === "dry" ? "dry" : "live" }; start(safeConfig, !!message.resumedAfterNavigation); sendResponse({ ok: true, runId: safeConfig.runId || "" }); }
    }
    else if (message.type === "QBA_STOP") {
      if (message.runId && state.config?.runId && String(message.runId) !== String(state.config.runId)) sendResponse({ ok: true, stale: true });
      else { stop(); sendResponse({ ok: true }); }
    }
    else if (message.type === "QBA_RESUME") {
      if (message.runId && state.config?.runId && String(message.runId) !== String(state.config.runId)) sendResponse({ ok: true, stale: true });
      else { resume(); sendResponse({ ok: true }); }
    }
    else if (message.type === "QBA_PICK_SELECTOR") { enablePicker(message.targetKey); sendResponse({ ok: true }); }
    else if (message.type === "QBA_PREFLIGHT") { sendResponse(preflight(message.config || {})); }
    else if (message.type === "QBA_REHEARSAL") { sendResponse(rehearsal(message.config || {})); }
    else if (message.type === "QBA_PING") {
      const pagePhase = classifyPagePhase();
      sendResponse({ ok: true, running: state.running, paused: state.paused, clickCount: state.clickCount, recentActionCount: recentActionCount(), selectedPriority: state.selectedPriority, autoCommitSent: state.autoCommitSent, awaitingConfirmation: state.awaitingConfirmation, confirmationConfirmed: state.confirmationConfirmed, recoveringReason: state.recoveringReason || null, recoveryCount: state.recoveryCount, url: location.href, title: document.title, visible: document.visibilityState === "visible", lifecycle: state.lifecycle || "active", timerDriftMs: Math.round(state.lastTimerDriftMs || 0), lastScheduledDelayMs: Number(state.lastScheduledDelayMs || 0), origin: location.origin, clockOffsetMs: Number(state.config?.clockOffsetMs || 0), pagePhase, selectorHealth: selectorHealth() });
    }
    else if (message.type === "QBA_DIAGNOSTICS") { sendResponse({ ok: true, diagnostics: diagnostics() }); }
    else if (message.type === "QBA_DEBUG_SCAN") { sendResponse(debugScan(message.config || {})); }
    return true;
  });
})();
