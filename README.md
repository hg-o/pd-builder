# byUs Story Builder

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
- **Title**: 전체 IP 를 가로형 카드(1:1 썸네일 · IP명 · 담당자 여러 명 · 진행 사항)로 표시. 카드 본문을 누르면 작품 상세(단계별 제작 화면)로 들어가고, 연필 아이콘을 누르면 수정/삭제 모달이 열립니다.
- 등록된 IP 가 없으면 `아직 등록된 IP가 없어요.` 만 표시됩니다.
- **IP 모달**: 썸네일 업로드 / 바꾸기 / 삭제 (브라우저에서 1:1 중앙 크롭 후 320px JPEG 로 축소해 저장), IP명(24자 이내, 필수), 담당자(필수 · 승인된 Admin·Editor 중 다중 선택), 진행 사항(시작 전 · 전략 기획 · 각색 기획 · 프롬프트 작성 · 시작 상황 작성 · 1차 QA · 2차 QA · byUs 정식 론칭), 링크(선택 · byUs 링크, http/https 주소).
- 담당자는 ID 와 함께 이름도 저장되므로, 담당자가 탈퇴(시트에서 삭제)해도 카드와 수정 모달에 이름이 그대로 남습니다.
- 링크를 넣으면 카드의 썸네일 모서리 아이콘과 상태 옆 도메인 칩이 외부 링크(새 탭)로 연결됩니다.
- 카드에는 생성일과 최근 수정일이 표시되고, 카드 우측 상단의 연필 아이콘(Admin·Editor 에게만 표시)을 눌러야 수정 모달이 열립니다.
- 스타일은 정수 px 로 작성되어 있고, 로그인·가입·권한 대기 화면은 원래 크기, 로그인 이후 화면(`#view-app`, `#modal-ip`)만 `zoom: 0.9` 로 축소됩니다. 배율을 바꾸려면 그 한 줄만 수정하세요.
- IP 추가/수정/삭제는 Admin·Editor 만 가능하고, Viewer 는 조회만 할 수 있습니다. Viewer 에게는 **[+ 새 IP 추가]** 버튼과 카드의 연필 아이콘이 표시되지 않습니다.
- 로그인 시 발급되는 세션 토큰(12시간, Redis `session:*`)으로 IP API 를 보호합니다. 만료되면 로그인 화면으로 돌아갑니다.

## 작품 상세 (단계별 제작, `#title/<id>[/<단계>]`)

카드를 누르면 PD 가 작품을 제작하는 7단계를 순서대로 밟는 화면이 열립니다.

| 순서 | 단계 (키) | 주요 항목 (★ 필수) | 완료 시 진행 사항 |
| --- | --- | --- | --- |
| 1 | 작품 기본 정보 (`basic`) | 장르★ · 원작 작가 · 연재처 · 줄거리 요약★ · 주요 등장인물★ · 유의점 | 전략 기획 |
| 2 | 콘텐츠 전략 기획 (`strategy`) | 타깃 독자★ · 핵심 매력 포인트★ · 콘텐츠 방향·포맷★ · 레퍼런스 · 리스크 | 각색 기획 |
| 3 | 각색 기획안 작성 (`adaptation`) | 등장 캐릭터★ · 세계관(Lore)★ · 규칙(Rule)★ · 시나리오 구조★ · 톤앤매너 | 프롬프트 작성 |
| 4 | 프롬프트 작성 (`prompt`) | 캐릭터 시트·시스템 프롬프트★ · 대화 예시 · 금지·제약 | 시작 상황 작성 |
| 5 | 시작 상황 작성 (`opening`) | 시작 상황 설명★ · 첫 메시지★ · 유저 역할 · 진입 선택지 | 1차 QA |
| 6 | 1차 QA (`qa1`) | QA 범위·테스트 시나리오★ · 발견된 이슈★ · 수정 내역 · 판정★(선택형) · 비고 | 2차 QA |
| 7 | 2차 QA (`qa2`) | QA 범위·재확인 항목★ · 발견된 이슈★ · 수정 내역 · 최종 판정★(선택형) · 비고 | byUs 정식 론칭 |

