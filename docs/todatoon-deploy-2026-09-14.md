# todatoon EC2 배포 — 2026-09-14

인스타툰 v0.16.8의 채널 입력·초안 생성·본문 그림 수정·승인 게시 런타임을 운영 EC2에 반영했다. 봇 교체 후 healthz의 startup·Discord·uptime·resources가 모두 healthy다. 실제 새 회차 생성과 사용자 승인 게시를 수행한 기록은 아직 없다. 이번 점검에서 Instagram 게시물과 Discord 테스트 메시지는 만들지 않았다.

## 사용

[#인스타툰-스튜디오](https://discord.com/channels/1498291933590585456/1546807040759037972)는 기존 비공개 채널을 그대로 사용한다. 채널 설명을 사용 방법으로 갱신했다. 소유자의 일반 메시지 한 개가 제작 요청 한 개이며 첫 줄을 제목으로 쓴다. 답글과 스레드 대화는 새 회차로 접수하지 않는다.

1. 첫 줄에 제목, 아래에 이야기와 대사를 적어 한 메시지로 보낸다.
2. 결과의 그림·대사·표지·캡션을 확인한다. 자동 검수 탈락은 게시 불가 초안으로 남는다.
3. 수정 스레드에 `3컷 표정 덜 놀라게`처럼 표지를 제외한 본문 번호와 그림 지시를 적는다. 표지·대사 수정은 아직 지원하지 않는다.
4. 최종 검수를 통과한 완성본에서 **승인하고 게시**를 누르면 승인된 파일과 캡션을 `@todatoon`에 보낸다. 수정하면 재승인이 필요하다.

## 적용 범위와 증빙

- EC2: `i-05117687970674d17`, `52.78.45.209`, `ap-northeast-2`.
- 릴리스: `/home/ubuntu/releases/todatoon-20260914`.
- 이미지: `todari-ops-content:todatoon-20260914`.
- 이미지 ID: `sha256:c5f7cd69b39df43c2ae283e30b2bb025278ddedfaf516604393ccc054b46eced`.
- pipeline SHA-256: `e28dae4cf5bd1b8ae31bedba86d1b78383196e78426cdf7e6d3dd12f2c9c5d65`.
- Compose 프로젝트 `todari-ops`, 컨테이너 `todari-ops-bot`, 기존 data·Claude state 볼륨을 유지했다. 기존 작업은 failed 4개·review 5개이며 교체 전 진행 중 작업과 미전송 결과/알림은 0개였다.
- git HEAD를 격리 추출하고 콘텐츠 관련 파일만 덮었다. 다른 로컬 작업 변경은 배포하지 않았다. 원화 scripts·bible은 서버의 기존 글꼴과 회차를 보존하며 동기화했다.
- `.env.content`는 릴리스와 `/home/ubuntu/todari-ops`에 600 권한으로 보존했다. 기존 계정 토큰·ID를 유지했고 생성·승인 게시·전용 채널 설정을 활성화했다. 실제 승인 상태는 변경하지 않았다.

릴리스 안 `release-manifest.json`, `verification.json`, `preflight.log`, `smoke-runtime.log`, `smoke-channel.log`, `channel.json`, `deploy.log`가 배포 증빙이다. 계정·API 키·서명 URL은 로그에 출력하지 않았다.

## 검사 결과

| 검사 | 결과 |
|---|---|
| 콘텐츠 TypeScript 33개·typecheck·build | 성공, 종료 코드 0 |
| 전체 Python 178개·배포 테스트 5개 | 성공, 종료 코드 0 |
| 최종 S3 코드 변경 후 게시 회귀 12개 | 성공, 종료 코드 0 |
| 최종 Docker 이미지 빌드·원화 3종 해시·한글 실제 렌더·전체 페이지·말풍선·피부 채색 검사 | 성공, 종료 코드 0 |
| Linux Python·Remotion·Chromium·글꼴·마운트 쓰기 권한 | 성공 |
| 실제 EC2 역할 업로드·서명 이미지 외부 GET | 성공, 이미지 바이트 일치 |
| 익명 S3 이미지 GET | 403, 비공개 유지 |
| 실제 Google JSON 생성·Instagram 계정 조회 | 성공, `todatoon` 확인 |
| 격리된 실제 채널 처리 함수·중복 접수·계정 불일치 차단 | 성공, 실작업/메시지 생성 0 |
| 운영 컨테이너 교체·healthz·Discord 연결 | 성공 |

서명 URL 검사에서 기본 S3 클라이언트의 링크가 `SignatureDoesNotMatch`로 실패했다. 실제 게시 코드의 `media_storage()`에서 버킷 리전·SigV4·virtual-hosted 주소를 명시한 뒤 같은 EC2 역할로 업로드·다운로드가 통과했다. [AWS Boto3 권장 설정](https://docs.aws.amazon.com/boto3/latest/guide/s3-presigned-urls.html).

버킷 `todatoon-content-236677164563-ap-northeast-2`는 퍼블릭 접근을 차단하고 AES256 암호화·`content/` 7일 만료를 사용한다. EC2에는 `TodatoonContentMediaRole`을 연결했으며 해당 버킷의 `content/*` PutObject/GetObject/AbortMultipartUpload만 허용한다. 정적 AWS 키를 서버에 복사하지 않았다. 테스트용 작은 흰 이미지 `content/deploy-smoke-20260914/probe.jpg`도 같은 만료 정책으로 정리된다.

## 재시작과 복구

현재 릴리스를 조회하거나 같은 이미지로 복구할 때 EC2에서 실행한다. `operate.sh`는 프로젝트 이름과 릴리스 이미지를 고정한다. `restart: unless-stopped`로 EC2 재부팅 후에도 컨테이너가 기동한다.

```sh
/home/ubuntu/releases/todatoon-20260914/operate.sh ps
/home/ubuntu/releases/todatoon-20260914/operate.sh up -d --no-build --wait --wait-timeout 180
curl -fsS http://127.0.0.1:3100/healthz
```

직전 기본 봇으로 되돌리는 명령은 다음과 같다. 콘텐츠 기능은 비활성으로 돌아가며 작업 볼륨은 보존한다.

```sh
docker compose -p todari-ops \
  --env-file /home/ubuntu/todari-ops/.env.production \
  -f /home/ubuntu/todari-ops/docker-compose.yml \
  -f /home/ubuntu/releases/todatoon-20260914/rollback/image.yml \
  up -d --no-build --wait --wait-timeout 180
```

이전 이미지 태그는 `todari-ops-bot:before-todatoon-20260914`다. 설정 백업은 `/home/ubuntu/todari-ops/.env.content.before-content-live-20260914`와 릴리스 `rollback/`에 보존했다. 키가 든 파일은 출력하거나 git에 넣지 않는다.

## 다음 배포 경계

이번 작업은 EC2 직접 배포다. 로컬의 `deploy/compose.sh` 및 `.github/workflows/deploy.yml` 수정안은 아직 커밋·푸시하지 않았으며 canonical 서버 소스도 기존 HEAD를 보존했다. 따라서 기존 원격 main의 자동 배포를 실행하면 기본 이미지로 되돌아갈 수 있다. 다음 코드 배포에서는 콘텐츠 진입점 변경을 검증해 원격에 반영하거나, 검증한 새 격리 릴리스를 같은 Compose 프로젝트로 교체해야 한다. 현재 운영 이미지를 재시작할 때는 위 `operate.sh`를 사용한다.

실제 첫 회차에서 Discord 수신→전체 생성→수정 스레드→사용자 승인→Instagram 게시와 게시 결과 안내를 확인해야 한다. API 조회·모의 게시 검사는 그 완료 증거가 아니며, 자동 검수 통과도 원화 품질의 무조건 보증이 아니다.
