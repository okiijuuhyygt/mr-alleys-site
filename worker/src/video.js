// video.js — 播放網址
//
// 目前用 YouTube 不公開影片，嵌在站內播（2026-11-06 耗耗定：不用 Bunny／Vimeo，不跳 YouTube）。
// 影片 ID 只在 /api/video 確認看得到之後才回給前端，課程結構 /api/course 裡沒有。
//
// 下面的 Bunny Stream 簽名網址是舊方案，留著備用（換回 Bunny 只要改 index.js 的 videoUrl 呼叫哪一支）。

/**
 * youtube-nocookie：使用者按播放前不放 YouTube cookie。
 * rel=0：片尾只推同頻道影片；playsinline=1：iPhone 不強制跳全螢幕。
 * @param {string} youtubeId 11 碼
 * @param {string} [origin] 嵌入頁的網址來源（YouTube IFrame API 建議帶）
 */
export function youtubeEmbedUrl(youtubeId, origin) {
  const qs = new URLSearchParams({ rel: '0', playsinline: '1', modestbranding: '1' });
  if (origin) qs.set('origin', origin);
  return { embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeId)}?${qs}` };
}

// ---------------------------------------------------------------- Bunny（備用）
// 官方公式：token = SHA256_HEX(token_security_key + video_id + expires)
//   https://bunny.net/docs/stream-embed-token-authentication

const EMBED_HOST = 'https://player.mediadelivery.net/embed';

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {string} tokenKey @param {string} videoId @param {number} expiresSec */
export function bunnyToken(tokenKey, videoId, expiresSec) {
  return sha256Hex(`${tokenKey}${videoId}${expiresSec}`);
}

/**
 * @param {object} o
 * @param {string} o.libraryId
 * @param {string} o.videoId   Bunny 的 video GUID
 * @param {string} o.tokenKey  Library 的 Token Authentication Key（secret）
 * @param {number} o.nowMs
 * @param {number} o.ttlSec
 */
export async function signedEmbedUrl({ libraryId, videoId, tokenKey, nowMs, ttlSec }) {
  const expires = Math.floor(nowMs / 1000) + ttlSec;
  const token = await bunnyToken(tokenKey, videoId, expires);
  const qs = new URLSearchParams({
    token,
    expires: String(expires),
    autoplay: 'false',
    preload: 'true',
    responsive: 'true',
  });
  return {
    embedUrl: `${EMBED_HOST}/${encodeURIComponent(libraryId)}/${encodeURIComponent(videoId)}?${qs}`,
    expiresAt: expires * 1000,
  };
}
