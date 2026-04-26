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
  renderHero();
  renderServices();
  renderProcess();
  renderAbout();
  renderShowcase();
  renderContact();
  renderFooter();
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
  // returns { label, className } based on service mode + checkout url presence
  if (svc.mode === 'paid' && svc.checkoutUrl && !String(svc.checkoutUrl).startsWith('PLACEHOLDER')) {
    return { label: 'AVAILABLE', className: '' };
  }
  if (svc.mode === 'paid') {
    return { label: 'CONFIG PENDING', className: 'service-card__status--soon' };
  }
  if (svc.mode === 'pre-order') {
    return { label: 'PRE-ORDER', className: 'service-card__status--quote' };
  }
  if (svc.mode === 'quote') {
    return { label: 'BY QUOTE', className: 'service-card__status--quote' };
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
function renderProcess() {
  const p = CONTENT.process || {};
  setText('processHeadline', (p.headline || 'SIGNAL FLOW').split('—')[0].trim());
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

  const modal = $('serviceModal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
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
