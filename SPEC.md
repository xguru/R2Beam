# R2Beam 사양서

이 문서는 제품 범위, 요구사항, 제약의 기준 문서입니다. 결정이 바뀌면 즉시
갱신합니다.

## 0. 목적과 범위

R2Beam은 Cloudflare 계정만 있으면 개인이 설치해 사용할 수 있는 완결형 미디어
업로더입니다. 비공개 관리 화면에서 미디어를 브라우저 내 변환하고 R2에 저장해,
beebs 같은 외부 게시판에서 사용할 공개 링크를 제공합니다.

MVP 범위는 단일 소유자, 하나의 R2 버킷, 이미지·MP3·MP4, 최근 미디어 목록,
링크 복사 및 삭제입니다. 다중 사용자·사용량 할당량·서버 측 트랜스코딩은 제외합니다.

## 1. 주요 사용자 시나리오

- S1: 소유자가 Cloudflare Access로 로그인하고 이미지나 영상을 드롭해 게시판용 링크를 복사합니다.
- S2: 소유자가 원본과 최적화본을 함께 보관하고 필요에 따라 각각의 URL을 복사합니다.
- S3: 외부 게시판 방문자가 인증 없이 `/media/*` 파일을 표시하거나 재생합니다.
- S4: 설치자가 자신의 Cloudflare 계정과 R2 버킷에 앱을 배포합니다.
- S5: 새 버전이 있으면 일반 업데이트를 안내하고, 최소 지원 버전 미만이면 관리자 기능의 업그레이드를 요구합니다.

## 2. 입력 / 출력

### 2.1 입력

- 이미지: JPEG, PNG, GIF, WebP, AVIF, HEIC, HEIF, 최대 10MB
- 오디오: MP3, 최대 25MB
- 영상: MP4, 최대 90MB
- 인증: Cloudflare Access의 `TEAM_DOMAIN`, 애플리케이션 `POLICY_AUD`, RS256 JWT
- 저장 옵션: `both`, `optimized`, `original`

서버는 파일명이나 브라우저 MIME 선언 대신 파일 시그니처로 형식을 다시
검증합니다.

### 2.2 출력

- R2 객체 키: `<kind>/<YYYY>/<MM>/<DD>-<group UUID>-<variant>.<ext>`
- 공개 URL: `<worker-origin>/media/<object-key>`
- 삽입 코드: 이미지는 Markdown, 오디오와 영상은 HTML media 요소
- R2 custom metadata: 원본명, 업로드 시각, 종류, variant, group ID

## 3. 변환 프로필

### 이미지

- WebP, quality 78 우선
- WebP 인코딩 미지원 브라우저에서는 JPEG quality 78로 폴백하고, 투명 픽셀이 있으면 PNG로 폴백
- 긴 변 최대 960px, 비율 유지, 크롭·확대 없음
- EXIF 방향을 픽셀에 반영하고 재인코딩으로 메타데이터 제거
- 9:16 입력은 최대 540×960
- 움직이는 GIF/WebP/AVIF는 애니메이션 보존을 위해 원본 저장
- HEIC/HEIF는 브라우저 네이티브 디코딩을 우선하며, 미지원 환경에서는 원본 저장만 지원

### 영상

- MP4 / H.264 / yuv420p / CRF 29 / preset veryfast
- 긴 변 최대 960px, 비율 유지, 크롭·확대 없음, 짝수 크기
- 최대 30fps, 회전 반영 후 rotate metadata 제거
- AAC-LC 96kbps, Fast Start, metadata/chapter/subtitle/data 제거
- 9:16 입력은 최대 540×960

변환은 브라우저 Canvas와 ffmpeg.wasm에서 수행합니다. 서버에는 결과 파일만
전송되므로 별도 변환 서버 비용이 없습니다.

## 4. UX / API 요구사항

- `/`와 `/index.html`: 유효한 Cloudflare Access JWT가 있어야 업로더 UI 제공
- `GET /api/media/me`: 검증된 Access 사용자 정보
- `GET /api/media`: cursor 기반 R2 객체 목록
- `POST /api/media/upload`: multipart 업로드
- `POST /api/media/delete`: 같은 group의 최대 4개 객체 삭제
- `GET|HEAD /media/:key`: 공개 객체 응답, ETag·immutable cache·byte range 지원
- 중앙 설치기 `GET|HEAD /version.json`: 최신·최소 지원 버전과 설치기 URL, CORS 공개

업로더는 드래그앤드롭, 파일 선택, 클립보드 붙여넣기와 다중 파일 업로드를
지원합니다. 최적화본이 있으면 그것을 기본 링크로 사용합니다.

## 5. 고수준 파이프라인

