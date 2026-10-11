# 2026-10-11 남은 버그 정리 B

감사에서 확인된 버그 가운데 채팅 화면(렌더러), 채팅 IPC·저장소, 토론 프롬프트·기록, 실행기·인자에 있던 것을 고친다. 이 문서는 묶음별로 이어 붙인다.

## 묶음 B4 — 채팅 화면(src/chat.js, src/chat-markdown.js)

코드가 많이 바뀌었으므로(전문 모드·역할 상담·하네스·작업공간 임대 삭제, 실행 중 질문 추가) 버그마다 먼저 지금 코드에 남아 있는지 확인했다. 아래 11건과 추가 3건은 모두 남아 있었다.

| ID | 원인 | 고친 방법 | 시험 |
| --- | --- | --- | --- |
| F1 | 프로젝트 폴더 선택·해제 응답에 보고 있는 대화의 meta가 없고, 렌더러는 `projects`만 바꾸고 헤더를 다시 그리지 않았다. 해제하면 백엔드가 권한을 chat으로 내리는데 화면의 `sessionMeta`는 그대로였다. | 두 IPC 응답에 `activeMeta`를 싣고, `applyWorkspaceChange`가 `projects`·`sessionMeta`를 맞춘 뒤 헤더를 다시 그린다. | `regress-workspace-header-sync` |
| F2 | 대화 이동 팝오버가 활성 프로젝트를 '(현재)'로 막았다. 트리에는 모든 프로젝트의 대화가 보이므로 틀렸다. | `sessionOwnerProjectId`가 `sessionsByProject`에서 대화의 실제 소속을 찾아 그 프로젝트만 막는다. | `regress-chat-renderer-state` |
| F3 | 읽기 전용 저장소는 활성 대화를 설정에 쓸 수 없어서, 고른 대화의 본문과 `activeSessionId`가 서로 다른 방을 가리켰다. | 읽기 전용일 때 둘러보는 프로젝트·대화를 메모리에만 기억하고 활성 프로젝트/대화 계산이 그 값을 쓴다. 설정 파일은 쓰지 않는다. | `regress-readonly-store-browse` |
| F6 | `flashNotice`가 호출 때의 문구를 되돌릴 값으로 잡아, 알림이 겹치면 영구 경고가 첫 알림 문구로 굳었다. | 영구 경고 문구를 `dataset.persistent`에 따로 두고(`showPersistentWarning`) 그 값으로 되돌린다. | `regress-chat-renderer-state` |
| F12 | 결정·작업 탭 동작 뒤 팝오버를 통째로 다시 만들며 메모리 탭으로 돌아가고, 닫은 팝오버도 다시 열었다. | `refreshWorkflowPopover`로 일원화. 열려 있을 때만 다시 만들고, 보던 탭과 아직 저장하지 않은 입력(규칙·새 기록·결정/작업 새 항목 폼)을 이어 준다. 저장에 성공한 폼은 비운다. 기존 항목을 고치는 중인 폼은 옮기지 않는다. | `regress-chat-renderer-state` |
| F14 | 알림 묶음 뒤에 다른 메시지가 붙으면 토글을 지워, 접힌 알림을 펼칠 수 없었다. | 묶음이 끝나면 토글과 접힘을 그대로 두고 다음 묶음이 새 토글을 만들게 한다. 펼침 글자는 모든 토글에 함께 반영한다. | `regress-chat-renderer-state` |
| F16 | 서식 없이 복사가 코드 펜스를 먼저 풀어 본문 규칙을 적용하고, `_` 강조 규칙이 단어 안의 밑줄을 지웠다. | 코드(펜스·인라인)와 주소는 자리표시자로 보호한 뒤 규칙을 적용한다. 이 화면이 그리지 않는 `_` 강조는 걷지 않고, 단어 안의 `*`는 곱셈일 수 있어 단어 경계에서만 걷는다. | `regress-chat-renderer-text` |
| F18 | 내 말풍선이 토큰의 `text`를 써서 구분자·주소·경로를 잃었다. | `chatMarkdown.tokenizeMentions`: 멘션만 토큰으로 나누고 나머지는 쓴 그대로 둔다. | `regress-chat-renderer-text` |
| F19 | 멘션 팝업 상태가 input·click에서만 갱신되어, 캐럿만 옮기고 Enter/Tab을 누르면 낡은 위치로 글을 덮었다. | Enter/Tab 때 먼저 현재 캐럿으로 팝업을 다시 맞추고(어긋나면 닫혀 Enter는 전송으로 간다), `acceptMention`도 캐럿이 맞지 않으면 아무것도 바꾸지 않고 닫는다. | `regress-chat-renderer-text` |
| F20 | 칩 클릭이 그때의 `textContent`를 원래 라벨로 기억해, 두 번 누르면 '경로 복사됨'이 원래 값이 되었다. | 원래 라벨은 토큰의 파일 이름으로 두고 연달아 눌러도 타이머를 하나만 둔다. | `regress-chat-renderer-text` |
| F23 | 가운데 클릭은 `auxclick`이라 막히지 않고 Electron 기본값대로 새 창이 열렸다. | 링크의 `auxclick`도 막고, 채팅 창에 `setWindowOpenHandler`로 새 창 열기를 모두 거절한다(Ctrl+클릭·`window.open` 포함). | `regress-chat-renderer-text` |

