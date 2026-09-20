(() => {
  const SCHEMA_VERSION = 1;
  const MAX_PROFILES = 50;
  const CAPABILITIES = ["purchase","quantity","price","sold","final","login","queue","captcha","otp"];

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

  function sanitizeProfile(input) {
    if (!input || typeof input !== "object") throw new Error("Profile 內容必須是 JSON 物件。");
    const schemaVersion = Number(input.schemaVersion || SCHEMA_VERSION);
    if (schemaVersion !== SCHEMA_VERSION) throw new Error(`不支援的 Profile schemaVersion：${schemaVersion}`);
    const id = cleanString(input.id, 100).replace(/[^a-zA-Z0-9._-]/g, "-") || `profile-${Date.now()}`;
    const name = cleanString(input.name, 120) || id;
    const version = cleanString(input.version, 40) || "1.0.0";
    const priority = Math.max(-10000, Math.min(10000, Number(input.priority || 0)));
    const hosts = uniqueStrings(input.match?.hosts || input.hosts || [], 20, 180).map(normalizeHostPattern).filter(Boolean);
    if (!hosts.length) throw new Error(`Profile「${name}」沒有有效的 match.hosts。`);
    const pathPrefixes = uniqueStrings(input.match?.pathPrefixes || ["/"], 20, 300).map(normalizePathPrefix);
    const capabilities = uniqueStrings(input.capabilities || CAPABILITIES, CAPABILITIES.length, 40).filter(x => CAPABILITIES.includes(x));
    const ruleInput = input.rule || {};
    if (!globalThis.QBA_RULES) throw new Error("QuickBuy 規則引擎尚未載入。");
    const rule = QBA_RULES.sanitizeRule({
      schemaVersion: 1,
      id: `profile-rule-${id}`,
      name: `${name} 內嵌規則`,
      version,
      enabled: true,
      priority: 0,
      match: { hosts, pathPrefixes },
      selectors: ruleInput.selectors || input.selectors || {},
      text: ruleInput.text || input.text || {},
      notes: cleanString(ruleInput.notes || input.notes, 500)
    });
    return {
      schemaVersion: SCHEMA_VERSION,
      id,
      name,
      version,
      enabled: input.enabled !== false,
      priority: Number.isFinite(priority) ? priority : 0,
      match: { hosts, pathPrefixes },
      capabilities,
      rule,
      notes: cleanString(input.notes, 500),
      importedAt: Number(input.importedAt || Date.now())
    };
  }

  function scoreProfile(profile, urlString) {
    if (!profile?.enabled) return -Infinity;
    let url;
    try { url = new URL(urlString); } catch (_) { return -Infinity; }
    if (!/^https?:$/.test(url.protocol)) return -Infinity;
    let hostScore = -Infinity;
    for (const p of profile.match?.hosts || []) {
      if (!hostMatches(url.hostname, p)) continue;
      hostScore = Math.max(hostScore, p === "*" ? 0 : p.startsWith("*.") ? 180 + p.length : 360 + p.length);
    }
    if (!Number.isFinite(hostScore)) return -Infinity;
    let pathScore = -Infinity;
    for (const prefix of profile.match?.pathPrefixes || ["/"]) {
      if (!url.pathname.startsWith(prefix)) continue;
      pathScore = Math.max(pathScore, Math.min(300, prefix.length * 3));
    }
    if (!Number.isFinite(pathScore)) return -Infinity;
    return hostScore + pathScore + Number(profile.priority || 0);
  }

  function normalizeCatalog(userProfiles = []) {
    const out = [], seen = new Set();
    for (const raw of Array.isArray(userProfiles) ? userProfiles : []) {
      try {
        const p = sanitizeProfile(raw);
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        out.push(p);
        if (out.length >= MAX_PROFILES) break;
      } catch (_) {}
    }
    return out;
  }

  function resolve(urlString, userProfiles = [], mode = "auto") {
    if (mode === "off") return { profile: null, score: -Infinity, matches: [] };
    const matches = normalizeCatalog(userProfiles)
      .map(profile => ({ profile, score: scoreProfile(profile, urlString) }))
      .filter(x => Number.isFinite(x.score))
      .sort((a,b) => b.score - a.score || Number(b.profile.importedAt || 0) - Number(a.profile.importedAt || 0));
    return { profile: matches[0]?.profile || null, score: matches[0]?.score ?? -Infinity, matches };
  }

  function makeTemplate(urlString = "") {
    let host = "example.com", path = "/";
    try {
      const u = new URL(urlString);
      host = u.hostname || host;
      path = u.pathname && u.pathname !== "/" ? u.pathname.replace(/[^/]*$/, "") || "/" : "/";
    } catch (_) {}
    return {
      schemaVersion: 1,
      id: `platform-${host.replace(/[^a-z0-9.-]/gi, "-")}`,
      name: `${host} Profile`,
      version: "1.0.0",
      enabled: true,
      priority: 200,
      match: { hosts: [host], pathPrefixes: [path] },
      capabilities: [...CAPABILITIES],
      rule: {
        selectors: { purchase: [], quantity: [], price: [], sold: [], final: [], login: [], queue: [], captcha: [], otp: [] },
        text: { next: [], sold: [], final: [], login: [], queue: [] }
      },
      notes: "Profile 只描述平台匹配與安全 selector / 文字，不執行任意 JavaScript。"
    };
  }

  function validatePack(data) {
    const raw = Array.isArray(data) ? data : Array.isArray(data?.profiles) ? data.profiles : [data];
    if (!raw.length) throw new Error("Profile 檔沒有任何 Profile。");
    return { schemaVersion: 1, app: "QuickBuy", profiles: raw.slice(0, MAX_PROFILES).map(sanitizeProfile) };
  }

  globalThis.QBA_PROFILES = Object.freeze({
    SCHEMA_VERSION, CAPABILITIES, sanitizeProfile, normalizeCatalog, scoreProfile, resolve, makeTemplate, validatePack
  });
})();
