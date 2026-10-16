const crypto = require("node:crypto");
const os = require("node:os");
const { createClaudeFileStore } = require("./claude-live-credentials");

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

function formatAgyBucketLabel({ window, bucketName }) {
  if (window) return window;
  let text = String(bucketName || "").trim();
  text = text.replace(/\s*(?:limit|remaining|한도|남음)\b/gi, "").trim();
  return text || "기타";
}

function classifyWindow(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return null;
  if (/(?:^|[^0-9])5[\s-]*(?:시간|h(?![a-z])|hours?)|five[_\s-]?hours?/.test(value)) return WINDOW_5H;
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
    // 구간은 화면용 문구(displayName)보다 기계용 필드(window: "weekly", bucketId: "gemini-weekly")로
    // 먼저 가립니다. 문구는 Google이 언제든 바꿀 수 있습니다.
    const window = classifyWindow(bucket.window) || classifyWindow(bucket.bucketId) || classifyWindow(bucketName);
    return {
      groupName: group.displayName || group.name || "",
      bucketName,
      window,
      usedPercent: clampPercent((1 - remaining) * 100),
      resetText: bucket.resetTime || bucket.reset_time || "",
    };
  };

  // 한도 그룹은 세 갈래입니다(2026-10, agy 1.4.0의 /usage와 같은 응답).
  //   일반 Gemini 그룹 "Gemini Models"(bucketId gemini-weekly·gemini-5h) → AGY 줄의 5시간·주간 칸
  //   모델 전용 그룹 "Gemini 4 Argon"(bucketId gemini-argon-…) → 그 모델만의 한도, 사이드바 아래 줄
  //   외부 모델 그룹 "Claude and GPT models"(bucketId 3p-…) → 상세 보기에만
  // 모델 전용 그룹도 이름에 Gemini가 들어 있어, 가려내지 않으면 가장 많이 쓴 Argon 주간이
  // AGY 주간 칸을 차지합니다.
  const groupName = (group) => String(group?.displayName || group?.name || "").trim();
  const isThirdParty = (group) =>
    /claude|gpt/i.test(groupName(group)) ||
    (group?.buckets || []).some((bucket) => /^3p[-_]/i.test(String(bucket?.bucketId || "")));
  const isGeneralGemini = (group) =>
    /^gemini(?:\s+models?)?$/i.test(groupName(group)) ||
    (group?.buckets || []).some((bucket) => /^gemini-[a-z0-9]+$/i.test(String(bucket?.bucketId || "")));
  const geminiGroups = groups.filter((group) => /gemini/i.test(groupName(group)));
  const generalGroups = geminiGroups.filter(isGeneralGemini);

  // 일반 그룹을 알아보지 못하면(옛 응답·이름 변경) 예전처럼 Gemini 그룹 전체에서 가장 빡빡한
  // 창을 씁니다. Gemini가 아예 없으면 첫 그룹을 쓰되, Claude/GPT 그룹은 대표로 올리지 않습니다.
  // 응답에서 Gemini 그룹이 빠졌을 때 Claude/GPT 한도가 AGY 한도처럼 보이면 안 됩니다.
  const primaryGroups = generalGroups.length > 0
    ? generalGroups
    : geminiGroups.length > 0
      ? geminiGroups
      : [groups.find((group) => !isThirdParty(group))].filter(Boolean);
  const scopedGroups = generalGroups.length > 0
    ? geminiGroups.filter((group) => !generalGroups.includes(group))
    : [];
  const secondaryGroups = groups.filter((group) => !primaryGroups.includes(group) && !scopedGroups.includes(group));

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

  // 모델 전용 한도에는 scope(사이드바 아래 줄 이름)와 window(5시간·주간)를 붙입니다.
  // 상세 보기 라벨은 전체 이름("Gemini 4 Argon · 주간"), 사이드바는 짧은 이름("Argon")을 씁니다.
  const scopedGauges = scopedGroups.flatMap((group) => {
    const fullName = formatAgyGroupLabel(groupName(group));
    const scope = fullName.replace(/^gemini\s+\d+(?:\.\d+)?\s+/i, "").trim() || fullName;
    return (group.buckets || []).flatMap((bucket) => {
      const parsed = parseBucket(group, bucket);
      if (!parsed) return [];
      return [{
        label: [fullName, formatAgyBucketLabel(parsed)].filter(Boolean).join(" · "),
        usedPercent: parsed.usedPercent,
        resetText: parsed.resetText,
        ...(parsed.window ? { scope, window: parsed.window } : {}),
      }];
    });
  });

  // 비 Gemini 그룹(Claude, GPT-OSS 등 AGY 별도 할당량 모델)도 상세 보기에서 확인할 수 있게 보존합니다.
  const otherGauges = secondaryGroups.flatMap((group) =>
    (group.buckets || []).flatMap((bucket) => {
      const parsed = parseBucket(group, bucket);
      if (!parsed) return [];
      const groupLabel = formatAgyGroupLabel(parsed.groupName);
      const bucketLabel = formatAgyBucketLabel(parsed);
      const label = [groupLabel, bucketLabel].filter(Boolean).join(" · ");
      return [{
        label,
        usedPercent: parsed.usedPercent,
        resetText: parsed.resetText,
      }];
    })
  );

  if (primaryGauges.length === 0 && scopedGauges.length === 0 && otherGauges.length === 0) {
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

  return [...primaryGauges, ...scopedGauges, ...otherGauges];
}