### 추가 항목

- F17 후속: 1부터 시작하지 않는 순서 목록은 v1.2.1에서 문단으로 그렸다. 이제 목록 블록에 `start`와 `numbers`를 담아 렌더러가 `<ol start>`와 `li.value`로 원문 번호를 그대로 그린다. 99를 넘는 숫자(`2026. 10. 10.` 같은 날짜 줄)는 번호가 아니라 날짜로 보고 문단으로 둔다. 기존 시험 두 개(3번 시작, 하위 불릿으로 끊긴 단계)는 새 계약(`list.start`·`list.numbers`)에 맞게 고쳤다. 사용자에게 보이는 번호는 그대로다.
- 새로고침 시 화면 설정 유실: 화면 설정은 main이 창이 처음 뜰 때 한 번 밀어 줄 뿐이라 Ctrl+R이면 기본 색으로 돌아갔다. `chat:appearance:get`(preload `appearanceGet`)을 추가하고 렌더러가 시작할 때 가져온다. 가져오는 사이 더 새 값이 밀려왔다면 덮지 않는다. 실패는 `call`을 거쳐 알림으로 보인다. 시험: `regress-chat-appearance-reload`.
- 바닥 고정: 창을 줄이거나 질문 카드 영역이 변해 대화 영역 높이가 바뀌면, 사용자 자신의 스크롤로 바닥이었던 사람만 바닥에 다시 붙인다(`ResizeObserver`). 높이 변화 때문에 생긴 스크롤 이벤트는 사용자의 스크롤로 세지 않는다. 위로 올려 읽던 사람은 움직이지 않는다. 시험: `regress-chat-scroll-pin`(가짜 스크롤러).

### 메모

- 이 화면 시험은 `chat.js` 구간을 격리된 컨텍스트에서 실제로 돌린다(`test/regress-ui-dom.cjs`는 질문 카드 시험용 가짜 DOM에 classList·형제 탐색을 덧붙인 것). 새로고침 바닥 고정 코드는 `chat.js` 전체를 올리는 기존 시험이 `ResizeObserver`를 `undefined`로 두므로 `typeof ResizeObserver === "function"`일 때만 붙인다.
- 채팅 창의 `setWindowOpenHandler`는 기존 시험의 가짜 창에 없으므로 `?.`로 부른다(실제 Electron에는 항상 있다).

## 묶음 B5 — 저장소·읽기 전용 저장소·첨부·채팅 IPC(src/chat/chat-ipc.js)

