const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const EXPEDIA_TAAP_URL = 'https://www.expediataap.com.br';
const EXPEDIA_USER = process.env.EXPEDIA_USER;
const EXPEDIA_PASS = process.env.EXPEDIA_PASS;

const BUDGET_RANGES = {
  economico: { min: 0, max: 400 },
  moderado: { min: 400, max: 800 },
  confortavel: { min: 800, max: 1500 },
  premium: { min: 1500, max: 3000 },
  luxo: { min: 3000, max: Infinity },
  sem_limite: { min: 0, max: Infinity },
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Try multiple selectors in PARALLEL with a single timeout.
 * Old version: 14 selectors x 15s = 210s worst case.
 * New version: 14 selectors racing = 8s worst case.
 */
async function findElement(page, selectors, timeout = 8000) {
  // Quick instant check first (no waiting)
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) return el;
    } catch {}
  }

  // Race all selectors in parallel with one shared timeout
  return new Promise(resolve => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(null); }
    }, timeout);

    selectors.forEach(sel => {
      page.waitForSelector(sel, { timeout })
        .then(el => {
          if (!resolved && el) {
            resolved = true;
            clearTimeout(timer);
            resolve(el);
          }
        })
        .catch(() => {});
    });
  });
}

/**
 * Quick check with page.$ (instant, no waiting)
 */
async function quickFind(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) return el;
    } catch {}
  }
  return null;
}

/**
 * Find a clickable element by its text content
 */
async function findByText(page, texts) {
  return await page.evaluateHandle((searchTexts) => {
    const all = document.querySelectorAll('a, button, input[type="submit"], input[type="button"]');
    for (const el of all) {
      const t = (el.textContent || el.value || '').trim().toLowerCase();
      for (const search of searchTexts) {
        if (t.includes(search)) return el;
      }
    }
    const links = document.querySelectorAll('a[href*="login"], a[href*="signin"]');
    if (links.length > 0) return links[0];
    return null;
  }, texts);
}

