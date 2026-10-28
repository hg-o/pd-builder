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
const TITLE_STATUSES = ['시작 전', '전략 기획', '각색 기획', '프롬프트 작성', 'QA', 'byUs 정식 론칭'];
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
    status: str(raw.status),
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

  const users = await listUsers();
  const nameOf = new Map(users.map((u) => [u.id.toLowerCase(), u.name]));
  // 현재 사용자 이름이 있으면 최신 이름, 탈퇴했으면 저장해 둔 이름, 그것도 없으면 ID
  return rows.map((t) => ({
    ...t,
    owners: t.owners.map((o) => ({ id: o.id, name: nameOf.get(o.id.toLowerCase()) || o.name || o.id }))
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
  const res = await p.exec();
  return Number(res[0]) > 0;
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
  listOwnerCandidates, listTitles, getTitle, saveTitle, deleteTitle, TITLE_STATUSES, TITLE_NAME_MAX
};
