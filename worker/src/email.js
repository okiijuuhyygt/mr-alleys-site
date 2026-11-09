// email.js — 寄信（Resend 或 Gmail API，可設定）＋信件內容
//
// EMAIL_PROVIDER = resend（預設）| gmail
// EMAIL_MODE = send | log（＝dry-run，也可以寫 dry-run）：log 時不寄，只印在 wrangler dev 的終端機
//   （本機測試用，驗證碼、交作業通知都會直接印出來）。
// 金鑰沒設也會退回 dry-run；但正式環境（ECPAY_ENV=prod）沒設會直接報錯，不會默默不寄。
//
// Gmail API 要的 secret（OAuth「網頁應用程式」用戶端＋該帳號的 refresh token，scope 只要 gmail.send）：
//   GMAIL_CLIENT_ID、GMAIL_CLIENT_SECRET、GMAIL_REFRESH_TOKEN
//   GMAIL_SENDER：寄件地址（要是授權的那個帳號或它的別名），沒設就用 EMAIL_FROM

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const isDryRun = (env) => env.EMAIL_MODE === 'log' || env.EMAIL_MODE === 'dry-run';

function providerOf(env) {
  return env.EMAIL_PROVIDER === 'gmail' ? 'gmail' : 'resend';
}

function providerReady(env) {
  if (providerOf(env) === 'gmail') return Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
  return Boolean(env.RESEND_API_KEY);
}

/**
 * @param {Record<string,string>} env
 * @param {{to:string, subject:string, text:string, html:string}} msg
 * @param {typeof fetch} [fetchImpl] 測試時換掉
 */
export async function sendEmail(env, msg, fetchImpl = fetch) {
  if (isDryRun(env) || !providerReady(env)) {
    if (env.ECPAY_ENV === 'prod' && !isDryRun(env)) throw new Error(`${providerOf(env)} credentials missing in production`);
    // 正式環境預設不准 dry-run；寄信授權還沒好、要先上線時，明確設 EMAIL_DRY_RUN_IN_PROD=true 才放行（信只印在 wrangler tail）
    if (env.ECPAY_ENV === 'prod' && env.EMAIL_DRY_RUN_IN_PROD !== 'true') throw new Error('EMAIL_MODE=log is not allowed in production');
    console.log(`[email:dry-run] provider=${providerOf(env)} to=${msg.to} subject=${msg.subject}\n${msg.text}`);
    return { logged: true };
  }
  if (providerOf(env) === 'gmail') return sendViaGmail(env, msg, fetchImpl);
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [msg.to],
      reply_to: env.EMAIL_REPLY_TO || undefined,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------- Gmail API

function utf8Base64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const b64url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${utf8Base64(s)}?=`);
const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const noCrlf = (s) => String(s || '').replace(/[\r\n]/g, ' ');

/** 「巷弄故事館 <a@b.com>」→ { name, address } */
export function parseAddress(s) {
  const m = String(s || '').match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, ''), address: m[2].trim() } : { name: '', address: String(s || '').trim() };
}

/** 組 RFC 2822 信件（multipart/alternative，純文字＋HTML），回 Gmail 要的 base64url raw */
export function buildMimeRaw({ from, to, replyTo, subject, text, html, boundary = `ma_${Date.now().toString(36)}` }) {
  const f = parseAddress(from);
  const lines = [
    `From: ${f.name ? `${encWord(noCrlf(f.name))} ` : ''}<${noCrlf(f.address)}>`,
    `To: ${noCrlf(to)}`,
    ...(replyTo ? [`Reply-To: ${noCrlf(replyTo)}`] : []),
    `Subject: ${encWord(noCrlf(subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8Base64(text || '')),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8Base64(html || '')),
    `--${boundary}--`,
    '',
  ];
  return b64url(utf8Base64(lines.join('\r\n')));
}

async function sendViaGmail(env, msg, fetchImpl) {
  const tok = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!tok.ok) throw new Error(`gmail token ${tok.status}: ${await tok.text()}`);
  const { access_token: accessToken } = await tok.json();
  const raw = buildMimeRaw({
    from: env.GMAIL_SENDER || env.EMAIL_FROM,
    to: msg.to,
    replyTo: env.EMAIL_REPLY_TO,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
  const res = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`gmail send ${res.status}: ${await res.text()}`);
  return res.json();
}

const wrap = (inner) => `<!doctype html><html lang="zh-Hant"><body style="margin:0;background:#f3ead4;color:#2a1f12;font-family:'Noto Sans TC','PingFang TC',sans-serif;line-height:1.85">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
<div style="font-size:12px;letter-spacing:2px;color:#6e4d10;margin-bottom:14px">MR.ALLEYS · 寫歌課</div>
${inner}
<p style="color:#8a7556;font-size:12px;margin-top:28px">巷弄故事館 · MR. ALLEYS｜有任何問題直接回這封信就好。</p>
</div></body></html>`;

/** @param {{code:string}} o */
export function loginCodeEmail({ code }) {
  const subject = `你的登入驗證碼：${code}`;
  const text = `你的登入驗證碼是：${code}\n\n10 分鐘內有效，只能用一次。\n如果不是你本人要求的，不用理會這封信。\n\n巷弄故事館 · MR. ALLEYS`;
  const html = wrap(`<p>你的登入驗證碼是：</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:700;color:#6e4d10;margin:8px 0 16px">${esc(code)}</p>
<p>10 分鐘內有效，只能用一次。</p>
<p style="color:#5e4a30;font-size:14px">如果不是你本人要求的，不用理會這封信。</p>`);
  return { subject, text, html };
}

