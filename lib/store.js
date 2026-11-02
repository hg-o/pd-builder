/**
 * 사용자 저장소 (Upstash Redis)
 *
 * Google Cloud 없이 동작하기 위해 Vercel 함수는 Upstash Redis 에 사용자를 저장하고,
 * 회사 계정으로 실행되는 Apps Script 가 주기적으로 /api/sync 를 호출해
 * 시트 ↔ Redis 를 맞춥니다. (시트가 기준: activate / permission 은 시트 값이 우선)
 *
 * 필요한 환경 변수:
 *   UPSTASH_REDIS_REST_URL    Upstash 콘솔 → Database → REST API → UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN  같은 화면의 UPSTASH_REDIS_REST_TOKEN
 *   HASH_PASSWORDS            (선택) 'true' 면 새 가입 비밀번호를 SHA-256 으로 저장
 *
 * 키 구조:
 *   user:<id 소문자>  HASH { name, id, password, permission, activate('TRUE'|''), synced('1'|'0'), createdAt }
 *   users            ZSET  member = id 소문자, score = createdAt(ms)
 */

const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const HASH_PASSWORDS = String(process.env.HASH_PASSWORDS || '').toLowerCase() === 'true';
const USERS_KEY = 'users';

let redis = null;

function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const err = new Error('서버 설정 오류: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 환경 변수가 없습니다.');
    err.status = 500;
    throw err;
  }
  // 문자열을 그대로 저장/조회하기 위해 자동 JSON 변환을 끕니다. ("007" 같은 값 보호)
  redis = new Redis({ url, token, automaticDeserialization: false });
  return redis;
}

const keyOf = (id) => 'user:' + str(id).toLowerCase();

/**
 * HGETALL 응답을 객체로 통일합니다.
 * automaticDeserialization: false 일 때는 [field, value, field, value, ...] 평면 배열로 오고,
 * 켜져 있을 때는 객체로 옵니다. 둘 다 받아들입니다.
 */
function toObject(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    const o = {};
    for (let i = 0; i + 1 < raw.length; i += 2) o[String(raw[i])] = raw[i + 1];
    return o;
  }
  return typeof raw === 'object' && Object.keys(raw).length ? raw : null;
}

function normalize(input) {
  const raw = toObject(input);
  if (!raw || !raw.id) return null;
  return {
    name: str(raw.name),
    id: str(raw.id),
    password: str(raw.password),
    permission: str(raw.permission),
    activate: isTrue(raw.activate),
    synced: str(raw.synced) === '1',
    createdAt: Number(raw.createdAt) || 0
  };
}

async function findUserById(id) {
  if (!str(id)) return null;
  const raw = await getRedis().hgetall(keyOf(id));
  return normalize(raw);
}

/** 신규 가입. activate 비움(권한 대기), synced=0 (아직 시트에 없음) */
async function createUser({ name, id, password, permission }) {
  const now = Date.now();
  const r = getRedis();
  const p = r.pipeline();
  p.hset(keyOf(id), {
    name,
    id,
    password: HASH_PASSWORDS ? hash(password) : password,
    permission,
    activate: '',
    synced: '0',
    createdAt: String(now)
  });
  p.zadd(USERS_KEY, { score: now, member: keyOf(id).slice(5) });
  await p.exec();
}

async function listUsers() {
  const r = getRedis();
  const ids = await r.zrange(USERS_KEY, 0, -1);
  if (!ids.length) return [];
  const p = r.pipeline();
  ids.forEach((k) => p.hgetall('user:' + k));
  const results = await p.exec();
  return results.map(normalize).filter(Boolean);
}

/**
 * 시트 ↔ Redis 동기화 (Apps Script 가 호출)
 * @param {Array<{name,id,password,permission,activate}>} rows 시트의 전체 사용자 행
 * @returns {{append: Array, imported: number, removed: number}}
 *   append : 시트에 아직 없는 신규 가입자 → Apps Script 가 시트에 추가
 */
