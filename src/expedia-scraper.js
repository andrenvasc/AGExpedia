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
  const basePort = parseInt(process.env.PROXY_PORT || '10001', 10);
  const proxyUser = process.env.PROXY_USER;
  const proxyPass = process.env.PROXY_PASS;

  // Retry loop — each attempt uses a different proxy port (= different IP)
  // Decodo endpoint:port mode: each port (10001, 10002, 10003) is a separate sticky session.
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let browser;
    try {
      // Rotate port on each attempt to get a different IP
      const proxyPort = basePort + (attempt - 1);
      console.log(`  → Attempt ${attempt}/${MAX_RETRIES} (proxy: ${useProxy ? proxyHost + ':' + proxyPort : 'none'})`);

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

      // Authenticate proxy — use plain username for endpoint:port mode.
      // Decodo endpoint:port: IP rotation is via port, NOT username suffix.
      if (useProxy && proxyUser && proxyPass) {
        await page.authenticate({ username: proxyUser, password: proxyPass });
        console.log(`  → Proxy authenticated (user: ${proxyUser}, port: ${proxyPort})`);
      }

      // Apply additional stealth measures on top of the plugin
      await applyStealthMeasures(page);

      // Intercept API/GraphQL responses to capture hotel data directly
      const apiResults = [];
      let jsonResponseCount = 0;
      page.on('response', async (response) => {
        try {
          const url = response.url();
          if (response.status() !== 200) return;
          const ct = response.headers()['content-type'] || '';
          if (!ct.includes('json')) return;

          // Log first few JSON responses for debugging
          jsonResponseCount++;
          if (jsonResponseCount <= 5) {
            console.log(`  → [JSON #${jsonResponseCount}] ${url.substring(0, 120)}`);
          }

          // Broad case-insensitive matching — parseApiResponse filters false positives
          const lowerUrl = url.toLowerCase();
          if (lowerUrl.includes('graphql') || lowerUrl.includes('/api/') ||
              lowerUrl.includes('search') || lowerUrl.includes('property') ||
              lowerUrl.includes('listing') || lowerUrl.includes('lodging') ||
              lowerUrl.includes('hotel') || lowerUrl.includes('offer')) {
            const json = await response.json();
            const hotels = parseApiResponse(json);
            if (hotels.length > 0) {
              apiResults.push(...hotels);
              console.log(`  → API intercepted: ${hotels.length} hotels from ${url.substring(0, 100)}`);
            }
          }
        } catch {}
      });

      // NOTE: We intentionally do NOT use setRequestInterception — it is detectable
      // by anti-bot systems and contributes to being flagged. Let all resources load naturally.

      // Warm-up: visit homepage first to establish cookies/session
      console.log('  → Warm-up: visiting Expedia homepage...');
      try {
        await page.goto('https://www.expediataap.com.br/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (navErr) {
        // If homepage times out, log and continue — cookies may still have been set
        console.log(`  → Warm-up navigation slow (${navErr.message}), continuing anyway...`);
      }
      console.log('  → Warm-up: homepage loaded');
      await delay(800 + Math.random() * 700);

      // Check if already blocked on homepage
      console.log('  → Warm-up: checking CAPTCHA...');
      let homepageCaptcha = false;
      try { homepageCaptcha = await withTimeout(isCaptchaPage(page), 5000, 'CAPTCHA check'); } catch {}
      if (homepageCaptcha) {
        console.log(`  → ⚠ CAPTCHA on homepage (attempt ${attempt}/${MAX_RETRIES})`);
        await browser.close();
        if (attempt < MAX_RETRIES) {
          const backoff = 3000 + Math.random() * 5000;
          console.log(`  → Retrying in ${Math.round(backoff / 1000)}s with new proxy port...`);
          await delay(backoff);
          continue;
        }
        console.log('  → All attempts blocked by CAPTCHA');
        return [];
      }

      // Quick mouse movement to look human (non-fatal if it fails)
      console.log('  → Warm-up: simulating mouse...');
      try { await withTimeout(simulateMouseMovement(page), 3000, 'mouse movement'); } catch {}
      console.log('  → Warm-up complete');

      // Navigate to Expedia Hotel-Search
      const searchUrl = buildSearchUrl(destino, checkIn, checkOut, adultos, criancas, idadesCriancas);
      console.log('  → Navigating to:', searchUrl);

      // Use domcontentloaded instead of networkidle2 — Expedia has persistent
      // connections (analytics, websockets, ads) that prevent networkidle2 from
      // resolving for 30-60s. The API interceptor captures data as it arrives.
      const navResponse = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const httpStatus = navResponse?.status() || 0;
      console.log(`  → DOM loaded: ${page.url()} (HTTP ${httpStatus})`);

      // HTTP 407 = proxy authentication rejected — credentials wrong or account expired.
      // No point retrying with different sessions; same credentials will fail every time.
      if (httpStatus === 407) {
        console.log('  → ⚠ HTTP 407: Proxy authentication failed');
        console.log('  → Check PROXY_USER/PROXY_PASS env vars or Decodo account status (expired/no traffic)');
        console.log('  → Skipping all retry attempts — falling through to Amadeus');
        await browser.close();
        return [];
      }

      // Wait for SPA hydration — Expedia is a Next.js app, the initial HTML is
      // an empty shell. We must wait for JavaScript to render actual content.
      console.log('  → Waiting for SPA hydration...');
      try {
        await page.waitForFunction(
          () => (document.title || '').length > 0 || (document.body?.innerText || '').length > 100,
          { timeout: 15000, polling: 500 }
        );
        console.log('  → Page rendered, title:', await page.title().catch(() => '(unknown)'));
      } catch {
        console.log('  → Page did not render within 15s, continuing...');
      }

      // Check for blank page (soft block) or CAPTCHA — both mean we're blocked
      const postTitle = await page.title().catch(() => '');
      const postBodyLen = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0);

      let isBlocked = false;
      let blockReason = '';

      // Soft block: Expedia serves a completely blank page instead of a CAPTCHA
      if (!postTitle && postBodyLen < 50) {
        isBlocked = true;
        blockReason = 'blank page (soft block)';
        const rawHtml = await page.content().catch(() => '');
        console.log(`  → ⚠ Blank page detected — HTML length: ${rawHtml.length}`);
        console.log(`  → Raw HTML preview: ${rawHtml.substring(0, 300)}`);
        console.log(`  → Final URL: ${page.url()}, HTTP ${httpStatus}`);
      }

      // Hard block: CAPTCHA page with challenge text
      if (!isBlocked) {
        try { isBlocked = await withTimeout(isCaptchaPage(page), 5000, 'search CAPTCHA check'); } catch {}
        if (isBlocked) blockReason = 'CAPTCHA';
      }

      if (isBlocked) {
        console.log(`  → ⚠ Blocked (${blockReason}) on attempt ${attempt}/${MAX_RETRIES}`);
        await browser.close();
        browser = null;
        if (attempt < MAX_RETRIES) {
          const backoff = 3000 + Math.random() * 5000;
          console.log(`  → Retrying in ${Math.round(backoff / 1000)}s with new proxy port...`);
          await delay(backoff);
          continue;
        }
        console.log(`  → All ${MAX_RETRIES} attempts blocked`);
        return [];
      }

      // Wait for hotel results — poll both API interceptor and DOM for hotel cards.
      console.log('  → Waiting for search results...');
      const waitStart = Date.now();
      const MAX_WAIT = 20000; // 20s max wait for results
      const POLL_INTERVAL = 1000;
      while (apiResults.length === 0 && (Date.now() - waitStart) < MAX_WAIT) {
        // Also check if hotel cards appeared in DOM (fallback if API interceptor misses)
        const hasCards = await page.evaluate(() =>
          document.querySelectorAll(
            '[data-stid="property-listing"], [data-testid="property-card"], .uitk-card-content-section'
          ).length > 0
        ).catch(() => false);
        if (hasCards) {
          console.log('  → Hotel cards detected in DOM, waiting 2s for more to load...');
          await delay(2000); // Let remaining cards load
          break;
        }
        await delay(POLL_INTERVAL);
      }
      console.log(`  → Data wait: ${Date.now() - waitStart}ms, API results: ${apiResults.length}`);

      // Quick human-like interaction (non-fatal if it fails)
      try { await withTimeout(simulateMouseMovement(page), 3000, 'search mouse movement'); } catch {}
      try { await withTimeout(simulateHumanScroll(page), 5000, 'search scroll'); } catch {}

      // Strategy 1: API/GraphQL intercepted results
      let results = deduplicateHotels(apiResults);
      console.log(`  → Strategy 1 (API intercept): ${results.length} hotels`);

      // Strategy 2: __NEXT_DATA__ embedded JSON
      if (results.length === 0) {
        try { results = await withTimeout(extractFromNextData(page), 8000, 'NEXT_DATA extraction'); } catch {}
        console.log(`  → Strategy 2 (__NEXT_DATA__): ${results.length} hotels`);
      }

      // Strategy 3: DOM extraction with multiple selectors
      if (results.length === 0) {
        try { results = await withTimeout(extractFromDOM(page), 8000, 'DOM extraction'); } catch {}
        console.log(`  → Strategy 3 (DOM): ${results.length} hotels`);
      }

      // Strategy 4: Broad page text parsing
      if (results.length === 0) {
        try { results = await withTimeout(extractFromPageContent(page), 8000, 'page text extraction'); } catch {}
        console.log(`  → Strategy 4 (page text): ${results.length} hotels`);
      }

      // Debug info when no results
      if (results.length === 0) {
        const title = await page.title().catch(() => '');
        const bodyPreview = await page.evaluate(() =>
          (document.body?.innerText || '').substring(0, 500)
        ).catch(() => '');
        const rawHtmlLen = await page.evaluate(() => document.documentElement.outerHTML.length).catch(() => 0);
        const finalUrl = page.url();
        console.log(`  → DEBUG no results. Title: "${title}"`);
        console.log(`  → URL: ${finalUrl}, HTML size: ${rawHtmlLen}, JSON responses seen: ${jsonResponseCount}`);
        console.log(`  → Body preview: "${bodyPreview.substring(0, 300)}"`);
      }

      console.log(`  → ${results.length} raw results`);

      // ── Phase 2: Scrape individual hotel detail pages ──
      // Enter each hotel to get room types, prices, amenities, and descriptions.
      if (results.length > 0) {
        const maxDetails = Math.min(results.length, 8);
        console.log(`  → Phase 2: Scraping details for ${maxDetails} hotels...`);

        for (let i = 0; i < maxDetails; i++) {
          console.log(`  → [${i + 1}/${maxDetails}] ${results[i].name}`);
          results[i] = await scrapeHotelDetail(page, results[i], checkIn, checkOut, adultos);

          // Human-like delay between hotel pages
          if (i < maxDetails - 1) {
            await delay(1500 + Math.random() * 2000);
          }
        }

        console.log(`  → Phase 2 complete`);
      }

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

  return `https://www.expediataap.com.br/Hotel-Search?${params}`;
}

