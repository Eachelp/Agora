"use strict";

// userData/settings.json 읽기·쓰기. main.js는 Electron이 있어야 불러올 수 있어서 따로 뗐다.
//
// 쓰는 도중 종료돼도 설정이 통째로 사라지지 않게 임시 파일에 먼저 쓰고 이름을 바꾼다
// (rename은 한 번에 바뀐다). 직전의 정상 파일은 .bak로 남겨 두고, 본문이 깨져 있으면
// 그 사본에서 읽는다. 예전에는 파일을 바로 덮어써서, 쓰다 끊기면 프록시 모드를 포함한
// 모든 설정이 기본값으로 돌아갔다.
const fs = require("node:fs");

function tryRead(fsApi, file) {
  try {
    const saved = JSON.parse(fsApi.readFileSync(file, "utf8"));
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : null;
  } catch {
    return null;
  }
}

function readSettingsFile(file, fsApi = fs) {
  return tryRead(fsApi, file) || tryRead(fsApi, `${file}.bak`) || {};
}

function writeSettingsFile(file, patch, { fs: fsApi = fs, warn = console.warn } = {}) {
  const good = tryRead(fsApi, file);
  const current = good || readSettingsFile(file, fsApi);
  delete current.themeSource;
  const next = { ...current, ...patch };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fsApi.writeFileSync(tmp, JSON.stringify(next, null, 2));
    // 본문이 정상일 때만 사본을 갱신한다. 깨진 파일이 정상 사본을 덮으면 안 된다.
    if (good) try { fsApi.copyFileSync(file, `${file}.bak`); } catch {}
    fsApi.renameSync(tmp, file);
  } catch (error) {
    warn("[agora] Failed to save settings.", error.message);
    try { fsApi.unlinkSync(tmp); } catch {}
  }
}

module.exports = { readSettingsFile, writeSettingsFile };
