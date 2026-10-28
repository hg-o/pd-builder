# byUs 각색 기획안 Builder

로그인 · ID 등록/권한 신청 · 권한 대기 · 메인 화면으로 구성된 웹 앱입니다.
사용자 데이터는 Google 스프레드시트에 저장됩니다.

- 시트: https://docs.google.com/spreadsheets/d/1bkeTv7isOVdy3TDpa7kkM2L2GDhJO73NaLdKwvXlw64/edit?gid=0#gid=0
- 컬럼: `name | ID | password | permission | activate`

두 가지 배포 방식을 지원하며, 프론트엔드(`index.html`)는 한 파일로 양쪽에서 그대로 동작합니다.

| 방식 | 프론트엔드 | 백엔드 | 접근 범위 |
| --- | --- | --- | --- |
| **GitHub + Vercel (권장)** | `public/index.html` | `api/*.js` 서버리스 함수가 서비스 계정으로 시트에 직접 읽기/쓰기 | 누구나 URL 접속 가능. 사이트 로그인 + 관리자 `activate` 승인으로 통제 |
| Apps Script 웹 앱 | `apps-script/Index.html` | `apps-script/Code.gs` (`google.script.run`) | 조직 정책상 회사 Google 계정 사용자만 |

## 폴더 구조

```
.
├── public/
│   └── index.html          # 프론트엔드 전체 (로그인, 권한 신청 모달, 대기 화면, 메인 화면, 다크 모드)
├── api/                    # Vercel 서버리스 함수 (Node 18+)
│   ├── register.js         # POST /api/register  { name, id, password, permission }
│   ├── login.js            # POST /api/login     { id, password }
│   └── status.js           # POST /api/status    { id }
├── lib/
│   ├── sheets.js           # Google Sheets API 접근 (서비스 계정 JWT)
│   └── http.js             # 응답 형식, 본문 파싱, 검증 규칙
├── apps-script/            # Apps Script 배포용 사본 (Code.gs + Index.html + appsscript.json)
├── package.json            # 의존성: google-auth-library
├── vercel.json             # 정적 출력 디렉터리(public), 함수 설정
├── .env.example            # 필요한 환경 변수 목록
└── .gitignore
```

## 1. Google 서비스 계정 준비 (Vercel 방식에 필요)

Vercel 함수가 시트에 접근하려면 서비스 계정이 필요합니다.

1. https://console.cloud.google.com → 프로젝트 선택(또는 새로 만들기)
2. **API 및 서비스 → 라이브러리** → "Google Sheets API" 검색 → **사용 설정**
3. **IAM 및 관리자 → 서비스 계정 → 서비스 계정 만들기** (이름 예: `byus-builder`) → 역할은 비워 두고 완료
4. 만든 서비스 계정 → **키** 탭 → **키 추가 → 새 키 만들기 → JSON** → 다운로드
5. 스프레드시트 **공유** → 서비스 계정 이메일(`…@….iam.gserviceaccount.com`)을 **편집자**로 추가
6. JSON 파일에서 `client_email` 과 `private_key` 값을 다음 단계의 환경 변수에 사용합니다. JSON 파일 자체는 저장소에 올리지 마세요.

## 2. GitHub 에 올리기

```bash
git init
```

```bash
git add .
```

```bash
git commit -m "byUs 각색 기획안 Builder: 프론트엔드 + Vercel API + Apps Script 백업"
```

GitHub 에서 빈 저장소를 만든 뒤:

```bash
git remote add origin https://github.com/<계정>/<저장소>.git
```

```bash
git push -u origin main
```

`.gitignore` 가 `.env`, `node_modules`, 서비스 계정 JSON 을 제외합니다.

## 3. Vercel 배포

1. https://vercel.com → **Add New → Project** → GitHub 저장소 Import
2. Framework Preset 은 **Other** 그대로 두면 됩니다 (`vercel.json` 이 `public/` 을 정적 출력으로 지정)
3. **Environment Variables** 에 아래 값을 추가 (Production / Preview 모두)

