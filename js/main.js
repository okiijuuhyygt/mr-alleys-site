/* =========================================================
   巷弄故事館 · MR. ALLEYS — main.js
   v0.1 MVP
   ========================================================= */

let CONTENT = null;
let CURRENT_SERVICE = null;

// ---------------------------------------------------------
// Boot
// ---------------------------------------------------------
async function boot() {
  try {
    const res = await fetch('content.json?_=' + Date.now());
    CONTENT = await res.json();
  } catch (err) {
    console.error('[mr-alleys] failed to load content.json', err);
    document.body.innerHTML = '<pre style="padding:40px;color:#f0e6d2;background:#14100c;font-family:monospace;">⚠ content.json 載入失敗。請檢查路徑與 JSON 格式。</pre>';
    return;
  }
  renderConsoleBar();
  renderMarquee();
  renderHero();
  renderServices();
  renderProcess();
  renderAbout();
  renderShowcase();
  renderContact();
  renderFooter();
  renderBgm();
  bindModal();
  bindReveal();
}

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
function $(id) { return document.getElementById(id); }
function setText(id, text) { const el = $(id); if (el) el.textContent = text; }
function setAttr(id, attr, value) { const el = $(id); if (el) el.setAttribute(attr, value); }

function statusForService(svc) {
  // per-service override wins
  if (svc.statusLabel) {
    return { label: svc.statusLabel, className: svc.statusClass || '' };
  }
  // mode-based fallback (中文化)
  if (svc.mode === 'paid' && svc.checkoutUrl && !String(svc.checkoutUrl).startsWith('PLACEHOLDER')) {
    return { label: '可預約', className: '' };
  }
  if (svc.mode === 'paid') {
    return { label: '設定中', className: 'service-card__status--soon' };
  }
  if (svc.mode === 'pre-order') {
    return { label: '預售中', className: 'service-card__status--quote' };
  }
  if (svc.mode === 'quote') {
    return { label: '諮詢報價', className: 'service-card__status--quote' };
  }
  return { label: '—', className: 'service-card__status--soon' };
}

// ---------------------------------------------------------
// Console top bar
// ---------------------------------------------------------
function renderConsoleBar() {
  const m = CONTENT.meta || {};
  setText('brandCode', m.studioCode || 'STUDIO');
  setText('brandNameEn', m.brandNameEn || 'MR. ALLEYS');
  setText('brandEst', m.established || '');
  setText('brandVersion', m.version || '');
}

// ---------------------------------------------------------
// Hero
// ---------------------------------------------------------
function renderHero() {
  const m = CONTENT.meta || {};
  const h = CONTENT.hero || {};
  setText('heroTitleZh', m.brandName || '巷弄故事館');
  setText('heroTitleEn', m.brandNameEn || 'MR. ALLEYS');
  setText('heroSub', m.subtagline || '');
  setText('heroCtaPrimary', h.ctaPrimary || '▶ 開始');
  setText('heroCtaSecondary', h.ctaSecondary || '↓ 看服務');
  setText('heroEyebrow', '— ' + (m.tagline || '音樂製作工作室') + ' —');

  const flow = $('signalFlow');
  flow.innerHTML = '';
  (h.consoleLines || []).forEach(line => {
    const div = document.createElement('div');
    div.className = 'signal-flow__line';
    div.textContent = line;
    flow.appendChild(div);
  });
}

// ---------------------------------------------------------
// Services grid
// ---------------------------------------------------------
function renderServices() {
  const grid = $('servicesGrid');
  grid.innerHTML = '';
  (CONTENT.services || []).forEach((svc) => {
    const status = statusForService(svc);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'service-card reveal';
    card.dataset.serviceId = svc.id;
    card.setAttribute('aria-label', svc.title);

    card.innerHTML = `
      <div class="service-card__head">
        <span class="service-card__code">${svc.code || ''}</span>
        <span class="service-card__status ${status.className}">${status.label}</span>
      </div>
      <h3 class="service-card__title">${svc.title}</h3>
      <p class="service-card__sub">${svc.subtitle || ''}</p>
      <div class="service-card__foot">
        <span class="service-card__price">${svc.priceLabel || '—'}</span>
        <span class="service-card__cta">${svc.ctaLabel || '→ 詳情'}</span>
      </div>
    `;
    card.addEventListener('click', () => openServiceModal(svc.id));
    grid.appendChild(card);
  });
}

