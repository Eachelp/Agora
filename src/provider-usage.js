const crypto = require("node:crypto");
const os = require("node:os");
const { createClaudeFileStore } = require("./claude-live-credentials");

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const cache = new Map();

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function tokenKey(provider, token) {
  const digest = crypto.createHash("sha256").update(String(token || "none")).digest("hex").slice(0, 16);
  return `${provider}:${digest}`;
}

async function cached(key, load, { ttl = 60000, force = false } = {}) {
  const old = cache.get(key);
  if (!force && old && Date.now() - old.at < ttl) return old.value;
  const value = Promise.resolve().then(load);
  cache.set(key, { at: Date.now(), value });
  try {
    return await value;
  } catch (error) {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw error;
  }
}

function clearUsageCache(provider = null) {
  for (const key of cache.keys()) {
    if (!provider || key.startsWith(`${provider}:`)) cache.delete(key);
  }
}

// 화면에 쓰는 두 구간입니다. 공급자가 몇 개를 주든 여기로 줄여서 보여 줍니다.
const WINDOW_5H = "5시간";
const WINDOW_WEEK = "주간";

// 공급자마다 창 이름 표기가 제각각이라(5시간 / 5h / five_hour / 일주일 / seven_day …)
// 넓게 받아들여 두 구간으로만 분류합니다. 어디에도 해당하지 않으면 null입니다.
function formatAgyGroupLabel(name) {
  let text = String(name || "").trim();
  if (/claude\s*(?:and|&)\s*gpt(?:\s*models)?/i.test(text)) {
    return "Claude / GPT";
  }
  return text.replace(/\s+models$/i, "").trim();
}

function formatAgyBucketLabel(bucketName) {
  const classified = classifyWindow(bucketName);
  if (classified) return classified;
  let text = String(bucketName || "").trim();
  text = text.replace(/\s*(?:limit|remaining|한도|남음)\b/gi, "").trim();
  return text || "기타";
}

function classifyWindow(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return null;
  if (/(?:^|[^0-9])5\s*(?:시간|h(?![a-z])|hours?)|five[_\s-]?hours?/.test(value)) return WINDOW_5H;
  if (/주간|일주일|주\s*단위|1\s*주|7\s*일|weekly|week|seven[_\s-]?days?/.test(value)) return WINDOW_WEEK;
  return null;
}

// 5시간대 1개 + 주간대 1개만 남깁니다. 같은 구간이 여러 개면 가장 빡빡한(많이 쓴) 것을 씁니다.
// 어느 쪽도 분류되지 않으면 공급자가 이름을 바꾼 경우이므로 원래 목록을 그대로 돌려줍니다.
function pickPrimaryWindows(gauges) {
  const strip = ({ window, ...rest }) => rest;
  const tightest = (target) =>
    gauges
      .filter((gauge) => gauge.window === target)
      .sort((a, b) => b.usedPercent - a.usedPercent)[0] || null;

  const picked = [tightest(WINDOW_5H), tightest(WINDOW_WEEK)].filter(Boolean);
  if (picked.length === 0) return gauges.map(strip);
  return picked.map((gauge) => ({ ...strip(gauge), label: gauge.window }));
}

function normalizeAgyQuota(data) {
  const groups = data?.groups || [];
  if (groups.length === 0) return [];

  const parseBucket = (group, bucket) => {
    const remaining = Number(bucket.remainingFraction ?? bucket.remaining_fraction);
    if (!Number.isFinite(remaining)) return null;
    const bucketName = bucket.displayName || bucket.window || "";
    return {
      groupName: group.displayName || group.name || "",
      bucketName,
      window: classifyWindow(bucketName),
      usedPercent: clampPercent((1 - remaining) * 100),
      resetText: bucket.resetTime || bucket.reset_time || "",
    };
  };

  const geminiGroups = [];
  const otherGroups = [];

  for (const group of groups) {
    const name = String(group?.displayName || group?.name || "");
    if (/gemini/i.test(name)) {
      geminiGroups.push(group);
    } else {
      otherGroups.push(group);
    }
  }

  // Gemini 계열 그룹(또는 Gemini가 없을 땐 첫 번째 그룹)에서 5시간·주간 대표 창을 추출합니다.
  const primaryGroups = geminiGroups.length > 0 ? geminiGroups : [groups[0]];
  const secondaryGroups = geminiGroups.length > 0 ? otherGroups : groups.slice(1);

  const primaryBuckets = primaryGroups.flatMap((group) =>
    (group.buckets || []).map((b) => parseBucket(group, b)).filter(Boolean)
  );
  const primaryGauges = pickPrimaryWindows(
    primaryBuckets.map((b) => ({
      label: [b.groupName, b.bucketName].filter(Boolean).join(" · "),
      window: b.window,
      usedPercent: b.usedPercent,
      resetText: b.resetText,
    }))
  );

  // 비 Gemini 그룹(Claude, GPT-OSS 등 AGY 별도 할당량 모델)도 상세 보기에서 확인할 수 있게 보존합니다.
  const otherGauges = secondaryGroups.flatMap((group) =>
    (group.buckets || []).flatMap((bucket) => {
      const parsed = parseBucket(group, bucket);
      if (!parsed) return [];
      const groupLabel = formatAgyGroupLabel(parsed.groupName);
      const bucketLabel = formatAgyBucketLabel(parsed.bucketName);
      const label = [groupLabel, bucketLabel].filter(Boolean).join(" · ");
      return [{
        label,
        usedPercent: parsed.usedPercent,
        resetText: parsed.resetText,
      }];
    })
  );

  if (primaryGauges.length === 0 && otherGauges.length === 0) {
    return groups.flatMap((group) =>
      (group.buckets || []).flatMap((bucket) => {
        const parsed = parseBucket(group, bucket);
        if (!parsed) return [];
        return [{
          label: [parsed.groupName, parsed.bucketName].filter(Boolean).join(" · "),
          usedPercent: parsed.usedPercent,
          resetText: parsed.resetText,
        }];
      })
    );
  }

  return [...primaryGauges, ...otherGauges];
}

