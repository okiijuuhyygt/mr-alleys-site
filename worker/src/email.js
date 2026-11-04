// email.js — 寄信（Resend）＋信件內容
//
// EMAIL_MODE=log 時不寄，只印在 wrangler dev 的終端機（本機測試用，驗證碼會直接印出來）。
// 正式環境（ECPAY_ENV=prod）沒設 RESEND_API_KEY 會直接報錯，不會默默不寄。

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * @param {Record<string,string>} env
 * @param {{to:string, subject:string, text:string, html:string}} msg
 */
export async function sendEmail(env, msg) {
  if (env.EMAIL_MODE === 'log' || !env.RESEND_API_KEY) {
    if (env.ECPAY_ENV === 'prod') throw new Error('RESEND_API_KEY missing in production');
    console.log(`[email:log] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
    return { logged: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
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
