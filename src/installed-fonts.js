const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// macOS 폰트 폴더입니다. 파일명 기반이라 정확한 family명과 다를 수 있지만,
// CSS font-family 후보로 쓰기에 충분하고 PowerShell/WPF 없이 즉시 조회할 수 있습니다.
const MAC_FONT_DIRS = [
  "/System/Library/Fonts",
  "/System/Library/Fonts/Supplemental",
  "/Library/Fonts",
  path.join(os.homedir(), "Library", "Fonts"),
];

const MAC_FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".dfont"]);

function getMacInstalledFonts() {
  const names = [];
  for (const dir of MAC_FONT_DIRS) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const extension = path.extname(entry).toLowerCase();
      if (!MAC_FONT_EXTENSIONS.has(extension)) continue;
      names.push(path.basename(entry, path.extname(entry)));
    }
  }
  return normalizeFontNames(names);
}

const FONT_REGISTRY_PATHS = [
  "Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
  "Registry::HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
];

function normalizeFontNames(values) {
  const fonts = [];
  for (const value of values || []) {
    const name = String(value || "")
      .replace(/\s+\((?:TrueType|OpenType|PostScript|Type 1)\)$/i, "")
      .trim();
    if (name && !name.startsWith("@")) fonts.push(name);
  }
  return [...new Set(fonts)].sort((left, right) => left.localeCompare(right, "ko"));
}

function buildFontRegistryScript() {
  const paths = FONT_REGISTRY_PATHS
    .map((registryPath) => `  '${registryPath.replace(/'/g, "''")}'`)
    .join(",\n");
  return `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName PresentationCore -ErrorAction Stop
  foreach ($family in [Windows.Media.Fonts]::SystemFontFamilies) {
    [Console]::Out.WriteLine($family.Source)
  }
  exit 0
} catch {
  # WPF를 사용할 수 없는 Windows 환경에서는 아래 레지스트리 목록으로 대체합니다.
}
$paths = @(
${paths}
)
foreach ($path in $paths) {
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $key = Get-Item -LiteralPath $path
  foreach ($name in $key.GetValueNames()) {
    [Console]::Out.WriteLine($name)
  }
}`;
}

// 조회 결과는 세션 동안 캐시하되, 실패(오류·시간 초과)나 빈 목록은 캐시하지 않는다.
// 한 번의 실패가 빈 목록으로 굳으면 설정 창이 글꼴을 못 고르고 저장된 글꼴까지 지워졌다.
// run 함수마다 따로 캐시해서(WeakMap) 주입된 가짜 run을 쓰는 테스트가 서로 섞이지 않는다.
const fontCaches = new WeakMap();

function getInstalledFonts({ run = execFile, platform = process.platform } = {}) {
  let byPlatform = fontCaches.get(run);
  if (!byPlatform) fontCaches.set(run, (byPlatform = new Map()));
  if (byPlatform.has(platform)) return byPlatform.get(platform);
  const promise = lookupInstalledFonts(run, platform).then((fonts) => {
    if (fonts.length === 0 && byPlatform.get(platform) === promise) byPlatform.delete(platform);
    return fonts;
  });
  byPlatform.set(platform, promise);
  return promise;
}

function lookupInstalledFonts(run, platform) {
  if (platform === "darwin") {
    return Promise.resolve().then(() => {
      try {
        return getMacInstalledFonts();
      } catch {
        return [];
      }
    });
  }
  if (platform === "linux") {
    return new Promise((resolve) => {
      run(
        "fc-list",
        ["--format=%{family}\\n"],
        { encoding: "utf8", timeout: 6000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve([]);
            return;
          }
          const families = String(stdout || "")
            .split(/\r?\n/)
            .flatMap((line) => line.split(","));
          resolve(normalizeFontNames(families));
        }
      );
    });
  }
  if (platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    const encoded = Buffer.from(buildFontRegistryScript(), "utf16le").toString("base64");
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { encoding: "utf8", windowsHide: true, timeout: 6000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(normalizeFontNames(String(stdout || "").split(/\r?\n/)));
      }
    );
  });
}

module.exports = {
  FONT_REGISTRY_PATHS,
  buildFontRegistryScript,
  getInstalledFonts,
  normalizeFontNames,
};