async function syncWithSheet(rows) {
  const r = getRedis();
  const sheet = new Map();
  (rows || []).forEach((row) => {
    const id = str(row && row.id);
    if (id) sheet.set(id.toLowerCase(), row);
  });

  const existing = await listUsers();
  const existingByKey = new Map(existing.map((u) => [u.id.toLowerCase(), u]));
  const now = Date.now();
  const p = r.pipeline();
  let imported = 0;
  let removed = 0;
  const append = [];

  // 1) 시트 → Redis : 시트에 있는 사용자는 시트 값으로 덮어씀 (시트가 기준)
  for (const [k, row] of sheet) {
    const prev = existingByKey.get(k);
    p.hset('user:' + k, {
      name: str(row.name),
      id: str(row.id),
      password: str(row.password),
      permission: str(row.permission),
      activate: isTrue(row.activate) ? 'TRUE' : '',
      synced: '1',
      createdAt: String(prev && prev.createdAt ? prev.createdAt : now)
    });
    if (!prev) {
      p.zadd(USERS_KEY, { score: now, member: k });
      imported++;
    }
  }

  // 2) Redis 에만 있는 사용자
  for (const u of existing) {
    const k = u.id.toLowerCase();
    if (sheet.has(k)) continue;
    if (u.synced) {
      // 예전에 시트에 있었는데 사라짐 = 관리자가 행을 삭제 → 계정 제거
      // (시트를 통째로 못 읽은 경우를 대비해 rows 가 비어 있으면 삭제하지 않음)
      if (sheet.size > 0) {
        p.del('user:' + k);
        p.zrem(USERS_KEY, k);
        removed++;
      }
    } else {
      append.push({ name: u.name, id: u.id, password: u.password, permission: u.permission, activate: '' });
    }
  }

  await p.exec();
  return { append, imported, removed, total: sheet.size + append.length };
}

// ───────────────────────────── 세션 (로그인 토큰) ─────────────────────────────

const SESSION_TTL_SEC = 12 * 60 * 60; // 12시간

/** 로그인 성공 시 발급. 토큰 → 사용자 ID 를 TTL 과 함께 저장 */
async function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await getRedis().set('session:' + token, userId, { ex: SESSION_TTL_SEC });
  return token;
}

/** 토큰으로 사용자 조회. 없거나 만료/비활성화면 null */
async function getSessionUser(token) {
  const t = str(token);
  if (!/^[a-f0-9]{48}$/.test(t)) return null;
  const r = getRedis();
  const userId = await r.get('session:' + t);
  if (!userId) return null;
  const user = await findUserById(userId);
  if (!user || !user.activate) return null;
  await r.expire('session:' + t, SESSION_TTL_SEC); // 사용 중이면 연장
  return user;
}

async function destroySession(token) {
  const t = str(token);
  if (t) await getRedis().del('session:' + t);
}

// ───────────────────────────── IP (Title) ─────────────────────────────

const TITLES_KEY = 'titles';
// IP 진행 사항: 기본 정보 작성 중 → 전략 기획 중 → 스토리(캐릭터) 제작 중 → 모든 스토리 배포 완료
const TITLE_STATUSES = ['시작 전', '전략 기획', '스토리 제작', 'byUs 정식 론칭'];
// 예전 값 → 현재 값 (스토리 위계 도입 전의 세부 단계 상태는 모두 '스토리 제작' 으로 읽음)
const LEGACY_STATUS = { 'QA': '스토리 제작', '1차 QA': '스토리 제작', '2차 QA': '스토리 제작', '각색 기획': '스토리 제작', '프롬프트 작성': '스토리 제작', '시작 상황 작성': '스토리 제작' };
const normalizeStatus = (v) => LEGACY_STATUS[str(v)] || str(v);
const TITLE_NAME_MAX = 24;
const THUMB_MAX_BYTES = 400 * 1024; // data URL 기준 약 400KB (클라이언트에서 320px 로 축소해 보냄)
const OWNER_PERMISSIONS = ['Admin', 'Editor'];

/**
 * owners 는 [{id, name}] 로 저장합니다. (예전 데이터의 ["id", ...] 형식도 읽습니다)
 * 이름을 함께 저장해 두므로 담당자가 탈퇴(시트에서 삭제)해도 카드에 이름이 남습니다.
 */
function parseOwners(v) {
  let arr = [];
  try { arr = JSON.parse(str(v) || '[]'); } catch (e) { arr = []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((o) => (typeof o === 'string' ? { id: str(o), name: '' } : { id: str(o && o.id), name: str(o && o.name) }))
    .filter((o) => o.id);
}

function normalizeTitle(input) {
  const raw = toObject(input);
  if (!raw || !raw.id) return null;
  return {
    id: str(raw.id),
    name: str(raw.name),
    owners: parseOwners(raw.owners),
    status: normalizeStatus(raw.status),
    thumbnail: str(raw.thumbnail),
    link: str(raw.link),
    createdBy: str(raw.createdBy),
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0
  };
}

const LINK_MAX = 2048;
function normalizeLink(v) {
  const s = str(v);
  if (!s) return '';
  if (s.length > LINK_MAX) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!/^[a-z0-9.-]+$/i.test(u.hostname) || !u.hostname.includes('.')) return null; // "https://not%20a%20url/" 같은 값 거부
    return u.href;
  } catch (e) { return null; }
}