진행 사항 목록은 `시작 전 · 전략 기획 · 각색 기획 · 프롬프트 작성 · 시작 상황 작성 · 1차 QA · 2차 QA · byUs 정식 론칭` 로, 단계 목록을 한 칸 민 것과 같습니다(진행 사항 = 지금 하고 있는 단계). 예전 값 `QA` 는 읽을 때 `1차 QA` 로 변환됩니다.

- **순차 진행**: 상단 스테퍼에서 완료(체크) · 진행 중(번호) · 잠김(자물쇠)을 구분합니다. 바로 앞 단계를 **[단계 완료]** 해야 다음 단계가 열리고, 잠긴 단계를 누르면 어느 단계를 끝내야 하는지 안내만 표시됩니다. 서버도 같은 규칙으로 검사합니다.
- **임시 저장 / 단계 완료 / 완료 취소**: 임시 저장은 필수 항목 없이도 가능하고, 단계 완료는 필수 항목을 검사한 뒤 완료 처리하고 다음 단계로 이동합니다. 완료된 단계는 **[저장]** 으로 내용을 덮어쓸 수 있고, **[완료 취소]** 를 누르면 진행 중 상태로 돌아갑니다. 완료를 취소하면 그 뒤 단계들의 완료 표시도 함께 풀리지만(다시 잠김) 작성한 내용은 그대로 남습니다.
- **진행 사항 자동 갱신**: 단계 완료나 완료 취소를 할 때마다 카드의 진행 사항을 단계 상태로부터 다시 계산해 덮어씁니다. 규칙은 "앞에서부터 처음 미완료인 단계 = 진행 사항" 이고, 모두 완료면 `byUs 정식 론칭` 입니다. IP 수정 모달에서 수동으로 바꾼 값은 다음 완료/취소 때 다시 계산된 값으로 덮어써집니다.
- **이전 단계 연동**: 2단계부터는 오른쪽 **이전 단계 참고** 패널에 앞 단계 내용이 접이식으로 표시됩니다(바로 앞 단계는 펼친 상태). 다음 단계를 처음 열면 일부 항목이 이전 단계 내용으로 미리 채워지고 `N단계에서 가져옴 · 수정 가능` 배지가 붙습니다. 3단계 등장 캐릭터 ← 1단계 주요 등장인물, 4단계 시스템 프롬프트 ← 3단계 캐릭터·세계관·규칙·톤·시나리오를 제목 붙여 합친 초안, 4단계 금지 사항 ← 3단계 규칙, 5단계 시작 상황 ← 3단계 시나리오, 6단계 QA 범위 ← 3단계 시나리오, 7단계 재확인 항목 ← 6단계 발견된 이슈.
- **권한**: Viewer 는 모든 단계를 읽기 전용으로만 봅니다(입력 비활성, 저장 버튼 없음). Admin·Editor 만 저장·완료할 수 있습니다.
- **저장 구조**: Redis `stage:<titleId>:<단계키>` 에 `{ fields, done, updatedAt, updatedBy, completedAt }` 을 JSON 으로 저장합니다. 항목당 10,000자 제한. IP 를 삭제하면 단계 데이터도 함께 지워집니다. 단계 정의(필드 키 · 필수 항목 · 완료 시 상태)는 `public/index.html` 의 `STAGES` 와 `lib/store.js` 의 `STAGE_DEFS` 두 곳에 있으므로 함께 수정해야 합니다.
- API: `POST /api/titles` 에 `action: 'detail' { id }` → `{ title, stages }`, `action: 'saveStage' { id, stage, fields, complete?, uncomplete? }` → `{ title, stages }` 가 추가되었습니다.
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
- **ID 등록 및 권한 요청**: 이름(16자 이내) · 아이디(영문/숫자/기호, 길이 제한 없음) · 비밀번호(영문/숫자/기호, 8자 이상) · 권한(Editor/Viewer · Admin 은 관리자가 시트에서만 지정) 모두 필수. 비거나 기준 미달이면 해당 입력창이 붉게 표시되고 "필수 문항 작성이 필요합니다." 가 하단에 뜹니다. 프론트와 서버가 같은 규칙으로 두 번 검증합니다. 통과하면 Redis 에 저장되고 ≤1분 내에 시트에 행이 추가됩니다(`activate` 비어 있음).
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
