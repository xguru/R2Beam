# Cloudflare Access 설정

R2Beam은 관리자 화면과 API를 Cloudflare Access로 보호하고, 게시판에 삽입되는
`/media/*`만 공개합니다. `https://r2beam.xguru.net` 중앙 설치기가 이 구성을
사용자의 Cloudflare 계정에 자동으로 만듭니다.

## 자동 구성 항목

- 기존 Zero Trust 조직 사용 또는 새 조직 생성
- 로그인 방식이 없으면 Cloudflare 계정 로그인을 생성하고 계정 구성원으로 제한
- `<worker>.<account>.workers.dev`: 설치자 이메일만 Allow
- `<worker>.<account>.workers.dev/media/*`: Everyone Bypass
- 선택한 `<custom-host>`: 설치자 이메일만 Allow
- 선택한 `<custom-host>/media/*`: Everyone Bypass
- Worker secret `TEAM_DOMAIN`, `POLICY_AUD`

커스텀 도메인을 선택해도 복구용 `workers.dev` Access 애플리케이션은 유지합니다.
Worker는 쉼표로 구분해 저장한 두 관리자 애플리케이션의 Audience를 모두 검증합니다.

Google 또는 GitHub 로그인이 필요하면 설치 후 Zero Trust → Integrations → Identity
providers에서 추가할 수 있습니다. R2Beam은 기존 로그인 방식이 있으면 변경하지
않습니다.

## 설치와 복구

1. `https://r2beam.xguru.net`에서 Cloudflare 로그인을 시작합니다.
2. 설치할 계정과 요청 권한을 확인하고 승인합니다.
3. 기본 Worker와 R2 버킷 이름을 확인하고, 필요하면 커스텀 도메인을 입력합니다.
4. 설치합니다.
5. 완료 화면에서 **내 미디어 볼트 열기**를 선택합니다.

설치는 같은 계정과 리소스 이름으로 다시 실행할 수 있습니다. 기존 R2 버킷과 Access
애플리케이션은 재사용하고 R2Beam 정책 및 Worker 배포를 갱신합니다. 이메일을 잘못
선택했거나 정책을 직접 변경해야 한다면 Zero Trust → Access controls → Applications
→ R2Beam에서 `R2Beam owner` 정책을 수정하세요.

## 완료 확인

- 로그아웃 또는 시크릿 브라우저에서 `/` 접속 → Access 로그인 화면
- 허용 계정 로그인 → 업로더와 최근 미디어 표시
- `/media/<existing-key>` → 로그인 없이 200
- 영상 URL에 Range 요청 → 206 Partial Content
- 로그아웃 버튼 → `/cdn-cgi/access/logout`을 거쳐 세션 종료

## 참고

- [Cloudflare identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/)
- [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- [Access JWT 검증](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