// ---------------------------------------------------------
// Process steps
// ---------------------------------------------------------
function setSubFromHeadline(id, headline) {
  const parts = (headline || '').split('—');
  const zh = (parts[1] || '').trim();
  setText(id, zh ? '— ' + zh + ' —' : '');
}

function renderProcess() {
  const p = CONTENT.process || {};
  setText('processHeadline', (p.headline || 'SIGNAL FLOW').split('—')[0].trim());
  setSubFromHeadline('processSub', p.headline);
  const wrap = $('processSteps');
  wrap.innerHTML = '';
  (p.steps || []).forEach(s => {
    const div = document.createElement('div');
    div.className = 'process-step reveal';
    div.innerHTML = `
      <div class="process-step__num">${s.step}</div>
      <h4 class="process-step__title">${s.title}</h4>
      <p class="process-step__desc">${s.desc}</p>
    `;
    wrap.appendChild(div);
  });
}

// ---------------------------------------------------------
// About
// ---------------------------------------------------------
function renderAbout() {
  const a = CONTENT.about || {};
  const headline = (a.headline || 'WORKSHOP NOTES').split('—')[0].trim();
  setText('aboutHeadline', headline);
  setSubFromHeadline('aboutSub', a.headline);

  const m = $('aboutManifesto');
  m.innerHTML = '';
  (a.manifesto || []).forEach(line => {
    const p = document.createElement('p');
    p.textContent = line;
    m.appendChild(p);
  });

  const stats = $('aboutStats');
  stats.innerHTML = '';
  (a.stats || []).forEach(s => {
    const card = document.createElement('div');
    card.className = 'stat-card reveal';
    card.innerHTML = `
      <span class="stat-card__label">${s.label}</span>
      <div>
        <span class="stat-card__value">${s.value}</span>
        <span class="stat-card__unit">${s.unit || ''}</span>
      </div>
    `;
    stats.appendChild(card);
  });
}

// ---------------------------------------------------------
// Showcase
// ---------------------------------------------------------
function renderShowcase() {
  const s = CONTENT.showcase || {};
  setText('showcaseHeadline', (s.headline || 'ALREADY ON AIR').split('—')[0].trim());
  setSubFromHeadline('showcaseSub', s.headline);
  setText('showcaseIntro', s.intro || '');
  const cta = $('showcaseCta');
  if (s.playlistUrl) {
    cta.href = s.playlistUrl;
    cta.textContent = s.playlistLabel || '▶ 開啟 playlist';
  } else {
    cta.style.display = 'none';
  }
}

// ---------------------------------------------------------
// Contact
// ---------------------------------------------------------
function renderContact() {
  const c = CONTENT.contact || {};
  setSubFromHeadline('contactSub', c.headline);
  setText('contactHeadline', (c.headline || 'TRANSMIT').split('—')[0].trim());
  const email = $('contactEmail');
  if (c.email) {
    email.textContent = c.email;
    email.href = 'mailto:' + c.email;
  }
  const list = $('contactSocials');
  list.innerHTML = '';
  (c.socials || []).forEach(s => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = s.url; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = '→ ' + s.label;
    li.appendChild(a);
    list.appendChild(li);
  });
}

// ---------------------------------------------------------
// Footer
// ---------------------------------------------------------
function renderFooter() {
  const f = CONTENT.footer || {};
  setText('footerCredit', f.credit || '');
  setText('footerBuild', f.buildNote || '');
}

