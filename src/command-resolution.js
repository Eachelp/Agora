const path = require("node:path");

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat"]);

function commandCandidates(whereOutput) {
  return String(whereOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function selectCommandPath(whereOutput, platform = process.platform) {
  const candidates = commandCandidates(whereOutput);
  if (platform !== "win32") return candidates[0] || null;

  const runnable = candidates.filter((candidate) => {
    const extension = path.extname(candidate).toLocaleLowerCase("en");
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(extension) || WINDOWS_SHELL_EXTENSIONS.has(extension);
  });
  const first = runnable[0];
  if (!first) return null;

  // 같은 설치 위치/이름이라면 네이티브 실행 파일을 우선합니다. 서로 다른
  // 설치본이면 PATH 순서를 지켜 Microsoft Store 내부의 접근 제한 exe가
  // 앞선 npm shim을 가로채지 않게 합니다.
  const firstBase = path.join(path.dirname(first), path.basename(first, path.extname(first))).toLowerCase();
  const nativeSibling = runnable.find((candidate) => {
    const extension = path.extname(candidate).toLocaleLowerCase("en");
    const base = path.join(
      path.dirname(candidate),
      path.basename(candidate, path.extname(candidate))
    ).toLowerCase();
    return base === firstBase && WINDOWS_EXECUTABLE_EXTENSIONS.has(extension);
  });
  return nativeSibling || first;
}

// where.exe는 파이프로 OEM 코드페이지(한국어 Windows는 CP949)로 출력해서 UTF-8로
// 읽으면 한글 사용자 폴더 경로가 깨진다. 코드페이지에 기대지 않도록 PATH와 PATHEXT를
// 직접 훑어 where 출력과 같은 모양(경로 목록)을 만든다.
function findWindowsPathMatches(command, env = process.env, existsSync = () => false) {
  const name = String(command || "");
  if (!name) return [];
  const pathApi = path.win32;
  const dirs = String(env.PATH || env.Path || "").split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const exts = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean);
  const names = pathApi.extname(name) ? [name] : exts.map((ext) => name + ext);
  const found = [];
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = pathApi.join(dir, candidate);
      try {
        if (existsSync(full)) found.push(full);
      } catch {}
    }
  }
  return found;
}

function commandNeedsShell(command, platform = process.platform) {
  if (platform !== "win32") return false;
  return WINDOWS_SHELL_EXTENSIONS.has(path.extname(String(command || "")).toLocaleLowerCase("en"));
}

module.exports = { commandNeedsShell, findWindowsPathMatches, selectCommandPath };
