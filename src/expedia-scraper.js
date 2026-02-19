const vanillaPuppeteer = require('puppeteer-core');
const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');

// Wrap puppeteer-core with stealth plugin
const puppeteer = addExtra(vanillaPuppeteer);
puppeteer.use(StealthPlugin());

const MAX_RETRIES = 3;

/**
 * Run a promise with a timeout. Rejects if not resolved within `ms`.
 */
function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)),
  ]);
}

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
 * Check if a residential proxy is configured
 */
function isProxyConfigured() {
  return !!(process.env.PROXY_HOST && process.env.PROXY_USER && process.env.PROXY_PASS);
}

/**
 * Generate a random session ID for proxy sticky sessions
 */
function generateSessionId() {
  return 'sess_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

/**
 * Check if page is blocked by CAPTCHA/bot detection
 */
async function isCaptchaPage(page) {
  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      return text.includes('captcha') ||
             text.includes('robô') ||
             text.includes('robot') ||
             text.includes('access denied') ||
             text.includes('blocked') ||
             text.includes('please verify') ||
             text.includes('suspicious') ||
             text.includes('mostre que você') ||
             title.includes('robô') ||
             title.includes('robot');
    });
  } catch {
    return false;
  }
}

async function searchExpedia(params) {
  const { destino, checkIn, checkOut, adultos, criancas, idadesCriancas, estilos, prioridades, orcamento } = params;

  const useProxy = isProxyConfigured();
  const proxyHost = process.env.PROXY_HOST || 'gate.decodo.com';
  const proxyPort = process.env.PROXY_PORT || '7000';
  const proxyUser = process.env.PROXY_USER;
  const proxyPass = process.env.PROXY_PASS;

  // Retry loop — each attempt uses a different proxy session (different IP)
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let browser;
    try {
      const sessionId = generateSessionId();
      console.log(`  → Attempt ${attempt}/${MAX_RETRIES} (proxy: ${useProxy ? proxyHost + ':' + proxyPort : 'none'}, session: ${sessionId})`);

      chromium.setHeadlessMode = true;
      chromium.setGraphicsMode = false;

      const launchArgs = [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--lang=pt-BR,pt,en-US,en',
        '--window-size=1366,768',
      ];

      // Add proxy if configured
      if (useProxy) {
        launchArgs.push(`--proxy-server=http://${proxyHost}:${proxyPort}`);
      }

      browser = await puppeteer.launch({
        args: launchArgs,
        defaultViewport: { width: 1366, height: 768 },
        executablePath: await chromium.executablePath(),
        headless: 'new',
        timeout: 30000,
      });

      console.log('  → Browser launched OK');
      const page = await browser.newPage();

      // Authenticate proxy with session-based username for sticky IP
      if (useProxy && proxyUser && proxyPass) {
        const sessionUser = `${proxyUser}-session-${sessionId}`;
        await page.authenticate({ username: sessionUser, password: proxyPass });
        console.log(`  → Proxy authenticated (session: ${sessionId})`);
      }

      // Apply additional stealth measures on top of the plugin
      await applyStealthMeasures(page);

      // Intercept API/GraphQL responses to capture hotel data directly
      const apiResults = [];
      page.on('response', async (response) => {
        try {
          const url = response.url();
          if (response.status() !== 200) return;
          const ct = response.headers()['content-type'] || '';
          if (!ct.includes('json')) return;

          if (url.includes('graphql') || url.includes('api/') || url.includes('search') || url.includes('property')) {
            const json = await response.json();
            const hotels = parseApiResponse(json);
            if (hotels.length > 0) {
              apiResults.push(...hotels);
              console.log(`  → API intercepted: ${hotels.length} hotels`);
            }
          }
        } catch {}
      });

      // NOTE: We intentionally do NOT use setRequestInterception — it is detectable
      // by anti-bot systems and contributes to being flagged. Let all resources load naturally.

      // Warm-up: visit homepage first to establish cookies/session
      console.log('  → Warm-up: visiting Expedia homepage...');
      try {
        await page.goto('https://www.expedia.com.br/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (navErr) {
        // If homepage times out, log and continue — cookies may still have been set
        console.log(`  → Warm-up navigation slow (${navErr.message}), continuing anyway...`);
      }
      console.log('  → Warm-up: homepage loaded');
      await delay(800 + Math.random() * 700);

      // Check if already blocked on homepage
      console.log('  → Warm-up: checking CAPTCHA...');
      const homepageCaptcha = await withTimeout(isCaptchaPage(page), 5000, 'CAPTCHA check');
      if (homepageCaptcha) {
        console.log(`  → ⚠ CAPTCHA on homepage (attempt ${attempt}/${MAX_RETRIES})`);
        await browser.close();
        if (attempt < MAX_RETRIES) {
          const backoff = 3000 + Math.random() * 5000;
          console.log(`  → Retrying in ${Math.round(backoff / 1000)}s with new proxy session...`);
          await delay(backoff);
          continue;
        }
        console.log('  → All attempts blocked by CAPTCHA');
        return [];
      }

      // Quick mouse movement to look human
      console.log('  → Warm-up: simulating mouse...');
      await withTimeout(simulateMouseMovement(page), 5000, 'mouse movement');
      await delay(500 + Math.random() * 500);
      console.log('  → Warm-up complete');

      // Navigate to Expedia Hotel-Search
      const searchUrl = buildSearchUrl(destino, checkIn, checkOut, adultos, criancas, idadesCriancas);
      console.log('  → Navigating to:', searchUrl);

      // Use domcontentloaded instead of networkidle2 — Expedia has persistent
      // connections (analytics, websockets, ads) that prevent networkidle2 from
      // resolving for 30-60s. The API interceptor captures data as it arrives.
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('  → DOM loaded:', page.url());

      // Check for CAPTCHA on search page
      if (await withTimeout(isCaptchaPage(page), 5000, 'search CAPTCHA check')) {
        console.log(`  → ⚠ CAPTCHA on search page (attempt ${attempt}/${MAX_RETRIES})`);
        await browser.close();
        if (attempt < MAX_RETRIES) {
          const backoff = 3000 + Math.random() * 5000;
          console.log(`  → Retrying in ${Math.round(backoff / 1000)}s with new proxy session...`);
          await delay(backoff);
          continue;
        }
        console.log('  → All attempts blocked by CAPTCHA');
        return [];
      }

      // Wait for results — poll API interceptor instead of waiting for full networkidle.
      // This is much faster: we stop as soon as we have data or after a reasonable timeout.
      console.log('  → Waiting for search results...');
      const waitStart = Date.now();
      const MAX_WAIT = 15000; // 15s max wait for results
      const POLL_INTERVAL = 1000;
      while (apiResults.length === 0 && (Date.now() - waitStart) < MAX_WAIT) {
        await delay(POLL_INTERVAL);
      }
      console.log(`  → Data wait: ${Date.now() - waitStart}ms, API results so far: ${apiResults.length}`);

      // Quick human-like interaction
      await withTimeout(simulateMouseMovement(page), 3000, 'search mouse movement');
      await withTimeout(simulateHumanScroll(page), 5000, 'search scroll');
      await delay(500 + Math.random() * 500);

      // Strategy 1: API/GraphQL intercepted results
      let results = deduplicateHotels(apiResults);
      console.log(`  → Strategy 1 (API intercept): ${results.length} hotels`);

      // Strategy 2: __NEXT_DATA__ embedded JSON
      if (results.length === 0) {
        results = await extractFromNextData(page);
        console.log(`  → Strategy 2 (__NEXT_DATA__): ${results.length} hotels`);
      }

      // Strategy 3: DOM extraction with multiple selectors
      if (results.length === 0) {
        results = await extractFromDOM(page);
        console.log(`  → Strategy 3 (DOM): ${results.length} hotels`);
      }

      // Strategy 4: Broad page text parsing
      if (results.length === 0) {
        results = await extractFromPageContent(page);
        console.log(`  → Strategy 4 (page text): ${results.length} hotels`);
      }

      // Debug info when no results
      if (results.length === 0) {
        const title = await page.title();
        const bodyPreview = await page.evaluate(() =>
          (document.body?.innerText || '').substring(0, 500)
        );
        console.log('  → DEBUG no results. Title:', title);
        console.log('  → Body:', bodyPreview);
      }

      console.log(`  → ${results.length} raw results`);
      const filtered = filterResults(results, { estilos, prioridades, orcamento });
      console.log(`  → ${filtered.length} after filtering`);
      return filtered;

    } catch (error) {
      console.error(`Expedia scraper error (attempt ${attempt}):`, error.message);
      if (attempt >= MAX_RETRIES) return [];
    } finally {
      if (browser) { try { await browser.close(); } catch {} }
    }
  }

  return [];
}