// ---------------------------------------------------------
// BGM (Web Audio API, bypasses iOS silent switch, no UI button)
// ---------------------------------------------------------
function renderBgm() {
  const b = CONTENT.bgm || { mode: 'off' };
  if (b.mode === 'off') return;
  const url = b.mode === 'custom' ? (b.customUrl || '') : (b.defaultUrl || '');
  if (!url) return;

  const VOL = 0.4;
  let ctx = null, buffer = null, source = null, gainNode = null;
  let isPlaying = false;
  let heroVisible = true;

  async function ensureBuffer() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    if (buffer) return;
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    buffer = await ctx.decodeAudioData(arr);
  }

  function startSource() {
    if (!ctx || !buffer) return;
    gainNode = ctx.createGain();
    gainNode.gain.value = heroVisible ? VOL : 0;
    gainNode.connect(ctx.destination);
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gainNode);
    source.start(0);
  }

  async function startBgm() {
    if (isPlaying) return;
    try {
      await ensureBuffer();
      startSource();
      isPlaying = true;
    } catch (e) {
      console.error('[bgm] play failed', e);
    }
  }

  // Auto-start on any first user interaction
  const autoStart = () => {
    document.removeEventListener('pointerdown', autoStart);
    document.removeEventListener('touchstart', autoStart);
    document.removeEventListener('scroll', autoStart);
    startBgm();
  };
  document.addEventListener('pointerdown', autoStart, { once: true, passive: true });
  document.addEventListener('touchstart', autoStart, { once: true, passive: true });
  document.addEventListener('scroll', autoStart, { once: true, passive: true });

  // Hero in/out viewport → mute via gain
  const hero = document.getElementById('hero');
  if (hero && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        heroVisible = e.isIntersecting;
        if (gainNode) gainNode.gain.value = heroVisible ? VOL : 0;
      });
    }, { threshold: 0.2 });
    observer.observe(hero);
  }
}

// ---------------------------------------------------------
// Marquee top bar (admin toggleable via content.json)
// ---------------------------------------------------------
function renderMarquee() {
  const m = CONTENT.marquee || {};
  const el = $('marquee');
  const track = $('marqueeTrack');
  if (!el || !track) return;

  // items: support array or newline-string (admin textarea may save either)
  let items = m.items;
  if (typeof items === 'string') items = items.split(/\r?\n/);
  items = (Array.isArray(items) ? items : []).map(s => String(s || '').trim()).filter(Boolean);

  // enabled accepts true / "true"
  const enabled = m.enabled === true || m.enabled === 'true';

  if (!enabled || items.length === 0) {
    el.hidden = true;
    return;
  }

  el.hidden = false;
  // Repeat 2x for seamless loop coverage on wide screens
  const sep = '  ●  ';
  const text = items.join(sep) + sep + items.join(sep) + sep;
  track.textContent = text;

  const speed = parseInt(m.speed) || 28;
  track.style.setProperty('--marquee-speed', `${speed}s`);
}