/**
 * Build a detail-page URL for a hotel, including dates & guest params
 */
function buildDetailUrl(detailUrl, hotelId, checkIn, checkOut, adultos) {
  if (!detailUrl && !hotelId) return '';

  let url;
  if (detailUrl) {
    url = detailUrl.startsWith('http') ? detailUrl : `https://www.expediataap.com.br${detailUrl}`;
  } else {
    url = `https://www.expediataap.com.br/h${hotelId}.Hotel-Information`;
  }

  try {
    const parsed = new URL(url);
    parsed.searchParams.set('chkin', checkIn);
    parsed.searchParams.set('chkout', checkOut);
    parsed.searchParams.set('adults', String(adultos || 2));
    parsed.searchParams.set('rooms', '1');
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Scrape an individual hotel detail page for rooms, amenities, photos, description.
 * Non-fatal — returns original hotel data if anything fails.
 */
async function scrapeHotelDetail(page, hotel, checkIn, checkOut, adultos) {
  const url = buildDetailUrl(hotel.detailUrl, hotel.hotelId, checkIn, checkOut, adultos);
  if (!url) {
    console.log(`    → No detail URL for ${hotel.name}, skipping`);
    return hotel;
  }

  try {
    console.log(`    → Opening: ${url.substring(0, 100)}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Wait for SPA to render content
    try {
      await page.waitForFunction(
        () => (document.body?.innerText || '').length > 200,
        { timeout: 12000, polling: 500 }
      );
    } catch {}

    // Check for CAPTCHA
    let blocked = false;
    try { blocked = await withTimeout(isCaptchaPage(page), 3000, 'detail CAPTCHA'); } catch {}
    if (blocked) {
      console.log(`    → CAPTCHA on detail page, keeping search data`);
      return hotel;
    }

    // Wait for room/price content to appear
    try {
      await page.waitForFunction(
        () => {
          const text = (document.body?.innerText || '').toLowerCase();
          return text.includes('r$') && (text.includes('quarto') || text.includes('room') || text.includes('suite') || text.includes('cama'));
        },
        { timeout: 10000, polling: 500 }
      );
    } catch {}

    // Extract rooms
    let rooms = [];
    try {
      rooms = await withTimeout(page.evaluate(() => {
        const results = [];

        // Multiple selector strategies for room offer cards
        const offerSelectors = [
          '[data-stid="offer-listing"]',
          '[data-stid="property-offer"]',
          '[data-stid="section-room-list"] [class*="card"]',
          '[data-testid="offer-card"]',
          '[data-stid="price-lockup-wrapper"]',
        ];

        let cards = [];
        for (const sel of offerSelectors) {
          cards = document.querySelectorAll(sel);
          if (cards.length > 0) break;
        }

        // Broader fallback: look for sections with price + room keywords
        if (cards.length === 0) {
          const sections = document.querySelectorAll('[class*="offer"], [class*="room"], [role="group"]');
          for (const sec of sections) {
            const t = (sec.innerText || '').toLowerCase();
            if (t.includes('r$') && (t.includes('cama') || t.includes('quarto') || t.includes('suite'))) {
              cards = sec.children;
              break;
            }
          }
        }

        Array.from(cards).slice(0, 6).forEach(card => {
          const text = card.innerText || '';

          // Room name
          let name = '';
          for (const sel of ['h3', 'h4', 'h2', '[data-stid="room-type-name"]', '[class*="room-name"]', '[class*="title"]']) {
            const el = card.querySelector(sel);
            if (el?.textContent?.trim()) { name = el.textContent.trim(); break; }
          }

          // Price
          const priceMatch = text.match(/R\$\s*([\d.,]+)/);
          const price = priceMatch
            ? parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'))
            : 0;

          // Bed info
          const bedMatch = text.match(/\d+\s*(cama|bed)[^.\n]*/i);
          const beds = bedMatch ? bedMatch[0].trim() : '';

          // Cancellation policy
          let cancellation = '';
          if (/cancelamento\s+gr[aá]tis/i.test(text)) cancellation = 'Cancelamento grátis';
          else if (/n[aã]o[\s-]*reembols[aá]vel/i.test(text)) cancellation = 'Não reembolsável';
          else if (/free\s+cancellation/i.test(text)) cancellation = 'Cancelamento grátis';
          else if (/non[\s-]*refundable/i.test(text)) cancellation = 'Não reembolsável';

          // Max guests
          const guestMatch = text.match(/(\d+)\s*(hóspede|guest|pessoa)/i);
          const maxGuests = guestMatch ? parseInt(guestMatch[1]) : 0;

          if (name || price) {
            results.push({
              name: name || 'Quarto',
              price,
              priceDisplay: priceMatch ? `R$ ${priceMatch[1]}` : '',
              beds,
              cancellation,
              maxGuests,
            });
          }
        });

        return results;
      }), 8000, 'room extraction');
    } catch {}

    // Extract amenities
    let amenities = [];
    try {
      amenities = await withTimeout(page.evaluate(() => {
        const items = [];

        const selectors = [
          '[data-stid="section-amenities"] li',
          '[data-stid="amenity-group"] li',
          '[data-stid="content-hotel-amenities"] li',
          '[data-stid="amenity-item"]',
          '.amenity-item',
        ];

        let elements = [];
        for (const sel of selectors) {
          elements = document.querySelectorAll(sel);
          if (elements.length > 0) break;
        }

        elements.forEach(el => {
          const t = el.textContent?.trim();
          if (t && t.length < 60 && !items.includes(t)) items.push(t);
        });

        // Fallback: detect common amenity keywords in page text
        if (items.length === 0) {
          const body = (document.body?.innerText || '').toLowerCase();
          const keywords = [
            'Wi-Fi', 'Piscina', 'Academia', 'Spa', 'Restaurante',
            'Estacionamento', 'Ar condicionado', 'Café da manhã',
            'Bar', 'Room service', 'Lavanderia', 'Pet friendly',
          ];
          for (const kw of keywords) {
            if (body.includes(kw.toLowerCase())) items.push(kw);
          }
        }

        return items.slice(0, 15);
      }), 5000, 'amenity extraction');
    } catch {}

    // Extract description if missing
    let description = hotel.description || '';
    if (!description) {
      try {
        description = await page.evaluate(() => {
          for (const sel of [
            '[data-stid="content-hotel-description"]',
            '[data-stid="section-description"] p',
            '.hotel-description',
          ]) {
            const el = document.querySelector(sel);
            if (el?.textContent?.trim()?.length > 30) {
              return el.textContent.trim().substring(0, 300);
            }
          }
          return '';
        }) || '';
      } catch {}
    }

    // Extract more photos
    let photos = hotel.photos || [];
    try {
      const morePhotos = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('img[src*="http"]'))
          .map(img => img.src)
          .filter(src => src.includes('lodging') || src.includes('hotel') || src.includes('images.trvl'))
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 5);
      });
      if (morePhotos.length > photos.length) photos = morePhotos;
    } catch {}

    console.log(`    → ${rooms.length} rooms, ${amenities.length} amenities`);

    return {
      ...hotel,
      rooms: rooms.length > 0 ? rooms : hotel.rooms || [],
      amenities: amenities.length > 0 ? amenities : hotel.amenities || [],
      description: description || hotel.description || '',
      photos,
      // Use cheapest room as primary price/type if available
      ...(rooms.length > 0 && rooms[0].price ? {
        pricePerNight: rooms[0].price,
        roomType: rooms[0].name,
      } : {}),
    };
  } catch (err) {
    console.log(`    → Detail failed: ${err.message}`);
    return hotel;
  }
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

      // Extract detail page URL or hotel ID for Phase 2 scraping
      const detailUrl =
        prop.pdpUrl || prop.propertyUrl || prop.destinationUrl || prop.url || '';
      const hotelId =
        prop.id || prop.propertyId || '';

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
        rooms: [],
        reviewCount,
        detailUrl,
        hotelId,
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
                rooms: [],
                hotelId: item.id || item.propertyId || '',
                detailUrl: item.pdpUrl || item.propertyUrl || '',
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

      // Extract link to hotel detail page
      const linkEl = card.closest('a[href]') || card.querySelector('a[href]');
      const detailUrl = linkEl?.href || '';

      const pc = priceText.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
      const pricePerNight = parseFloat(pc) || 0;
      const rm = ratingText.match(/[\d.,]+/);
      const rating = rm ? parseFloat(rm[0].replace(',', '.')) : 0;

      if (name) {
        hotels.push({ name, location, rating, pricePerNight, priceTotal: priceText, photos: photo ? [photo] : [], description: '', roomType: 'Standard', amenities: [], rooms: [], detailUrl });
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
