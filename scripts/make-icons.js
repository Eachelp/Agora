// Agora 앱 아이콘 조립기.
//
// scripts/make-icons.ps1이 build/icon-src에 그려 둔 PNG들을 모아
// build/icon.ico(7개 크기)와 build/icon.png · build/icon-mac.png(512)를 만듭니다.
// 이미지 라이브러리를 쓰지 않고 ICO 컨테이너만 직접 조립하므로 새 의존성이 없습니다.
//
// 아이콘을 바꿀 때만 손으로 실행합니다:
//   powershell -File scripts/make-icons.ps1
//   node scripts/make-icons.js

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const buildDir = path.join(root, "build");
const srcDir = path.join(buildDir, "icon-src");

// ICO에 담을 크기입니다. Windows 탐색기·작업 표시줄·Alt+Tab이 서로 다른 크기를 씁니다.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function readSource(size) {
  const file = path.join(srcDir, `icon-${size}.png`);
  if (!fs.existsSync(file)) {
    throw new Error(`${file}가 없습니다. 먼저 scripts/make-icons.ps1을 실행하세요.`);
  }
  return fs.readFileSync(file);
}

// ICO는 PNG를 그대로 담을 수 있습니다(Windows Vista 이상). BMP로 다시 인코딩하지 않습니다.
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    // 256px는 1바이트에 담을 수 없어 0으로 기록하는 것이 규격입니다.
    const dimension = entry.size >= 256 ? 0 : entry.size;
    directory.writeUInt8(dimension, at + 0); // width
    directory.writeUInt8(dimension, at + 1); // height
    directory.writeUInt8(0, at + 2); // palette color count
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // color planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

function main() {
  const entries = ICO_SIZES.map((size) => ({ size, data: readSource(size) }));
  fs.writeFileSync(path.join(buildDir, "icon.ico"), buildIco(entries));

  // Linux AppImage·트레이·설정 창 로고가 쓰는 png. macOS는 512 이상을 요구합니다.
  const png512 = readSource(512);
  fs.writeFileSync(path.join(buildDir, "icon.png"), png512);
  fs.writeFileSync(path.join(buildDir, "icon-mac.png"), png512);

  console.log(`icon.ico (${entries.length} sizes), icon.png, icon-mac.png generated`);
}

main();
