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

module.exports = { findUserById, createUser, listUsers, syncWithSheet, verifyPassword, str, isTrue };
