/**
 * POST /api/files   (로그인 필요: Authorization: Bearer <token>) — IP 단계의 첨부 파일
 * body.action:
 *   'upload' → { key, files }   { id, stage, field, name, mime, data(base64) }   Drive 에 저장 후 목록에 추가 (파일당 3MB 이하)
 *   'delete' → { key, files }   { id, stage, field, fileId }                     Drive 휴지통으로 보내고 목록에서 제거
 * 첨부는 Admin, Editor 만 가능. 목록은 titles 의 detail / storyDetail 응답(files)에 포함됩니다.
 * 파일 본체는 Apps Script 웹 앱을 통해 Google Drive 폴더에 저장됩니다 (lib/drive.js).
 */
const { authHandler, ok, fail } = require('../lib/http');
const { uploadStageFile, deleteStageFile, str } = require('../lib/store');

const WRITE_ROLES = ['Admin', 'Editor'];

module.exports = authHandler(async (req, res, b, user) => {
  const action = str(b.action);

  if (!WRITE_ROLES.includes(user.permission)) {
    return fail(res, '파일을 첨부하거나 삭제할 권한이 없습니다. (Admin / Editor 전용)', [], 403);
  }

  if (action === 'upload') {
    const result = await uploadStageFile({ id: b.id, stage: b.stage, field: b.field, name: b.name, mime: b.mime, data: b.data }, user);
    return ok(res, result);
  }

  if (action === 'delete') {
    const result = await deleteStageFile({ id: b.id, stage: b.stage, field: b.field, fileId: b.fileId });
    return ok(res, result);
  }

  return fail(res, '알 수 없는 요청입니다: ' + action, [], 400);
});
