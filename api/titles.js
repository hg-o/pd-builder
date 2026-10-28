/**
 * POST /api/titles   (로그인 필요: Authorization: Bearer <token>)
 * body.action:
 *   'list'   → { titles: [...], candidates: [...] }   전체 IP + 담당자 후보(Admin/Editor)
 *   'save'   → { id }                                  생성/수정 { id?, name, owners[], status, thumbnail }
 *   'delete' → { deleted: boolean }                    { id }
 * 생성/수정/삭제는 Admin, Editor 만 가능. 조회는 승인된 모든 사용자.
 */
const { authHandler, ok, fail } = require('../lib/http');
const { listTitles, listOwnerCandidates, saveTitle, deleteTitle, str } = require('../lib/store');

const WRITE_ROLES = ['Admin', 'Editor'];

module.exports = authHandler(async (req, res, b, user) => {
  const action = str(b.action);

  if (action === 'list') {
    const [titles, candidates] = await Promise.all([listTitles(), listOwnerCandidates()]);
    return ok(res, { titles, candidates });
  }

  if (!WRITE_ROLES.includes(user.permission)) {
    return fail(res, 'IP 를 추가하거나 수정할 권한이 없습니다. (Admin / Editor 전용)', [], 403);
  }

  if (action === 'save') {
    const id = await saveTitle({
      id: b.id,
      name: b.name,
      owners: b.owners,
      status: b.status,
      thumbnail: b.thumbnail,
      link: b.link
    }, user.id);
    return ok(res, { id });
  }

  if (action === 'delete') {
    const deleted = await deleteTitle(b.id);
    return ok(res, { deleted });
  }

  return fail(res, '알 수 없는 요청입니다: ' + action, [], 400);
});