// ---------------------------------------------------------
// Service modal
// ---------------------------------------------------------
function openServiceModal(id) {
  const svc = (CONTENT.services || []).find(s => s.id === id);
  if (!svc) return;
  CURRENT_SERVICE = svc;

  setText('modalCode', svc.code || '');
  setText('modalTitle', svc.title || '');
  setText('modalSub', svc.subtitle || '');
  setText('modalDesc', svc.description || '');
  setText('modalDuration', svc.duration || '—');
  setText('modalDeliverable', svc.deliverable || '—');
  setText('modalPrice', svc.priceLabel || '—');
  setText('modalPriceNote', svc.priceNote || '');

  const list = $('modalIncludes');
  list.innerHTML = '';
  (svc.includes || []).forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  });

  const checkout = $('modalCheckout');
  const soon = $('modalSoon');
  soon.hidden = true;
  checkout.disabled = false;
  checkout.style.display = '';

  if (svc.mode === 'paid' && svc.checkoutUrl && !String(svc.checkoutUrl).startsWith('PLACEHOLDER')) {
    checkout.textContent = svc.ctaLabel || '▶ 前往結帳';
    checkout.onclick = () => window.open(svc.checkoutUrl, '_blank', 'noopener');
  } else if (svc.mode === 'quote' && svc.quoteFormUrl) {
    checkout.textContent = svc.ctaLabel || '→ 索取報價';
    checkout.onclick = () => window.open(svc.quoteFormUrl, '_blank', 'noopener');
  } else if (svc.mode === 'pre-order') {
    checkout.textContent = '→ 留 email 候補';
    checkout.disabled = true;
    soon.hidden = false;
    soon.textContent = svc.preOrderText || '排程整理中，請來信 ' + (CONTENT.contact?.email || '');
  } else {
    // Paid but URL not configured yet
    checkout.disabled = true;
    checkout.textContent = '結帳系統建置中';
    soon.hidden = false;
    soon.textContent = svc.preOrderText || '結帳設定中，請先 email 預約：' + (CONTENT.contact?.email || '');
  }

  // Notion link
  const notionLink = $('modalNotionLink');
  if (svc.notionUrl) {
    notionLink.href = svc.notionUrl;
    notionLink.textContent = '↗ Notion 完整介紹';
    notionLink.hidden = false;
  } else {
    notionLink.hidden = true;
  }

  // Coupon button (only show if service.discount is configured)
  const couponBtn = $('modalCoupon');
  if (couponBtn) {
    const d = svc.discount;
    const enabled = d && (d.enabled === true || d.enabled === 'true');
    if (enabled && d.code && d.discountedUrl) {
      couponBtn.hidden = false;
      couponBtn.textContent = d.buttonLabel || '🎟️ 我有優惠碼';
      couponBtn.onclick = () => openCouponDialog(svc);
    } else {
      couponBtn.hidden = true;
      couponBtn.onclick = null;
    }
  }

  const modal = $('serviceModal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

// ---------------------------------------------------------
// Coupon dialog (優惠碼輸入 → 對碼後跳優惠版 ECPay URL)
// ---------------------------------------------------------
function openCouponDialog(svc) {
  const dialog = $('couponDialog');
  const input = $('couponInput');
  const feedback = $('couponFeedback');
  const apply = $('couponApply');
  const cancel = $('couponCancel');
  if (!dialog || !input || !feedback) return;

  const d = (svc && svc.discount) || {};
  input.value = '';
  feedback.textContent = '';
  feedback.className = 'coupon-dialog__feedback';

  if (typeof dialog.showModal === 'function') {
    try { dialog.showModal(); } catch (e) { dialog.setAttribute('open', ''); }
  } else {
    dialog.setAttribute('open', '');
  }
  setTimeout(() => input.focus(), 50);

  const closeIt = () => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  };

  const tryApply = () => {
    const userCode = input.value.trim().toUpperCase();
    const validCode = String(d.code || '').trim().toUpperCase();
    if (!userCode) {
      feedback.textContent = '請輸入優惠碼';
      feedback.className = 'coupon-dialog__feedback';
      return;
    }
    if (userCode === validCode) {
      feedback.textContent = d.successMessage || '優惠碼有效，跳到優惠價結帳...';
      feedback.className = 'coupon-dialog__feedback is-success';
      setTimeout(() => {
        closeIt();
        window.open(d.discountedUrl, '_blank', 'noopener');
      }, 700);
    } else {
      feedback.textContent = d.wrongCodeMessage || '優惠碼無效，請確認後再試';
      feedback.className = 'coupon-dialog__feedback';
    }
  };

  apply.onclick = tryApply;
  cancel.onclick = closeIt;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); tryApply(); }
  };
}

function closeServiceModal() {
  const modal = $('serviceModal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  CURRENT_SERVICE = null;
}

function bindModal() {
  $('modalClose').addEventListener('click', closeServiceModal);
  $('serviceModal').addEventListener('click', (e) => {
    if (e.target.id === 'serviceModal') closeServiceModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('serviceModal').classList.contains('open')) {
      closeServiceModal();
    }
  });
}

// ---------------------------------------------------------
// Reveal on scroll
// ---------------------------------------------------------
function bindReveal() {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        en.target.classList.add('in');
        io.unobserve(en.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
}

// ---------------------------------------------------------
// Go
// ---------------------------------------------------------
boot();
