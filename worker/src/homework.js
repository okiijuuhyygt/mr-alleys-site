// homework.js — 交作業：文字＋一個檔案（錄音、照片、PDF…）
//
// 文字與檔案資訊存 D1 homework 表；檔案本體存 KV（binding HOMEWORK_FILES）。
// KV 單一值上限 25 MiB，所以檔案上限預設 20 MB（HOMEWORK_MAX_MB 可以調小，不能超過 25）。

export const HOMEWORK_DEFAULTS = {
  maxMb: 20,
  maxBodyChars: 5000,
  perEmailPerDay: 20, // 同一個學員一天最多交 20 次（擋誤觸連按）
};

// 常見的錄音／影片／圖片／文件。副檔名跟 MIME 擇一符合就收。
const EXT_OK = new Set([
  'mp3', 'm4a', 'wav', 'aac', 'ogg', 'oga', 'flac', 'aif', 'aiff', 'caf', 'webm', 'amr', '3gp',
  'mp4', 'mov', 'm4v',
  'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif',
  'pdf', 'txt', 'md', 'doc', 'docx', 'pages', 'rtf',
]);
const MIME_OK = /^(audio|video|image)\/|^application\/pdf$|^text\/plain$/;

export function maxBytes(env) {
  const mb = Math.min(25, Math.max(1, Number(env.HOMEWORK_MAX_MB) || HOMEWORK_DEFAULTS.maxMb));
  return mb * 1024 * 1024;
}

/** 檔名只留安全的字（中文可以），擋路徑與控制字元 */
export function safeFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().slice(-100);
  return cleaned || 'file';
}

export function fileAllowed(name, type) {
  const ext = (String(name).match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase();
  return (ext && EXT_OK.has(ext)) || MIME_OK.test(String(type || ''));
}

export function newHomeworkId() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  return 'hw_' + [...crypto.getRandomValues(new Uint8Array(12))].map((b) => a[b % a.length]).join('');
}

/**
 * 把 multipart/form-data 解析成作業。不寫入任何東西。
 * @returns {Promise<{ok:true, unitId:string, body:string, file:File|null} | {ok:false, error:string, status:number}>}
 */
export async function parseHomeworkForm(request, env) {
  const limit = maxBytes(env);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len && len > limit + 64 * 1024) return { ok: false, error: 'file_too_large', status: 413 };
  if (!/multipart\/form-data/i.test(request.headers.get('Content-Type') || '')) {
    return { ok: false, error: 'bad_request', status: 400 };
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, error: 'bad_request', status: 400 };
  }
  const unitId = String(form.get('unitId') || '');
  const body = String(form.get('body') || '').replace(/\r\n/g, '\n').trim();
  if (body.length > HOMEWORK_DEFAULTS.maxBodyChars) return { ok: false, error: 'text_too_long', status: 400 };
  const f = form.get('file');
  const file = f && typeof f === 'object' && typeof f.arrayBuffer === 'function' && f.size > 0 ? f : null;
  if (!body && !file) return { ok: false, error: 'homework_empty', status: 400 };
  if (file) {
    if (file.size > limit) return { ok: false, error: 'file_too_large', status: 413 };
    if (!fileAllowed(file.name, file.type)) return { ok: false, error: 'file_type', status: 400 };
  }
  return { ok: true, unitId, body, file };
}