/**
 * Apply additional stealth measures on top of puppeteer-extra-plugin-stealth.
 * The stealth plugin already handles: webdriver, chrome.runtime, navigator.plugins,
 * permissions, iframe contentWindow, media codecs, etc.
 * Here we add extra measures specific to Expedia's detection.
 */
async function applyStealthMeasures(page) {
  // Realistic User-Agent (Chrome 131 on Windows 10 — current stable)
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );

  // Set realistic headers matching Chrome 131
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
  });

  // Additional navigator overrides not covered by stealth plugin
  await page.evaluateOnNewDocument(() => {
    // Realistic hardware specs
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

    // Realistic screen properties
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

    // Realistic connection info
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
      Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 });
      Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
    }

    // Override Date.getTimezoneOffset for Brazilian timezone
    const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function() {
      return 180; // UTC-3 (Brasilia)
    };

    // Ensure Intl reports Brazilian locale
    if (window.Intl) {
      const origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function() {
        const result = origResolvedOptions.call(this);
        if (!result.timeZone || result.timeZone === 'UTC') {
          result.timeZone = 'America/Sao_Paulo';
        }
        return result;
      };
    }

    // WebGL vendor/renderer (match real Chrome on common hardware)
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Google Inc. (Intel)';
      if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.5)';
      return getParameter.call(this, parameter);
    };
  });
}

