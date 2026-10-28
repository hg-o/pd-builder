/**
 * 서버리스 함수 공용 헬퍼: 응답 형식, 본문 파싱, 검증 규칙
 * 프론트엔드가 기대하는 응답 형식: { ok: true, data } | { ok: false, error, fields }
 */

const PERMISSIONS = ['Admin', 'Editor', 'Viewer'];
const REGISTER_PERMISSIONS = ['Editor', 'Viewer']; // 가입 신청 시 선택 가능한 권한 (Admin 은 시트에서만 지정)
const ASCII_TOKEN = /^[A-Za-z0-9!-\/:-@\[-`{-~]+$/; // 영문·숫자·기호(ASCII 출력 가능 문자, 공백 제외)

const RULES = {
  name: (v) => v.length >= 1 && v.length <= 16,
  id: (v) => v.length >= 1 && ASCII_TOKEN.test(v), // 길이 제한 없음
  password: (v) => v.length >= 8 && ASCII_TOKEN.test(v),
  permission: (v) => REGISTER_PERMISSIONS.includes(v)
};

function validateRegistration(p) {
  return Object.keys(RULES).filter((k) => !RULES[k](p[k] || ''));
}

function ok(res, data) {
  return res.status(200).json({ ok: true, data: data || {} });
}

function fail(res, error, fields, status) {
  return res.status(status || 200).json({ ok: false, error, fields: fields || [] });
}

/** Vercel 은 application/json 본문을 req.body 로 파싱해 줍니다. 문자열로 올 때도 대비합니다. */
function body(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return req.body;
}

/**
 * POST 전용 핸들러 래퍼. 메서드 검사와 예외 처리를 공통으로 수행합니다.
 */
function postHandler(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return fail(res, 'POST 요청만 허용됩니다.', [], 405);
    }
    try {
      await fn(req, res, body(req));
    } catch (err) {
      console.error('[api]', err);
      const status = err.status || 500;
      const message = status === 500 && !err.status
        ? '서버 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'
        : err.message;
      return fail(res, message, err.fields || [], status);
    }
  };
}

/** Authorization: Bearer <token> 에서 토큰 추출 */
function bearerToken(req) {
  const h = String(req.headers['authorization'] || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

/**
 * 로그인 사용자를 요구하는 핸들러 래퍼. 토큰이 없거나 만료되면 401.
 * fn(req, res, body, user)
 */
function authHandler(fn, opts) {
  const { getSessionUser } = require('./store');
  const allow = (opts && opts.permissions) || null;
  return postHandler(async (req, res, b) => {
    const user = await getSessionUser(bearerToken(req));
    if (!user) return fail(res, '로그인이 필요합니다. 다시 로그인해 주세요.', [], 401);
    if (allow && !allow.includes(user.permission)) return fail(res, '이 작업을 수행할 권한이 없습니다.', [], 403);
    await fn(req, res, b, user);
  });
}

module.exports = { PERMISSIONS, REGISTER_PERMISSIONS, validateRegistration, ok, fail, body, postHandler, authHandler, bearerToken };
