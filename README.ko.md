# Codex Renown

[English](README.md)

> Your Codex usage, told through milestones.

Codex Renown은 Codex 계정 토큰 사용량을 GitHub 프로필용 정적 카드 7종으로 게시합니다. 각 컴퓨터에서 정제된 통계를 모으고 Git으로 동기화한 뒤 GitHub Actions에서 SVG를 렌더링하므로 계속 운영할 개인 서버는 필요하지 않습니다.

Codex Renown is an unofficial community project. OpenAI와 제휴하거나 보증받은 프로젝트가 아닙니다. 계급과 업적은 개인 사용량 milestone이며 사용자 간 순위, 생산성, 코드 품질, 개발 성과를 뜻하지 않습니다.

## 카드 구성

- `overview.svg` — 누적 토큰, 정확한 계정 전체 숫자, 현재 crest, 다음 계급 진행률, 오늘·7일·30일·활동일
- `achievements.svg` — 현재 crest, 20단계 rank track, 범주별 대표 업적 4개
- `trophy-case.svg` — Renown·Momentum·Consistency·Journey의 16 achievements 전체
- `records.svg` — peak day, 최고 7일·30일 구간, 최고 완전한 달
- `trends.svg` — 30일·12주·12개월 micro chart
- `activity.svg` — 53×7 heatmap, 활동일, current/longest streak, peak
- `compact.svg` — 선택형 416×96 crest·rank badge

GitHub 프로필 README의 권장 배치입니다.

```html
<p>
  <img width="100%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/overview.svg" alt="Codex Renown overview">
</p>
<p>
  <img width="49%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/achievements.svg" alt="Codex Renown rank achievements">
  <img width="49%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/records.svg" alt="Codex Renown records">
</p>
<p>
  <img width="100%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/trophy-case.svg" alt="Codex Renown trophy case">
</p>
<p>
  <img width="49%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/trends.svg" alt="Codex Renown trends">
  <img width="49%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/activity.svg" alt="Codex Renown activity">
</p>
```

공간이 좁으면 compact 대안을 단독으로 사용할 수 있습니다.

```html
<img width="416" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/compact.svg" alt="Codex Renown compact rank badge">
```

GitHub raw cache 때문에 갱신 직후 잠시 이전 이미지가 보일 수 있습니다.

## 테마

모든 카드는 light/dark 색상을 자동 전환하며 정적 테마 계열 5개를 제공합니다. 기본 `github` 테마만 기존 URL을 사용하고 나머지는 suffix를 붙입니다.

| 테마 | 파일 예시 |
|---|---|
| `github` | `overview.svg` |
| `midnight` | `overview-midnight.svg` |
| `aurora` | `overview-aurora.svg` |
| `ember` | `overview-ember.svg` |
| `monochrome` | `overview-monochrome.svg` |

카드 7종 × 테마 5개로 `cards/`의 flat allowlist에 정확히 35 SVG가 생성됩니다. 테마를 바꿀 때는 모든 이미지 URL에 같은 suffix를 사용하세요.

```html
<img width="100%" src="https://raw.githubusercontent.com/jukrap/codex-renown/main/cards/overview-midnight.svg" alt="Codex Renown midnight overview">
```

SVG는 외부 font·image·link·animation·gradient 없이 한 파일로 완결됩니다. 결정론적 출력과 접근성 `<title>/<desc>`를 유지합니다.

## 계급, crest, 업적

대표 계급은 lifetime token만으로 정하며 두 threshold 사이 진행률은 선형입니다.

| Rank | 칭호 | 최소 토큰 |
|---:|---|---:|
| I | Novice | 0 |
| II | Initiate | 10K |
| III | Apprentice | 50K |
| IV | Adept | 100K |
| V | Scout | 500K |
| VI | Adventurer | 1M |
| VII | Knight | 5M |
| VIII | Veteran | 10M |
| IX | Elite | 50M |
| X | Champion | 100M |
| XI | Hero | 500M |
| XII | Warlord | 1B |
| XIII | Overlord | 2.5B |
| XIV | Paragon | 5B |
| XV | Mythic | 10B |
| XVI | Ascendant | 25B |
| XVII | Immortal | 50B |
| XVIII | Sovereign | 100B |
| XIX | Eternal | 250B |
| XX | Transcendent | 1T |