/**
 * Simulate realistic mouse movements across the page
 */
async function simulateMouseMovement(page) {
  try {
    const viewport = page.viewport();
    const width = viewport?.width || 1366;
    const height = viewport?.height || 768;

    // Generate 3-6 random mouse movements
    const moves = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < moves; i++) {
      const x = 100 + Math.floor(Math.random() * (width - 200));
      const y = 100 + Math.floor(Math.random() * (height - 200));
      await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
      await delay(200 + Math.random() * 400);
    }
  } catch {}
}

/**
 * Simulate human-like scrolling behavior
 */
async function simulateHumanScroll(page) {
  try {
    await page.evaluate(async () => {
      const scrollHeight = document.body.scrollHeight;
      const viewportHeight = window.innerHeight;
      let scrolled = 0;

      while (scrolled < Math.min(scrollHeight * 0.6, 3000)) {
        const scrollStep = 100 + Math.random() * 200;
        window.scrollBy(0, scrollStep);
        scrolled += scrollStep;
        await new Promise(r => setTimeout(r, 150 + Math.random() * 300));
      }

      // Scroll back up a bit (human behavior)
      window.scrollBy(0, -(200 + Math.random() * 300));
    });
  } catch {}
}

/**
 * Build public Expedia Hotel-Search URL
 */
function buildSearchUrl(destino, checkIn, checkOut, adultos, criancas, idadesCriancas) {
  const params = new URLSearchParams({
    destination: destino,
    startDate: checkIn,
    endDate: checkOut,
    rooms: '1',
    adults: String(adultos || 2),
    sort: 'RECOMMENDED',
  });

  if (criancas > 0 && idadesCriancas?.length) {
    params.set('children', idadesCriancas.join(','));
  }

  return `https://www.expedia.com.br/Hotel-Search?${params}`;
}

/**
 * Parse hotel data from intercepted API/GraphQL responses
 */
