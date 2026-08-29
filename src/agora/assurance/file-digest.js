"use strict";

// 파일 내용 해시. frozen 입력 재대조(input-binding)와 결과물 subject
// (assurance-subject)가 같은 방식으로 지문을 떠야 하므로 한 곳에 둔다.
//
// 통째로 읽지 않고 청크로 읽어 해시한다. readFileSync는 파일 전체를 메모리에
// 올리기 때문에 상한을 낮게 둘 수밖에 없었고, 그 상한에 걸린 입력은
// "확인할 수 없음"으로 강등되어 계약이 성립하지 않았다. 실제로는 확인할 수 있는
// 파일인데 읽는 방식 때문에 못 한 것이므로, 읽는 방식을 고친다.

const fs = require("node:fs");
const crypto = require("node:crypto");

const CHUNK_BYTES = 1024 * 1024;

// 상한의 의미는 메모리가 아니라 대기 시간이다. 이 해시는 동기 실행이라 main
// 프로세스를 그동안 붙잡는다. 측정값은 약 1.7GB/s이므로 4GiB면 최대 2~3초다.
// 그보다 큰 입력은 frozen으로 선언하지 말고 live로 두는 편이 맞다.
const MAX_DIGEST_BYTES = 4 * 1024 * 1024 * 1024;

// 성공하면 sha256 hex, 읽지 못하면 null.
function sha256FileSync(absPath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let fd;
  try {
    fd = fs.openSync(absPath, "r");
    let read;
    while ((read = fs.readSync(fd, buffer, 0, CHUNK_BYTES, null)) > 0) {
      hash.update(read === CHUNK_BYTES ? buffer : buffer.subarray(0, read));
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return hash.digest("hex");
}

// "too-large"만으로는 사용자가 무엇을 해야 할지 알 수 없다. 실제 크기와 상한을
// 함께 밝혀야 파일을 줄일지, live로 선언할지 판단할 수 있다.
function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb.toFixed(1)}MB`;
}

function tooLargeReason(size) {
  return `too-large: ${formatBytes(size)} > 상한 ${formatBytes(MAX_DIGEST_BYTES)}`;
}

module.exports = { CHUNK_BYTES, MAX_DIGEST_BYTES, sha256FileSync, tooLargeReason };
