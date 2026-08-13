const fs = require("node:fs");
const path = require("node:path");
const { nativeImage } = require("electron");
const {
  DEFAULT_SPRITE_ROWS,
  V2_SPRITE_ROWS,
  detectSpriteRows,
} = require("../sprite-layout");

// 펫 스프라이트 선택·로딩을 다루는 모듈입니다. 이동 루프(움직임 타이머, 드래그, runtime의
// 위치/방향 필드)와는 얽히지 않고, runtime.spriteRows 갱신과 petWindow로의 SET_SPRITE
// IPC 전송만 필요합니다 — 그래서 이동 클러스터와 달리 이 두 개의 좁은 접근자만 주입받으면
// main.js와 깔끔히 분리됩니다.
//
// options:
//   CODEX_PETS_DIR, SPRITE_ASSET, getBaseDir — main.js가 이미 정의한 경로 상수/함수를
//     그대로 재사용합니다. SPRITE_ASSET.filePath는 main.js의 __dirname 기준으로 만들어져
//     있으므로, 값을 여기서 다시 계산하지 않고 그대로 주입받습니다.
//   readSettings, writeSettings, refreshTrayMenu, getPetWindow, setSpriteRows,
//   setSpriteChannel — 펫 선택 반영에 필요한 main.js 쪽 상태/부수효과.
function createPetSprites(options) {
  const {
    CODEX_PETS_DIR,
    SPRITE_ASSET,
    getBaseDir,
    readSettings,
    writeSettings,
    refreshTrayMenu,
    getPetWindow,
    setSpriteRows,
    setSpriteChannel,
  } = options;

  // 사용할 수 있는 펫 목록을 우선순위 순서로 모읍니다.
  //  1. exe(또는 프로젝트) 옆 pet/spritesheet.webp — 목록에 없는 커스텀 스프라이트용
  //  2. ~/.codex/pets/* — Codex가 설치한 펫들 (pet.json의 displayName을 메뉴 이름으로 사용)
  //  3. 내장 기본 스프라이트
  function listAvailablePets() {
    const pets = [];

    const customDir = path.join(getBaseDir(), "pet");
    const customPath = path.join(customDir, "spritesheet.webp");
    if (fs.existsSync(customPath)) {
      let spriteVersionNumber = null;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(customDir, "pet.json"), "utf8"));
        spriteVersionNumber = Number(meta.spriteVersionNumber) || null;
      } catch {
        // pet.json이 없어도 이미지 크기로 규격을 판별합니다.
      }
      pets.push({
        key: "custom",
        label: "커스텀 (pet 폴더)",
        spritePath: customPath,
        spriteVersionNumber,
      });
    }

    let codexPetNames = [];
    try {
      codexPetNames = fs.readdirSync(CODEX_PETS_DIR);
    } catch {
      // Codex가 설치되지 않은 PC면 그냥 건너뜁니다.
    }

    for (const name of codexPetNames) {
      const spritePath = path.join(CODEX_PETS_DIR, name, "spritesheet.webp");
      if (!fs.existsSync(spritePath)) continue;

      let label = name;
      let spriteVersionNumber = null;
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(CODEX_PETS_DIR, name, "pet.json"), "utf8")
        );
        if (meta.displayName) label = meta.displayName;
        spriteVersionNumber = Number(meta.spriteVersionNumber) || null;
      } catch {
        // pet.json이 없거나 형식이 달라도 폴더명으로 표시하면 됩니다.
      }

      pets.push({ key: `codex:${name}`, label, spritePath, spriteVersionNumber });
    }

    if (fs.existsSync(SPRITE_ASSET.filePath)) {
      pets.push({
        key: "builtin",
        label: "기본 펫 (내장)",
        spritePath: SPRITE_ASSET.filePath,
        spriteVersionNumber: SPRITE_ASSET.spriteVersionNumber,
      });
    }

    return pets;
  }

  // 저장된 선택이 유효하면 그 펫을, 아니면(첫 실행, 펫 삭제됨 등) 목록의 첫 번째를 사용합니다.
  function resolveSelectedPet() {
    const pets = listAvailablePets();
    if (pets.length === 0) return null;

    const savedKey = readSettings().petKey;
    return pets.find((pet) => pet.key === savedKey) || pets[0];
  }

  function detectPetSpriteRows(pet = resolveSelectedPet()) {
    if (!pet?.spritePath) return null;

    try {
      const size = nativeImage.createFromPath(pet.spritePath).getSize();
      return detectSpriteRows({
        width: size.width,
        height: size.height,
        spriteVersionNumber: pet.spriteVersionNumber,
      });
    } catch (error) {
      console.warn("[desktop-pet] Failed to detect sprite rows for menu.", error.message);
      return Number(pet.spriteVersionNumber) === 2 ? V2_SPRITE_ROWS : null;
    }
  }

  // 스프라이트 파일을 renderer가 바로 쓸 수 있는 data URL로 바꿉니다.
  // portable exe에서는 내장 assets가 app.asar 안에 들어가고, renderer가 file:// 경로를 직접 읽으면
  // 투명창만 뜨는 식으로 실패할 수 있습니다. main process가 파일을 읽어서 넘기면
  // 내장 스프라이트, ~/.codex/pets, exe 옆 pet 폴더를 같은 방식으로 안정적으로 처리할 수 있습니다.
  function createSpritePayload(pet) {
    if (!pet) {
      return {
        spriteUrl: null,
        spritePath: "pet/spritesheet.webp (not found)",
        assetExists: false,
      };
    }

    try {
      const spriteBuffer = fs.readFileSync(pet.spritePath);
      const spriteUrl = `data:${SPRITE_ASSET.mimeType};base64,${spriteBuffer.toString("base64")}`;

      return {
        spriteUrl,
        spritePath: pet.spritePath,
        spriteVersionNumber: pet.spriteVersionNumber || null,
        assetExists: true,
      };
    } catch (error) {
      console.error(`[desktop-pet] Failed to read sprite: ${pet.spritePath}`, error);

      return {
        spriteUrl: null,
        spritePath: pet.spritePath,
        assetExists: false,
      };
    }
  }

  // 메뉴에서 펫을 고르면 저장하고 renderer의 스프라이트를 즉시 교체합니다.
  function applyPet(petKey) {
    writeSettings({ petKey });

    const pet = resolveSelectedPet();
    if (!pet) return;
    setSpriteRows(detectPetSpriteRows(pet) || DEFAULT_SPRITE_ROWS);
    const petWindow = getPetWindow();
    if (!petWindow || petWindow.isDestroyed()) return;

    petWindow.webContents.send(setSpriteChannel, createSpritePayload(pet));
    refreshTrayMenu();
  }

  // 펫 선택 메뉴는 펫 우클릭 메뉴와 시스템 트레이 메뉴에서 같이 사용합니다.
  // 새 펫 소스를 추가할 때 listAvailablePets()만 확장하면 두 메뉴가 동시에 갱신됩니다.
  function buildPetSelectionSubmenu() {
    const currentPetKey = resolveSelectedPet()?.key;
    const pets = listAvailablePets();

    if (pets.length === 0) {
      return [
        {
          label: "사용 가능한 스프라이트 없음",
          enabled: false,
        },
      ];
    }

    return pets.map((pet) => ({
      label: pet.label,
      type: "radio",
      checked: pet.key === currentPetKey,
      click: () => applyPet(pet.key),
    }));
  }

  return {
    listAvailablePets,
    resolveSelectedPet,
    detectPetSpriteRows,
    createSpritePayload,
    applyPet,
    buildPetSelectionSubmenu,
  };
}

module.exports = { createPetSprites };
