/**
 * POST /api/login
 * body: { id, password }
 * 아이디/비밀번호가 맞으면 사용자 정보, activate 여부, 세션 토큰을 돌려줍니다.
 * activate 가 TRUE 가 아니면 프론트엔드가 '권한 부여 대기 중입니다.' 화면을 보여줍니다.
 * (토큰은 승인된 사용자에게만 발급되며 IP 관리 API 호출에 사용됩니다)
 */
const { postHandler, ok, fail } = require('../lib/http');
const { findUserById, verifyPassword, createSession, str } = require('../lib/store');

module.exports = postHandler(async (req, res, b) => {
  const id = str(b.id);
  const password = str(b.password);
  if (!id || !password) return fail(res, '아이디와 비밀번호를 입력해 주세요.');

  const user = await findUserById(id);
  if (!user || !verifyPassword(user.password, password)) {
    return fail(res, '아이디 또는 비밀번호가 올바르지 않습니다.');
  }

  const token = user.activate ? await createSession(user.id) : '';
  return ok(res, {
    name: user.name,
    id: user.id,
    permission: user.permission,
    activate: user.activate,
    token
  });
});
