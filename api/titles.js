/**
 * POST /api/titles   (로그인 필요: Authorization: Bearer <token>)
 * body.action:
 *   'list'   → { titles: [...], candidates: [...] }   전체 IP + 담당자 후보(Admin/Editor)
 *   'save'   → { id }                                  생성/수정 { id?, name, owners[], status, thumbnail }
 *   'delete' → { deleted: boolean }                    { id }
 *   'detail' → { title, stages }                       { id }  작품 상세(5단계 데이터 포함)
 *   'saveStage' → { title, stages }                    { id, stage, fields{}, complete?, uncomplete? }  단계 저장 / 완료 / 완료 취소
 * 생성/수정/삭제/단계 저장은 Admin, Editor 만 가능. 조회는 승인된 모든 사용자.
 */
const { authHandler, ok, fail } = require('../lib/http');
const { listTitles, listOwnerCandidates, saveTitle, deleteTitle, getTitleDetail, saveStage, str } = require('../lib/store');

const WRITE_ROLES = ['Admin', 'Editor'];

module.exports = authHandler(async (req, res, b, user) => {
  const action = str(b.action);

  if (action === 'list') {
    const [titles, candidates] = await Promise.all([listTitles(), listOwnerCandidates()]);
    return ok(res, { titles, candidates });
  }

  if (action === 'detail') {
    const detail = await getTitleDetail(b.id);
    return ok(res, detail);
  }

  if (!WRITE_ROLES.includes(user.permission)) {
    return fail(res, 'IP 를 추가하거나 수정할 권한이 없습니다. (Admin / Editor 전용)', [], 403);
  }

  if (action === 'saveStage') {
    const result = await saveStage({ id: b.id, stage: b.stage, fields: b.fields, complete: b.complete, uncomplete: b.uncomplete }, user);
    return ok(res, result);
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
