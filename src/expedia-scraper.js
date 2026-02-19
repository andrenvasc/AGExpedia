const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

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

async function searchExpedia(params) {
  const { destino, checkIn, checkOut, adultos, criancas, idadesCriancas, estilos, prioridades, orcamento } = params;
  let browser;

  try {
    const useProxy = isProxyConfigured();
    const proxyHost = process.env.PROXY_HOST || 'gate.decodo.com';
    const proxyPort = process.env.PROXY_PORT || '7000';
    const proxyUser = process.env.PROXY_USER;
    const proxyPass = process.env.PROXY_PASS;

    console.log(`  → Launching browser (proxy: ${useProxy ? proxyHost + ':' + proxyPort : 'none'})...`);
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

    // Authenticate proxy if configured
    if (useProxy && proxyUser && proxyPass) {
      await page.authenticate({ username: proxyUser, password: proxyPass });
      console.log('  → Proxy authenticated');
    }

    // --- Stealth measures ---
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

    // Block heavy resources but keep CSS/JS for bot detection evasion
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navigate to Expedia Hotel-Search
    const searchUrl = buildSearchUrl(destino, checkIn, checkOut, adultos, criancas, idadesCriancas);
    console.log('  → Navigating to:', searchUrl);

    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('  → Page loaded:', page.url());

    // Human-like delay
    await delay(3000 + Math.random() * 3000);

    // Simulate human interaction: scroll down slowly
    await simulateHumanScroll(page);
    await delay(2000 + Math.random() * 2000);

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

      // Check for bot detection indicators
      const isBotBlocked = await page.evaluate(() => {
        const text = document.body?.innerText?.toLowerCase() || '';
        return text.includes('captcha') ||
               text.includes('robot') ||
               text.includes('access denied') ||
               text.includes('blocked') ||
               text.includes('please verify') ||
               text.includes('suspicious');
      });
      if (isBotBlocked) {
        console.log('  → ⚠ BOT DETECTION: Page appears to be blocked by anti-bot system');
        if (!useProxy) {
          console.log('  → TIP: Configure a residential proxy (PROXY_HOST, PROXY_USER, PROXY_PASS) to bypass bot detection');
        }
      }
    }

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
 * Apply comprehensive stealth measures to avoid bot detection
 */
async function applyStealthMeasures(page) {
  // Realistic User-Agent (Chrome 122 on Windows 10)
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  // Set realistic headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Sec-CH-UA': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  });

  // Override navigator properties to hide automation
  await page.evaluateOnNewDocument(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Realistic plugins array
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
      },
    });

    // Realistic languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['pt-BR', 'pt', 'en-US', 'en'],
    });

    // Chrome runtime (exists in real Chrome, missing in headless)
    window.chrome = {
      runtime: { id: undefined },
      loadTimes: function() {},
      csi: function() {},
    };

    // Hide "HeadlessChrome" from user agent
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);

    // Canvas fingerprint (add subtle noise)
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      const ctx = origGetContext.call(this, type, ...args);
      if (type === '2d' && ctx) {
        const origFillText = ctx.fillText;
        ctx.fillText = function(...textArgs) {
          // Add invisible noise
          textArgs[0] = textArgs[0]; // no-op to create unique stack
          return origFillText.apply(this, textArgs);
        };
      }
      return ctx;
    };

    // WebGL vendor/renderer (match real Chrome)
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Google Inc. (Intel)';
      if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)';
      return getParameter.call(this, parameter);
    };
  });
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
