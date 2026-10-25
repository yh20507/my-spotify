# Replay 설정 안내

처음 한 번만 하면 돼요. 15분 정도 걸려요.

- 사이트 주소: https://yh20507.github.io/my-spotify/
- Supabase 프로젝트: `my-spotify` (`https://gctesmvvacfcgqllziga.supabase.co`)

## 1. GitHub Pages 켜기

1. https://github.com/yh20507/my-spotify/settings/pages 접속
2. **Source**: `Deploy from a branch`
3. **Branch**: `main`, 폴더 `/ (root)` 선택 후 **Save**
4. 1~2분 뒤 https://yh20507.github.io/my-spotify/ 가 열리면 완료

## 2. Google Cloud 설정 (유튜브 읽기 권한)

1. https://console.cloud.google.com 접속 → 위쪽 프로젝트 선택 → **새 프로젝트** → 이름 `my-spotify` → 만들기
2. **YouTube API 켜기**: https://console.cloud.google.com/apis/library/youtube.googleapis.com → **사용**
3. **OAuth 동의 화면** (메뉴: Google 인증 플랫폼 / OAuth consent screen)
   - 앱 이름: `Replay`, 사용자 지원 이메일: 내 이메일
   - 대상(User type): **외부(External)**
   - **테스트 사용자**에 유튜브를 쓰는 내 구글 계정 추가 (중요! 여기 등록된 계정만 로그인돼요)
   - 데이터 액세스(범위)에 `https://www.googleapis.com/auth/youtube.readonly` 추가
4. **OAuth 클라이언트 만들기** (메뉴: 클라이언트 / Credentials → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID)
   - 애플리케이션 유형: **웹 애플리케이션**
   - 승인된 자바스크립트 원본: `https://yh20507.github.io`
   - 승인된 리디렉션 URI: `https://gctesmvvacfcgqllziga.supabase.co/auth/v1/callback`
   - 만들기 → 나오는 **클라이언트 ID**와 **클라이언트 보안 비밀번호**를 복사해두기

## 3. Supabase에 구글 로그인 연결

1. https://supabase.com/dashboard/project/gctesmvvacfcgqllziga/auth/providers 접속
2. **Google** 펼치기 → 켜기 → 위에서 복사한 클라이언트 ID, 보안 비밀번호 붙여넣기 → **Save**
3. https://supabase.com/dashboard/project/gctesmvvacfcgqllziga/auth/url-configuration 접속
   - **Site URL**: `https://yh20507.github.io/my-spotify/`
   - **Redirect URLs**에 `https://yh20507.github.io/my-spotify/` 추가

## 4. 처음 로그인

1. https://yh20507.github.io/my-spotify/ 에서 **구글로 로그인**
2. "Google에서 확인하지 않은 앱" 화면이 나오면 **고급 → Replay(으)로 이동** (내가 만든 앱이라 괜찮아요)
3. 유튜브 읽기 권한 허용 → 불러올 플레이리스트 선택

## 알아두면 좋은 것

- 유튜브 연결은 로그인 후 약 1시간 동안 유효해요. 그 뒤에 불러오기나 다시 맞추기를 누르면 자동으로 다시 로그인 화면을 거쳐요. **재생은 연결이 끊겨도 계속 돼요.** (곡 목록은 Supabase에 저장돼 있으니까요.)
- 유튜브에서 곡을 추가·삭제했다면 플레이리스트 화면의 새로고침 아이콘(유튜브와 다시 맞추기)을 눌러주세요.
- 일부 공식 뮤직비디오는 외부 사이트 재생을 막아둬서 자동으로 건너뛰어요.
- 휴대폰에서는 화면이 꺼지거나 다른 앱으로 가면 재생이 멈춰요. (유튜브 정책)
- "나중에 볼 동영상"은 유튜브가 외부에 공개하지 않아서 불러올 수 없어요.
