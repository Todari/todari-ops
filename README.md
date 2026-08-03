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
- 선택적으로 Obsidian 지식 저장소를 읽고 할 일·일정·세션 회고 흐름을 연결합니다.
- 세션 메타데이터와 Claude 대화 상태를 볼륨에 보존해 재배포 뒤에도 이어갑니다.

## 안전 설계

- 소유자 Discord ID를 확인한 뒤 명령과 승인 버튼을 처리합니다.
- 허용 목록에 없는 쓰기 도구는 자동으로 거부하고, 승인 요청은 60초 후 만료됩니다.
- GitHub 토큰은 clone URL이나 저장소 remote에 넣지 않고 프로세스 단위 인증 헤더로만
  전달합니다.
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
| `GITHUB_TOKEN` | 빈 값 | private repository clone 및 GitHub 연동 |
| `WORK_DIR` | `./data/work` | thread별 checkout과 세션 상태 위치 |
| `ACTION_ALLOWLIST` | `Edit,Write,Bash` | Discord에서 승인 가능한 도구 |
| `ALERTS_CHANNEL_ID` | 빈 값 | 운영 알림 채널 |
| `BOT_PUBLIC_HOST` | Todari 운영 host | 봇 자체 domain/TLS 감시 대상 |
| `VAULT_REPO_URL` | Todari vault repository | 선택적 지식 저장소 |
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

private repository는 `GITHUB_TOKEN`에 해당 저장소의 Contents 읽기 권한을 부여해야 합니다.
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
  vault/        선택적 지식 저장소 연동
  webhook/      HMAC 검증과 provider별 event 처리
  workspaces/   thread별 Git checkout
```

## 라이선스

[MIT](LICENSE)
