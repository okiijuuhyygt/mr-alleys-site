/* api.js — 線上寫歌課前端共用：API 位址、fetch、錯誤訊息
 *
 * API 位址：本機（localhost／127.0.0.1）打 wrangler dev 的 8787，其他一律打正式 API。
 * 正式 API 網域要跟 worker/wrangler.toml 的 production routes 一致。
 */
(function () {
  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var API_BASE = local ? 'http://localhost:8787' : 'https://course-api.mralleys.com';

  var MESSAGES = {
    invalid_email: 'email 格式好像不對，再檢查一次。',
    must_agree: '請先勾選「我已閱讀退款說明」。',
    already_paid: '這個 email 已經預購過了，不用再付一次。如果有問題，寫信到 hao@mralleys.com。',
    preorder_closed: '預購目前沒有開放。',
    rate_limited: '操作太頻繁了，請稍等一段時間（最多約 1 小時）再試一次。',
    email_failed: '驗證碼信寄不出去，請過幾分鐘再試；一直不行的話寫信到 hao@mralleys.com。',
    invalid: '驗證碼不對，再檢查一次；或重新寄一組。',
    expired: '這組驗證碼過期了（10 分鐘有效），請重新寄一組。',
    too_many_attempts: '錯太多次了，這組驗證碼已經失效，請重新寄一組。',
    replaced: '你的帳號在另一台裝置登入了，這台已經自動登出。一個帳號同一時間只能在一台裝置上看。',
    expired_session: '登入已經過期，請重新登入。',
    no_access: '這個帳號目前沒有看課權限。如果有疑問，寫信到 hao@mralleys.com。',
    course_not_open: '課程還沒上線，上線那天會寄信通知你。',
    video_not_ready: '這支影片還在準備中。',
    network: '連不上伺服器，請確認網路後再試一次。',
    server_error: '伺服器出了點問題，請過幾分鐘再試。',
  };

  function message(code) {
    return MESSAGES[code] || MESSAGES.server_error;
  }

  /** @returns {Promise<{ok:boolean,status:number,data:any}>} */
  function call(method, path, body) {
    var opt = { method: method, credentials: 'include', headers: {} };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, opt).then(
      function (res) {
        return res
          .json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      },
      function () { return { ok: false, status: 0, data: { error: 'network' } }; }
    );
  }

  /** 學員區頁面用：沒登入就帶著原因跳回登入頁 */
  function requireLogin(prefix) {
    return call('GET', '/api/session').then(function (r) {
      if (r.ok) return r.data;
      var reason = r.data && r.data.error;
      if (r.status === 0) throw new Error('network');
      var q = reason === 'replaced' ? '?reason=replaced' : reason === 'expired' ? '?reason=expired_session' : reason === 'no_access' ? '?reason=no_access' : '';
      location.replace((prefix || '') + 'login.html' + q);
      return new Promise(function () {});
    });
  }

  function logout() {
    return call('POST', '/api/auth/logout').then(function () { location.replace('login.html'); });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  window.MACourse = { API_BASE: API_BASE, call: call, message: message, requireLogin: requireLogin, logout: logout, el: el };
})();
