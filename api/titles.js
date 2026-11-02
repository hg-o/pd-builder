/**
 * POST /api/titles   (로그인 필요: Authorization: Bearer <token>)
 * body.action:
 *   'list'   → { titles: [...], candidates: [...] }   전체 IP + 담당자 후보(Admin/Editor)
 *   'save'   → { id }                                  생성/수정 { id?, name, owners[], status, thumbnail }
 *   'delete' → { deleted: boolean }                    { id }
 *   'detail'      → { title, stages, stories }                 { id }            작품 상세 (IP 단계 + 스토리 목록)
 *   'storyDetail' → { title, stages, story, storyStages, stories }  { id, storyId }  스토리 상세 (스토리 단계)
 *   'saveStage'   → { title, stages, stories }                 { id, stage, fields{}, complete?, uncomplete? }           IP 단계 저장 / 완료 / 완료 취소
 *   'saveStoryStage' → { title, stages, story, storyStages, stories }  { id, storyId, stage, fields{}, complete?, uncomplete? }  스토리 단계
 * 생성/수정/삭제/단계 저장은 Admin, Editor 만 가능. 조회는 승인된 모든 사용자.
 */
const { authHandler, ok, fail } = require('../lib/http');
const { listTitles, listOwnerCandidates, saveTitle, deleteTitle, getTitleDetail, saveStage, getStoryDetail, saveStoryStage, str } = require('../lib/store');

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

  if (action === 'storyDetail') {
    const detail = await getStoryDetail(b.id, b.storyId);
    return ok(res, detail);
  }

  if (!WRITE_ROLES.includes(user.permission)) {
    return fail(res, 'IP 를 추가하거나 수정할 권한이 없습니다. (Admin / Editor 전용)', [], 403);
  }

  if (action === 'saveStage') {
    const result = await saveStage({ id: b.id, stage: b.stage, fields: b.fields, complete: b.complete, uncomplete: b.uncomplete }, user);
    return ok(res, result);
  }

  if (action === 'saveStoryStage') {
    const result = await saveStoryStage({ id: b.id, storyId: b.storyId, stage: b.stage, fields: b.fields, complete: b.complete, uncomplete: b.uncomplete }, user);
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
