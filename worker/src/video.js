// video.js — Bunny Stream 有效期限的播放網址（Embed View Token Authentication）
//
// 官方公式：token = SHA256_HEX(token_security_key + video_id + expires)
//   https://bunny.net/docs/stream-embed-token-authentication
// expires 是 Unix 秒數。Bunny 後台 Library → Security 要打開「Embed view token authentication」，
// 並在「Allowed domains」只填 mralleys.com（含 localhost 測試時再暫加）。
//
// 要換成 Cloudflare Stream：只要改這支，回傳同樣的 { embedUrl, expiresAt } 就好，
// 前端與路由都不用動（見 ARCHITECTURE.md「影片服務」）。

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
