# 원클릭 설치 서비스

`https://r2beam.xguru.net`은 Cloudflare 공개 OAuth를 이용해 사용자의 계정에
R2Beam을 설치합니다. 사용자가 API Token이나 Account ID를 복사할 필요가 없습니다.

## 처리 흐름

1. 설치기가 Authorization Code + PKCE 로그인을 시작합니다.
2. Cloudflare 동의 화면에서 사용자가 계정과 제한된 권한을 승인합니다.
3. 설치기는 20분짜리 KV 세션에 접근 토큰을 보관합니다.
4. 설치 대상 계정의 활성 Zone을 조회하고 선택적 커스텀 도메인을 검증합니다.
5. 사용자가 확인한 계정에 R2 버킷, Worker와 Access 정책을 생성합니다.
6. 커스텀 도메인이 있으면 Worker Custom Domain, 인증서와 별도 Access 정책을 구성합니다.
7. 최종 주소가 Access 로그인으로 보호되는지 최대 약 11초 동안 확인합니다.
8. 앱의 정적 자산은 사용자 R2의 `_r2beam/assets/` 예약 경로에 복사됩니다.
9. 설치 완료 후 OAuth 토큰과 설치 세션을 폐기합니다.

설치 이후 관리자 요청, 업로드와 공개 미디어 전송은 중앙 설치기를 거치지
않습니다. 설치기 장애가 이미 설치된 R2Beam에 영향을 주지 않습니다.

## 중앙 설치기 배포

Cloudflare OAuth Client에는 다음 값을 사용합니다.

- Client URL: `https://r2beam.xguru.net`
- Redirect URL: `https://r2beam.xguru.net/oauth/callback`
- Grant: Authorization Code
- PKCE: S256
- 공개 범위: `workers-r2.write`, `workers-scripts.write`, `access.write`, `zone-access.write`,
  `access-acct.write`, `account-settings.read`, `user-details.read`, `zone.read`

OAuth Client ID는 환경 변수, Client Secret은 Worker secret으로 설정합니다.
`INSTALL_SESSIONS` KV에는 만료 시간이 있는 OAuth state와 설치 세션만 저장합니다.

## 커스텀 도메인

설치 화면의 커스텀 도메인은 선택 사항입니다. 설치기는 OAuth로 조회한 활성 Zone 중
설치 대상 계정에 속하면서 입력 호스트 이름의 접미사와 일치하는 Zone만 허용합니다.
검증이 끝나면 Worker Custom Domain API로 호스트를 연결합니다. Cloudflare가 DNS와
인증서를 관리하므로 사용자가 별도의 CNAME을 만들 필요는 없습니다. 같은 호스트가
다른 Worker에 연결되어 있으면 덮어쓰지 않고 설치를 중단합니다.

기본 `workers.dev` 주소는 계속 활성 상태로 남습니다. 설치기는 기본 주소와 커스텀
주소에 각각 관리자 애플리케이션과 `/media/*` Bypass 애플리케이션을 만들고, 두 관리자
애플리케이션의 Audience를 Worker에 함께 저장합니다.