Rank I–IV는 Common, V–VIII는 Uncommon, IX–XII는 Rare, XIII–XVI는 Epic, XVII–XX는 Legendary입니다. 각 계급은 고유 glyph를 사용하며 frame 실루엣과 1–4개 pip로 색상 없이도 단계가 구분됩니다.

계정 lifetime이 19.3B라면 `Rank XV · Mythic`이고 `Ascendant · 25B`까지 약 62%입니다. device fallback 합계는 관측된 하한이므로 overview에 `DEVICE FALLBACK`을 표시하고 rank 제목은 간결한 `XIV · Paragon`처럼 표시하며, total과 진행률에는 `≥`를 사용합니다. 한 번 이상 정상 갱신했지만 lifetime을 알 수 없으면 `Unranked`, 최초 동기화 전이면 `Not updated yet`, 1T 이상이면 `MAX RANK`입니다.

16 achievements는 누적 renown, peak·rolling momentum, streak consistency, active-day journey를 다룹니다. locked는 outline, Unknown은 점선, unlocked는 문자 marker까지 함께 표시하므로 색상에만 의존하지 않습니다.

## Coverage와 records

누락 날짜는 선언된 coverage 안에서만 0으로 취급하고 밖에서는 Unknown으로 둡니다.

- `≥`와 점선은 알려진 하한인 Partial입니다.
- `—`와 outline-only bar/cell은 Unknown입니다.
- `0`은 관측된 0이며 Unknown이 아닙니다.

계정 profile은 `Codex account calendar`, device fallback은 설정한 IANA timezone을 사용합니다. 서로 다른 날짜 체계를 더하지 않습니다. Records는 coverage가 완전한 후보만 비교하고, 그 안의 누락일은 0으로 채우며, 동률이면 더 이른 구간을 선택합니다.

## 동작 구조

1. 모든 컴퓨터의 고정 collector가 로컬 기록에 `ccusage codex`를 실행하고 일별 집계로 축약합니다.
2. 컴퓨터마다 `data/devices/<opaque-device-id>.json` 하나를 소유하며 정제된 account profile candidate 하나를 게시할 수 있습니다.
3. `npm run sync`는 그 컴퓨터의 device/profile 경로만 검증하고 push합니다.
4. GitHub Actions가 공개 snapshot을 병합해 allowlist의 35 SVG를 결정론적으로 생성합니다.

Git은 동기화 계층입니다. GitHub Actions는 로컬 로그나 CLI 인증 상태를 읽을 수 없습니다.

## 요구 사항과 시작 방법

- Node.js 24 이상과 npm
- Git
- 참여 컴퓨터마다 `https://github.com/jukrap/codex-renown.git` 전용 clone
- 예약 실행에서도 동작하는 비대화형 push authentication
- 모든 기기에서 같은 IANA timezone(예: `Asia/Seoul`)

```console
git clone https://github.com/jukrap/codex-renown.git
cd codex-renown
npm ci
npm run setup -- --timezone Asia/Seoul
npm run sync
```

`setup`은 컴퓨터마다 서로 다른 익명 device ID와 private writer key를 만듭니다. `.agent-card.local.json`을 다른 컴퓨터에 복사하면 ownership conflict와 중복 집계가 생길 수 있으므로 복사하지 마세요.

기본 실행 파일 이름은 `codex-renown`이며 기존 `agent-card`도 alias로 유지합니다. npm script 이름, `.agent-card.local.json`, `AGENT_CARD_CODEX_BIN`, `.git/agent-card-sync.lock`은 migration 중에도 그대로입니다.

자동 실행은 [Windows Task Scheduler 안내](docs/setup-windows.md) 또는 [macOS/Linux launchd·cron 안내](docs/setup-unix.md)를 따르세요. 기존 설치는 모든 clone에서 [Codex Renown migration runbook](docs/migration-codex-renown.md)을 완료한 뒤 scheduler를 재개해야 합니다.

## 계정 profile과 device fallback

`npm run profile`과 `npm run sync`는 로그인된 Codex CLI App Server를 shell 없이 JSONL stdio로 시작하고 experimental API를 initialize한 뒤 `account/usage/read`를 호출합니다. 화면 scraping이 아니며 bearer 환경변수도 요구하지 않습니다.

계정 전체 수집에는 최신 Codex CLI와 명령을 실행하는 같은 OS 사용자의 ChatGPT 로그인이 필요합니다. Windows에서는 npm으로 설치된 native binary를 우선 찾습니다. 자동 탐색이 부족할 때만 비밀값이 아닌 `AGENT_CARD_CODEX_BIN`에 실행 파일 절대 경로를 지정하세요.

