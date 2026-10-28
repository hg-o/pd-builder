/**
 * POST /api/sync   (Apps Script 전용 — 헤더 x-sync-secret 필요)
 * body: { rows: [{ name, id, password, permission, activate }] }  ← 시트의 전체 사용자 행
 *
 * 1) 시트에 있는 사용자 → Redis 에 반영 (activate / permission 등 시트 값이 기준)
 * 2) Redis 에만 있는 신규 가입자 → append 로 돌려줌 (Apps Script 가 시트에 추가)
 * 3) 예전에 시트에 있다가 사라진 사용자 → Redis 에서 제거 (관리자가 행 삭제 = 계정 삭제)
 */
const crypto = require('crypto');
const { postHandler, ok, fail } = require('../lib/http');
const { syncWithSheet } = require('../lib/store');

function secretMatches(given) {
  const expected = process.env.SYNC_SECRET || '';
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = postHandler(async (req, res, b) => {
  if (!process.env.SYNC_SECRET) {
    return fail(res, '서버 설정 오류: SYNC_SECRET 환경 변수가 없습니다.', [], 500);
  }
  if (!secretMatches(req.headers['x-sync-secret'])) {
    return fail(res, '인증에 실패했습니다.', [], 401);
  }
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const result = await syncWithSheet(rows);
  return ok(res, result);
});