여섯 건 모두 지금 코드에 남아 있었다. 시험은 `test/regress-stores-b5.test.js`(진입점 `createChatFeature` + 가짜 ipcMain)이고 고치기 전에는 모두 실패한다.

| ID | 원인 | 고친 방법 |
| --- | --- | --- |
| F187 | '보낼 예정' 첨부 목록은 메모리에만 있는데 사본은 디스크에 복사된다. 보내지 않고 앱이 끝나면 사본만 남아 그 대화의 첨부 한도(200MiB)를 계속 차지하고, 같은 파일을 다시 붙여도 거부됐다. | `pendingFor`가 이 실행에서 한 대화의 목록을 처음 만들 때 `sweepOrphanAttachments`가 보낸 메시지가 쓰지 않는 사본(보류분, 복사 도중 끊긴 `.tmp`)만 지운다. 대화 기록을 읽지 못하면 아무것도 지우지 않고, 못 지운 파일은 로그에 남긴다. 목록을 처음 만드는 곳이 첨부 추가보다 먼저라 한도 계산 전에 정리가 끝난다. 읽기 전용 저장소에서는 건드리지 않는다. |
| F188 | 대화 IPC는 `requireSession`만 확인해서, 읽기 전용 저장소(더 새 버전이 만든 데이터)에서도 보내기·실행이 되고 기록은 저장되지 않아 재시작하면 대화가 사라졌다. 첨부는 읽기 전용 저장소에 파일을 복사했다. | `requireWritableSession`을 추가해 보내기·끼어들기·토론 시작·토론 요약·넘기기·첨부 추가(대화상자·드롭)에 적용했다. 읽기 전용이면 "더 새로운 버전의 Agora가 만든 것이라 읽기 전용입니다…"로 시작 전에 거절하고, 화면에는 기존 `call` 경로로 알림이 뜬다. |
| F61 | 기록관 자동 저장(`saveRecorderOutput`)이 읽기 전용을 확인하지 않고 Memory Bank와 작업 기록에 썼다. | F188로 읽기 전용에서는 토론이 시작되지 않으므로 도달하지 않지만, 쓰기 지점에도 같은 검사를 한 줄 두어 이중으로 막는다. |
| F67 | 읽기 IPC(`chat:memory:read`, `chat:memory:rules:read`)가 쓰기용 `requireProject`를 거쳐 읽기 전용에서 "변경할 수 없습니다"로 거절됐다. | `requireProject(projectId, { forRead })`를 두어 읽기 IPC와, 읽기 전용 저장소에서의 `chat:projects:select`(둘러보기)만 읽기 전용 검사를 건너뛴다. 쓰기 IPC는 기본값 그대로 막힌다. |
| F69 | `chat:decisions:delete`가 연결된 작업을 `listTasks` 기본 목록(파일이 없거나 새 버전으로 바뀐 작업 제외)으로 확인하고 `deleteDecision`이 false를 돌려줘도 무시해, 성공으로 답하고는 아무것도 지우지 않았다. | 숨겨진 작업까지(`includeAll`) 확인하고, 그래도 `deleteDecision`이 false면 같은 안내를 던진다. 안내에 파일이 없어졌거나 새 버전으로 바뀐 작업이 연결됐을 수 있다는 이유를 덧붙였다. |
| F68 | `chat:attachments:add-dropped`가 `importPaths`에 넘기기 전에 `.slice(0, 10)`으로 잘라, 거기서 만드는 "(N개 제외)" 안내가 드롭에서는 나올 수 없었다. | 드롭 쪽 `slice`를 없애고 열 개 제한을 `importPaths` 한 곳에서만 건다. 렌더러는 기존대로 `errors`를 알림으로 보인다. |

### 메모

- F187은 앱 종료 때 지우는 대신 다음에 대화를 만질 때 지운다. 강제 종료·충돌·전원 끊김도 같은 길로 정리되고, 종료 시점에 별도 코드가 필요 없다.
