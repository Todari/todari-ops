# todari-ops

Discord에서 AI 코딩 세션, 배포 알림, 서비스 상태, 작업 기록을 한곳에 다루는 개인용
운영 컨트롤 플레인입니다. 여러 사이드 프로젝트를 혼자 관리하며 반복되는 확인과 대응을
줄이기 위해 만들었습니다.

[![CI](https://github.com/Todari/todari-ops/actions/workflows/deploy.yml/badge.svg)](https://github.com/Todari/todari-ops/actions/workflows/deploy.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 이 저장소는 실제 Todari 운영 환경에서 사용하는 구현을 공개한 프로젝트입니다. 프로젝트
> 카탈로그와 일부 워크플로는 개인 환경에 맞춰져 있으므로, 포크해 사용할 때는
> `src/projects.ts`와 환경변수를 자신의 환경에 맞게 바꿔야 합니다.

## 왜 만들었나

사이드 프로젝트가 늘어나면 코딩보다 상태를 확인하는 데 더 많은 맥락 전환이 생깁니다.
todari-ops는 Discord를 공통 인터페이스로 사용해 다음 흐름을 연결합니다.

```text
Discord 명령/메시지
        │
        ├── AI 코딩 세션 ── Git checkout ── Claude Agent SDK
        │                         │
        │                    사람 승인 게이트
        │
        ├── task·idea ────── 규칙 기반 Obsidian 편집 ── commit/push
        ├── note ─────────── 제한된 볼트 편집 에이전트 ─┘
        │                         └── 실패 시 Discord 안전 큐
        │
        ├── GitHub · Sentry · Vercel webhook ── 진단/알림
        └── uptime · 도메인 · TLS · 일정 ────── digest
```

## 주요 기능

- `/code`로 프로젝트별 AI 코딩 세션을 만들고 Discord 스레드에서 대화를 이어갑니다.
- `Edit`, `Write`, `Bash` 같은 도구 실행은 버튼으로 승인하거나 거부할 수 있습니다.
- 권한 요청과 감사 로그에서 토큰·비밀번호·API 키 패턴을 자동 마스킹합니다.
- GitHub, Sentry, Vercel webhook을 HMAC으로 검증하고 배포·오류 이벤트를 알립니다.
- 서비스 uptime, 도메인 등록 만료, TLS 인증서 만료를 주기적으로 확인합니다.
- 일간 digest, 주간 요약, 리마인더, 저녁 check-in을 Discord에 게시합니다.
- `/task`, `/idea`는 Obsidian 볼트에 즉시 커밋하고 `/note`는 관련 문서를 찾아 제한된
  범위에서 바로 편집합니다. 충돌하면 Discord 인박스가 안전 큐 역할을 합니다.
- digest의 할 일에서 코딩 세션을 시작하고, 검증 후 `/end`하면 원본 볼트 체크박스도
  자동으로 완료합니다.
- Obsidian 할 일·일정, 세션 회고와 일간·주간 브리핑을 연결합니다.
- 세션 메타데이터와 Claude 대화 상태를 볼륨에 보존해 재배포 뒤에도 이어갑니다.

## 안전 설계

- 소유자 Discord ID를 확인한 뒤 명령과 승인 버튼을 처리합니다.
- 허용 목록에 없는 쓰기 도구는 자동으로 거부하고, 승인 요청은 60초 후 만료됩니다.
- GitHub 토큰은 clone URL이나 저장소 remote에 넣지 않고 프로세스 단위 인증 헤더로만
  전달합니다.
- 자연어 볼트 편집은 Markdown 최대 3개·변경 200줄로 제한하며 삭제, 첨부파일,
  `.obsidian` 변경을 거부합니다.
- 볼트 쓰기는 한 번에 하나씩 실행하고, push 충돌은 한 번 rebase 재시도한 뒤 안전 큐로
  전환합니다. 실패한 전용 checkout은 폐기해 미전송 커밋이 다음 요청에 섞이지 않게 합니다.
- webhook secret이 없으면 해당 endpoint를 비활성화합니다.
- `.env`, `.env.production`, `data/`, 배포 비밀 파일은 Git에서 제외됩니다.
- 민감한 문제는 공개 Issue 대신 [보안 정책](SECURITY.md)에 따라 제보해 주세요.

`bypassPermissions` 모드는 모든 도구 실행을 자동 승인하므로 신뢰할 수 있는 단일 사용자
환경에서만 사용해야 합니다. 이 프로젝트는 다중 테넌트 격리를 제공하지 않습니다.

## 기술 구성

| 영역 | 기술 |
| --- | --- |
| 런타임 | Node.js 22, TypeScript |
| Discord | discord.js |
| AI 세션 | Claude Agent SDK |
| 관측 | Sentry, 자체 uptime/domain/TLS monitor |
| 상태 | 파일 볼륨, 선택적 PostgreSQL audit DB |
| 배포 | Docker Compose, GitHub Actions, SSH/rsync |
| 테스트 | Vitest, TypeScript compiler |

## 빠른 시작

필요한 것은 Node.js 22+, pnpm 11+, Discord application, 그리고 Claude OAuth token 또는
Anthropic API key입니다.

```bash
git clone https://github.com/Todari/todari-ops.git
cd todari-ops
pnpm install
cp .env.example .env
pnpm dev
```

`.env`에서 아래 필수 값을 설정합니다.

| 변수 | 설명 |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_APP_ID` | Discord application ID |
| `DISCORD_GUILD_ID` | slash command를 등록할 guild ID |
| `OWNER_DISCORD_ID` | 명령과 승인 권한을 가진 단일 사용자 ID |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Pro/Max 인증. API key와 둘 중 하나만 필요 |
| `ANTHROPIC_API_KEY` | 사용량 기반 인증. OAuth token과 둘 중 하나만 필요 |

자주 쓰는 선택 변수는 다음과 같습니다. 전체 목록과 설명은
[`.env.example`](.env.example)에 있습니다.

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 빈 값 | private repository clone 및 볼트 Contents 쓰기 |
| `WORK_DIR` | `./data/work` | thread별 checkout과 세션 상태 위치 |
| `ACTION_ALLOWLIST` | `Edit,Write,Bash` | Discord에서 승인 가능한 도구 |
| `ALERTS_CHANNEL_ID` | 빈 값 | 운영 알림 채널 |
| `INSTAGRAM_CHANNEL_ID` | 빈 값 | 야있날·섹터4 게시 성공 알림 채널 |
| `INSTAGRAM_WEBHOOK_SECRET` | 빈 값 | Instagram 게시기와 공유하는 HMAC 시크릿 |
| `BOT_PUBLIC_HOST` | Todari 운영 host | 봇 자체 domain/TLS 감시 대상 |
| `VAULT_REPO_URL` | Todari vault repository | 읽기·즉시 기록에 사용할 private Obsidian 저장소 |
| `WEBHOOK_ENABLED` | `true` | HTTP webhook server 활성화 |

## 프로젝트 카탈로그 바꾸기

`src/projects.ts`에서 `/code`가 찾을 저장소, 기본 branch, 별칭, health URL을 정의합니다.

```ts
{
  slug: "example",
  name: "Example Service",
  aliases: ["example-api"],
  repoUrl: "https://github.com/example/example.git",
  defaultBranch: "main",
  healthUrl: "https://example.com/health",
}
```

private 코드 저장소만 쓰면 `GITHUB_TOKEN`에 Contents 읽기 권한이면 충분합니다. 볼트 즉시
기록을 쓰려면 `VAULT_REPO_URL` 저장소에는 Contents 읽기·쓰기 권한이 필요합니다. Mac의
Obsidian Git도 주기적인 pull/push와 `pull before push`를 켜 두어 양쪽 변경을 받아야 합니다.
패키지의 `private: true`는 GitHub 공개 범위와 무관하며, 실수로 npm에 배포되는 것을 막기 위한
설정입니다.

## Webhook

HTTP server는 다음 endpoint를 제공합니다.

| Endpoint | 검증 |
| --- | --- |
| `GET /healthz` | 없음 |
| `POST /webhook/sentry/:slug` | `SENTRY_WEBHOOK_SECRET` |
| `POST /webhook/github` | `GITHUB_WEBHOOK_SECRET` |
| `POST /webhook/vercel` | `VERCEL_WEBHOOK_SECRET` |
| `POST /webhook/vault-sync` | `VAULT_SYNC_SECRET` |
| `POST /webhook/instagram` | `INSTAGRAM_WEBHOOK_SECRET` (`X-Instagram-Signature`) |

외부에 노출할 때는 nginx, Caddy 같은 reverse proxy에서 TLS를 종료하고 bot port는 loopback에만
bind하는 구성을 권장합니다.

```nginx
server {
  server_name ops.example.com;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Instagram 포트폴리오 운영 지표

EC2 호스트의 `scripts/instagram-watchdog.py`는 게시 침묵 실패를 감시하고, 매일 KST 21시
이후 한 번 `scripts/instagram_portfolio.py`를 실행한다. 야있날·섹터4·주진모의 최근 14일
게시물을 같은 스키마로 수집해 `/home/ubuntu/ops-watchdog/instagram-insights.json`에 저장한다.

- 각 계정 토큰은 해당 `/home/ubuntu/<repo>/.env`에서 읽으며 결과 파일에 기록하지 않는다.
- 게시물 조회·도달·저장·공유·반응·릴스 평균 시청 시간과 계정 프로필 조회·팔로워 수를 수집한다.
- 핵심 포맷과 보조 포맷을 분리하고 도달 1,000명당 저장·공유·반응을 계산한다.
- 포맷별 게시물당 평균·중앙값과 게시물별 35일 스냅샷을 유지해 +24시간/+7일 성과를 비교한다.
- 35일치 계정·포맷 요약을 유지해 대표 포맷을 감이 아니라 누적 성과로 고를 수 있게 한다.
- 시리즈별 +24시간 표본이 5개 쌓이면 한 변수만 다음 생성 실험으로 선택한다. 순서는
  중단 규칙(도달 중앙값 20 미만) → 피드 시리즈의 팔로워 밖 노출 0(도달 중앙값 ≤ 팔로워 수)
  → 릴스 시청 중앙값 5초 미만 `opening_hook` → 도달 1,000당 프로필 방문 3 미만 `follow_promise`
  → 도달 1,000당 저장+공유 1 미만 `save_share_value` → 관찰. 성과 수치는 콘텐츠 사실 근거로
  사용하지 않는다.
- `pause_series`는 각 생성기의 화이트리스트 밖이라 프롬프트에 전달되지 않는다. 발행량을
  줄이거나 시리즈를 멈추는 운영 판단용이며, 계정별 `pause_candidates`와 주간 리포트의
  "중단 후보 시리즈" 줄로만 노출한다.
- 계정 단위 퍼널로 도달 1,000당 프로필 방문(`profile_visits_per_1000_reach`, 일간 도달 100
  미만이면 비율이 요동쳐 계산하지 않음)과 팔로워 증감
  (`follower_delta_7d`, 7일 기준선이 없으면 보유한 가장 오래된 이력을 쓰고 실제 창 일수를
  `follower_delta_window_days`에 남김)을 기록한다. 릴스 시리즈는 시청 중앙값과 4초 미만
  시청 비중(`watch_under_4s_share`)을 유지율 대리 지표로 함께 남긴다.
- 경기일보다 이틀 이상 늦은 야있날 게시와 같은 날 세 편 이상 몰아서 올린 섹터4 동일 시리즈는
  백필로 분류해 성장 표본에서 제외한다.
- 일요일 주간 리포트에는 계정별 다음 실험을 함께 남긴다. 각 생성기는 공용 insights 파일을
  읽되 파일이 없거나 표본이 부족하면 기존 프롬프트를 그대로 사용한다.
- 프로필 방문과 7일 팔로워 증감은 계정 단위 보조 신호로만 사용한다. 특정 게시물이 만든
  팔로우로 직접 귀속하지 않는다.

호스트 설치 또는 갱신:

```bash
EC2_HOST=ubuntu@<ip> SSH_KEY=~/.ssh/key.pem ./deploy/install-instagram-watchdog.sh
```

## Docker 배포

```bash
cp .env.production.example .env.production
# 실제 값과 WORK_DIR=/data/work를 설정
docker compose --env-file .env.production up -d --build
curl --fail http://127.0.0.1:3100/healthz
```

기본 GitHub Actions workflow는 `main` push에서 typecheck 후 SSH/rsync 배포를 수행합니다.
사용하려면 `EC2_HOST`, `EC2_SSH_KEY`, `EC2_KNOWN_HOSTS` repository secret을 설정하세요.
다른 배포 방식을 쓴다면 workflow를 비활성화하거나 교체하면 됩니다.

## 개발과 검증

```bash
pnpm typecheck
pnpm test
pnpm build
```

주요 디렉터리:

```text
src/
  agent/        Claude 세션, 권한 게이트, 입력 마스킹
  discord/      client와 slash command 등록
  handlers/     command, message, button 처리
  monitor/      uptime, resource, domain/TLS 감시
  storage/      session과 audit 상태
  vault/        Obsidian 조회·제한된 즉시 편집·충돌 폴백
  webhook/      HMAC 검증과 provider별 event 처리
  workspaces/   thread별 Git checkout
```

## 라이선스

[MIT](LICENSE)
