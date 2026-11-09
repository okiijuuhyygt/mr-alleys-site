/* api.js — 線上寫歌課前端共用：API 位址、fetch、錯誤訊息
 *
 * API 位址：本機（localhost／127.0.0.1）打 wrangler dev 的 8787，其他一律打正式 API。
 * 正式 API 要跟 worker/wrangler.toml 的 production 一致（2026-11-09 起放在 workers.dev）。
 *
 * 登入：API 在 workers.dev、網站在 mralleys.com，是跨站，Safari 會擋 cookie。
 * 所以登入成功時把 token 存在這台的 localStorage，之後每個請求用 X-MA-Session header 帶（cookie 照樣送，有就用）。
 */
(function () {
  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var API_BASE = local ? 'http://localhost:8787' : 'https://mralleys-course-api.mralleys.workers.dev';
  var TOKEN_KEY = 'ma_course_session';

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }
  function withSession(headers) {
    var t = getToken();
    if (t) headers['X-MA-Session'] = t;
    return headers;
  }

  var MESSAGES = {
    invalid_email: 'email 格式好像不對，再檢查一次。',
    must_agree: '請先勾選「我已閱讀退款說明」。',
    already_paid: '這個 email 已經預購過了，不用再付一次。如果有問題，寫信到 hao@mralleys.com。',
    preorder_closed: '預購目前沒有開放。',
    payment_not_ready: '線上付款還在設定中，暫時不能付款。想先預購的話寫信到 hao@mralleys.com，我們會回覆你。',
    trial_closed: '預購期間先不開放試看，課程上線時一起開放。',
    rate_limited: '操作太頻繁了，請稍等一段時間（最多約 1 小時）再試一次。',
    email_failed: '驗證碼信寄不出去，請過幾分鐘再試；一直不行的話寫信到 hao@mralleys.com。',
    invalid: '驗證碼不對，再檢查一次；或重新寄一組。',
    expired: '這組驗證碼過期了（10 分鐘有效），請重新寄一組。',
    too_many_attempts: '錯太多次了，這組驗證碼已經失效，請重新寄一組。',
    replaced: '你的帳號在另一台裝置登入了，這台已經自動登出。',
    expired_session: '登入已經過期，請重新登入。',
    no_access: '這個帳號目前沒有看課權限。如果有疑問，寫信到 hao@mralleys.com。',
    course_not_open: '課程還沒上線，上線那天會寄信通知你。',
    video_not_ready: '這一集還在準備中。',
    locked: '這一集要購買課程才看得到。',
    unknown_video: '找不到這一集，可能已經下架了。',
    homework_empty: '寫點文字或附一個檔案再送出。',
    file_too_large: '檔案太大了（上限 20 MB）。錄音可以先轉成 m4a 或 mp3 再交。',
    file_type: '這種檔案收不了。錄音、影片、照片、PDF、文字檔都可以。',
    text_too_long: '文字太長了（上限 5,000 字），可以分兩次交，或存成檔案附上。',
    upload_unavailable: '目前收不了檔案，可以先只交文字，或寫信到 hao@mralleys.com。',
    unknown_unit: '找不到這個單元。',
    unauthorized: '後台密碼不對。',
    network: '連不上伺服器，請確認網路後再試一次。',
    server_error: '伺服器出了點問題，請過幾分鐘再試。',
  };

  function message(code) {
    return MESSAGES[code] || MESSAGES.server_error;
  }

  /** @returns {Promise<{ok:boolean,status:number,data:any}>} */
  function call(method, path, body) {
    var opt = { method: method, credentials: 'include', headers: withSession({}) };
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

  /** 交作業：multipart（不要自己設 Content-Type，瀏覽器會帶 boundary） */
  function upload(path, formData) {
    return fetch(API_BASE + path, { method: 'POST', credentials: 'include', headers: withSession({}), body: formData }).then(
      function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      },
      function () { return { ok: false, status: 0, data: { error: 'network' } }; }
    );
  }

  /** 後台：帶 Bearer token，不帶 cookie */
  function admin(method, path, token, body, raw) {
    var opt = { method: method, headers: { Authorization: 'Bearer ' + token } };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, opt).then(
      function (res) {
        if (raw) return res;
        return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      },
      function () { return raw ? null : { ok: false, status: 0, data: { error: 'network' } }; }
    );
  }

  /** 學員區頁面用：沒登入就帶著原因跳回登入頁 */
  function requireLogin(prefix) {
    return call('GET', '/api/session').then(function (r) {
      if (r.ok) return r.data;
      var reason = r.data && r.data.error;
      if (r.status === 0) throw new Error('network');
      setToken('');
      var q = reason === 'replaced' ? '?reason=replaced' : reason === 'expired' ? '?reason=expired_session' : reason === 'no_access' ? '?reason=no_access' : '';
      location.replace((prefix || '') + 'login.html' + q);
      return new Promise(function () {});
    });
  }

  function logout() {
    return call('POST', '/api/auth/logout').then(function () { setToken(''); location.replace('login.html'); });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  window.MACourse = { API_BASE: API_BASE, setToken: setToken, call: call, upload: upload, admin: admin, message: message, requireLogin: requireLogin, logout: logout, el: el };
})();
