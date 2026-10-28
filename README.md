# byUs 각색 기획안 Builder

로그인 · ID 등록/권한 신청 · 권한 대기 · 메인 화면으로 구성된 웹 앱입니다.
관리자는 지금처럼 **Google 스프레드시트**에서 사용자를 관리합니다(`activate` 를 `TRUE` 로 바꾸면 승인).

- 시트: https://docs.google.com/spreadsheets/d/1bkeTv7isOVdy3TDpa7kkM2L2GDhJO73NaLdKwvXlw64/edit?gid=0#gid=0
- 컬럼: `name | ID | password | permission | activate`

## 구조 (Google Cloud 불필요)

```
사용자 브라우저 ──► Vercel (public/index.html + api/*.js) ──► Upstash Redis (사용자 저장소)
                                                   ▲
                                 1분마다 /api/sync  │  (회사 계정으로 실행, 조직 내부)
                                                   │
                              Apps Script (syncWithVercel) ◄──► Google 스프레드시트 (관리자 화면)
```

- 가입/로그인은 Vercel 함수가 **Upstash Redis** 에서 즉시 처리합니다.
- **Apps Script** 가 1분마다 시트 전체를 Vercel 로 보내고, 시트에 없는 신규 가입자를 받아 시트에 추가합니다.
- 시트가 기준입니다. 시트에서 `activate` 나 `permission` 을 바꾸면 다음 동기화(≤1분)에 반영되고, 행을 지우면 계정이 삭제됩니다.
- 회사 Workspace 정책상 Google Cloud 프로젝트를 만들 수 없어 서비스 계정 대신 이 구조를 씁니다. Apps Script 웹 앱(회사 계정 전용)도 백업 경로로 그대로 동작합니다.

## 로그인 이후 화면 (IP 관리)

- **Home → 나의 담당 작품**: 등록된 IP 중 담당자에 로그인한 사용자가 포함된 것만 표시. 우측 상단 **[+ 새 IP 추가]** 를 누르면 담당자에 내 이름이 기본 선택된 모달이 열립니다.
- **Title**: 전체 IP 를 가로형 카드(1:1 썸네일 · IP명 · 담당자 여러 명 · 진행 사항)로 표시. 카드를 누르면 수정/삭제 모달.
- 등록된 IP 가 없으면 `아직 등록된 IP가 없어요.` 만 표시됩니다.
- **IP 모달**: 썸네일 업로드 / 바꾸기 / 삭제 (브라우저에서 1:1 중앙 크롭 후 320px JPEG 로 축소해 저장), IP명(24자 이내, 필수), 담당자(승인된 Admin·Editor 중 다중 선택), 진행 사항(시작 전 · 전략 기획 · 각색 기획 · 프롬프트 작성 · QA · byUs 정식 론칭).
- IP 추가/수정/삭제는 Admin·Editor 만 가능하고, Viewer 는 조회만 할 수 있습니다.
- 로그인 시 발급되는 세션 토큰(12시간, Redis `session:*`)으로 IP API 를 보호합니다. 만료되면 로그인 화면으로 돌아갑니다.
- IP 데이터는 Redis(`title:*`, `titles`)에만 저장되며 시트와 동기화되지 않습니다. Apps Script 웹 앱(백업 경로)에서는 IP 관리 기능을 쓸 수 없습니다.

## 폴더 구조

```
.
├── public/index.html       # 프론트엔드 전체 (Vercel / Apps Script 양쪽에서 동작)
├── api/
│   ├── register.js         # POST /api/register  { name, id, password, permission }
│   ├── login.js            # POST /api/login     { id, password }
│   ├── status.js           # POST /api/status    { id }
│   ├── logout.js           # POST /api/logout    세션 폐기
│   ├── titles.js           # POST /api/titles    { action: list | save | delete } (Bearer 토큰 필요)
│   └── sync.js             # POST /api/sync      Apps Script 전용 (x-sync-secret 헤더)
├── lib/
│   ├── store.js            # Upstash Redis 저장소: 사용자·세션·IP + 시트 동기화 로직
│   └── http.js             # 응답 형식, 본문 파싱, 검증 규칙
├── apps-script/
│   ├── Code.gs             # syncWithVercel / installSyncTrigger + 웹 앱 백업 API
│   ├── Index.html          # public/index.html 과 동일한 사본
│   └── appsscript.json
├── package.json            # 의존성: @upstash/redis
├── vercel.json             # 정적 출력 디렉터리(public), 함수 설정
├── .env.example            # 필요한 환경 변수 목록
└── .gitignore
```

## 설정 순서

### 1. Upstash Redis 데이터베이스