| 이름 | 값 |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | 서비스 계정 이메일 |
| `GOOGLE_PRIVATE_KEY` | 키 JSON 의 `private_key` 값 전체 (`-----BEGIN PRIVATE KEY-----` 부터 끝까지, `\n` 포함 그대로) |
| `SHEET_ID` | `1bkeTv7isOVdy3TDpa7kkM2L2GDhJO73NaLdKwvXlw64` |
| `SHEET_NAME` | `시트1` |
| `HASH_PASSWORDS` | `false` (해시 저장을 원하면 `true`) |

4. **Deploy** → 발급된 `https://<프로젝트>.vercel.app` 이 사이트 주소입니다.
5. `public/index.html` 상단의 `SERVICE_URL` 을 이 주소로 바꿔 커밋하면, 정적 미리보기 배너가 Vercel 주소를 가리킵니다.

이후에는 `main` 브랜치에 push 할 때마다 자동으로 재배포됩니다.

### 로컬 실행

```bash
npm install
```

`.env.example` 을 `.env` 로 복사해 값을 채운 뒤:

```bash
npx vercel dev
```

## 동작 흐름

- **로그인**: ID/PW 가 시트와 일치하면 로그인. `activate` 가 `TRUE` 가 아니면 "권한 부여 대기 중입니다." 화면만 표시됩니다.
- **ID 등록 및 권한 요청**: 이름(16자 이내) · 아이디(영문/숫자/기호, 16자 이내) · 비밀번호(영문/숫자/기호, 8자 이상) · 권한(Admin/Editor/Viewer) 모두 필수. 비거나 기준 미달이면 해당 입력창이 붉게 표시되고 "필수 문항 작성이 필요합니다." 가 하단에 뜹니다. 프론트와 서버가 같은 규칙으로 두 번 검증합니다. 통과하면 시트에 한 행이 추가되고 `activate` 는 비어 있습니다.
- **권한 부여**: 관리자가 시트에서 `activate` 를 `TRUE` 로 바꾸면 그 순간부터 로그인 시 메인 화면이 열립니다. 대기 화면의 "권한 상태 다시 확인" 으로도 즉시 반영됩니다.
- 중복 아이디는 거절됩니다(대소문자 무시).

API 응답 형식은 양쪽 백엔드가 동일합니다: `{ ok: true, data }` 또는 `{ ok: false, error, fields }`.

## Apps Script 방식 (백업 / 회사 계정 전용)

- 프로젝트: https://script.google.com/home/projects/1VXFq-WizuHlb3E2-sGvXERtUcdNky1NNJzStHdECjugqDzhtx1GiZQCJ/edit
- 웹 앱 URL (버전 1): https://script.google.com/a/macros/webtoonscorp.com/s/AKfycbxRjyLtiKvCX5lc_ikY_1xMuOjsuYotbLPIcvK__iAr2VqA5_mx6IvooagPEMGPTHomsg/exec
- 액세스: 네이버 주식회사의 모든 사용자 (조직 정책상 익명 공개 불가)
- 코드를 바꾼 뒤에는 `apps-script/` 의 파일을 편집기에 붙여 넣고 **배포 → 배포 관리 → 새 버전** 으로 갱신해야 `/exec` 에 반영됩니다.
- Vercel 프론트엔드에서 이 웹 앱을 호출하는 구성은 **불가능**합니다. 조직 외부 요청은 Google 로그인 페이지로 리디렉션되기 때문입니다.

## 참고

- 비밀번호는 요구사항대로 평문 저장이 기본입니다. 시트 공유 범위를 관리자와 서비스 계정으로만 한정하세요. `HASH_PASSWORDS=true` 로 바꾸면 SHA-256 해시로 저장/비교합니다.
- 로그인 상태는 브라우저 `sessionStorage` 에만 보관되며 탭을 닫으면 사라집니다.
- 시트 탭 이름이 바뀌면 `SHEET_NAME` 환경 변수(또는 `Code.gs` 의 `SHEET_NAME`)를 함께 바꾸세요.
