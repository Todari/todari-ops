# 왜냐면·인스타툰 승인 게시

**2026-09-14 현재 상태:** 인스타툰 v0.16.8을 EC2에 배포했다. [#인스타툰-스튜디오](https://discord.com/channels/1498291933590585456/1546807040759037972)에 소유자가 첫 줄에 제목, 아래에 이야기와 대사를 한 메시지로 올리면 제작을 시작한다. 통과한 완성본의 **승인하고 게시** 버튼으로 `@todatoon`에 게시한다. 실제 새 이야기의 운영 채널 접수부터 첫 승인 게시까지는 아직 실행하지 않았다. [배포 증빙·운영·복구 절차](todatoon-deploy-2026-09-14.md).

실행 이미지는 `todari-ops-content:todatoon-20260914`이며 콘텐츠 생성·승인 후 게시 설정을 활성화했다. 원화·한글 실제 렌더, Google 생성 API, Instagram 계정 조회, EC2 역할을 통한 S3 업로드·서명 URL 다운로드, 격리된 채널 입력 처리와 중복 방지, 교체 후 healthz·Discord 연결이 통과했다. 기존 작업 9개를 보존했고 진행 중인 작업은 없었다. 토큰·계정 ID는 기존 값을 사용하며 설정 파일 권한은 600이다. 아래 과거 “계정 미연결”·“미배포” 기록은 당시 상태다.

로컬 업로더는 계정별 `*_IG_API=instagram|facebook`으로 요청 호스트를 선택한다. `instagram`은 `graph.instagram.com`, 미설정의 기존 기본값 `facebook`은 `graph.facebook.com`이다. 잘못된 값은 업로드 전 차단한다. 직접 로그인 토큰을 Facebook 전용 호스트로 보내던 불일치를 수정했으며, 기존 다른 계정의 기본값은 유지한다. Instagram 직접 로그인 방식에는 Facebook 페이지 연결이 필요하지 않다. [Meta 공식 API 문서](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login).

9월 14일 읽기 전용 검증: `/me?fields=id,user_id,username`의 username은 `todatoon`, 저장된 ID와 응답 ID가 일치했다. 저장된 ID와 `user_id` 양쪽으로 게시 한도 조회가 성공했다. `/permissions`는 이 API에서 지원하지 않는 필드 오류를 반환했으므로 권한 목록 확인이나 실제 게시 성공으로 보고하지 않는다. 테스트는 Python 178개+배포 5개, 콘텐츠 TS 33개와 typecheck/build를 통과했다. 캐러셀의 자식 이미지·캡션·게시 요청이 Instagram 호스트와 Bearer 헤더를 사용하는지 모의 API로 검사했으며, 이 검사가 실게시 성공을 대신하지는 않는다.

`/content kind:왜냐면 topic:주제 body:전달할 내용` 또는 인스타툰 선택 → EC2가 대본·원화·음성·조판/렌더·검수 → 같은 채널에 미리보기/검수표와 **승인하고 게시 / 반려** 버튼 → 소유자 승인 후 Instagram 게시. `/content job:작업ID`로 상태 확인.

한 번에 1편, 대기 최대 5편. 입력은 데이터로 전달하고 쉘 명령에 삽입하지 않는다. 기존 OWNER_DISCORD_ID 권한 검사가 명령과 버튼에 적용된다. 5~8컷 대본을 만들며 대본은 최대 2회, 원화는 컷당 최대 2회 생성한다. 최종 검수 탈락은 게시 대기로 넘어가지 않는다. 반려 후에는 수정 내용을 포함해 새 작업을 요청한다.

왜냐맨은 Google Search grounding의 지원 문장과 직접 읽은 공식 기관·대학 원문을 대본의 주장에 연결하고 독립적으로 사실을 검수한다. 검색 응답의 출처 정보가 없어도 실제 취득한 1차 원문이 있으면 진행하며, 둘 다 없으면 중단한다. 출처 없는 모델 설명은 근거로 승격하지 않는다. 음성/자막 생성 근거를 기존 검사기로 확인하며 1080×1920, 음성 포함, 20~90초를 검사한다. 최종 압축 미리보기와 장면별 원본 프레임으로 발음·싱크·가독성을 멀티모달 검수한다. 인스타툰은 확정 캐릭터 시트를 참조하며 3종 이상의 샷 크기를 사용한다. 한글은 코드로 조판하고 40px에서도 넘치면 실패한다. 실제 게시하는 JPEG를 검수한다. 자동 검수는 사람 판단을 대체하지 않으며 최종 승인은 완성본을 보고 누른다.

## 초안과 스레드 수정 (2026-09-21 로컬 보완, 운영 미반영)

인스타툰은 한 컷이 검수를 통과하지 못해도 회차를 버리지 않는다. 통과한 컷과 실패한 컷(마지막 시도 원화에 계획된 조판을 얹음)을 함께 렌더해 **초안(게시 불가)** 메시지로 올리고, 실패한 컷 번호와 검수 사유를 적는다. 초안에는 승인 버튼이 없고 `manifest.json`도 만들지 않는다. 최종 검수가 대본 수준에서 탈락해도 같은 초안으로 남긴다. 작업 상태는 `draft`다.

검토 요청·초안 메시지에는 봇이 스레드(`수정 요청 · 제목`)를 연다. 소유자의 요청은 대상 확인 단계로 접수하며 **확인 버튼 전에는 실행하거나 비용을 발생시키지 않는다**.

- 첫 줄 `수정 대상: 6컷`, 다음 줄 `5컷처럼 노란 과자 봉지를 남겨 주세요.` — 대상 필드만 해석하므로 5컷은 참고용이다.
- 여러 컷은 `수정 대상: 2, 4컷`. 컷 번호는 표지를 뺀 본문 순서이며 번호 없는 요청의 실패 컷 전체 적용은 폐지했다.
- `원복 대상: 6컷`은 직전 수정 전 백업에서 해당 컷만 복구한다. 이미지 생성은 없지만 전체 AI 재검수 비용은 발생하며 확인 버튼이 필요하다.
- 표지·대사·설명문 변경은 지원하지 않는다. 지시문에서 표지를 참고하는 것은 허용한다.

확인 버튼을 누르면 `revision.json`을 쓰고 상태를 `revising`으로 바꾼다. 워커는 불변 백업을 만든 뒤 지정 컷만 수정·전체 재검수한다. 최종 자동 보정도 대상 컷 밖으로 확장하지 않으며 비선택 컷 원화/JPEG/대본 변경은 실패 처리하고 이전 결과를 복구한다. 결과는 같은 스레드에 전후 비교 HTML, 검토 자료, 새 검토 요청 또는 초안 순서로 올라온다. 자료와 이미지 메시지를 나눠 첨부 10개 한도를 지킨다. 지정하지 않은 실패 컷은 실패로 남는다.

실패·재시작 시 `recovering` 워커가 백업 무결성을 검증하고 복원한 뒤 새 검토 메시지를 발급한다. 복구 실패는 게시 불가이며 백업 없는 기존 중단 작업은 수동 확인이 필요하다. 같은 해시로 원복하더라도 옛 메시지의 승인 버튼은 거절한다. 새 승인 없이는 게시하지 않는다. 초안 재제작은 원래 채널과 해당 수정 스레드에서만 허용하며 결과는 원래 채널로 보낸다.

추가 산출물: `revision-backups/<revisionId>/`, `revision-result.json`, `comparison.html`. 실패 초안의 미승인 컷으로 원복할 수 없다. API 사용 기록·모델 캐시는 복구 시 유지하며 실패 후보의 개별 파일은 유지하지 않을 수 있다. 검증·배포 전제는 [보완 기록](todatoon-revision-safety-2026-09-21.md) 참조. **아직 운영 반영 및 실제 Discord 버튼 E2E는 하지 않았다.**

## EC2 설정

기본 런타임은 Alpine이며 콘텐츠 기능은 opt-in이다. 로컬의 `deploy/compose.sh`와 GitHub Actions 수정안은 EC2 `.env.content`의 `CONTENT_ENABLED=true`를 읽어 `Dockerfile.content`와 compose overlay를 선택한다. 이 수정안은 아직 원격 main에 커밋·푸시하지 않았다. **현재 운영은 격리 릴리스 직접 배포이며, 다음 main 자동 배포가 기본 봇으로 되돌리지 않도록 위 배포 기록의 경계를 먼저 확인한다.** 미설정·false·0이면 기본 런타임, true·1이면 콘텐츠 런타임이며 오타는 배포를 중단한다. 단일 bot replica를 유지한다.

1. EC2의 전용 경로에 `waenyamyeon`, `instatoon-studio`를 배치한다. `.env`, macOS `node_modules`, 캐시를 복사하지 않는다. 두 제작 레포는 현재 최초 커밋 전이므로 원격 git clone 가능 여부를 먼저 확인한다.
2. `waenyamyeon`에서 **Linux Node 22 환경**으로 `npm ci`. `episodes/ep001.json`, `public/anchor/anchor.png`, `public/fonts/`(IBM Plex 및 OFL), `public/sfx/`의 공통 합성 효과음, `instatoon-studio/bible/sheets/core-cast-turnaround-v1.png`를 포함한다. 작업 루트·episodes·public·assets는 컨테이너 사용자 UID 1000이 쓸 수 있어야 한다.
3. 라이선스가 확인된 `BMKIRANGHAERANG-OTF.otf`와 `Pretendard-SemiBold.ttf`를 `instatoon-studio/fonts/`에 둔다. Linux Noto Sans KR/CJK는 컨테이너에 설치된다.
4. EC2의 `.env.content`(권한 600)에 아래 **환경변수 이름**을 설정한다. 공통 봇 설정은 기존 `.env.production`을 유지하고 `.env.content`를 추가로 읽는다. 키 값을 채팅이나 git에 기록하지 않는다.

| 변수 | 용도 |
|---|---|
| CONTENT_ENABLED | `true`로 콘텐츠 런타임 활성화(서버 설정에 보존) |
| CONTENT_PUBLISH_ENABLED | 계정 연결 전 `false`. 계정·토큰·S3 설정을 마친 뒤에만 `true` |
| CONTENT_REPOS_DIR | EC2 제작 레포 부모 경로(compose 치환용) |
| GEMINI_API_KEY | 대본·Search·이미지·TTS·검수 |
| CONTENT_TEXT_MODEL | Search와 멀티모달/JSON을 지원하는 계정 사용 가능 모델 ID |
| CONTENT_IMAGE_MODEL | 참조 이미지와 aspectRatio를 지원하는 모델 ID |
| CONTENT_GRAPH_VERSION | 사용하는 Meta Graph 버전 (`v숫자.숫자`) |
| WAENYAMYEON_IG_USER_ID / WAENYAMYEON_IG_ACCESS_TOKEN | 왜냐면 프로페셔널 계정 / 게시 권한 토큰 |
| INSTATOON_IG_USER_ID / INSTATOON_IG_ACCESS_TOKEN | 인스타툰 프로페셔널 계정 / 게시 권한 토큰 |
| INSTATOON_IG_API / WAENYAMYEON_IG_API | 각 계정의 로그인 방식: `instagram` 또는 `facebook`(미설정 기본). todatoon은 `instagram` |
| CONTENT_S3_BUCKET | 게시 파일 임시 저장 버킷 |
| AWS_DEFAULT_REGION | 버킷 리전 |

S3는 SDK 기본 자격 증명 체인(EC2 IAM 역할 등)을 사용한다. 버킷 `content/*`에 PutObject/GetObject가 필요하며 컨테이너에서 역할 접근이 가능해야 한다. 객체를 공개 ACL로 바꾸지 않고 서명 URL로 Meta에 전달한다. URL의 요청 만료는 24시간이며 임시 역할 자격 증명이 먼저 만료되면 URL도 만료된다. 서명은 SigV4와 버킷 리전의 virtual-hosted 주소를 사용한다. 버킷에 7일 만료 lifecycle을 설정해 임시 파일을 정리한다. 업로더의 로그인 방식은 계정별 `*_IG_API`로 선택하며 토큰의 발급 방식과 일치해야 한다.

설정을 마친 뒤 실행할 명령:

```sh
bash deploy/compose.sh deploy
bash deploy/compose.sh logs --tail=50 bot
```

배포는 이미지를 빌드한 뒤 임시 컨테이너에서 Python 모듈·ffmpeg·Remotion 의존성·Chromium 실행·필수 원화와 글꼴·제작 경로 쓰기 권한을 검사한다. 검사에 실패하면 기존 봇을 교체하지 않는다. 바인드 경로가 없을 때 빈 디렉터리를 자동 생성하지 않는다. 이 검사는 모델 API와 게시 API를 호출하지 않으며 실제 한 편의 렌더/음성 품질 검증을 대신하지 않는다.

## 승인과 장애 복구

왜냐맨 새 자동 생성은 `waenyamyeon/scripts/science_diagrams.py`와 `src/overlays/ScientificDiagram.tsx`의 `science-diagram-v2`를 사용한다. 응결·금속/나무 열 전달·얼음 밀도 세 원리만 지원하며 미지원 주제는 중단한다. 출처와 연결된 대본을 다섯 장면으로 조립하고 입자·열 이동·같은 양/부피 비교를 코드 애니메이션으로 설명한다. `왜냐맨. @whynyaman`, 글꼴·색상, 최대 두 줄 자막을 고정한다. 기존 원화 기반 작업의 복구에는 `auto_episode.py`를 유지한다. 코드의 형식 검증이 과학적 정확성까지 보증하지는 않는다.

`CONTENT_VIDEO_MODEL`을 명시하면 끝에서 두 번째 장면에 해당 Veo 모델로 8초 클립 한 개를 생성한다. 미설정이면 코드 애니메이션만 사용한다. 이 옵션은 추가 유료 호출을 활성화하므로 운영자가 모델·예산을 정한 뒤 설정한다. 완성된 클립은 입력/파일 해시가 맞으면 재사용하며, 요청 결과가 불명확한 클립 생성 오류는 자동 재요청하지 않는다.

과학 도식 프리뷰는 승인 대본, 다섯 장면의 시작/후반 프레임, 원인·비교 장면의 12초 동영상을 함께 검수한다. 최종 검수에는 전체 재생 영상과 원본 프레임, 도식·계정명·자막 확대 및 발화 끝 자막을 제공한다. 얼음 비교 프레임은 실제 픽셀에서 물 12개/얼음 11개의 설명용 점을 독립 계수하며, 개수 변경·겹침은 중단한다. 이는 두 샘플 프레임의 검사로 전체 영상의 과학성·음성 검사를 대신하지 않는다. 상세 검수 입력과 SHA-256은 `final-review-inputs.json`에 남긴다. Discord에는 `review.html`을 포함해 최대 10개 첨부만 전달한다.

폰트는 제작 레포의 `public/fonts/`에서 읽는다. 작은 서버의 메모리 사용량을 제한하기 위해 렌더 기본 동시성은 1이며 `REMOTION_CONCURRENCY=1..8`로 조정할 수 있다. 음성 트랙은 -16 LUFS/-2 dBTP로 정규화하고 장면 ID와 무관하게 효과음을 배치한다. 최종 검수에는 540p 재생 미리보기와 장면별 1080p 프레임을 함께 전달한다.

모델 요청의 일시적 네트워크/429/일부 5xx 오류는 최대 3회 backoff 재시도한다. 소진 시 생성 작업만 최대 총 3회 실행하며 작업 디렉터리의 `model-cache/`와 음성 캐시, 렌더 입력 해시로 완료된 단계를 재사용한다. 재시작된 생성도 같은 예산으로 복구한다. 영구 오류·품질 탈락·게시 요청은 자동 재시도하지 않는다. 모델 요청이 서버에 도달한 뒤 응답을 잃은 경우 과금 중복 가능성까지 제거하지는 못한다.

`WORK_DIR/content/<UUID>/`에 입력, 조사 근거, 대본 후보, 검수, 이미지, 최종본, manifest, 승인 상태, 게시 receipt를 보존한다. 승인 해시에 캡션·계정·파일 체크섬·검수표가 포함된다. 게시 전에 파일과 계정을 다시 검사한다. 생성 중 재시작은 남은 재시도 예산이 있으면 queued, 없으면 failed로 복구한다. 게시 중 재시작/타임아웃은 uncertain으로 바꾸며 자동 재게시하지 않는다.

`publish-attempt.json`은 실제 `media_publish` 요청 전에 저장한다. `receipt.json`이 있으면 해당 media ID를 계정에서 확인한다. attempt만 있으면 container 상태와 실제 계정을 확인해야 한다. **확인 없이 attempt 삭제나 새 게시 요청을 하지 않는다.** 준비 단계 실패도 보수적으로 uncertain에 남긴다. 검토 알림 실패는 10초 간격으로 다시 전달한다. 디스코드가 전송 성공 응답을 잃으면 요청 메시지는 중복될 수 있지만 첫 승인 이후 다른 버튼은 거부된다.

오류는 `error.json`에 단계와 예외 유형, 자식 프로세스 실패 시 실행 파일명과 종료 코드를 남긴다. 외부 오류 응답 본문은 비밀 노출 방지를 위해 저장하지 않는다. 성공한 모델 응답은 재개용 캐시에 남는다. Discord 입력 및 산출물은 업무 데이터이므로 작업 디렉터리 백업/보존 정책을 운영자가 정한다. 원화 후보는 왜냐맨 장면당 최대 3개, 인스타툰 최대 2개이며 일시 오류 재요청과 선택형 클립의 비용은 별도다. 왜냐맨의 원화 수정 요청에는 실패 후보 한 장만 전달해 편집 대상 혼동을 줄이고, 수정 결과 검수에는 앞 장면과 화풍 맥락을 다시 전달한다.

## 검증

2026-09-08 왜냐면 렌더 검증: 네트워크를 차단한 Linux 컨테이너(CPU 1개, 메모리 1800MB)에서 기존 음성/원화와 연출 fixture로 1080×1920·30fps·24.68초 H.264/AAC MP4를 생성했다. 시스템 Chromium은 `chrome-for-testing` 모드(new headless)로 실행한다. 중단된 scratch에서 `smoke_content_render.py --resume-work`를 실행해 최종 MP4/음성 재생성 없이 두 번 재사용되고, 미리보기 및 장면별 1080p 검토 이미지가 생성되는 것을 확인했다. 실제 모델 호출/게시는 0회이며 Gemini 발음·새 원화의 지시 이행률과 실제 EC2 처리 시간은 별도 검증 대상이다.

재현 명령은 `python3 scripts/smoke_content_render.py --source-root /path/to/waenyamyeon --work-dir /tmp/new-content-smoke`이며 Linux에서는 Linux용 `node_modules`와 `REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium`을 사용한다. 원본 레포를 변경하지 않고 지정한 새 작업 폴더에 복사해 테스트한다. 중단된 해당 scratch만 다시 검사하려면 같은 경로에 `--resume-work`를 추가한다.

```sh
bash -n deploy/compose.sh deploy/deploy.sh
python3 -B deploy/test_compose.py
pnpm typecheck
pnpm exec vitest run src/content
python3 -B -m unittest discover -s scripts -p 'test_content*.py' -v
```

외부 API 없이 승인·재시작·변조 방지와 게시 요청 중복 방지를 검사한다. 실제 모델 생성 품질, Discord 전송, EC2 컨테이너, S3와 계정 게시 성공은 운영 설정 후 승인된 시험 콘텐츠로 별도 확인해야 한다.

API 근거: [Google 구조화 출력](https://ai.google.dev/gemini-api/docs/structured-output), [Meta 공식 Instagram API 컬렉션](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).

2026-09-08 로컬 확인: 봇 전체 테스트 및 신규 작업 상태 테스트, Python 생성/승인/게시 모의 테스트, 두 제작 레포 기존 테스트와 타입 검사 통과. 실제 글꼴로 정상 조판/넘침 차단을 확인했다. Linux arm64 Docker 이미지 빌드와 네트워크를 차단한 컨테이너의 Python 모듈·ffmpeg·headless Chromium 실행을 확인했다. EC2 실제 아키텍처에서의 렌더, 유료 모델 생성 결과, 계정 게시 성공은 아직 확인하지 않았다.


## EC2 적용 상태 — 2026-09-08

기존 통합 EC2(x86_64)의 `/home/ubuntu/todari-ops`에 콘텐츠 런타임을 적용했다. `todari-ops-bot` healthy 및 Discord `/content` 명령의 `kind/topic/body/job` 옵션 등록을 API 조회로 확인했다. 제작 레포·기준 이미지·공통 효과음·글꼴은 `/home/ubuntu/content-repos`에 설치했고 Linux용 `npm ci`를 완료했다. 계정/API 호출 없이 실제 1080×1350 한글 카드, 1080×1920 자막 프레임과 오디오 포함 MP4 렌더가 통과했다.

`.env.content`는 권한 600이며 `CONTENT_ENABLED=true`, `CONTENT_PUBLISH_ENABLED=false`, `REMOTION_CONCURRENCY=1`이다. 봇 컨테이너에는 CPU 1개·메모리 1800MiB 제한을 적용했다. 게시 계정이 없어도 생성·검수할 수 있도록 게시 설정과 생성 사전 검사를 분리했다. 계정이 없는 검토 요청은 게시 버튼이 비활성화되고 백엔드에서도 승인을 거부한다. Gemini 키가 없으면 유료 작업을 접수하지 않고 설정 안내를 응답한다.

사용자 요청에 따라 포크레터 `.env.prod`의 Gemini 키를 EC2 `.env.content`에 연결했다(값은 기록하지 않음). 설정된 대본·이미지 모델 접근과 실제 JSON 대본 API 응답을 확인했고 운영 봇에 적용 후 healthz/Discord 연결이 정상이다. 전체 콘텐츠 신규 생성과 실제 이미지 생성은 아직 검증하지 않았다. Instagram 두 계정은 아직 없으므로 계정 생성·Meta 게시 권한·미디어 제공용 S3 연결은 남아 있다. 실게시나 Discord 테스트 메시지 전송은 하지 않았다.

이전 소스는 `/home/ubuntu/content-backup-20260908-1153/source-before.tar.gz`, 이전 이미지는 `todari-ops-bot:before-content-20260908`로 보존했다. 검증 릴리스는 `/home/ubuntu/content-release-20260908-1153`, 적용 이미지 태그는 `todari-ops-content:20260908-1153`이다. 로컬 커밋·푸시는 수행하지 않았다.

2026-09-08 후속 배포: 왜냐면의 최신 렌더/음성/폰트/연출 검증과 `audio_ready` 재개 수정, 클립 요청 중복 방지, 검토 프레임 전달을 반영했다. 작업 중인 인스타툰 추가 수정은 섞지 않고 서버 기존 분기를 보존했다. 적용 이미지는 `todari-ops-content:waenya-1305`, 릴리스는 `/home/ubuntu/waenyamyeon-release-20260908-1305`, 백업은 `/home/ubuntu/waenyamyeon-backup-20260908-1305` 및 `todari-ops-content:before-waenya-1305`다. 사전 점검과 교체 후 healthz/Discord 연결이 정상이며, 실제 EC2의 봇 컨테이너에서 한글 제목·자막·애니메이션 및 오디오 포함 1080×1920·30fps·2.048초 검증 MP4를 생성했다. `/content` 등록과 검토 채널 `instagram-bot` 존재도 API 조회로 확인했다. 이후 사용자 지정 Gemini 키 연결과 소규모 JSON 생성 호출을 완료했다. 전체 콘텐츠 신규 생성·Discord 검토 메시지·Instagram 게시는 아직 실행하지 않았다.


2026-09-08 실제 생성 후속 점검: 승인된 Gemini 키를 운영 환경에 연결하고 텍스트·이미지·TTS 모델 접근을 확인했다. 작업 `8f90fa4a-a410-41dd-b9b4-55ac5c822a76`(풍선은 왜 머리카락에 달라붙을까?)으로 유료 생성 검증을 진행했다. 첫 두 실행은 원화 검수에서 중단되었고 Discord 실패 알림이 전송됐다. 스타일 참고 이미지의 주제를 실제 장면으로 평가하는 오류를 수정하고, 원화 수정 요청에 실패 후보를 함께 전달하도록 보완했다. 검수 응답은 단일 JSON 객체 스키마로 제한했다. 현재 적용 이미지는 `todari-ops-content:waenya-art-repair`; 앞선 코드 백업은 `waenyamyeon-backup-20260908-1305/pipeline-before-art-repair.py`다. 서버 기존 인스타툰 분기를 보존했고 관련 Python 테스트 6개 및 컨테이너 health check가 통과했다. 같은 작업의 세 번째 실행 결과는 아래에 기록한다. 실게시는 계속 비활성 상태다.

세 번째 실행 결과: 원화 8장 생성·자동 검수까지 통과했으나 연출 검증이 두 번 실패해 작업이 `failed`로 종료됐다. 저장된 응답을 로컬 검증기로 재검사한 결과 첫 응답은 허용되지 않은 색상명(`orange`/`teal`), 수정 응답은 화면 밖으로 나가는 callout 라벨 좌표가 원인이었다. 검증 기준은 완화하지 않았다. Discord 실패 알림은 전달됐으며, TTS·최종 MP4·완성본 검토 요청은 아직 생성되지 않았다. 작업의 총 실행 한도 3회에 도달하여 추가 유료 재시도는 하지 않았다. 후속 작업은 연출 JSON 제약과 라벨 배치 보정의 강화, 대본의 미시적 정전기 원인 및 습도 설명에 대한 사실 검토다. 키 연결/서버 정상 상태와 전체 자동 영상 제작 성공을 구분해야 한다.


2026-09-08 왜냐맨 3편 생성 배포: 사용자 요청에 따라 동일 서버 자동화로 응결·열전도 촉감·얼음 부력 3편을 제작한다. `why-three-20260908` 이미지에 왜냐맨 대본/주장-근거 연결/독립 사실 감사와 구조화 연출을 반영했다. 새 자동 영상은 question/tag/callout만 사용하고, 실제 글꼴 폭으로 제목·자막 및 고정 라벨을 배치하며 `왜냐맨. @whynyaman`을 합성한다. 기존 수동 에피소드 효과와 서버 인스타툰 분기는 유지했다.

적용 이미지 `todari-ops-content:why-three-20260908`, 릴리스 `/home/ubuntu/why-three-20260908`, 백업 `/home/ubuntu/why-three-backup-20260908` 및 이미지 `todari-ops-content:before-why-three`. 로컬 렌더러 Python 17개·자막 Node 회귀·타입 검사, ops 콘텐츠 22개·인스타툰 24개, 격리 배포 변형 12개 검증이 통과했다. EC2 사전 점검과 재기동 healthz가 정상이다. 첫 요청 `9808567a-05ad-4922-af41-4dd88dfeb3ec`을 운영 JobStore에 접수했다. 계정의 앱 설정 완료와 별개로 서버 게시 계정 연결은 아직 없으며, 게시 비활성 설정을 유지한다. 아래에 실제 제작 결과를 기록한다.

2026-09-08 후속 호환 수정: 적용 이미지 `todari-ops-content:why-three-render`(`087a2a8f8b258d69ec751216f49de95a28ff6d72ed1b0265449dc5c5097cce1c`), 배포 pipeline SHA-256 `f62c26abaf40af2ea8bb8aa155b8e3360887d95f08edf23379617faaadcc606d`. 대본 검수는 작업당 새 후보 3개와 입력 해시 기반 체크포인트를 사용한다. 원화 검수에는 승인된 현재 장면과 직전 수정 결과를 전달해 컵받침 추가/제거처럼 상반된 지시를 줄인다. 수정 요청은 실패 후보 한 장에 집중하며, 지적된 구도·배치는 바꾸고 올바른 사물 묘사는 보존한다.

연출 JSON은 실제 API에서 중첩된 분기 스키마가 HTTP 400으로 거부되어, 전송용 공통 속성 스키마와 내부 엄격 검증을 분리했다. 단순화한 전송 형식으로 EC2의 실제 원화 5장을 사용한 요청이 성공했고 결과가 기존 좌표·글자 수·정확한 필드·첫/끝 제목·중간 설명 검증을 통과했다. 전송 스키마 단순화가 내부 검증 완화를 의미하지 않는다. `auto_episode.py` SHA-256 `ea62a2a2c1574f7d08509fe13697ded15dbea483e93491877e976cbb578b6f9b`. 재기동 전후 실제 콘텐츠 Python(`/opt/content-venv/bin/python3`) 사전 점검, 운영 컨테이너의 렌더러 Python 19개·자막 회귀·타입 검사, pipeline/근거 수집 회귀 31개가 통과했다. 모든 실행 횟수와 실패 산출물은 초기화하지 않고 작업별 `previous-attempts/`에 보존한다.


2026-09-08 검수·복구 보완: 현재 적용 이미지는 `todari-ops-content:why-three-review`(`198570f5a3859850cdefa071e5c386c40052ba65c42e5a3cd7c26f25db55408f`), 격리 배포 pipeline SHA-256은 `0e28122df0427c57bc9f70763a3a5ae0fcb40e7434ab8caa75f2320e4c48dea6`이다. 최종 검수에 원화도 함께 전달하고 `final-review-inputs.json`에 입력 역할과 해시를 기록해, 코드가 합성한 정상 제목·설명 라벨을 원화에 그려진 금지 텍스트로 오인하지 않도록 했다. 완성본의 가독성·과학성·연속성 기준은 유지한다. 기존 원화는 현재 대본과 기준으로 다시 검수해 통과한 경우에만 재사용한다. EC2 사전 점검, 격리 pipeline/근거 수집 회귀 34개, 재기동 후 healthz 확인이 통과했다. 렌더러는 직전 검증한 동일 소스다.

응결 편은 실제 서버 MP4(1080×1920·30fps·47.253333초, SHA-256 `1dbf40657018c83effaf6932f1c1eb8ef7dd2306f37f33bfdf49b6541b2794ed`) 생성까지 완료했다. 여덟 번째 실행의 최종 검수는 컵·얼음 형태와 물방울·컵받침의 컷 간 연속성 문제로 탈락했다. 비교용 파일은 보존하며 게시 승인 상태로 바꾸지 않았다. 이 결과는 서버 렌더 가능성을 확인하지만 무인 제작 품질의 안정성을 입증하지 않는다.

2026-09-08 대본 일관성 보완: 얼음 편 네 번째 실행의 대본에 반복 화자 표기와 근거 없는 분자 간 반발 설명이 들어간 것을 사람이 확인해 해당 생성 프로세스를 중단했다. 왜냐맨 대본 요청에서 인스타툰 인용 대사 지시를 분리하고, 화자명·콜론이 실제 발화에 들어가는 경우를 코드로 차단했다. 얼음 입력 범위도 검증된 성긴 구조·부피·밀도 설명으로 다시 제한했다. 현재 이미지는 `todari-ops-content:why-three-narration`(`ee5fcc083cf080c6f37aa2ad35fb4e65cae13310c72467f95dfc3cfc649def51`), 격리 pipeline SHA-256은 `0c655141bc96b4a4dee89cc2f779bfa124d1aa66ee45197c7b73d443468d2e59`다. 로컬 관련 테스트 78개, 격리 및 실제 EC2 테스트 35개, 콘텐츠 사전 점검과 healthz가 통과했다. 완료된 두 MP4는 그대로 보존하고 얼음 작업만 다섯 번째 실행으로 재개했다. 앞선 실패 기록과 실제 실행 횟수를 유지한다.

2026-09-08 세 편의 실제 서버 생성 결과: 모두 1080×1920·30fps·H.264/AAC MP4가 생성됐고, 다운로드 파일과 서버 렌더 기록의 SHA-256이 일치한다. 렌더러·글꼴·설정 파일 16개의 해시는 세 편 모두 같고, 음성은 Gemini Charon이다. 아래 실행 횟수에는 원인 수정 뒤 사람이 재개한 횟수가 포함된다.

| 작업 | 주제 | 길이 | 누적 실행 | 최종 검수 |
|---|---|---:|---:|---|
| `9808567a-05ad-4922-af41-4dd88dfeb3ec` | 컵 겉면의 응결 | 47.3초 | 8회 | 미통과: 컵·얼음·물방울·컵받침의 컷 간 연속성 |
| `c4a72a8f-7bb8-4650-b4fa-354633628f2f` | 금속과 나무의 촉감 | 40.8초 | 5회 | 통과, `review` 상태 및 manifest 체크섬 확인 |
| `dd53acbe-034d-47ba-bfc0-2ebe2d4d97ce` | 얼음이 물에 뜨는 이유 | 46.5초 | 6회 | 미통과: 수면을 경계로 얼음이 두 조각처럼 보이는 묘사 |

얼음 편 여섯 번째 실행은 다섯 번째 대본 후보의 과장 표현에 대한 구체적인 편집자 피드백을 추가해 재개했다. 승인 상태를 수정하지 않고 사실·대본·원화·최종 검수를 다시 수행했다. 완성본 세 개는 `waenyamyeon/out/why-three-20260908/`의 비교 페이지·게시글·검수표·생성 증빙과 함께 보존했다. MP4 생성에 성공했지만 최종 품질 검수는 1/3만 통과했다. 특히 장면별 원화 검수와 전체 영상의 연속성·시각 정확성 판단 사이에 차이가 남아 있어, 완전 무인 운영의 안정성은 확보하지 못했다. 긴 자막이 48~56px 사이에서 달라지는 점도 추가 조판 개선 대상으로 확인했다. Instagram 게시와 승인 상태 강제 변경은 하지 않았다.

## 인스타툰 로컬 표지·말풍선 개선 — 2026-09-08

instatoon-studio v0.9의 `presentation: comic-v1`은 대본 다음에 원문 근거가 있는 표시 대사와 두 줄 표지를 계획·검수한다. `scripts/comic_presentation.py`가 글꼴·말풍선·얼굴 보호 영역을 조판하며, 최종 JPEG 순서는 cover.jpg, card-0.jpg부터의 본문이다. 최종 검수 수정 번호에 표지 오프셋을 적용하고 표지 결함은 본문 오수정 없이 중단한다. 화풍 검사에는 원본 화풍·원화뿐 아니라 회차 시트와 현재 컷 인물 정보를 전달한다. 원화가 없는 새 인물을 다른 원화 인물로 잘못 교정하지 않기 위해서다.

로컬 그림 생성·재조판의 상세 결과와 한계는 `../instatoon-studio/bible/comic-presentation-2026-09-08.md`가 정본이다. 이 변경은 서버에 배포하지 않았다. 검증은 `scripts`에서 `python3 -B -m unittest test_instatoon_quality test_instatoon_repair test_instatoon_presentation test_cast_library test_content_pipeline test_content_recovery test_content_science`로 수행한다.


## 인스타툰 전용 채널 접수 — 2026-09-08

사용자 요청으로 `인스타툰-스튜디오` 채널(ID `1546807040759037972`)을 생성했다. 일반 멤버의 열람을 차단하고 소유자와 봇에게 접근 권한을 부여했다. 채널 생성 외 메시지 전송·제작 접수·게시·배포는 하지 않았다.

로컬 구현은 `.env.content`의 `INSTATOON_CHANNEL_ID`가 가리키는 채널에서 소유자의 일반 메시지 한 건을 인스타툰 한 편으로 접수한다. 원문 전체와 대사를 보존하고 첫 줄 100자를 임시 주제로 사용한다. 봇·다른 사용자·DM·답글·스레드·시스템 메시지는 제작하지 않는다. 4,000자 제한과 기존 대기 5건 제한을 적용하며, 원본 Discord 메시지 ID를 작업에 저장하여 재수신·재시작 후 중복 생성을 막는다. 메시지를 수정해도 기존 제작 요청이 자동 수정되지는 않는다. `/content`는 기존 작업 상태 확인용으로 계속 지원한다.

실제 서버 반영 전이다. 배포 시 `INSTATOON_CHANNEL_ID=1546807040759037972`를 지정하고 봇과 instatoon-studio 최신 원화·렌더러를 함께 반영해야 한다. 생성 결과와 캡션은 같은 채널에서 검토한다. 승인 전 게시하지 않는다.

실행 중인 EC2 컨테이너 확인: `CONTENT_ENABLED=true`, 생성 키 있음, `CONTENT_PUBLISH_ENABLED=false`. `INSTATOON_IG_USER_ID`, `INSTATOON_IG_ACCESS_TOKEN`, `CONTENT_GRAPH_VERSION`, `CONTENT_S3_BUCKET`은 미설정이다. 따라서 현재 인스타툰 봇의 실제 게시가 가능하다고 볼 수 없다. 토큰 값은 읽어 출력하지 않고 설정 존재 여부만 확인했다.

검증: `pnpm typecheck`, `pnpm exec vitest run src/content` (21개 테스트) 통과. Discord 채널은 실제 생성했으나 일반 메시지 자동 접수와 인스타 게시의 운영 환경 검증은 아직 수행하지 않았다.


## 왜냐맨 과학 도식 개선본 — 2026-09-10

실제 EC2 JobStore/worker에서 응결(`2810b9eb-cb9c-4822-b280-2a0a4dbc4e57`, 48.7초), 금속/나무 열 전달(`835aaccb-7c7c-4126-bd2f-e2c293d9d5eb`, 47.7초), 얼음 밀도(`384dca2e-3bc5-4ba5-8f0f-0715c35c9027`, 44.4초)의 도식 MP4를 생성했다. 세 편 모두 1080×1920·30fps, Gemini Charon, 원본 대본/자막 일치 및 서버/로컬 SHA-256 일치를 확인했다. 음량은 -17.6~-16.5 LUFS다. 공통 색상·글꼴과 응결/열 전달 함수는 동일하고, 얼음의 점 배치와 표본을 저울에 올리는 동작만 최종 보완했다.

응결·열 전달은 자동 최종 검수 통과(`review`), 얼음은 `failed` 상태를 그대로 보존했다. 얼음의 마지막 탈락 사유는 mechanism 상자 하단과 괄호/글자 겹침인데, 확인한 원본 시작/후반 프레임과 고정 y 좌표에서는 겹침이 없다. 자동 검수가 점 개수·문자·프레임 사이 자막을 잘못 판단한 기록도 남아 있다. 이번 결과는 세 편의 서버 생성과 도식 개선을 입증하지만 무인 제작의 안정성을 입증하지 않는다. 실패 검수를 강제로 승인하거나 실행 횟수를 초기화하지 않았다. 누적 실행은 각각 1·4·6회이며, 이전 영상과 실패 기록을 보존했다.

검토 파일은 `../waenyamyeon/out/why-diagrams-final-20260910/comparison.html`, 상세 검증은 같은 폴더의 `verification.json`, `review.md`, `inspection-notes.json`, `renderer-scope-proof.json`이다. 현재 이미지는 `todari-ops-content:why-diagrams-ice-clarity`(`4bd48ab5e413fbb9412d216d61a11602e8316ffbe30177996b9ac1891af08410`), 배포 pipeline SHA-256은 `15b3338828b03a9c4b9645255c4a75e23b63d7e14c6bd9a913fc9ecc6a142b1f`다. 서버 기존 인스타툰 분기를 보존한 격리 소스를 배포했다.

로컬 콘텐츠 Python 52개, 격리/EC2 파이프라인·근거 검사 46개, 렌더러 Python 24개·Node 회귀·타입 검사와 실제 프리뷰 렌더가 통과했다. 비교 페이지의 PC/모바일 배치, 세 영상 동시 재생·정지·개별 음성 전환도 확인했다. 서버는 healthy이며 실행 중 작업은 없다. `CONTENT_PUBLISH_ENABLED=false`; Instagram 게시와 Git 커밋·푸시는 하지 않았다.

## 인스타툰 전용 채널·감정 연출 운영 적용 — 2026-09-11

EC2에 명령어 없는 전용 채널 접수와 인스타툰 v0.11 런타임을 적용했다. 채널 `1546807040759037972`의 소유자 일반 메시지만 접수하며, 메시지 ID로 중복을 방지한다. 인스타툰 전용 텍스트 모델은 `INSTATOON_TEXT_MODEL=gemini-3.8-flash`, 원화/복구는 `gemini-3.1-flash-image`다. 비밀 값은 로그에 남기지 않는다.

기존 과학 콘텐츠 동작을 보존하기 위해 서버의 원래 `content_pipeline.py`는 인스타툰 job만 별도 `instatoon_pipeline.py` 프로세스로 전달한다. 서버용 후자는 로컬 `scripts/content_pipeline.py`의 현재 스냅샷이다. `Dockerfile.content`는 두 파일을 모두 복사한다. 향후 인스타툰 수정 배포 시 별도 스냅샷도 갱신해야 한다. 로컬 전체 파이프라인을 서버 dispatcher 위에 덮어쓰지 않는다.

현재 이미지 `todari-ops-instatoon:20260911-r2`, digest `83cc3c40dd79efb5463b4804aea20b8b10dc44af4b8fd90b9871aec487486ecb`. 인스타툰 pipeline SHA-256 `7bc960e2a806142ff735acb22dda50cb15bc04b68f41dd61e87537d241a4dace`. 원본 및 환경 설정 백업은 서버 `/home/ubuntu/instatoon-release-20260911/backup`, 복원 목록은 `activation-files.json`, 복원 스크립트는 `rollback.py`다. 복원 뒤 `todari-ops-instatoon-base:20260911`을 `todari-ops-bot:latest`로 태그하고 compose로 재생성한다. 백업에는 비밀 설정이 있으므로 출력하지 않는다.

검증된 범위:
- 로컬 studio 34개, 콘텐츠 Python 57개, 콘텐츠 Vitest 21개 통과. `pnpm typecheck`, `pnpm build` 통과.
- EC2 실제 콘텐츠 Python의 사전 점검과 조판 테스트 17개 통과. 컨테이너 healthy. 재기동 직전 실행 중 작업 없음 확인.
- 실제 운영 모듈의 접수 함수에 합성 소유자 메시지를 전달해 queued 저장 및 중복 억제 확인. 실제 Discord 게이트웨이의 사용자 메시지 수신까지 확인한 것은 아니다.
- 로컬 자동 생성 후 검수 통과한 `late-message` 패키지를 provenance와 동일 해시로 서버 review 상태에 가져왔다. 서버 worker가 이미지 7장·review.html·캡션·버튼을 실제 채널에 전달했고 REST로 확인했다. 이는 서버 원화 생성의 E2E 증거가 아니라 실제 검토 전달 경로의 증거다.
- 검토 메시지: https://discord.com/channels/1498291933590585456/1546807040759037972/1547772498635137196
- job `c8eb49c9-6068-48bf-a52c-88f5f1c211b4`는 review이며 승인 해시를 만들지 않았다. 게시 버튼은 `계정 연결 후 게시 가능`으로 비활성화, 반려는 활성화돼 있다.

`CONTENT_PUBLISH_ENABLED=false`. 인스타툰 계정 ID/토큰, Graph 버전, 공개 이미지 저장소 설정이 없으므로 실제 Instagram 게시를 검증하지 못했다. 계정 확인과 연결 후 새 계정에 묶인 초안 검토→사용자의 게시 버튼→캡션/캐러셀 게시 검증이 남아 있다. 계정이 null인 기존 초안을 승인 완료 상태로 바꾸거나 강제 게시하지 않는다.

실제 다양한 이야기 생성 결과와 실패·재시도 비용은 studio의 `episodes/emotion-automation-review-20260911/` 및 `bible/automation-review-2026-09-11.md`를 참조한다. API 응답 사용량은 작업별 `api-usage/`에 기록한다. 응답 캐시 재사용은 새 API 비용으로 집계하지 않는다.

### 2026-09-11 로컬 실전 시험 후속

인스타툰 10개 원문으로 20회 생성·재시험을 수행했다. 첫 10회 자동 완료 4회/사람 검토 초안 수용 3회, v0.12 선별 재시험 7회 자동 완료 3회/초안 수용 1회다. 재시험은 캐시를 일부 재사용했으므로 전체 성공률 개선으로 해석하지 않는다. 표지 제목 충돌과 설명문 실측 배치의 최종 로컬 수정은 v0.12.1이며 전체 유료 재시험은 아직 하지 않았다.

`content_pipeline.py`의 변경은 아직 EC2에 배포하지 않았다. 기존 v0.11/r2와 science 분리 dispatcher를 유지한다. 이후 배포 시 로컬 모듈을 서버 `instatoon_pipeline.py`로 옮기는 경계를 지키고 science의 기존 `content_pipeline.py`를 덮어쓰지 않는다. Python scripts 157개와 deploy 5개 검증 통과. 상세 산출물은 형제 레포 `instatoon-studio/bible/automation-stress-test-2026-09-11.md` 및 비교 갤러리에 있다.

### 설명문 배치 후속 — 로컬 v0.13.2

설명문 컷도 세로 원화에 그린 사각 상자를 탐지·조판하도록 연결했다. 수정 프롬프트가 공간 지시를 삭제하는 순서 오류와 화풍 검수가 필요한 내레이션 상자를 거절하는 충돌을 수정했다. 3명 이상 인물 시트는 개별 생성·검수 후 비율을 보존해 별도 칸으로 배치한다. Studio `comic_presentation.py`와 함께 반영해야 하는 계약 변경이다. Python 검증은 Studio 50, Ops scripts 160 + deploy 5 통과. 추가 전체 생성 5회는 완주하지 못했으며, 단일 컷 시안·조판 재현·화풍 재검수와 구분한다. 서버는 계속 v0.11/r2이며 실험 버전을 배포하지 않았다. 상세: 형제 레포 `bible/automation-layout-repair-2026-09-11.md`.


### 2026-09-11 실전 준비 재검증 (0.15.2 후보)

운영 컨테이너는 교체하지 않았다. `todari-ops-instatoon:v0152-candidate`와 `/home/ubuntu/instatoon-release-v0152`에 후보를 준비했다. 현재 서버의 science dispatcher는 보존했고, 후보 Linux 환경의 일반 콘텐츠 및 인스타툰 전용 preflight(폰트·원화 해시·설명 상자·말풍선·표지·실제 렌더)가 통과했다. Python 226개, content TypeScript 26개, typecheck/build 통과. 후보 소스 해시와 로컬도 일치한다.

이 후보에는 생성 실패 후 원문으로 새 작업을 만드는 ‘같은 이야기 다시 제작’ 버튼이 있다. 중복 클릭/프로세스 재시작으로 작업이 중복 생성되지 않으며, 승인·게시 상태를 상속하지 않는다. 원본 실패 이력과 캐시는 보존한다. 게시 요청에는 자동 재시도를 추가하지 않았다.

최종 3편 회귀 시험은 자동 완료 1/3, 별도 이미지 검토 게시 적합 0/3이었다. 원화의 상자 크기·수평 분할선 문제와, 모델 검수가 놓친 소품 형태/피부색/명암 변화 때문에 운영 승격을 보류했다. Instagram 계정 ID/토큰 미연결, 게시 비활성 상태도 확인했다. 상세 정본: `../instatoon-studio/bible/release-readiness-2026-09-11.md`.
