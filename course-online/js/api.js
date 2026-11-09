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
  // 導師身份：這台瀏覽器登入過後台（/course-online/admin/ 存的密碼）就一起帶，API 對了就全部解鎖（只讀，不算學員）
  // 訪客模式：導師在這個分頁切成「訪客看」＝不帶後台密碼、也不帶學員登入，畫面跟沒買的人一模一樣（存在 sessionStorage，只影響這個分頁）
  var ADMIN_KEY = 'ma-course-admin-token-v1';
  var VISITOR_KEY = 'ma-tutor-visitor';
  function adminToken() {
    try { return localStorage.getItem(ADMIN_KEY) || ''; } catch (e) { return ''; }
  }
  function visitorMode() {
    try { return sessionStorage.getItem(VISITOR_KEY) === '1'; } catch (e) { return false; }
  }
  function setVisitorMode(on) {
    try { if (on) sessionStorage.setItem(VISITOR_KEY, '1'); else sessionStorage.removeItem(VISITOR_KEY); } catch (e) {}
    location.reload();
  }
  function withSession(headers) {
    if (visitorMode() && adminToken()) return headers; // 訪客模式：什麼身份都不帶
    var t = getToken();
    if (t) headers['X-MA-Session'] = t;
    var a = adminToken();
    if (a) headers['X-MA-Admin'] = a;
    return headers;
  }

  /**
   * 前台頁面最上面的小字＋切換鈕（學員看不到）：
   *   API 確認是導師 → 「導師身份：所有集數已解鎖」＋「切成訪客看」
   *   導師切成訪客 → 「訪客模式」＋「切回導師」
   * @param {{adminPreview?: boolean}} d /api/course 的回應
   */
  function tutorBar(d) {
    var tutor = Boolean(d && d.adminPreview);
    var visitor = !tutor && visitorMode() && Boolean(adminToken());
    if (!tutor && !visitor) return;
    var old = document.getElementById('tutorBar');
    if (old) old.remove();
    var b = document.createElement('div');
    b.id = 'tutorBar';
    b.setAttribute('data-mode', tutor ? 'tutor' : 'visitor');
    b.style.cssText = 'position:sticky;top:0;z-index:20;background:' + (tutor ? '#2a1f12' : '#6e4d10') + ';color:#f3ead4;font-size:13px;line-height:1.4;padding:6px 12px;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;justify-content:center;text-align:center;border-bottom:3px solid #b8801f;';
    var t = document.createElement('span');
    t.textContent = tutor ? '導師身份：所有集數已解鎖（學員看不到這條）' : '訪客模式：現在看到的是沒登入、沒購買的訪客畫面（學員看不到這條）';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'tutorToggle';
    btn.textContent = tutor ? '切成訪客看' : '切回導師';
    btn.style.cssText = 'font:inherit;font-size:12px;padding:3px 10px;background:#f3ead4;color:#2a1f12;border:1px solid #d4a13a;cursor:pointer;';
    btn.addEventListener('click', function () { setVisitorMode(tutor); });
    b.appendChild(t);
    b.appendChild(btn);
    document.body.insertBefore(b, document.body.firstChild);
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

  /**
   * 這台存著登入、但 API 說沒登入：多半是帳號在另一台裝置登入後這台被登出了，或登入過期。
   * 問一次原因、清掉這台存的登入，回要顯示的訊息代碼（replaced／no_access／expired_session）；不是這種情況回 ''。
   * 沒有這一步的話，被登出的學員重新整理只會看到「購買課程」，不知道發生什麼事。
   * @param {{member?: boolean}} d /api/course 的回應
   * @returns {Promise<string>}
   */
  function staleLogin(d) {
    if (!d || d.member || !getToken() || (visitorMode() && adminToken())) return Promise.resolve('');
    return call('GET', '/api/session').then(function (r) {
      if (r.status !== 401) return '';
      setToken('');
      var reason = r.data && r.data.error;
      return reason === 'replaced' ? 'replaced' : reason === 'no_access' ? 'no_access' : 'expired_session';
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

  window.MACourse = { API_BASE: API_BASE, setToken: setToken, tutorBar: tutorBar, call: call, upload: upload, admin: admin, message: message, requireLogin: requireLogin, staleLogin: staleLogin, logout: logout, el: el };
})();