const CLAUDE_LIMIT_WINDOWS = { session: WINDOW_5H, weekly: WINDOW_WEEK };

function normalizeClaudeUsage(data) {
  const windows = [
    [WINDOW_5H, data?.five_hour],
    [WINDOW_WEEK, data?.seven_day],
  ];
  const main = windows.flatMap(([label, value]) => {
    const utilization = Number(value?.utilization);
    if (!Number.isFinite(utilization)) return [];
    return [{
      label,
      usedPercent: clampPercent(utilization),
      resetText: value.resets_at || "",
    }];
  });
  // 모델 전용 한도(2026-10 기준 Fable 주간)는 limits 배열에 scope.model로 따로 옵니다.
  // 예전 모델별 필드(seven_day_opus·seven_day_sonnet)는 읽지 않습니다. 다시 채워져 오면
  // limits와 같은 한도를 두 번 세게 됩니다.
  const scoped = (Array.isArray(data?.limits) ? data.limits : []).flatMap((limit) => {
    const scope = String(limit?.scope?.model?.display_name || "").trim();
    const window = CLAUDE_LIMIT_WINDOWS[limit?.group];
    const percent = Number(limit?.percent);
    if (!scope || !window || !Number.isFinite(percent)) return [];
    return [{
      label: `${scope} · ${window}`,
      usedPercent: clampPercent(percent),
      resetText: limit.resets_at || "",
      scope,
      window,
    }];
  });
  return [...main, ...scoped];
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

// 사용량 조회는 읽기 전용이다. refresh 토큰은 한 번 쓰면 새 것으로 바뀌는 일회용이라, 여기서 갱신하고
// 저장에 실패하면 새 토큰이 사라져 Claude CLI 로그인이 조용히 풀린다. 갱신은 CLI가 쓸 때 스스로 한다.
const CLAUDE_EXPIRED_MESSAGE = "토큰 만료 (Claude를 한 번 쓰면 갱신)";
class ClaudeTokenExpiredError extends Error {
  constructor() {
    super(CLAUDE_EXPIRED_MESSAGE);
    this.expired = true;
  }
}

// credentialStore를 넘기지 않으면 파일 저장소를 사용합니다. (macOS 실사용은 main.js가 Keychain 저장소를 주입)
async function fetchClaudeUsage({ home = os.homedir(), force = false, credentialStore } = {}) {
  const store = credentialStore || createClaudeFileStore(home);
  const credentials = store.read();
  if (!credentials) throw new Error("Claude 로그인 정보가 없습니다.");
  const oauth = credentials.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error("Claude 로그인 정보가 없습니다.");
  const key = tokenKey("claude", oauth.refreshToken || oauth.accessToken);

  return cached(key, async () => {
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
      if (error.status === 401) throw new ClaudeTokenExpiredError();
      throw error;
    }
    return { provider: "claude", gauges: normalizeClaudeUsage(data) };
  }, { force });
}

function tierLabel(assist) {
  const tier = assist?.currentTier || assist?.current_tier || assist?.paidTier || null;
  if (typeof tier === "string") return tier;
  return tier?.displayName || tier?.display_name || tier?.name || tier?.id || null;
}

// AGY 한도는 agy CLI와 같은 호스트에서, CLI와 같은 user-agent로 받습니다. 서버가 user-agent의
// CLI 버전을 보고 응답을 고르기 때문입니다. 예전에 고정해 둔 1.0.11로 보내면 daily 호스트가
// Gemini·Argon 그룹을 빼고 Claude/GPT 그룹만 돌려줬고(2026-10-16 확인), 그 탓에 한때 정식
// 호스트로 옮겼지만 정식 호스트에는 Argon 그룹이 없습니다. 기준은 `agy -p "/usage"` 출력입니다.
const AGY_QUOTA_HOST = "https://daily-cloudcode-pa.googleapis.com";
// 설치된 CLI 버전(agy --version)을 모를 때만 씁니다. 감지한 버전이 늘 우선합니다.
const AGY_FALLBACK_CLI_VERSION = "1.4.0";

function agyUserAgent(cliVersion, platform = process.platform, arch = process.arch) {
  const version = String(cliVersion || "").match(/\d+\.\d+\.\d+/)?.[0] || AGY_FALLBACK_CLI_VERSION;
  const osName = { win32: "windows", darwin: "darwin", linux: "linux" }[platform] || platform;
  const cpu = { x64: "amd64", arm64: "arm64", ia32: "386" }[arch] || arch;
  return `antigravity/cli/${version} ${osName}/${cpu}`;
}

async function fetchAntigravityUsage({ credential, force = false, cliVersion = null } = {}) {
  const token = credential?.token?.access_token;
  if (!token) throw new Error("AGY 로그인 정보가 없습니다.");
  const key = tokenKey("agy", credential?.token?.refresh_token || token);

  return cached(key, async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": agyUserAgent(cliVersion),
    };
    const [assist, identity] = await Promise.all([
      json(`${AGY_QUOTA_HOST}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: { pluginType: "GEMINI" } }),
      }),
      fetchAntigravityIdentity({ credential }).catch(() => ({})),
    ]);
    const project = assist?.cloudaicompanionProject;
    if (!project) throw new Error("AGY 프로젝트 정보를 찾지 못했습니다.");
    const quota = await json(
      `${AGY_QUOTA_HOST}/v1internal:retrieveUserQuotaSummary`,
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
  agyUserAgent,
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
