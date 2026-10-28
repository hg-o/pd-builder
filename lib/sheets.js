/**
 * Google Sheets 접근 계층 (Vercel 서버리스 함수에서 사용)
 *
 * 서비스 계정으로 인증해 시트를 직접 읽고 씁니다.
 * 필요한 환경 변수 (Vercel 프로젝트 설정 → Environment Variables):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  서비스 계정 이메일 (…@….iam.gserviceaccount.com)
 *   GOOGLE_PRIVATE_KEY            서비스 계정 키 JSON 의 private_key 값 (줄바꿈은 \n 그대로 두어도 됨)
 *   SHEET_ID                      (선택) 스프레드시트 ID. 기본값은 byUs PD 자동화 ID 시트
 *   SHEET_NAME                    (선택) 탭 이름. 기본값 '시트1'
 *   HASH_PASSWORDS                (선택) 'true' 면 비밀번호를 SHA-256 으로 저장/비교
 *
 * 시트 컬럼: A name | B ID | C password | D permission | E activate
 */

const crypto = require('crypto');
const { JWT } = require('google-auth-library');

const SHEET_ID = process.env.SHEET_ID || '1bkeTv7isOVdy3TDpa7kkM2L2GDhJO73NaLdKwvXlw64';
const SHEET_NAME = process.env.SHEET_NAME || '시트1';
const HASH_PASSWORDS = String(process.env.HASH_PASSWORDS || '').toLowerCase() === 'true';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

let client = null;

function getClient() {
  if (client) return client;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) {
    const err = new Error('서버 설정 오류: GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY 환경 변수가 없습니다.');
    err.status = 500;
    throw err;
  }
  key = key.replace(/\\n/g, '\n').replace(/^"|"$/g, '');
  client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return client;
}

function range(a1) {
  return encodeURIComponent(`${SHEET_NAME}!${a1}`);
}

/** 2행부터 모든 사용자 행을 읽어 객체 배열로 돌려줍니다. */
async function readUsers() {
  const res = await getClient().request({
    url: `${API}/${SHEET_ID}/values/${range('A2:E')}`,
    method: 'GET'
  });
  const rows = (res.data && res.data.values) || [];
  return rows.map((r, i) => ({
    rowNumber: i + 2,
    name: str(r[0]),
    id: str(r[1]),
    password: str(r[2]),
    permission: str(r[3]),
    activate: isTrue(r[4])
  }));
}

/** ID 컬럼에서 대소문자 무시 매칭 */
async function findUserById(id) {
  const target = str(id).toLowerCase();
  if (!target) return null;
  const users = await readUsers();
  return users.find((u) => u.id.toLowerCase() === target) || null;
}

/** 마지막 행 뒤에 사용자 추가. activate 는 비워 둠(= 권한 대기) */
async function appendUser({ name, id, password, permission }) {
  await getClient().request({
    url: `${API}/${SHEET_ID}/values/${range('A:E')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    method: 'POST',
    data: { values: [[name, id, HASH_PASSWORDS ? hash(password) : password, permission, '']] }
  });
}

function verifyPassword(stored, input) {
  const expected = HASH_PASSWORDS ? hash(input) : input;
  const a = Buffer.from(str(stored));
  const b = Buffer.from(str(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

module.exports = { readUsers, findUserById, appendUser, verifyPassword, str, isTrue };
