# 토다툰 부분 수정 안전성 보완

## 상태

2026-09-21 로컬 구현·검증 완료. 커밋·푸시·운영 배포·유료 재생성·실제 Instagram 게시 없음. 기존 dirty 변경은 보존했다. 운영 버전은 [직전 핫픽스](todatoon-source-hotfix-2026-09-21.md)이며 이번 보완은 아직 포함하지 않는다.

## 변경

- 수정 대상은 첫 줄 `수정 대상: 6컷`으로만 지정하고 다음 줄의 비교 기준 번호는 무시한다. 실행 전 대상·비용 확인 버튼과 취소 버튼을 제공한다. 최신 요청 토큰만 1회 소비한다.
- 첫 변경 전 원화·조판 계획·manifest·미리보기를 `revision-backups/<revisionId>/`에 복사하고 파일 해시를 보존한다. job/승인/게시 receipt와 API 사용 기록은 복원하지 않는다.
- 선택 컷만 재생성하며 최종 자동 보정도 같은 범위로 제한한다. 비선택 컷 대본·조판·원화·JPEG가 바뀌면 실패 후 원복한다.
- `comparison.html`은 이전/이후 이미지를 내장하고 입력 문구를 escape한다. 문서와 이미지는 별도 메시지로 보내 첨부 10개 제한을 지킨다.
- `원복 대상: 6컷`은 직전 백업의 해당 컷 원화·계획을 복구하고 전체 재검수한다. 이미지 재생성은 없지만 AI 검수 비용이 발생한다. 실패 초안의 해당 컷 또는 전체 실패로의 원복은 거부한다.
- 수정 실패·서버 재시작은 `recovering` → 백업 검증·복구 → 새 검토 메시지. 복구 실패나 revisionId 없는 기존 중단 작업은 게시 불가로 닫는다. 동일 해시라도 옛 Discord 메시지 승인 버튼은 재활성화되지 않는다.
- 해당 수정 스레드의 재제작 버튼을 허용하되 새 작업의 결과 채널은 부모 채널로 유지한다. 접수 이후 Discord 응답 실패를 작업 거절로 잘못 알리지 않는다.

## 검증

- `DOTENV_CONFIG_PATH=/dev/null pnpm test`: 29파일, 186개 통과 (content 40개 포함).
- `pnpm typecheck`, `pnpm build`: 통과.
- `/Users/lth/miniforge3/bin/python3 -B -m unittest discover -s scripts -q`: 202개 통과.
- 같은 Python으로 `unittest discover -s deploy -q`: 5개 통과.
- 실제 저장된 `비상식량의 주인` 이전/이후 계획·JPEG로 검사: 대상 `[5]`(6컷만)이면 원치 않은 5컷 변경을 거부하며, `[4,5]`면 변경 범위가 일치한다. 임시 복사본으로 검사해 운영 산출물은 바꾸지 않았다.
- 대상 분리·확인/취소·오래된 토큰·중복 클릭·실패와 재시작 복원·복구 실패 차단·이전 승인 메시지 거부·심볼릭 링크/경로/백업 무결성·비교 HTML·최종 자동보정 범위를 회귀 검증했다.

## 운영 반영 전 남은 일

1. 배포 요청을 받은 뒤 현재 운영 파일 기준으로 이번 변경만 이식한다. 로컬에는 기존 9컷 확장·재시도 예산 등 다른 미배포 변경이 있으므로 통째로 배포하지 않는다. TS content index/store와 Python pipeline + 새 `content_revision.py`가 함께 필요하며 `Dockerfile.content`에도 새 모듈 COPY를 추가했다.
2. 활성 생성/수정/게시 작업이 없는 상태에서 교체하고, 새 Discord 대상 확인/취소/확인·전후 비교·원복·새 승인 흐름을 실제 검증한다. 모의 테스트를 실제 E2E 완료로 간주하지 않는다.
3. 기존 작업 `28ba87cb-328a-4e54-bb71-c9751e205a6b`의 5컷 원본 복구는 별도다. `review-before/`에는 JPEG와 계획만 보존되어 있어 새 snapshot 기능으로 바로 원복할 수 없다. 서버 `revision-0-4-repair-input-0.png`가 수정 전 원화인지 원본 JPEG 재현으로 검증하고 조판 계약을 맞춘 뒤 복구·전체 재검수·새 승인 요청을 발급한다. 아직 수행하지 않았다.
4. 완성본 사용자 확인 전 실제 게시 금지. 현재 운영 해시 `32d2df1b178f91cfde21e434`의 원치 않은 5컷 수정 상태를 승인하지 않는다.

백업은 현재 자동 GC가 없어 반복 수정 시 디스크 사용이 증가한다. API 사용 기록/캐시는 유지하지만 실패 후보별 원화 보관은 이번 범위에 넣지 않았다.

## 2026-10-01 운영 반영

- 릴리스 `/home/ubuntu/releases/todatoon-20261001-revision-safety`, 이미지 `todari-ops-content:todatoon-20261001-revision-safety`(`cd4eb6f7b5c8`). 9/14 운영 src에 로컬 `src/content/*.ts`만 덮어 이미지 안에서 tsc 빌드, `content_pipeline.py`·`content_revision.py` 교체. 함께 반영: 9컷 확장, 재시도 예산(6회/전체 4회), 인스타툰 캡션 끝 브랜드 공통 마무리 자동 추가(`publish_caption`).
- 로컬 검증: vitest 186개(부하로 `--testTimeout=120000`), Python 203개 통과. 새 이미지에서 모듈 import·dist 로드 확인. 교체 전 활성 작업 0개, 교체 후 healthz 4개 항목 healthy·Discord 로그인 확인.
- 재시작: `bash /home/ubuntu/releases/todatoon-20261001-revision-safety/operate.sh up -d --no-build --wait --wait-timeout 180`. 롤백: 같은 명령을 `todatoon-20260921-source-hotfix/operate.sh`로.
- 28ba87cb 5컷 복구 준비: `art-4-attempt-0.png`(수정 입력본과 SHA 동일)를 원화로, `review-before/production-plan.json`의 5컷 계획(수정 후와 동일)을 넣은 백업 `revision-backups/aee1677d-9f0f-471f-ba51-f8c88dac89fc`를 만들고 job `lastRevisionBackup`에 등록했다. 컨테이너에서 `checked_snapshot` 무결성 통과. 원본 `accepted-art-4.json`은 없어 백업에서 제외했다(원복 시 삭제되며 최종 검수가 전체를 다시 본다).
- 남은 일: 수정 스레드에 `원복 대상: 5컷` → 확인 버튼 → 전체 재검수·새 승인 메시지 → 사용자 확인 후 게시. 실제 Discord E2E는 아직 미검증.