/**
 * @param {{name?:string, merchantTradeNo:string, amount:number, launchText:string, refundDeadlineText:string, siteOrigin:string}} o
 */
export function preorderPaidEmail({ name, merchantTradeNo, amount, launchText, refundDeadlineText, siteOrigin }) {
  const hi = name ? `${name}，你好：` : '你好：';
  const loginUrl = `${siteOrigin}/course-online/learn/login.html`;
  const subject = '預購完成：寫歌課・線上第一期';
  const text = `${hi}

謝謝你預購「寫歌課・線上第一期」。這封信是你的付款確認，請留著。

訂單編號：${merchantTradeNo}
金額：NT$${amount.toLocaleString('en-US')}
上線時間：${launchText}

上線那天會再寄信通知你。到時候用這個 email 登入就能看課，不用設密碼：
${loginUrl}

退款說明：如果課程沒有開課，或到 ${refundDeadlineText} 還沒上線，你可以申請全額退款，直接回這封信就好。

巷弄故事館 · MR. ALLEYS`;
  const html = wrap(`<p>${esc(hi)}</p>
<p>謝謝你預購「寫歌課・線上第一期」。這封信是你的付款確認，請留著。</p>
<table style="border-collapse:collapse;margin:10px 0 16px;font-size:15px">
<tr><td style="padding:4px 14px 4px 0;color:#5e4a30">訂單編號</td><td>${esc(merchantTradeNo)}</td></tr>
<tr><td style="padding:4px 14px 4px 0;color:#5e4a30">金額</td><td>NT$${esc(amount.toLocaleString('en-US'))}</td></tr>
<tr><td style="padding:4px 14px 4px 0;color:#5e4a30">上線時間</td><td>${esc(launchText)}</td></tr>
</table>
<p>上線那天會再寄信通知你。到時候用這個 email 登入就能看課，不用設密碼：<br><a href="${esc(loginUrl)}" style="color:#1f5b8b">${esc(loginUrl)}</a></p>
<p style="background:#ede2c4;border-left:4px solid #b8801f;padding:10px 14px;font-size:14px;color:#5e4a30">退款說明：如果課程沒有開課，或到 ${esc(refundDeadlineText)} 還沒上線，你可以申請全額退款，直接回這封信就好。</p>`);
  return { subject, text, html };
}

/** 給老闆的通知（選用：設了 OWNER_NOTIFY_EMAIL 才寄） */
export function ownerNotifyEmail({ email, name, merchantTradeNo, amount, paidCount }) {
  const subject = `線上課預購 +1（目前 ${paidCount} 筆）`;
  const text = `新的預購：${name || '（未填稱呼）'} <${email}>\n訂單：${merchantTradeNo}\n金額：NT$${amount}\n目前已付款：${paidCount} 筆`;
  return { subject, text, html: wrap(`<pre style="font-family:inherit;white-space:pre-wrap">${esc(text)}</pre>`) };
}

/**
 * 交作業通知（寄給我們：HOMEWORK_NOTIFY_EMAIL，沒設就用 OWNER_NOTIFY_EMAIL）
 * @param {{id:string, email:string, name?:string|null, unitNo:number, unitTitle:string, body?:string|null,
 *          fileName?:string|null, fileSize?:number|null, adminUrl:string, createdText:string}} o
 */
export function homeworkNotifyEmail({ id, email, name, unitNo, unitTitle, body, fileName, fileSize, adminUrl, createdText }) {
  const who = name ? `${name} <${email}>` : email;
  const subject = `交作業：第 ${unitNo} 單元｜${name || email}`;
  const n = Number(fileSize || 0);
  const size = n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  const file = fileName ? `${fileName}（${size}）` : '（沒有附檔）';
  const text = `${who} 交了第 ${unitNo} 單元「${unitTitle}」的作業。

時間：${createdText}
附檔：${file}

文字：
${body || '（沒有寫文字）'}

到後台聽檔案、標記已回覆：
${adminUrl}

作業編號：${id}`;
  const html = wrap(`<p><b>${esc(who)}</b> 交了第 ${esc(unitNo)} 單元「${esc(unitTitle)}」的作業。</p>
<table style="border-collapse:collapse;margin:6px 0 14px;font-size:15px">
<tr><td style="padding:4px 14px 4px 0;color:#5e4a30">時間</td><td>${esc(createdText)}</td></tr>
<tr><td style="padding:4px 14px 4px 0;color:#5e4a30">附檔</td><td>${esc(file)}</td></tr>
</table>
<div style="background:#fffdf4;border:2px solid #2a1f12;padding:12px 14px;white-space:pre-wrap">${esc(body || '（沒有寫文字）')}</div>
<p style="margin-top:16px"><a href="${esc(adminUrl)}" style="color:#1f5b8b">到後台聽檔案、標記已回覆</a></p>
<p style="color:#8a7556;font-size:12px">作業編號：${esc(id)}</p>`);
  return { subject, text, html };
}