1. 브라우저가 파일 종류와 저장 옵션을 판별합니다.
2. 이미지 Canvas 또는 ffmpeg.wasm이 필요할 때 최적화본을 생성합니다.
3. 원본 및/또는 최적화본을 인증된 API로 순서대로 전송합니다.
4. Worker가 시그니처·크기·group ID를 검증하고 R2에 스트리밍 저장합니다.
5. UI가 공개 URL 및 Markdown/HTML 삽입 코드를 클립보드에 복사합니다.

## 6. 보안 모델

- Cloudflare Access가 Cloudflare 계정, Google, GitHub, OTP 등 IdP 로그인을 담당합니다.
- Worker도 `Cf-Access-Jwt-Assertion`의 RS256 서명을 원격 JWKS로 검증합니다.
- `iss`는 `TEAM_DOMAIN`, `aud`는 `POLICY_AUD`와 일치해야 하며 `exp`와 `nbf`를 확인합니다.
- JWKS는 5분 캐시하고 알 수 없는 `kid`이면 한 번 새로 받아 키 회전을 처리합니다.
- 상태 변경 요청은 같은 Origin만 허용합니다.
- `/media/*`는 Access Bypass 및 Worker 공개 경로이고, 나머지 모든 경로는 인증 필수입니다.
- 객체명은 UUID 기반이며 디렉터리 순회와 임의 R2 key 접근을 차단합니다.
- UI에는 `noindex`; 공개 객체는 1년 immutable cache를 사용합니다.
- `DEV_AUTH_BYPASS`는 loopback hostname에서만 효력이 있습니다.
- 중앙 설치기의 OAuth 토큰은 만료되는 설치 세션에만 보관하고 설치 완료 후 폐기합니다.
- 버전 확인 요청은 인증 정보와 사용자·계정 식별자를 전송하지 않습니다.

Access 정책이 실수로 빠져도 Worker의 JWT 검증이 관리 화면과 API를 한 번 더
차단합니다. 반대로 `/media/*` Bypass 정책을 만들지 않으면 외부 게시판의 미디어
요청도 Access 로그인 화면으로 이동하므로 설치 검증에 반드시 포함합니다.

## 7. 플랫폼 및 제약

- Cloudflare Workers, Workers Static Assets, R2
- Node.js 20+, Wrangler 4
- Worker 요청 크기와 R2 요금은 사용자 Cloudflare 요금제 정책을 따릅니다.
- ffmpeg core 압축 파일은 약 10MB이고 첫 영상 변환 때 브라우저에서 내려받아
  약 32MB WASM으로 압축 해제합니다.
- 브라우저 메모리·CPU가 부족하면 영상 최적화가 실패할 수 있습니다. `both`
  모드에서는 원본만 저장하고, `optimized` 모드에서는 업로드하지 않습니다.
- Safari 등 `DecompressionStream` 미지원 환경에서는 영상 변환을 사용할 수 없습니다.
- R2 인터넷 egress 무료는 무제한 서비스 보장이나 전체 작업 무료를 뜻하지 않습니다.

## 8. 배포와 오픈소스 로드맵

`https://r2beam.xguru.net` 중앙 설치기가 Cloudflare OAuth 승인을 받아 다음 작업을
idempotent하게 수행합니다.

1. 전용 R2 버킷과 R2Beam Worker 생성 또는 갱신
2. 선택한 커스텀 도메인을 Worker Custom Domain으로 연결
3. 기존 Zero Trust 조직 조회 또는 새 조직 생성
4. 로그인 방식이 없으면 계정 구성원 전용 Cloudflare IdP 생성
5. `workers.dev`와 커스텀 도메인의 전체 애플리케이션에 설치자 이메일 Allow 정책 생성
6. 각 주소의 더 구체적인 `/media/*`에 Everyone Bypass 정책 생성
7. Worker의 `TEAM_DOMAIN`과 복수 `POLICY_AUD` secret 설정

중앙 버전 정책의 `latestVersion`보다 설치 버전이 낮으면 일반 업데이트 배너를 표시합니다.
`minimumVersion`보다 낮으면 관리자 업로드·삭제 UI를 차단하지만 `/media/*` 응답은 차단하지
않습니다. 정책 조회 실패는 fail-open으로 처리합니다.

사용자는 Cloudflare 계정과 권한을 확인한 뒤 설치만 실행합니다. 일부 단계가 실패해도
같은 계정과 리소스 이름으로 재실행할 수 있습니다. 중앙 설치기 소스는 저장소의
`installer/`에 포함합니다. 다음 개선 후보는 저장량 soft quota입니다.

## 9. 미해결 질문

- 월 업로드 soft quota와 알림을 앱 자체 기능으로 제공할지 여부
- 다중 사용자 모드를 별도 에디션으로 둘지 여부
