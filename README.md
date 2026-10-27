# Replay

유튜브에 모아둔 플레이리스트를 유튜브에 들어가지 않고 바로 재생하는 나만의 음악 플레이어.

- 구글 로그인으로 내 유튜브 플레이리스트, 좋아요 표시한 동영상 불러오기
- 셔플, 전체 반복, 한 곡 반복, 다음 곡 목록
- 앱 안에서 새 플레이리스트 만들기, 노래 검색하거나 링크 붙여넣어 담기 (유튜브 계정은 건드리지 않음)
- 유튜브 프리미엄 계정으로 재생해서 광고 없음 (윈도우 앱은 "유튜브 프리미엄 연결"로 한 번 로그인)
- 곡 검색은 내 계정과 연결되지 않아 검색 기록이 추천에 섞이지 않음
- 재생할 수 없는 영상은 자동으로 건너뛰기
- 곡 목록은 Supabase에 저장 (본인 데이터만 보이도록 RLS 적용)

## 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 뼈대 |
| `style.css` | 디자인 |
| `app.js` | 로그인, 유튜브 불러오기, 플레이어 |
| `config.js` | Supabase 주소와 공개 키 |
| `supabase/schema.sql` | DB 테이블과 보안 규칙 |
| `supabase/functions/yt-search` | 곡 검색 서버 함수 (API 키는 Supabase 비밀값에 보관) |

빌드 과정 없이 GitHub Pages에서 그대로 돌아가요. 처음 설정은 [SETUP.md](SETUP.md)를 보세요.

## 내 컴퓨터에서 실행

```bash
python3 -m http.server 8000
# http://localhost:8000 접속 (Supabase Redirect URLs에 http://localhost:8000/ 추가 필요)
```