async function searchExpedia(params) {
  const { destino, checkIn, checkOut, adultos, criancas, idadesCriancas, estilos, prioridades, orcamento } = params;
  let browser;

  try {
    console.log('  → Launching browser...');
    chromium.setHeadlessMode = true;
    chromium.setGraphicsMode = false;

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
      ],
      defaultViewport: { width: 1366, height: 768 },
      executablePath: await chromium.executablePath(),
      headless: 'new',
      timeout: 30000,
    });

    console.log('  → Browser launched OK');
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Block heavy resources
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await login(page);

    console.log('  → Searching hotels...');
    const results = await searchHotels(page, { destino, checkIn, checkOut, adultos, criancas, idadesCriancas });
    console.log(`  → ${results.length} raw results`);

    const filtered = filterResults(results, { estilos, prioridades, orcamento });
    console.log(`  → ${filtered.length} after filtering`);
    return filtered;

  } catch (error) {
    console.error('Expedia scraper error:', error.message);
    return [];
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

/**
 * Login flow:
 * 1. Open www.expediataap.com.br
 * 2. Click "Fazer Login" on the central card
 * 3. Fill email + senha
 * 4. Click "Fazer login" submit
 */
async function login(page) {
  if (!EXPEDIA_USER || !EXPEDIA_PASS) {
    throw new Error('Credenciais TAAP não configuradas (.env)');
  }

  // STEP 1: Landing page
  console.log('  → Opening TAAP...');
  await page.goto(EXPEDIA_TAAP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('  → Loaded:', page.url());
  await delay(2000);

  // STEP 2: Click "Fazer Login"
  console.log('  → Clicking "Fazer Login"...');
  const loginHandle = await findByText(page, ['fazer login', 'login', 'entrar', 'acessar']);
  const loginBtn = loginHandle.asElement();

  if (loginBtn) {
    await loginBtn.click();
  } else {
    const fallback = await quickFind(page, ['a[href*="login"]', 'a[href*="signin"]', '.login-btn', 'a.btn-primary']);
    if (fallback) {
      await fallback.click();
    } else {
      throw new Error('Botão "Fazer Login" não encontrado');
    }
  }

  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch {
    await delay(3000);
  }
  console.log('  → Login page:', page.url());
  await delay(1500);

  // STEP 3: Fill email
  console.log('  → Filling email...');
  const emailInput = await findElement(page, [
    'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
    'input[id="email"]', 'input[id="username"]',
    'input[placeholder*="e-mail" i]', 'input[placeholder*="email" i]',
  ], 10000);

  if (!emailInput) {
    // Check iframes
    for (const frame of page.frames()) {
      try {
        const fe = await frame.$('input[type="email"], input[name="email"]');
        if (fe) { await loginInFrame(frame); await delay(5000); return; }
      } catch {}
    }
    throw new Error('Campo de e-mail não encontrado');
  }

  await emailInput.click({ clickCount: 3 });
  await emailInput.type(EXPEDIA_USER, { delay: 20 });
  await delay(300);

  // STEP 3b: Fill password
  console.log('  → Filling password...');
  let passInput = await findElement(page, [
    'input[type="password"]', 'input[name="password"]', 'input[id="password"]',
  ], 5000);

  if (!passInput) {
    await page.keyboard.press('Enter');
    await delay(3000);
    passInput = await findElement(page, ['input[type="password"]'], 8000);
  }
  if (!passInput) throw new Error('Campo de senha não encontrado');

  await passInput.click({ clickCount: 3 });
  await passInput.type(EXPEDIA_PASS, { delay: 20 });
  await delay(300);

  // STEP 4: Submit
  console.log('  → Submitting...');
  const submitHandle = await findByText(page, ['fazer login', 'entrar', 'sign in', 'log in']);
  const submitBtn = submitHandle.asElement();
  if (submitBtn) {
    await submitBtn.click();
  } else {
    const fallbackSubmit = await page.$('button[type="submit"], input[type="submit"]');
    if (fallbackSubmit) await fallbackSubmit.click();
    else await page.keyboard.press('Enter');
  }

  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    await delay(5000);
  }

  console.log('  → After login:', page.url());

  const stillLogin = await page.$('input[type="password"]');
  if (stillLogin) {
    const err = await page.evaluate(() => document.querySelector('.error, .alert, [role="alert"]')?.textContent?.trim() || '');
    if (err) throw new Error(`Login falhou: ${err}`);
    console.warn('  → WARNING: may still be on login page');
  }
  console.log('  → Login OK!');
}

async function loginInFrame(frame) {
  const email = await frame.$('input[type="email"], input[name="email"]');
  if (email) { await email.click({ clickCount: 3 }); await email.type(EXPEDIA_USER, { delay: 20 }); }
  await delay(300);
  const pass = await frame.$('input[type="password"]');
  if (pass) { await pass.click({ clickCount: 3 }); await pass.type(EXPEDIA_PASS, { delay: 20 }); }
  await delay(300);
  const btn = await frame.$('button[type="submit"], input[type="submit"]');
  if (btn) await btn.click();
  await delay(5000);
}

async function searchHotels(page, params) {
  const { destino, checkIn, checkOut, adultos, criancas, idadesCriancas } = params;

  try {
    const destInput = await findElement(page, [
      'input[name="destination"]', 'input[placeholder*="destino" i]',
      'input[placeholder*="Going to" i]', 'input[placeholder*="Para onde" i]',
      '#destination', 'button[data-testid="destination_form_field"]',
    ], 8000);

    if (destInput) {
      console.log('  → Found search form');
      const tag = await page.evaluate(el => el.tagName.toLowerCase(), destInput);
      if (tag === 'button') {
        await destInput.click();
        await delay(800);
        const inner = await page.$('input[type="text"]:focus, input[placeholder*="destino" i]');
        if (inner) await inner.type(destino, { delay: 20 });
      } else {
        await destInput.click({ clickCount: 3 });
        await destInput.type(destino, { delay: 20 });
      }
      await delay(1500);

      const sug = await quickFind(page, [
        'li[role="option"]', '.suggestion-item', '[data-stid="destination-result"]',
        '.typeahead-item', 'ul[role="listbox"] li',
      ]);
      if (sug) { await sug.click(); await delay(800); }

      await fillDates(page, checkIn, checkOut);
      await fillGuests(page, adultos, criancas);

      const searchBtn = await quickFind(page, ['button[type="submit"]', '.search-btn', '#search-btn']);
      if (searchBtn) {
        await searchBtn.click();
        try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }); }
        catch { await delay(5000); }
      }
    } else {
      throw new Error('No search form');
    }
  } catch {
    const url = buildSearchUrl(destino, checkIn, checkOut, adultos, criancas, idadesCriancas);
    console.log('  → Trying URL:', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  await delay(4000);
  await findElement(page, [
    '[data-stid="property-listing"]', '.hotel-card', '.property-listing',
    '.uitk-card', '[data-testid="property-card"]',
  ], 8000);

  return extractHotelListings(page);
}

async function fillDates(page, checkIn, checkOut) {
  for (const sel of ['input[name="checkIn"]', 'input[name="startDate"]', '#check-in']) {
    const el = await page.$(sel);
    if (el) { await el.click({ clickCount: 3 }); await el.type(formatDate(checkIn), { delay: 15 }); break; }
  }
  await delay(200);
  for (const sel of ['input[name="checkOut"]', 'input[name="endDate"]', '#check-out']) {
    const el = await page.$(sel);
    if (el) { await el.click({ clickCount: 3 }); await el.type(formatDate(checkOut), { delay: 15 }); break; }
  }
  await delay(200);
}

async function fillGuests(page, adultos, criancas) {
  const btn = await quickFind(page, ['.guests-btn', '[data-stid="open-room-picker"]', 'button[data-testid="travelers_form_field"]']);
  if (!btn) return;
  await btn.click();
  await delay(500);
  for (const sel of ['input[name="adults"]', '#adults']) {
    const el = await page.$(sel);
    if (el) { await el.click({ clickCount: 3 }); await el.type(String(adultos)); break; }
  }
  if (criancas > 0) {
    for (const sel of ['input[name="children"]', '#children']) {
      const el = await page.$(sel);
      if (el) { await el.click({ clickCount: 3 }); await el.type(String(criancas)); break; }
    }
  }
  const done = await page.$('button[data-testid="guests-done"], .done-btn');
  if (done) await done.click();
  await delay(200);
}

async function extractHotelListings(page) {
  return page.evaluate(() => {
    const hotels = [];
    const sels = ['[data-stid="property-listing"]', '[data-testid="property-card"]', '.hotel-card', '.property-listing', '.uitk-card', '.result-item', '.property-card', 'article[data-hotelid]'];
    let cards = [];
    for (const s of sels) { cards = document.querySelectorAll(s); if (cards.length) break; }
    if (!cards.length) return [];

    cards.forEach((card, i) => {
      if (i >= 15) return;
      let name = '';
      for (const s of ['h2', 'h3', 'h4', '.hotel-name', '.property-name', '[data-stid="content-hotel-title"]']) {
        const e = card.querySelector(s); if (e?.textContent?.trim()) { name = e.textContent.trim(); break; }
      }
      let priceText = '';
      for (const s of ['.price', '.hotel-price', '[data-stid="content-hotel-price"]', '[data-testid="price"]', '.current-price']) {
        const e = card.querySelector(s); if (e?.textContent?.trim()) { priceText = e.textContent.trim(); break; }
      }
      let ratingText = '';
      for (const s of ['.rating', '.review-score', '[data-stid="content-hotel-review-rating"]', '.guest-rating']) {
        const e = card.querySelector(s); if (e?.textContent?.trim()) { ratingText = e.textContent.trim(); break; }
      }
      const img = card.querySelector('img[src*="http"], img[data-src*="http"]');
      const photo = img?.src || img?.dataset?.src || '';
      let location = '';
      for (const s of ['.neighborhood', '.location', '.address', '.subtitle']) {
        const e = card.querySelector(s); if (e?.textContent?.trim()) { location = e.textContent.trim(); break; }
      }
      const pc = priceText.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
      const pricePerNight = parseFloat(pc) || 0;
      const rm = ratingText.match(/[\d.,]+/);
      const rating = rm ? parseFloat(rm[0].replace(',', '.')) : 0;
      if (name) hotels.push({ name, location, rating, pricePerNight, priceTotal: priceText, photos: photo ? [photo] : [], description: '', roomType: 'Standard', amenities: [] });
    });
    return hotels;
  });
}

function filterResults(hotels, { estilos, prioridades, orcamento }) {
  let f = [...hotels];
  const b = BUDGET_RANGES[orcamento] || BUDGET_RANGES.sem_limite;
  if (b.max !== Infinity || b.min > 0) f = f.filter(h => !h.pricePerNight || (h.pricePerNight >= b.min && h.pricePerNight <= b.max));
  if (prioridades?.includes('preco')) f.sort((a, b) => (a.pricePerNight || 999999) - (b.pricePerNight || 999999));
  else f.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return f.slice(0, 10);
}

function buildSearchUrl(destino, checkIn, checkOut, adultos, criancas, idadesCriancas) {
  const p = new URLSearchParams({ destination: destino, startDate: checkIn, endDate: checkOut, adults: String(adultos), children: String(criancas || 0) });
  if (idadesCriancas?.length) p.set('childAges', idadesCriancas.join(','));
  return `${EXPEDIA_TAAP_URL}/hotels?${p}`;
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

module.exports = { searchExpedia };
