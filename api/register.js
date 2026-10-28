/**
 * POST /api/register
 * body: { name, id, password, permission }
 * [권한 신청하기] — 필수/형식 검증 후 시트에 한 행 추가 (activate 비움 = 권한 대기)
 */
const { postHandler, ok, fail, validateRegistration } = require('../lib/http');
const { findUserById, appendUser, str } = require('../lib/sheets');

module.exports = postHandler(async (req, res, b) => {
  const payload = {
    name: str(b.name),
    id: str(b.id),
    password: str(b.password),
    permission: str(b.permission)
  };

  const invalid = validateRegistration(payload);
  if (invalid.length) {
    return fail(res, '필수 문항 작성이 필요합니다.', invalid);
  }

  if (await findUserById(payload.id)) {
    return fail(res, '이미 등록된 아이디입니다. 다른 아이디를 사용해 주세요.', ['id']);
  }

  await appendUser(payload);
  return ok(res, { name: payload.name, id: payload.id, permission: payload.permission });
});