function parseApiResponse(json) {
  const hotels = [];
  try {
    const listings =
      json?.data?.propertySearch?.propertySearchListings ||
      json?.data?.propertySearch?.properties ||
      json?.data?.properties ||
      json?.properties ||
      json?.results ||
      json?.listings ||
      [];

    for (const prop of listings) {
      if (!prop || prop.__typename === 'LodgingEnrichedMessage') continue;

      const name =
        prop.name ||
        prop.header?.text ||
        prop.headingSection?.heading ||
        prop.title ||
        '';
      if (!name) continue;

      const priceInfo = prop.price || prop.pricing || prop.priceSection || {};
      const lead = priceInfo.lead || priceInfo.options?.[0]?.strikeOut || {};
      const pricePerNight = lead.amount || priceInfo.perNight?.amount || 0;

      const priceDisplay =
        priceInfo.displayMessages?.[0]?.lineItems?.[0]?.value ||
        lead.formatted ||
        '';

      const reviewInfo = prop.reviews || prop.reviewInfo || {};
      const rating = reviewInfo.score || reviewInfo.overallScore || prop.star || 0;
      const reviewCount = reviewInfo.total || reviewInfo.count || 0;

      const neighborhood = prop.neighborhood?.name || prop.location?.name || '';
      const photo =
        prop.propertyImage?.image?.url ||
        prop.image?.url ||
        prop.thumbnail ||
        '';

      hotels.push({
        name,
        location: neighborhood,
        rating: parseFloat(rating) || 0,
        pricePerNight: parseFloat(pricePerNight) || 0,
        priceTotal: priceDisplay || (pricePerNight ? `R$ ${pricePerNight}` : ''),
        photos: photo ? [photo] : [],
        description: prop.description || '',
        roomType: 'Standard',
        amenities: [],
        reviewCount,
      });
    }
  } catch (e) {
    console.warn('  → API parse error:', e.message);
  }
  return hotels;
}

/**
 * Extract hotels from __NEXT_DATA__ script tag (SSR data)
 */
async function extractFromNextData(page) {
  try {
    return await page.evaluate(() => {
      const script = document.querySelector('#__NEXT_DATA__');
      if (!script) return [];

      const nextData = JSON.parse(script.textContent);
      const hotels = [];

      function findHotels(obj, depth) {
        if (depth > 8 || !obj || typeof obj !== 'object') return;

        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (item && typeof item === 'object' && item.name &&
                (item.price || item.pricePerNight || item.reviews || item.star)) {
              const priceInfo = item.price || {};
              const lead = priceInfo.lead || {};
              hotels.push({
                name: item.name || item.header?.text || '',
                location: item.neighborhood?.name || '',
                rating: parseFloat(item.reviews?.score || item.star || 0),
                pricePerNight: parseFloat(lead.amount || item.pricePerNight || 0),
                priceTotal: lead.formatted || '',
                photos: item.propertyImage?.image?.url ? [item.propertyImage.image.url] : [],
                description: '',
                roomType: 'Standard',
                amenities: [],
              });
            }
            if (typeof item === 'object') findHotels(item, depth + 1);
          }
          return;
        }

        for (const key of Object.keys(obj)) {
          if (['propertySearch', 'propertySearchListings', 'properties', 'listings', 'searchResults', 'results'].includes(key)) {
            findHotels(obj[key], depth + 1);
          }
        }
      }

      findHotels(nextData?.props?.pageProps, 0);
      return hotels;
    });
  } catch (e) {
    console.warn('  → __NEXT_DATA__ error:', e.message);
    return [];
  }
}

/**
 * Extract hotels from DOM using multiple selector strategies
 */
