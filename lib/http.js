/**
 * 서버리스 함수 공용 헬퍼: 응답 형식, 본문 파싱, 검증 규칙
 * 프론트엔드가 기대하는 응답 형식: { ok: true, data } | { ok: false, error, fields }
 */

const PERMISSIONS = ['Admin', 'Editor', 'Viewer'];
const ASCII_TOKEN = /^[A-Za-z0-9!-\/:-@\[-`{-~]+$/; // 영문·숫자·기호(ASCII 출력 가능 문자, 공백 제외)

const RULES = {
  name: (v) => v.length >= 1 && v.length <= 16,
  id: (v) => v.length >= 1 && v.length <= 16 && ASCII_TOKEN.test(v),
  password: (v) => v.length >= 8 && ASCII_TOKEN.test(v),
  permission: (v) => PERMISSIONS.includes(v)
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
      return fail(res, message, [], status);
    }
  };
}

module.exports = { PERMISSIONS, validateRegistration, ok, fail, body, postHandler };
