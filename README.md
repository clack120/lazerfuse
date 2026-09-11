# lazerfuse

osu!lazer의 해시 저장소(`~/.local/share/osu/files/`)를 옛날 osu!stable 디렉토리 구조로 보여주는 read-only FUSE 파일시스템.

```
<mount>/Songs/163112 Kuba Oms - My Love/My Love.mp3
<mount>/Replays/Clack12 playing Kuba Oms - My Love (W h i t e) [Hard] (2026-05-16_04-57).osr
<mount>/Skins/<skin name>/...
```

lazer가 **실행 중이어도 안전**: `client.realm`을 Realm 멀티프로세스 모드로 열고
(MVCC 스냅샷 읽기, `.lock`/`.note` 조율), collection listener로 맵 추가/삭제를
실시간 반영한다 (500ms 디바운스 후 인덱스 전체 재빌드, 원자적 스왑).

## 사용

```sh
npm install          # realm + @cocalc/fuse-native (install 스크립트 승인 필요)
node lazerfuse.js <mountpoint>
```

옵션:

- `--osu-dir <dir>` — 기본 `~/.local/share/osu`
- `--passthrough` — 심링크 대신 일반 파일로 노출 (FUSE 경유 read).
  기본은 심링크 모드: `readlink`가 `files/x/xx/<sha256>` 절대경로를 돌려줘서
  실제 I/O는 커널이 직접 처리 (네이티브 속도, 27GB도 부담 없음)
- `--debug` — FUSE/인덱스 로그

종료는 Ctrl-C (자동 unmount).

## 특성

- 파일명 lookup은 **대소문자 무시** (stable/Windows 툴 호환)
- 폴더명: `{OnlineID} {Artist} - {Title}`, 미제출 맵은 ID 없이; 충돌 시 ` (2)` 접미사
- Windows 금지 문자 제거, `sb/element.png` 같은 중첩 경로 지원
- 쓰기 계열 연산은 전부 미구현 → 읽기 전용, lazer 저장소 오염 불가
- `DeletePending` 셋과 파일 0개 스킨(내장 기본 스킨)은 제외
- 폴더 mtime = lazer의 `DateAdded`, 리플레이 mtime = 스코어 `Date`
- 리플레이 파일명의 시각은 UTC
- `Replays/`: 저장 블롭이 이미 표준 .osr 컨테이너라 변환 없이 그대로 노출
  (lazer가 저장 시점에 legacy 인코딩; 단 version이 lazer 스킴 ≥30000000이라
  아주 오래된 파서는 거부할 수 있음). lazer가 직접 기록한 스코어는
  `replay.osr`, 임포트된 리플레이는 원본 파일명(`tmpXXXX.osr` 등)으로
  저장돼 있어 `.osr`로 끝나는 파일을 잡음

## 주의

- realm-js 20.2.0에 고정. lazer가 나중에 realm-core 파일 포맷을 올리면 열기가
  실패할 수 있음 (열기 전후 파일 해시 불변 확인됨 — 포맷이 맞는 동안은 원본을
  절대 수정하지 않음). 그때는 realm-js 버전 업 또는 .NET 리더로 전환.
- 심링크 모드에서 타겟 경로를 못 따라가는 (chroot/샌드박스) 앱은 `--passthrough` 사용.