async function extractFromDOM(page) {
  return page.evaluate(() => {
    const hotels = [];

    const cardSelectors = [
      '[data-stid="property-listing"]',
      '[data-testid="property-card"]',
      'li[data-stid="property-listing"]',
      '.uitk-card-content-section',
      'article[data-hotelid]',
      '.hotel-card',
      '.property-listing',
      '.result-item',
    ];

    let cards = [];
    for (const sel of cardSelectors) {
      cards = document.querySelectorAll(sel);
      if (cards.length > 0) break;
    }

    if (cards.length === 0) return [];

    cards.forEach((card, i) => {
      if (i >= 15) return;

      let name = '';
      for (const sel of ['h3', 'h2', 'h4', '[data-stid="content-hotel-title"]', '.hotel-name', '.property-name']) {
        const el = card.querySelector(sel);
        if (el?.textContent?.trim()) { name = el.textContent.trim(); break; }
      }

      let priceText = '';
      for (const sel of ['[data-stid="price-lockup-wrapper"]', '[data-stid="content-hotel-price"]', '[data-testid="price"]', '.price', '.current-price']) {
        const el = card.querySelector(sel);
        if (el?.textContent?.trim()) { priceText = el.textContent.trim(); break; }
      }

      let ratingText = '';
      for (const sel of ['[data-stid="content-hotel-review-rating"]', '.rating', '.review-score', '.guest-rating']) {
        const el = card.querySelector(sel);
        if (el?.textContent?.trim()) { ratingText = el.textContent.trim(); break; }
      }

      let location = '';
      for (const sel of ['.neighborhood', '.location', '.address', '.subtitle']) {
        const el = card.querySelector(sel);
        if (el?.textContent?.trim()) { location = el.textContent.trim(); break; }
      }

      const img = card.querySelector('img[src*="http"]');
      const photo = img?.src || '';

      const pc = priceText.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
      const pricePerNight = parseFloat(pc) || 0;
      const rm = ratingText.match(/[\d.,]+/);
      const rating = rm ? parseFloat(rm[0].replace(',', '.')) : 0;

      if (name) {
        hotels.push({ name, location, rating, pricePerNight, priceTotal: priceText, photos: photo ? [photo] : [], description: '', roomType: 'Standard', amenities: [] });
      }
    });

    return hotels;
  });
}

/**
 * Last resort: parse visible page text for hotel-like patterns
 */
async function extractFromPageContent(page) {
  try {
    return await page.evaluate(() => {
      const hotels = [];
      const body = document.body?.innerText || '';
      const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      for (let i = 0; i < lines.length && hotels.length < 15; i++) {
        const line = lines[i];
        if (line.length < 5 || line.length > 120) continue;

        const nearby = lines.slice(i + 1, i + 6).join(' ');
        const priceMatch = nearby.match(/R\$\s*([\d.,]+)/);

        if (priceMatch && !line.match(/^(R\$|Filtro|Ordenar|Buscar|Hotel|Mostrar|Ver|Page|Voltar)/i)) {
          const pc = priceMatch[1].replace(/\./g, '').replace(',', '.');
          const price = parseFloat(pc) || 0;

          const ratingMatch = nearby.match(/([\d]+[.,][\d])\s*\/\s*10|([\d]+[.,][\d])\s*(Excelente|Muito|Bom|Fant)/i);
          const rating = ratingMatch ? parseFloat((ratingMatch[1] || ratingMatch[2]).replace(',', '.')) : 0;

          if (!hotels.find(h => h.name === line)) {
            hotels.push({
              name: line,
              location: '',
              rating,
              pricePerNight: price,
              priceTotal: `R$ ${priceMatch[1]}`,
              photos: [],
              description: '',
              roomType: 'Standard',
              amenities: [],
            });
          }
        }
      }

      return hotels;
    });
  } catch {
    return [];
  }
}

function deduplicateHotels(hotels) {
  const seen = new Set();
  return hotels.filter(h => {
    if (seen.has(h.name)) return false;
    seen.add(h.name);
    return true;
  });
}

function filterResults(hotels, { estilos, prioridades, orcamento }) {
  let f = [...hotels];
  const b = BUDGET_RANGES[orcamento] || BUDGET_RANGES.sem_limite;

  if (b.max !== Infinity || b.min > 0) {
    f = f.filter(h => !h.pricePerNight || (h.pricePerNight >= b.min && h.pricePerNight <= b.max));
  }

  if (prioridades?.includes('preco')) {
    f.sort((a, b) => (a.pricePerNight || 999999) - (b.pricePerNight || 999999));
  } else {
    f.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }

  return f.slice(0, 10);
}

module.exports = { searchExpedia, isProxyConfigured };