function normalizeClaudeUsage(data) {
  // Claude는 7일 창을 전체 / Sonnet / Opus로 쪼개 주지만 화면에는 전체 하나만 씁니다.
  const windows = [
    [WINDOW_5H, data?.five_hour],
    [WINDOW_WEEK, data?.seven_day],
  ];
  return windows.flatMap(([label, value]) => {
    const utilization = Number(value?.utilization);
    if (!Number.isFinite(utilization)) return [];
    return [{
      label,
      usedPercent: clampPercent(utilization),
      resetText: value.resets_at || "",
    }];
  });
}

async function json(url, options, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new HttpError(`사용량 서버가 HTTP ${response.status}를 반환했습니다.`, response.status);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshClaudeOAuth(credentials, store) {
  const oauth = credentials.claudeAiOauth;
  if (!oauth?.refreshToken) throw new Error("Claude 로그인 정보가 만료됐습니다.");
  const refresh = await json("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  const expiresAt = Number(refresh.expires_at) ||
    (Number(refresh.expires_in) ? Date.now() + Number(refresh.expires_in) * 1000 : oauth.expiresAt);
  const next = {
    ...oauth,
    accessToken: refresh.access_token || oauth.accessToken,
    refreshToken: refresh.refresh_token || oauth.refreshToken,
    expiresAt,
  };
  credentials.claudeAiOauth = next;
  store.write(credentials);
  return next;
}

// credentialStore를 넘기지 않으면 파일 저장소를 사용합니다. (macOS 실사용은 main.js가 Keychain 저장소를 주입)
async function fetchClaudeUsage({ home = os.homedir(), force = false, credentialStore } = {}) {
  const store = credentialStore || createClaudeFileStore(home);
  const credentials = store.read();
  if (!credentials) throw new Error("Claude 로그인 정보가 없습니다.");
  let oauth = credentials.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error("Claude 로그인 정보가 없습니다.");
  const key = tokenKey("claude", oauth.refreshToken || oauth.accessToken);

  return cached(key, async () => {
    // refreshToken이 없는 자격 증명(데스크톱 앱 관리 인증)은 현재 accessToken으로 그대로 시도합니다.
    if (oauth.refreshToken && oauth.expiresAt && Number(oauth.expiresAt) <= Date.now() + 60000) {
      oauth = await refreshClaudeOAuth(credentials, store);
    }

    const request = () => json("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    let data;
    try {
      data = await request();
    } catch (error) {
      if (error.status !== 401 || !oauth.refreshToken) throw error;
      oauth = await refreshClaudeOAuth(credentials, store);
      data = await request();
    }
    return { provider: "claude", gauges: normalizeClaudeUsage(data) };
  }, { force });
}

function tierLabel(assist) {
  const tier = assist?.currentTier || assist?.current_tier || assist?.paidTier || null;
  if (typeof tier === "string") return tier;
  return tier?.displayName || tier?.display_name || tier?.name || tier?.id || null;
}

async function fetchAntigravityUsage({ credential, force = false } = {}) {
  const token = credential?.token?.access_token;
  if (!token) throw new Error("AGY 로그인 정보가 없습니다.");
  const key = tokenKey("agy", credential?.token?.refresh_token || token);

  return cached(key, async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "antigravity/cli/1.0.11 windows/amd64",
    };
    const [assist, identity] = await Promise.all([
      json("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: { pluginType: "GEMINI" } }),
      }),
      fetchAntigravityIdentity({ credential }).catch(() => ({})),
    ]);
    const project = assist?.cloudaicompanionProject;
    if (!project) throw new Error("AGY 프로젝트 정보를 찾지 못했습니다.");
    const quota = await json(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ project }),
      }
    );
    return {
      provider: "agy",
      email: identity.email || null,
      plan: tierLabel(assist),
      gauges: normalizeAgyQuota(quota),
    };
  }, { force });
}

async function fetchAntigravityIdentity({ credential, force = false } = {}) {
  const token = credential?.token?.access_token;
  if (!token) throw new Error("AGY 로그인 정보가 없습니다.");
  const key = tokenKey("agy:identity", credential?.token?.refresh_token || token);
  return cached(key, async () => {
    const identity = await json("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${token}` },
    });
    return { email: identity?.email || null };
  }, { force });
}

module.exports = {
  classifyWindow,
  clearUsageCache,
  fetchAntigravityIdentity,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  normalizeAgyQuota,
  normalizeClaudeUsage,
  pickPrimaryWindows,
  tierLabel,
};