Source 선택은 항상 하나입니다.

1. 가장 최신의 유효한 account profile candidate. 수집 후 48시간까지는 최신 상태로, 그 이후에는 마지막 갱신일을 밝힌 account snapshot으로 유지
2. 보존할 account snapshot이 없을 때만 모든 기기의 로컬 Codex 합계로 fallback
3. 어떤 source도 정상 동기화를 마치지 않았다면 별도의 `NOT UPDATED YET` 상태

계정 profile과 로컬 합계를 절대 더하지 않습니다. profile이 오래되어도 상태 표기만 바뀌고 선택한 데이터는 유지되므로, 예약 렌더링이 이전 account total을 더 작은 fallback 값으로 바꾸지 않습니다. `npm run sync`는 `account profile updated` 또는 `device fallback`을 명시합니다. 계정 수집이 fallback되면 같은 상태 줄에 raw App Server 출력을 노출하지 않는 `APP_SERVER_PROTOCOL` 같은 정제된 오류 코드도 표시합니다. 인증 실패, CLI 미설치, 미지원 method, timeout, protocol 변경, 잘못된 응답은 마지막 유효 profile candidate를 보존하며 렌더링도 이를 마지막 account snapshot으로 유지합니다. API-key 사용자나 account usage를 지원하지 않는 App Server 환경도 로컬 로그 기반 device fallback 카드를 계속 게시할 수 있습니다.

계정 수집만 확인하려면 다음을 실행합니다.

```console
npm run profile
```

## 공개 schema와 개인정보 경계

공개 device snapshot과 profile candidate는 schema version 2이며 Codex source만 허용합니다. 공개 artifact에는 opaque device identity, writer-key hash, 수집 시각, timezone, 정제된 상태, 일별 token aggregate, 선택적인 session count, 계정 일별 total, lifetime total, coverage만 포함될 수 있습니다.

raw logs, raw prompts, responses, project name, file path, session IDs, email, hostname, username, Git credential, API key, CLI authentication state, stderr, App Server response bodies는 포함하지 않습니다. JSON allowlist와 35개 카드 allowlist가 unknown field·unlisted file을 거부하고 SVG validator가 active/external content를 차단합니다.

aggregate는 의도적으로 공개되며 token volume, active dates, timezone, 수집 주기, stale-device event를 드러낼 수 있습니다. 민감하다면 private repository를 사용해야 하며 Git history에는 과거 aggregate가 남습니다.

신고와 위협 경계는 [SECURITY.md](SECURITY.md)를 참고하세요.

## 자동화와 복구

render workflow는 data push 뒤, 매일 정각을 피한 시각, 수동 dispatch에서 실행됩니다. GitHub scheduled workflow는 best effort이므로 실행이 지연되거나 누락될 수 있고 repository 활동이 60일 없으면 schedule이 비활성화될 수 있습니다.

카드가 오래됐다면 다음 순서로 확인합니다.

1. `npm run sync`
2. GitHub Actions의 **Render Codex Renown cards** 확인 또는 수동 실행
3. Actions를 쓸 수 없으면 `npm run publish-cards -- --as-of YYYY-MM-DD`

복구 명령은 35개 카드 경로만 렌더·검증·stage하며 충돌 처리는 bounded입니다. sync는 force-push하지 않습니다. `REMOTE_UPDATE_REQUIRES_RESTART`가 나오면 scheduler를 중지하고 clone을 갱신한 뒤 `npm ci --ignore-scripts`, `npm run validate`를 실행하고 새 sync를 시작하세요.

`sync`, `render`, `publish-cards`는 `.git/agent-card-sync.lock`을 공유합니다. `SYNC_STALE_LOCK`에서는 scheduler를 멈추고 해당 clone을 쓰는 process가 없음을 확인한 뒤 그 lock 파일 하나만 삭제하세요. `.git` 전체를 재귀 정리하면 안 됩니다.

## 로컬 명령

```console
npm run collect
npm run profile
npm run render -- --as-of YYYY-MM-DD
npm run validate
npm run check:determinism -- --as-of YYYY-MM-DD
npm run publish-cards -- --as-of YYYY-MM-DD
npm run check
```

## 라이선스

MIT. [LICENSE](LICENSE)와 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요.