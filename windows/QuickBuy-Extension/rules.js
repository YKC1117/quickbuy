(() => {
  const SCHEMA_VERSION = 1;
  const MAX_RULES = 50;
  const MAX_SELECTORS_PER_KIND = 12;
  const MAX_TEXTS_PER_KIND = 20;
  const SELECTOR_KINDS = ["purchase", "quantity", "price", "sold", "final", "login", "queue", "captcha", "otp"];
  const TEXT_KINDS = ["next", "sold", "final", "login", "queue"];

  const BUILTIN_RULES = [
    {
      schemaVersion: 1,
      id: "builtin-generic",
      name: "QuickBuy 通用辨識",
      version: "1.0.0",
      enabled: true,
      priority: -1000,
      builtin: true,
      match: { hosts: ["*"], pathPrefixes: ["/"] },
      selectors: {},
      text: {},
      notes: "最後回退規則；使用 QuickBuy 內建通用文字與元素判斷。"
    }
  ];

  function cleanString(value, max = 240) {
    return String(value ?? "").trim().slice(0, max);
  }

  function uniqueStrings(values, maxItems, maxLen = 240) {
    const out = [];
    for (const raw of Array.isArray(values) ? values : []) {
      const v = cleanString(raw, maxLen);
      if (!v || out.includes(v)) continue;
      out.push(v);
      if (out.length >= maxItems) break;
    }
    return out;
  }

  function normalizeHostPattern(value) {
    let host = cleanString(value, 180).toLowerCase();
    if (!host) return "";
    host = host.replace(/^https?:\/\//, "").split("/")[0].replace(/:\d+$/, "");
    if (host === "*") return "*";
    if (host.startsWith("*.")) host = `*.${host.slice(2).replace(/^\.+|\.+$/g, "")}`;
    else host = host.replace(/^\.+|\.+$/g, "");
    return /^[*a-z0-9.-]+$/.test(host) ? host : "";
  }

  function normalizePathPrefix(value) {
    let path = cleanString(value, 300) || "/";
    if (!path.startsWith("/")) path = `/${path}`;
    return path.replace(/\/{2,}/g, "/");
  }

  function sanitizeRule(input, { builtin = false } = {}) {
    if (!input || typeof input !== "object") throw new Error("規則內容必須是 JSON 物件。");
    const schemaVersion = Number(input.schemaVersion || SCHEMA_VERSION);
    if (schemaVersion !== SCHEMA_VERSION) throw new Error(`不支援的規則 schemaVersion：${schemaVersion}`);

    const id = cleanString(input.id, 100).replace(/[^a-zA-Z0-9._-]/g, "-") || `rule-${Date.now()}`;
    const name = cleanString(input.name, 120) || id;
    const version = cleanString(input.version, 40) || "1.0.0";
    const priority = Math.max(-10000, Math.min(10000, Number(input.priority || 0)));

    const rawHosts = input.match?.hosts || input.hosts || [];
    const hosts = uniqueStrings(rawHosts, 20, 180).map(normalizeHostPattern).filter(Boolean);
    if (!hosts.length) throw new Error(`規則「${name}」沒有有效的 match.hosts。`);
    const pathPrefixes = uniqueStrings(input.match?.pathPrefixes || ["/"], 20, 300).map(normalizePathPrefix);

    const selectors = {};
    for (const kind of SELECTOR_KINDS) {
      const vals = uniqueStrings(input.selectors?.[kind], MAX_SELECTORS_PER_KIND, 500);
      if (vals.length) selectors[kind] = vals;
    }

    const text = {};
    for (const kind of TEXT_KINDS) {
      const vals = uniqueStrings(input.text?.[kind], MAX_TEXTS_PER_KIND, 120);
      if (vals.length) text[kind] = vals;
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      id,
      name,
      version,
      enabled: input.enabled !== false,
      priority: Number.isFinite(priority) ? priority : 0,
      builtin: !!builtin,
      match: { hosts, pathPrefixes },
      selectors,
      text,
      notes: cleanString(input.notes, 500),
      importedAt: builtin ? 0 : Number(input.importedAt || Date.now())
    };
  }

  function hostMatches(hostname, pattern) {
    const host = String(hostname || "").toLowerCase();
    const p = String(pattern || "").toLowerCase();
    if (p === "*") return true;
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === p;
  }

  function scoreRule(rule, urlString) {
    if (!rule?.enabled) return -Infinity;
    let url;
    try { url = new URL(urlString); } catch (_) { return -Infinity; }
    if (!/^https?:$/.test(url.protocol)) return -Infinity;

    let bestHost = -Infinity;
    for (const p of rule.match?.hosts || []) {
      if (!hostMatches(url.hostname, p)) continue;
      const score = p === "*" ? 0 : p.startsWith("*.") ? 180 + p.length : 360 + p.length;
      bestHost = Math.max(bestHost, score);
    }
    if (!Number.isFinite(bestHost)) return -Infinity;

    let bestPath = -Infinity;
    for (const prefix of rule.match?.pathPrefixes || ["/"]) {
      if (!url.pathname.startsWith(prefix)) continue;
      bestPath = Math.max(bestPath, Math.min(300, prefix.length * 3));
    }
    if (!Number.isFinite(bestPath)) return -Infinity;

    return bestHost + bestPath + Number(rule.priority || 0);
  }

  function normalizeCatalog(userRules = []) {
    const out = [];
    const seen = new Set();
    for (const raw of [...BUILTIN_RULES, ...(Array.isArray(userRules) ? userRules : [])]) {
      try {
        const rule = sanitizeRule(raw, { builtin: !!raw.builtin });
        const key = `${rule.id}@${rule.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rule);
        if (out.length >= MAX_RULES) break;
      } catch (_) {}
    }
    return out;
  }

  function resolve(urlString, userRules = [], mode = "auto") {
    if (mode === "generic") return { rule: BUILTIN_RULES[0], score: -1000, source: "generic" };
    const catalog = normalizeCatalog(userRules);
    const matches = catalog
      .map(rule => ({ rule, score: scoreRule(rule, urlString) }))
      .filter(x => Number.isFinite(x.score))
      .sort((a, b) => b.score - a.score || Number(b.rule.importedAt || 0) - Number(a.rule.importedAt || 0));
    const best = matches[0] || { rule: BUILTIN_RULES[0], score: -1000 };
    return { ...best, source: best.rule.builtin ? "generic" : "custom" };
  }

  function makeTemplate(urlString = "") {
    let host = "example.com";
    let path = "/";
    try {
      const u = new URL(urlString);
      host = u.hostname || host;
      path = u.pathname && u.pathname !== "/" ? u.pathname.replace(/[^/]*$/, "") || "/" : "/";
    } catch (_) {}
    return {
      schemaVersion: 1,
      id: `custom-${host.replace(/[^a-z0-9.-]/gi, "-")}`,
      name: `${host} 專用規則`,
      version: "1.0.0",
      enabled: true,
      priority: 100,
      match: { hosts: [host], pathPrefixes: [path] },
      selectors: {
        purchase: [],
        quantity: [],
        price: [],
        sold: [],
        final: [],
        login: [],
        queue: [],
        captcha: [],
        otp: []
      },
      text: {
        next: [],
        sold: [],
        final: [],
        login: [],
        queue: []
      },
      notes: "只填你確認過的 selector / 文字；留白的項目會回退到 QuickBuy 通用辨識。"
    };
  }

  function validatePack(data) {
    const rawRules = Array.isArray(data) ? data : Array.isArray(data?.rules) ? data.rules : [data];
    if (!rawRules.length) throw new Error("規則檔沒有任何規則。");
    const rules = rawRules.slice(0, MAX_RULES).map(x => sanitizeRule(x));
    return { schemaVersion: 1, app: "QuickBuy", rules };
  }

  globalThis.QBA_RULES = Object.freeze({
    SCHEMA_VERSION,
    BUILTIN_RULES,
    sanitizeRule,
    normalizeCatalog,
    resolve,
    scoreRule,
    makeTemplate,
    validatePack
  });
})();