/** 담당자로 지정할 수 있는 사용자(Admin/Editor, 승인됨) */
async function listOwnerCandidates() {
  const users = await listUsers();
  return users
    .filter((u) => u.activate && OWNER_PERMISSIONS.includes(u.permission))
    .map((u) => ({ id: u.id, name: u.name, permission: u.permission }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/** 전체 IP 목록 (최신순). owners 는 [{id, name}] 로 이름을 붙여 돌려줍니다. */
async function listTitles() {
  const r = getRedis();
  const ids = await r.zrange(TITLES_KEY, 0, -1, { rev: true });
  if (!ids.length) return [];
  const p = r.pipeline();
  ids.forEach((id) => p.hgetall('title:' + id));
  const rows = (await p.exec()).map(normalizeTitle).filter(Boolean);

  const [users, storiesByTitle] = await Promise.all([listUsers(), listStoriesForTitles(rows.map((t) => t.id))]);
  const nameOf = new Map(users.map((u) => [u.id.toLowerCase(), u.name]));
  // 현재 사용자 이름이 있으면 최신 이름, 탈퇴했으면 저장해 둔 이름, 그것도 없으면 ID
  // 카드에 보여줄 스토리 요약(id · 주인공 이름 · 성별 · 상태)도 함께 붙입니다.
  return rows.map((t) => ({
    ...t,
    owners: t.owners.map((o) => ({ id: o.id, name: nameOf.get(o.id.toLowerCase()) || o.name || o.id })),
    stories: (storiesByTitle[t.id] || []).map((s) => ({ id: s.id, name: s.name, gender: s.gender, status: s.status }))
  }));
}

async function getTitle(id) {
  const raw = await getRedis().hgetall('title:' + str(id));
  return normalizeTitle(raw);
}

/**
 * IP 생성/수정. 검증 실패 시 { fields } 를 담은 에러를 던집니다.
 * @param {{id?:string,name:string,owners:string[],status:string,thumbnail?:string}} data
 * @param {string} actorId
 */
async function saveTitle(data, actorId) {
  const name = str(data.name);
  const status = str(data.status);
  const ownerIds = Array.isArray(data.owners) ? [...new Set(data.owners.map(str).filter(Boolean))] : [];
  const thumbnail = str(data.thumbnail);
  const link = normalizeLink(data.link);

  const now = Date.now();
  let id = str(data.id);
  let prev = null;
  if (id) {
    prev = await getTitle(id);
    if (!prev) { const e = new Error('수정할 IP 를 찾을 수 없습니다.'); e.status = 404; throw e; }
  }

  const fields = [];
  if (!name || name.length > TITLE_NAME_MAX) fields.push('name');
  if (!TITLE_STATUSES.includes(status)) fields.push('status');
  if (thumbnail && (!/^data:image\/(jpeg|png|webp);base64,/.test(thumbnail) || thumbnail.length > THUMB_MAX_BYTES)) fields.push('thumbnail');
  if (link === null) fields.push('link');

  // 담당자(필수): 승인된 Admin/Editor 이거나, 이미 이 IP 의 담당자였던 사람(탈퇴했더라도 유지 가능)
  const candidates = await listOwnerCandidates();
  const candidateName = new Map(candidates.map((u) => [u.id.toLowerCase(), u.name]));
  const prevName = new Map((prev ? prev.owners : []).map((o) => [o.id.toLowerCase(), o.name]));
  if (!ownerIds.length || ownerIds.some((o) => !candidateName.has(o.toLowerCase()) && !prevName.has(o.toLowerCase()))) {
    fields.push('owners');
  }
  if (fields.length) {
    const err = new Error(fields.length === 1 && fields[0] === 'link' ? '링크는 http:// 또는 https:// 로 시작하는 주소여야 합니다.' : '필수 문항 작성이 필요합니다.');
    err.status = 400;
    err.fields = fields;
    throw err;
  }
  const owners = ownerIds.map((oid) => {
    const k = oid.toLowerCase();
    return { id: oid, name: candidateName.get(k) || prevName.get(k) || oid };
  });

  if (!id) id = 't_' + now.toString(36) + '_' + crypto.randomBytes(3).toString('hex');

  const r = getRedis();
  const p = r.pipeline();
  p.hset('title:' + id, {
    id,
    name,
    owners: JSON.stringify(owners),
    status,
    thumbnail,
    link,
    createdBy: prev ? prev.createdBy : str(actorId),
    createdAt: String(prev ? prev.createdAt : now),
    updatedAt: String(now)
  });
  if (!prev) p.zadd(TITLES_KEY, { score: now, member: id });
  await p.exec();
  return id;
}

async function deleteTitle(id) {
  const key = str(id);
  if (!key) return false;
  const r = getRedis();
  const p = r.pipeline();
  p.del('title:' + key);
  p.zrem(TITLES_KEY, key);
  STAGE_ORDER.forEach((s) => p.del(stageKey(key, s)));
  await deleteStoriesOf(key, p); // 스토리와 스토리 단계도 함께 삭제
  const res = await p.exec();
  return Number(res[0]) > 0;
}

// ───────────────────────────── 제작 단계: IP 단계 + 스토리 단계 ─────────────────────────────
//
// 위계: IP(title) ─┬─ IP 단계   : 작품 기본 정보(basic) → 콘텐츠 전략 기획(strategy)
//                  │              strategy 의 마지막 항목 'stories' 가 이 IP 에 들어갈 스토리 구성(주인공 이름·성별, 1개 이상)
//                  └─ 스토리(story, 1개 이상) ─ 스토리 단계 : 프롬프트(prompt) → 시작 설정(opening) → 1차 QA(qa1) → 2차 QA(qa2) → 배포(release)
//
// 규칙:
//  - 앞 단계를 완료(done)해야 다음 단계를 저장할 수 있다. 스토리 단계는 IP 의 strategy 가 완료되어야 열린다.
//  - strategy 가 완료된 상태로 저장될 때마다 'stories' 항목과 실제 스토리 엔티티를 동기화한다 (추가·이름/성별 수정·삭제).
//  - 완료/완료 취소 때마다 IP 진행 사항(status)과 스토리 상태를 다시 계산해 덮어쓴다.
//
// 키 구조:
//   stage:<titleId>:<stageKey>            STRING(JSON) IP 단계      { fields, done, updatedAt, updatedBy, completedAt }
//   stories:<titleId>                      ZSET  member = storyId, score = order
//   story:<storyId>                        HASH  { id, titleId, name, gender, order, status, done(JSON {stage:bool}), createdAt, updatedAt }
//   sstage:<storyId>:<stageKey>            STRING(JSON) 스토리 단계  (IP 단계와 같은 형식)
//
// 프론트(public/index.html 의 STAGES / STORY_STAGES)와 필드 키·필수 항목을 맞춰야 합니다.
const STAGE_DEFS = {
  basic:    { keys: ['genre', 'author', 'source', 'synopsis', 'characters', 'notes'],           required: ['genre', 'synopsis', 'characters'] },
  strategy: { keys: ['target', 'appeal', 'direction', 'reference', 'risk', 'stories'],           required: ['target', 'appeal', 'direction', 'stories'] }
};
const STAGE_ORDER = Object.keys(STAGE_DEFS);

const STORY_STAGE_DEFS = {
  prompt:  { keys: ['sheet', 'examples', 'constraints'],              required: ['sheet'],                      label: '프롬프트 작성' },
  opening: { keys: ['situation', 'first', 'userRole', 'branches'],    required: ['situation', 'first'],         label: '시작 설정' },
  qa1:     { keys: ['scope', 'issues', 'fixes', 'verdict', 'memo'],   required: ['scope', 'issues', 'verdict'], label: '1차 QA' },
  qa2:     { keys: ['scope', 'issues', 'fixes', 'verdict', 'memo'],   required: ['scope', 'issues', 'verdict'], label: '2차 QA' },
  release: { keys: ['date', 'link', 'checklist', 'memo'],             required: ['date'],                       label: '배포' }
};
const STORY_STAGE_ORDER = Object.keys(STORY_STAGE_DEFS);
const STORY_DONE_STATUS = '배포 완료';
const STORY_GENDERS = ['여성', '남성', '알 수 없음', '그 외'];
const STORY_NAME_MAX = 24;
const STAGE_FIELD_MAX = 10000; // 항목당 글자 수 상한

// 블록 추가형 항목: 값은 JSON 배열 문자열. 항목별로 검증하고 정규화해서 저장합니다.
//  - basic.author     : [{ type: '웹소설'|'웹툰', name }]
//  - basic.characters : [{ name, desc }]
const AUTHOR_TYPES = ['웹소설', '웹툰'];
const BLOCK_NAME_MAX = 40;
const BLOCK_ITEMS_MAX = 100;
const BLOCK_FIELDS = {
  author: {
    item: (o) => ({ type: str(o && o.type), name: str(o && o.name) }),
    valid: (b) => AUTHOR_TYPES.includes(b.type) && !!b.name && b.name.length <= BLOCK_NAME_MAX,
    error: '원작 작가 항목이 잘못되었습니다. (종류: 웹소설 / 웹툰 · 닉네임 ' + BLOCK_NAME_MAX + '자 이내)'
  },
  characters: {
    item: (o) => ({ name: str(o && o.name), desc: str(o && o.desc) }),
    valid: (b) => !!b.name && b.name.length <= BLOCK_NAME_MAX && b.desc.length <= STAGE_FIELD_MAX,
    error: '등장인물 항목이 잘못되었습니다. (이름 ' + BLOCK_NAME_MAX + '자 이내 · 설명 ' + STAGE_FIELD_MAX.toLocaleString() + '자 이내)'
  }
};

/** 블록 항목 JSON 검증 → { list, error } (빈 값은 빈 목록) */
function parseBlocks(key, json) {
  const def = BLOCK_FIELDS[key];
  const raw = str(json);
  if (!raw) return { list: [], error: '' };
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { return { list: [], error: def.error }; }
  if (!Array.isArray(arr)) return { list: [], error: def.error };
  if (arr.length > BLOCK_ITEMS_MAX) return { list: [], error: '항목은 ' + BLOCK_ITEMS_MAX + '개까지 추가할 수 있습니다.' };
  const list = arr.map(def.item);
  return { list, error: list.every(def.valid) ? '' : def.error };
}

const stageKey = (titleId, stage) => 'stage:' + titleId + ':' + stage;
const storyStageKey = (storyId, stage) => 'sstage:' + storyId + ':' + stage;
const storiesKey = (titleId) => 'stories:' + titleId;

function parseStage(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object') return null;
    return {
      fields: o.fields && typeof o.fields === 'object' ? o.fields : {},
      done: !!o.done,
      updatedAt: Number(o.updatedAt) || 0,
      updatedBy: o.updatedBy && typeof o.updatedBy === 'object' ? { id: str(o.updatedBy.id), name: str(o.updatedBy.name) } : null,
      completedAt: Number(o.completedAt) || 0
    };
  } catch (e) { return null; }
}

async function readStages(keys, order) {
  if (!keys.length) return {};
  const raws = await getRedis().mget(...keys);
  const out = {};
  order.forEach((s, i) => { const v = parseStage(raws && raws[i]); if (v) out[s] = v; });
  return out;
}

/** IP 단계 데이터 { basic, strategy } */
async function getStages(titleId) {
  const id = str(titleId);
  if (!id) return {};
  return readStages(STAGE_ORDER.map((s) => stageKey(id, s)), STAGE_ORDER);
}

/** 스토리 단계 데이터 { prompt, opening, qa1, qa2, release } */
async function getStoryStages(storyId) {
  const id = str(storyId);
  if (!id) return {};
  return readStages(STORY_STAGE_ORDER.map((s) => storyStageKey(id, s)), STORY_STAGE_ORDER);
}

function isOpenIn(order, records, stage) {
  const i = order.indexOf(stage);
  if (i < 0) return false;
  if (i === 0) return true;
  const prev = records[order[i - 1]];
  return !!(prev && prev.done);
}

// ───── 스토리 엔티티 ─────

function normalizeStory(input) {
  const raw = toObject(input);
  if (!raw || !raw.id) return null;
  let done = {};
  try { done = JSON.parse(str(raw.done) || '{}'); } catch (e) { done = {}; }
  return {
    id: str(raw.id),
    titleId: str(raw.titleId),
    name: str(raw.name),
    gender: str(raw.gender),
    order: Number(raw.order) || 0,
    status: str(raw.status) || STORY_STAGE_DEFS[STORY_STAGE_ORDER[0]].label,
    done: done && typeof done === 'object' ? done : {},
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0
  };
}

async function getStory(storyId) {
  const raw = await getRedis().hgetall('story:' + str(storyId));
  return normalizeStory(raw);
}

/** IP 의 스토리 목록 (order 순) */
async function listStories(titleId) {
  const id = str(titleId);
  if (!id) return [];
  const r = getRedis();
  const ids = await r.zrange(storiesKey(id), 0, -1);
  if (!ids.length) return [];
  const p = r.pipeline();
  ids.forEach((sid) => p.hgetall('story:' + sid));
  return (await p.exec()).map(normalizeStory).filter(Boolean).sort((a, b) => a.order - b.order);
}

/** 여러 IP 의 스토리 요약을 한 번에 (목록 카드용) → { titleId: [story, ...] } */
async function listStoriesForTitles(titleIds) {
  const out = {};
  const ids = (titleIds || []).map(str).filter(Boolean);
  if (!ids.length) return out;
  const r = getRedis();
  const p1 = r.pipeline();
  ids.forEach((id) => p1.zrange(storiesKey(id), 0, -1));
  const members = await p1.exec();
  const flat = [];
  ids.forEach((id, i) => { out[id] = []; (members[i] || []).forEach((sid) => flat.push({ id, sid })); });
  if (!flat.length) return out;
  const p2 = r.pipeline();
  flat.forEach((f) => p2.hgetall('story:' + f.sid));
  const rows = await p2.exec();
  flat.forEach((f, i) => { const s = normalizeStory(rows[i]); if (s) out[f.id].push(s); });
  Object.keys(out).forEach((k) => out[k].sort((a, b) => a.order - b.order));
  return out;
}

/** 스토리 상태: 앞에서부터 처음 미완료 단계의 라벨, 모두 완료면 '배포 완료' */
function deriveStoryStatus(done) {
  for (const k of STORY_STAGE_ORDER) if (!done[k]) return STORY_STAGE_DEFS[k].label;
  return STORY_DONE_STATUS;
}

/**
 * IP 진행 사항: 기본 정보 미완료 → 시작 전, 전략 기획 미완료 → 전략 기획,
 * 스토리가 있고 모두 배포 완료 → byUs 정식 론칭, 그 외 → 스토리 제작
 */
function deriveTitleStatus(stages, stories) {
  if (!stages.basic || !stages.basic.done) return TITLE_STATUSES[0];
  if (!stages.strategy || !stages.strategy.done) return '전략 기획';
  if (stories.length && stories.every((s) => s.status === STORY_DONE_STATUS)) return 'byUs 정식 론칭';
  return '스토리 제작';
}

/**
 * strategy.fields.stories (JSON 문자열) 검증 → [{ id?, name, gender }]
 * 반환: { list, fields }  (fields: 잘못된 항목이 있으면 ['stories'])
 */
function parseStoryPlan(json, requireOne) {
  let arr = [];
  try { arr = JSON.parse(str(json) || '[]'); } catch (e) { return { list: [], fields: ['stories'] }; }
  if (!Array.isArray(arr)) return { list: [], fields: ['stories'] };
  const list = arr.map((o) => ({ id: str(o && o.id), name: str(o && o.name), gender: str(o && o.gender) }));
  const bad = list.some((s) => !s.name || s.name.length > STORY_NAME_MAX || !STORY_GENDERS.includes(s.gender));
  if (bad || (requireOne && !list.length)) return { list, fields: ['stories'] };
  return { list, fields: [] };
}

/**
 * 스토리 구성(plan) ↔ 스토리 엔티티 동기화. 새 항목은 생성하고 id 를 채워 돌려줍니다.
 * plan 에 없는 기존 스토리는 단계 데이터와 함께 삭제합니다.
 */
async function syncStories(titleId, plan, now) {
  const r = getRedis();
  const existing = await listStories(titleId);
  const byId = new Map(existing.map((s) => [s.id, s]));
  const keep = new Set();
  const p = r.pipeline();
  const result = plan.map((entry, i) => {
    let id = entry.id && byId.has(entry.id) ? entry.id : '';
    const prev = id ? byId.get(id) : null;
    if (!id) id = 's_' + now.toString(36) + '_' + crypto.randomBytes(3).toString('hex') + i.toString(36);
    keep.add(id);
    p.hset('story:' + id, {
      id,
      titleId,
      name: entry.name,
      gender: entry.gender,
      order: String(i),
      status: prev ? prev.status : STORY_STAGE_DEFS[STORY_STAGE_ORDER[0]].label,
      done: JSON.stringify(prev ? prev.done : {}),
      createdAt: String(prev ? prev.createdAt : now),
      updatedAt: String(now)
    });
    p.zadd(storiesKey(titleId), { score: i, member: id });
    return { id, name: entry.name, gender: entry.gender };
  });
  existing.forEach((s) => {
    if (keep.has(s.id)) return;
    p.del('story:' + s.id);
    p.zrem(storiesKey(titleId), s.id);
    STORY_STAGE_ORDER.forEach((k) => p.del(storyStageKey(s.id, k)));
  });
  await p.exec();
  return result;
}

async function deleteStoriesOf(titleId, p) {
  const stories = await listStories(titleId);
  stories.forEach((s) => {
    p.del('story:' + s.id);
    STORY_STAGE_ORDER.forEach((k) => p.del(storyStageKey(s.id, k)));
  });
  p.del(storiesKey(titleId));
}

// ───── 공통: 단계 레코드 만들기 ─────

function buildStageRecord(def, data, prev, actor, now) {
  const uncomplete = !!data.uncomplete;
  const complete = !!data.complete && !uncomplete;
  const src = data.fields && typeof data.fields === 'object' ? data.fields : {};
  const fields = {};
  const tooLong = [];
  const blockCount = {};
  for (const k of def.keys) {
    const v = src[k] === null || src[k] === undefined ? '' : String(src[k]);
    if (BLOCK_FIELDS[k]) {
      // 블록 항목: 항목별 검증 후 정규화한 JSON 으로 저장 (전체 길이 상한 대신 항목 단위 상한 적용)
      const parsed = parseBlocks(k, v);
      if (parsed.error) { const e = new Error(parsed.error); e.status = 400; e.fields = [k]; throw e; }
      blockCount[k] = parsed.list.length;
      fields[k] = parsed.list.length ? JSON.stringify(parsed.list) : '';
      continue;
    }
    if (v.length > STAGE_FIELD_MAX) tooLong.push(k);
    fields[k] = v;
  }
  if (tooLong.length) {
    const e = new Error('항목당 ' + STAGE_FIELD_MAX.toLocaleString() + '자 이내로 작성해 주세요.'); e.status = 400; e.fields = tooLong; throw e;
  }
  if (complete) {
    const missing = def.required.filter((k) => (BLOCK_FIELDS[k] ? !blockCount[k] : !fields[k].trim()));
    if (missing.length) { const e = new Error('필수 문항 작성이 필요합니다.'); e.status = 400; e.fields = missing; throw e; }
  }
  const done = uncomplete ? false : (complete || !!(prev && prev.done));
  return {
    complete, uncomplete,
    record: {
      fields,
      done,
      updatedAt: now,
      updatedBy: { id: str(actor && actor.id), name: str(actor && actor.name) },
      completedAt: !done ? 0 : (complete && !(prev && prev.done) ? now : (prev ? prev.completedAt : 0))
    }
  };
}

/** 작품 상세: 기본 정보 + IP 단계 + 스토리 목록 */
async function getTitleDetail(id) {
  const title = await getTitle(id);
  if (!title) { const e = new Error('작품을 찾을 수 없습니다.'); e.status = 404; throw e; }
  const [stages, stories] = await Promise.all([getStages(title.id), listStories(title.id)]);
  return { title, stages, stories };
}

/** 스토리 상세: IP 정보 · IP 단계(참고용) · 스토리 · 스토리 단계 */
async function getStoryDetail(titleId, storyId) {
  const title = await getTitle(titleId);
  if (!title) { const e = new Error('작품을 찾을 수 없습니다.'); e.status = 404; throw e; }
  const story = await getStory(storyId);
  if (!story || story.titleId !== title.id) { const e = new Error('스토리를 찾을 수 없습니다.'); e.status = 404; throw e; }
  const [stages, storyStages, stories] = await Promise.all([getStages(title.id), getStoryStages(story.id), listStories(title.id)]);
  return { title, stages, story, storyStages, stories };
}

/**
 * IP 단계 저장 (basic / strategy)
 *  - complete=true   : 필수 항목 검사 후 완료 처리
 *  - uncomplete=true : 완료 취소 (이후 단계 완료 표시도 해제, 내용은 유지)
 *  - strategy 가 완료 상태로 저장되면 stories 구성과 스토리 엔티티를 동기화
 *  - 완료/취소 때마다 진행 사항을 다시 계산
 */
async function saveStage(data, actor) {
  const stage = str(data.stage);
  const def = STAGE_DEFS[stage];
  if (!def) { const e = new Error('알 수 없는 단계입니다: ' + stage); e.status = 400; throw e; }

  const title = await getTitle(data.id);
  if (!title) { const e = new Error('작품을 찾을 수 없습니다.'); e.status = 404; throw e; }

  const stages = await getStages(title.id);
  if (!isOpenIn(STAGE_ORDER, stages, stage)) { const e = new Error('이전 단계를 먼저 완료해야 이 단계를 저장할 수 있습니다.'); e.status = 400; throw e; }
  if (data.uncomplete && !(stages[stage] && stages[stage].done)) { const e = new Error('완료되지 않은 단계입니다.'); e.status = 400; throw e; }

  const now = Date.now();
  const prev = stages[stage] || null;
  const { complete, uncomplete, record } = buildStageRecord(def, data, prev, actor, now);

  // 전략 기획: 스토리 구성 검증 (완료 시 1개 이상 필수) → 완료 상태면 스토리 엔티티와 동기화
  if (stage === 'strategy') {
    const plan = parseStoryPlan(record.fields.stories, complete || record.done);
    if (plan.fields.length && (complete || record.done || str(record.fields.stories))) {
      const e = new Error(plan.list.length ? '스토리 구성에 비어 있거나 잘못된 항목이 있습니다. (이름 24자 이내 · 성별 선택)' : '스토리는 1개 이상 구성해야 합니다.');
      e.status = 400; e.fields = ['stories']; throw e;
    }
    if (record.done) {
      const synced = await syncStories(title.id, plan.list, now);
      record.fields.stories = JSON.stringify(synced);
    }
  }

  const r = getRedis();
  const p = r.pipeline();
  p.set(stageKey(title.id, stage), JSON.stringify(record));
  stages[stage] = record;

  if (uncomplete) {
    for (const k of STAGE_ORDER.slice(STAGE_ORDER.indexOf(stage) + 1)) {
      const s = stages[k];
      if (s && s.done) {
        stages[k] = { ...s, done: false, completedAt: 0, updatedAt: now, updatedBy: record.updatedBy };
        p.set(stageKey(title.id, k), JSON.stringify(stages[k]));
      }
    }
  }

  const stories = await listStories(title.id);
  const patch = { updatedAt: String(now) };
  if (complete || uncomplete || stage === 'strategy') patch.status = deriveTitleStatus(stages, stories);
  p.hset('title:' + title.id, patch);
  await p.exec();

  return { title: await getTitle(title.id), stages, stories };
}

/**
 * 스토리 단계 저장 (prompt / opening / qa1 / qa2 / release)
 * IP 의 strategy 가 완료되어야 하며, 스토리 안에서도 앞 단계를 완료해야 다음 단계를 저장할 수 있습니다.
 */
async function saveStoryStage(data, actor) {
  const stage = str(data.stage);
  const def = STORY_STAGE_DEFS[stage];
  if (!def) { const e = new Error('알 수 없는 단계입니다: ' + stage); e.status = 400; throw e; }

  const title = await getTitle(data.id);
  if (!title) { const e = new Error('작품을 찾을 수 없습니다.'); e.status = 404; throw e; }
  const story = await getStory(data.storyId);
  if (!story || story.titleId !== title.id) { const e = new Error('스토리를 찾을 수 없습니다.'); e.status = 404; throw e; }

  const [stages, storyStages] = await Promise.all([getStages(title.id), getStoryStages(story.id)]);
  if (!stages.strategy || !stages.strategy.done) { const e = new Error('콘텐츠 전략 기획을 완료해야 스토리 단계를 저장할 수 있습니다.'); e.status = 400; throw e; }
  if (!isOpenIn(STORY_STAGE_ORDER, storyStages, stage)) { const e = new Error('이전 단계를 먼저 완료해야 이 단계를 저장할 수 있습니다.'); e.status = 400; throw e; }
  if (data.uncomplete && !(storyStages[stage] && storyStages[stage].done)) { const e = new Error('완료되지 않은 단계입니다.'); e.status = 400; throw e; }

  const now = Date.now();
  const prev = storyStages[stage] || null;
  const { complete, uncomplete, record } = buildStageRecord(def, data, prev, actor, now);

  const r = getRedis();
  const p = r.pipeline();
  p.set(storyStageKey(story.id, stage), JSON.stringify(record));
  storyStages[stage] = record;
  if (uncomplete) {
    for (const k of STORY_STAGE_ORDER.slice(STORY_STAGE_ORDER.indexOf(stage) + 1)) {
      const s = storyStages[k];
      if (s && s.done) {
        storyStages[k] = { ...s, done: false, completedAt: 0, updatedAt: now, updatedBy: record.updatedBy };
        p.set(storyStageKey(story.id, k), JSON.stringify(storyStages[k]));
      }
    }
  }

  // 스토리 상태 갱신 → IP 진행 사항 재계산
  const done = {};
  STORY_STAGE_ORDER.forEach((k) => { if (storyStages[k] && storyStages[k].done) done[k] = true; });
  story.done = done;
  story.status = deriveStoryStatus(done);
  story.updatedAt = now;
  p.hset('story:' + story.id, { status: story.status, done: JSON.stringify(done), updatedAt: String(now) });

  const stories = (await listStories(title.id)).map((s) => (s.id === story.id ? story : s));
  const patch = { updatedAt: String(now) };
  if (complete || uncomplete) patch.status = deriveTitleStatus(stages, stories);
  p.hset('title:' + title.id, patch);
  await p.exec();

  return { title: await getTitle(title.id), stages, story, storyStages, stories };
}

/** 저장값이 평문이든 해시든 모두 허용 (시트에 관리자가 직접 적은 평문 행과 혼용 가능) */
function verifyPassword(stored, input) {
  const s = str(stored);
  if (!s || !input) return false;
  return safeEqual(s, input) || safeEqual(s, hash(input));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hash(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function isTrue(v) {
  return v === true || str(v).toUpperCase() === 'TRUE';
}

module.exports = {
  findUserById, createUser, listUsers, syncWithSheet, verifyPassword, str, isTrue,
  createSession, getSessionUser, destroySession,
  listOwnerCandidates, listTitles, getTitle, saveTitle, deleteTitle, TITLE_STATUSES, TITLE_NAME_MAX,
  getStages, getTitleDetail, saveStage, STAGE_DEFS, STAGE_ORDER,
  listStories, getStoryDetail, saveStoryStage, STORY_STAGE_DEFS, STORY_STAGE_ORDER, STORY_GENDERS,
  AUTHOR_TYPES, BLOCK_FIELDS, parseBlocks
};
