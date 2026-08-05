# Agent Guide

이 저장소는 SPEC 중심 워크플로우를 사용합니다. 공개 문서를 최신으로 유지합니다.

## Scope

- 이 파일은 저장소 전체에 적용됩니다. 하위 `AGENTS.md`가 있으면 그 파일이 우선합니다.
- 사용자와의 대화는 존댓말로 합니다.

## Ground Truth Docs

- `SPEC.md` — 제품 범위, 요구사항, 제약의 기준 문서. 결정 변경 시 갱신합니다.
- `README.md` — 설치자가 그대로 따라 할 수 있는 공개 사용 설명서입니다.

## Run & Validate

```bash
npm install
cp .dev.vars.local.example .dev.vars
npm run dev

npm test
npm run build
npm run check
```

- `public/vendor/ffmpeg/`는 생성물이며 직접 수정하거나 커밋하지 않습니다.
- 브라우저 코드는 `public/app.js`, Worker는 `src/index.js`, 순수 함수는
  `src/media.js`에 둡니다.
- 실제 배포 전 `npm run check`와 로컬 로그인→업로드→Range GET→삭제 흐름을 검증합니다.

## Outputs

- `public/` — Workers Static Assets 및 빌드된 ffmpeg 브라우저 자산
- `src/` — Worker API, 인증, R2 공개 객체 라우팅
- `.wrangler/` — 로컬 R2와 dry-run 산출물; 커밋하지 않음

## Approval / Prompts

- 공식 `xguru/R2Beam` 저장소는 사용자가 승인할 때 public으로 생성합니다.
- 외부 저장소 생성·push·실서비스 배포는 사용자 승인 범위를 확인합니다.
- `.dev.vars`, Access audience/team 설정, Cloudflare 자격 증명은 절대 커밋하지 않습니다.
- 초기 커밋 메시지 기본값은 `Initial scaffold and UI`입니다.

## Editing Rules

- 변경은 최소 단위로 작업 범위에 집중합니다.
- API·변환 프로필·보안 경계 변경 시 `SPEC.md`와 `README.md`를 함께 검토합니다.
- 업로드 형식은 확장자가 아니라 magic bytes 검증을 유지합니다.
- `/media/*` 공개 경로는 Range, ETag, Content-Type, immutable cache를 보존합니다.

## Next Steps

- 설치된 R2Beam의 버전 확인 및 안전한 업그레이드 흐름
- 커스텀 도메인 충돌과 장시간 인증서 지연의 복구 안내
- 브라우저 변환 통합 테스트 자동화
