/**
 * POST /api/status
 * body: { id }
 * 권한 대기 화면의 "권한 상태 다시 확인" 용. 활성 여부만 돌려줍니다.
 */
const { postHandler, ok, fail } = require('../lib/http');
const { findUserById, str } = require('../lib/sheets');

module.exports = postHandler(async (req, res, b) => {
  const user = await findUserById(str(b.id));
  if (!user) return fail(res, '등록 정보를 찾을 수 없습니다.');
  return ok(res, { activate: user.activate, permission: user.permission, name: user.name });
});
