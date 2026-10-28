/**
 * POST /api/logout   (Authorization: Bearer <token>)
 * 세션 토큰을 폐기합니다. 토큰이 없어도 200 을 돌려줍니다.
 */
const { postHandler, ok, bearerToken } = require('../lib/http');
const { destroySession } = require('../lib/store');

module.exports = postHandler(async (req, res) => {
  await destroySession(bearerToken(req));
  return ok(res, {});
});