1. https://console.upstash.com → **Create Database** (이름 예: `byus-builder`, Region: Asia Pacific(ap-northeast-1 등) 권장, Free)
2. 데이터베이스 → **REST API** 탭에서 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` 확인

   또는 Vercel 대시보드 → 프로젝트 → **Storage → Create Database → Upstash Redis** 로 연결하면 두 환경 변수가 자동으로 등록됩니다.

### 2. Vercel 환경 변수

Vercel 프로젝트 → Settings → Environment Variables (Production / Preview 모두)

| 이름 | 값 |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST Token |
| `SYNC_SECRET` | 긴 임의 문자열 (로컬 `.env` 에 생성해 둔 값 사용) |
| `HASH_PASSWORDS` | `false` |

저장 후 **Deployments → 최신 배포 → Redeploy** 를 눌러야 함수가 새 값을 읽습니다.

### 3. Apps Script 동기화

1. https://script.google.com 의 `byUs 각색 기획안 Builder` 프로젝트에 `apps-script/Code.gs` 내용을 붙여 넣고 저장
2. 톱니바퀴(프로젝트 설정) → **스크립트 속성** 에 추가
   - `VERCEL_SYNC_URL` = `https://<프로젝트>.vercel.app/api/sync`
   - `SYNC_SECRET` = Vercel 에 넣은 것과 같은 값
3. 편집기에서 함수 `syncWithVercel` 을 한 번 **실행** → 권한 승인(외부 URL 연결, 트리거) → 실행 로그에 `sync ok` 가 보이면 정상. 이때 시트의 기존 행(관리자 등)이 Redis 로 들어가 Vercel 사이트에서 바로 로그인됩니다.
4. 함수 `installSyncTrigger` 를 한 번 **실행** → 1분 주기 트리거 설치 완료 (왼쪽 시계 아이콘에서 확인)

### 4. GitHub + Vercel

```bash
git init
```

```bash
git add .
```

```bash
git commit -m "byUs 각색 기획안 Builder: Upstash Redis + Apps Script 시트 동기화"
```

```bash
git remote add origin https://github.com/<계정>/<저장소>.git
```

```bash
git push -u origin main
```

Vercel 에서 저장소를 Import 하면 이후 `main` push 마다 자동 배포됩니다. 배포 주소가 나오면 `public/index.html` 상단의 `SERVICE_URL` 을 그 주소로 바꿔 커밋하세요(정적 미리보기 배너가 가리키는 링크).

## 동작 흐름

- **로그인**: ID/PW 가 저장소와 일치하면 로그인. `activate` 가 `TRUE` 가 아니면 "권한 부여 대기 중입니다." 화면만 표시됩니다.
- **ID 등록 및 권한 요청**: 이름(16자 이내) · 아이디(영문/숫자/기호, 16자 이내) · 비밀번호(영문/숫자/기호, 8자 이상) · 권한(Admin/Editor/Viewer) 모두 필수. 비거나 기준 미달이면 해당 입력창이 붉게 표시되고 "필수 문항 작성이 필요합니다." 가 하단에 뜹니다. 프론트와 서버가 같은 규칙으로 두 번 검증합니다. 통과하면 Redis 에 저장되고 ≤1분 내에 시트에 행이 추가됩니다(`activate` 비어 있음).
- **권한 부여**: 관리자가 시트에서 `activate` 를 `TRUE` 로 바꾸면 ≤1분 내 반영. 대기 화면의 "권한 상태 다시 확인" 으로 확인할 수 있습니다.
- 중복 아이디는 거절됩니다(대소문자 무시). 시트에서 행을 지우면 다음 동기화 때 계정이 삭제됩니다.

API 응답 형식: `{ ok: true, data }` 또는 `{ ok: false, error, fields }`.

## 동기화 규칙 (`lib/store.js` → `syncWithSheet`)

| 상황 | 처리 |
| --- | --- |
| 시트에 있는 ID | 시트 값(name/password/permission/activate)으로 Redis 덮어쓰기 |
| Redis 에만 있고 아직 시트에 간 적 없는 ID (신규 가입) | 응답 `append` 로 돌려줌 → Apps Script 가 시트 끝에 추가 |
| 예전에 시트에 있었는데 지금 없는 ID | Redis 에서 삭제 (관리자가 행을 지운 것으로 간주) |
| 시트가 비어서 전달됨 (`rows: []`) | 삭제는 건너뜀 (읽기 실패 대비) |

## 참고

- 비밀번호는 요구사항대로 평문 저장이 기본입니다. 시트 공유 범위를 관리자에게만 한정하세요. `HASH_PASSWORDS=true` 로 바꾸면 새 가입자의 비밀번호를 SHA-256 으로 저장하며, 로그인은 평문/해시 모두 허용하므로 기존 행과 혼용됩니다.
- 로그인 상태는 브라우저 `sessionStorage` 에만 보관되며 탭을 닫으면 사라집니다.
- 동기화를 멈추려면 Apps Script 에서 `removeSyncTrigger` 를 실행하세요.
- Apps Script 웹 앱(백업): https://script.google.com/a/macros/webtoonscorp.com/s/AKfycbxRjyLtiKvCX5lc_ikY_1xMuOjsuYotbLPIcvK__iAr2VqA5_mx6IvooagPEMGPTHomsg/exec (회사 계정 전용, 시트 직접 기록)
