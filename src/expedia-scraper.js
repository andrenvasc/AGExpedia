const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const EXPEDIA_TAAP_URL = 'https://www.expediataap.com.br';
const EXPEDIA_USER = process.env.EXPEDIA_USER;
const EXPEDIA_PASS = process.env.EXPEDIA_PASS;

// Budget ranges in BRL per night
const BUDGET_RANGES = {
  economico: { min: 0, max: 400 },
  moderado: { min: 400, max: 800 },
  confortavel: { min: 800, max: 1500 },
  premium: { min: 1500, max: 3000 },
  luxo: { min: 3000, max: Infinity },
  sem_limite: { min: 0, max: Infinity },
};

/**
 * Small delay helper (replaces deprecated waitForTimeout)
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Try multiple selectors and return the first match
 */
async function findElement(page, selectors, timeout = 5000) {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout });
      if (el) return el;
    } catch {}
  }
  return null;
}

/**
 * Search Expedia TAAP for hotel options matching the criteria
 */
async function searchExpedia(params) {
  const {
    destino,
    checkIn,
    checkOut,
    adultos,
    criancas,
    idadesCriancas,
    estilos,
    prioridades,
    orcamento,
  } = params;

  let browser;

  try {
    console.log('  → Launching browser...');
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1366, height: 768 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Block images/fonts for faster loading
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Step 1: Login to Expedia TAAP
    console.log('  → Navigating to Expedia TAAP...');
    await login(page);

    // Step 2: Search for hotels
    console.log('  → Searching hotels...');
    const results = await searchHotels(page, {
      destino,
      checkIn,
      checkOut,
      adultos,
      criancas,
      idadesCriancas,
    });

    console.log(`  → Found ${results.length} raw results`);

    // Step 3: Apply filters
    const filtered = filterResults(results, { estilos, prioridades, orcamento });
    console.log(`  → ${filtered.length} results after filtering`);

    return filtered;

  } catch (error) {
    console.error('Expedia scraper error:', error.message);
    return [];
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

/**
 * Login to Expedia TAAP at www.expediataap.com.br
 *
 * Flow:
 * 1. Open landing page (www.expediataap.com.br)
 * 2. Click "Fazer Login" button on the central card
 * 3. Fill "Endereço de e-mail" and "Senha"
 * 4. Click "Fazer login" submit button
 * 5. Wait for dashboard to load
 */
async function login(page) {
  if (!EXPEDIA_USER || !EXPEDIA_PASS) {
    throw new Error('Credenciais do Expedia TAAP não configuradas (.env EXPEDIA_USER / EXPEDIA_PASS)');
  }

  // ===== STEP 1: Open landing page =====
  console.log('  → Opening Expedia TAAP landing page...');
  await page.goto(EXPEDIA_TAAP_URL, {
    waitUntil: 'networkidle2',
    timeout: 45000,
  });

  console.log('  → Landing page loaded:', page.url());
  await delay(2000);

  // ===== STEP 2: Click "Fazer Login" button on the central card =====
  console.log('  → Looking for "Fazer Login" button on landing page...');

  // Try to find by text content first (most reliable for this specific site)
  const fazerLoginBtn = await page.evaluateHandle(() => {
    // Look for links/buttons containing "Fazer Login" or "Fazer login" or "Login" text
    const allElements = document.querySelectorAll('a, button, input[type="submit"], input[type="button"]');
    for (const el of allElements) {
      const text = (el.textContent || el.value || '').trim().toLowerCase();
      if (text.includes('fazer login') || text === 'login' || text === 'entrar' || text === 'acessar') {
        return el;
      }
    }
    // Also check for links with href containing "login"
    const loginLinks = document.querySelectorAll('a[href*="login"], a[href*="signin"], a[href*="auth"]');
    if (loginLinks.length > 0) return loginLinks[0];
    return null;
  });

  const btnElement = fazerLoginBtn.asElement();

  if (btnElement) {
    console.log('  → Found "Fazer Login" button, clicking...');
    await btnElement.click();
  } else {
    // Fallback: try common selector patterns
    console.log('  → Text search failed, trying CSS selectors...');
    const loginBtnSelectors = [
      'a[href*="login"]',
      'a[href*="signin"]',
      'a[href*="auth"]',
      'button.login',
      '.login-btn',
      '.btn-login',
      '#login-btn',
      'a.btn-primary',
      'button.btn-primary',
    ];

    const loginLink = await findElement(page, loginBtnSelectors, 10000);
    if (loginLink) {
      console.log('  → Found login link via CSS, clicking...');
      await loginLink.click();
    } else {
      console.error('  → Could not find "Fazer Login" button');
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
      console.error('  → Page text:', bodyText.substring(0, 300));
      throw new Error('Botão "Fazer Login" não encontrado na landing page');
    }
  }

  // Wait for login page to load
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
  } catch {
    await delay(3000);
  }

  console.log('  → Login page URL:', page.url());
  await delay(2000);

  // ===== STEP 3: Fill email and password =====
  console.log('  → Looking for email field ("Endereço de e-mail")...');

  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[id="email"]',
    'input[id="username"]',
    'input[id="loginId"]',
    'input[placeholder*="e-mail"]',
    'input[placeholder*="E-mail"]',
    'input[placeholder*="email"]',
    'input[placeholder*="Email"]',
    'input[aria-label*="e-mail"]',
    'input[aria-label*="email"]',
    'input[aria-label*="Email"]',
    '#credentials-email',
  ];

  const emailInput = await findElement(page, emailSelectors, 15000);

  if (!emailInput) {
    // Check inside iframes (some auth flows use embedded frames)
    const frames = page.frames();
    console.log(`  → Checking ${frames.length} frames for login form...`);

    for (const frame of frames) {
      try {
        const frameEmail = await frame.$('input[type="email"], input[name="email"]');
        if (frameEmail) {
          console.log('  → Found login form in iframe, logging in there...');
          await loginInContext(frame);
          // Wait for main page to update after iframe login
          await delay(5000);
          console.log('  → After iframe login URL:', page.url());
          return;
        }
      } catch {}
    }

    const pageTitle = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
    console.error(`  → Email field not found. Title: "${pageTitle}", URL: ${page.url()}`);
    console.error(`  → Page content: ${bodyText.substring(0, 300)}`);
    throw new Error('Campo de e-mail não encontrado na página de login');
  }

  // Type email
  console.log('  → Filling email...');
  await emailInput.click({ clickCount: 3 });
  await delay(200);
  await emailInput.type(EXPEDIA_USER, { delay: 30 });
  await delay(500);

  // Find password field
  console.log('  → Looking for password field ("Senha")...');
  const passSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[id="password"]',
    'input[placeholder*="enha"]',
    'input[placeholder*="assword"]',
    'input[aria-label*="enha"]',
    'input[aria-label*="assword"]',
  ];

  let passInput = await findElement(page, passSelectors, 5000);

  if (!passInput) {
    // Some flows show password after submitting email
    console.log('  → Password not visible yet, submitting email first...');
    await page.keyboard.press('Enter');
    await delay(3000);
    passInput = await findElement(page, passSelectors, 10000);
  }

  if (!passInput) {
    throw new Error('Campo de senha não encontrado na página de login');
  }

  // Type password
  console.log('  → Filling password...');
  await passInput.click({ clickCount: 3 });
  await delay(200);
  await passInput.type(EXPEDIA_PASS, { delay: 30 });
  await delay(500);

  // ===== STEP 4: Click "Fazer login" submit button =====
  console.log('  → Looking for submit button ("Fazer login")...');

  // Try text-based search first
  const submitBtn = await page.evaluateHandle(() => {
    const buttons = document.querySelectorAll('button, input[type="submit"], a.btn');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').trim().toLowerCase();
      if (text.includes('fazer login') || text.includes('entrar') || text.includes('sign in') || text.includes('log in') || text === 'login') {
        return btn;
      }
    }
    // Fallback to type="submit"
    const submit = document.querySelector('button[type="submit"], input[type="submit"]');
    return submit || null;
  });

  const submitElement = submitBtn.asElement();

  if (submitElement) {
    console.log('  → Clicking "Fazer login" button...');
    await submitElement.click();
  } else {
    // Last resort: press Enter
    console.log('  → Submit button not found, pressing Enter...');
    await page.keyboard.press('Enter');
  }

  // ===== STEP 5: Wait for dashboard to load =====
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
  } catch {
    await delay(5000);
  }

  const loggedInUrl = page.url();
  console.log('  → After login URL:', loggedInUrl);

  // Verify login succeeded
  const stillOnLogin = await page.$('input[type="password"]');
  if (stillOnLogin) {
    const errorMsg = await page.evaluate(() => {
      const errorEl = document.querySelector('.error, .alert, .alert-danger, .error-message, [role="alert"], .notification-error');
      return errorEl?.textContent?.trim() || '';
    });
    if (errorMsg) {
      console.error('  → Login error message:', errorMsg);
      throw new Error(`Login falhou: ${errorMsg}`);
    }
    console.warn('  → WARNING: Password field still visible, login may have failed');
  }

  console.log('  → Login completed successfully!');
}

/**
 * Handle login inside an iframe or frame context
 */
async function loginInContext(context) {
  const emailInput = await context.$('input[type="email"], input[name="email"], input[name="username"]');
  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(EXPEDIA_USER, { delay: 30 });
  }

  await delay(500);

  const passInput = await context.$('input[type="password"], input[name="password"]');
  if (passInput) {
    await passInput.click({ clickCount: 3 });
    await passInput.type(EXPEDIA_PASS, { delay: 30 });
  }

  await delay(500);

  // Try to find submit by text
  const submitBtn = await context.evaluateHandle(() => {
    const buttons = document.querySelectorAll('button, input[type="submit"]');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').trim().toLowerCase();
      if (text.includes('fazer login') || text.includes('entrar') || text.includes('login') || text.includes('sign in')) {
        return btn;
      }
    }
    return document.querySelector('button[type="submit"], input[type="submit"]') || null;
  });

  const btnEl = submitBtn.asElement();
  if (btnEl) {
    await btnEl.click();
  }

  await delay(5000);
}

/**
 * Search for hotels on Expedia TAAP
 */
async function searchHotels(page, params) {
  const { destino, checkIn, checkOut, adultos, criancas, idadesCriancas } = params;

  // First try: use the search form on the current page
  try {
    console.log('  → Looking for hotel search form...');

    const destSelectors = [
      'input[name="destination"]',
      'input[placeholder*="destino"]',
      'input[placeholder*="Destino"]',
      'input[placeholder*="cidade"]',
      'input[placeholder*="hotel"]',
      'input[placeholder*="Para onde"]',
      'input[placeholder*="Going to"]',
      '#destination',
      '.search-destination',
      'input[data-testid="destination-input"]',
      'input[aria-label*="destino"]',
      'input[aria-label*="Destino"]',
      'button[data-testid="destination_form_field"]',
    ];

    const destinationInput = await findElement(page, destSelectors, 10000);

    if (destinationInput) {
      console.log('  → Found destination field, filling search form...');

      // Some TAAP portals use a button that opens a dialog
      const tagName = await page.evaluate(el => el.tagName.toLowerCase(), destinationInput);

      if (tagName === 'button') {
        await destinationInput.click();
        await delay(1000);
        // Look for the actual text input inside the dialog
        const dialogInput = await page.$('input[type="text"]:focus, input[placeholder*="destino"], input[placeholder*="Going"]');
        if (dialogInput) {
          await dialogInput.type(destino, { delay: 30 });
        }
      } else {
        await destinationInput.click({ clickCount: 3 });
        await delay(200);
        await destinationInput.type(destino, { delay: 30 });
      }

      await delay(2000);

      // Select first suggestion
      const suggestionSelectors = [
        '.suggestion-item',
        '.autocomplete-result',
        '[data-stid="destination-result"]',
        '.typeahead-item',
        'li[role="option"]',
        '.result-item',
        'ul[role="listbox"] li',
        'button[data-stid*="result"]',
      ];

      const suggestion = await findElement(page, suggestionSelectors, 5000);
      if (suggestion) {
        console.log('  → Clicking suggestion...');
        await suggestion.click();
        await delay(1000);
      }

      // Set dates
      await fillDates(page, checkIn, checkOut);

      // Set guests
      await fillGuests(page, adultos, criancas, idadesCriancas);

      // Click search
      const searchBtnSelectors = [
        'button[type="submit"]',
        'button[data-testid="submit-button"]',
        '.search-btn',
        '#search-btn',
        'button[aria-label*="Buscar"]',
        'button[aria-label*="Search"]',
      ];

      const searchBtn = await findElement(page, searchBtnSelectors, 5000);
      if (searchBtn) {
        console.log('  → Clicking search button...');
        await searchBtn.click();
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        } catch {
          await delay(5000);
        }
      }
    } else {
      throw new Error('Search form not found, trying URL approach');
    }

  } catch (err) {
    // Fallback: try direct URL navigation
    console.warn('  → Form approach failed, trying direct URL...');
    const searchUrl = buildSearchUrl(destino, checkIn, checkOut, adultos, criancas, idadesCriancas);
    console.log('  → Navigating to:', searchUrl);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  }

  // Wait for results to load
  console.log('  → Waiting for results...');
  await delay(5000);

  // Try to wait for hotel cards to appear
  const resultSelectors = [
    '[data-stid="property-listing"]',
    '.hotel-card',
    '.property-listing',
    '.uitk-card',
    '.result-item',
    '.hotel-result',
    '[data-testid="property-card"]',
  ];

  for (const sel of resultSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      console.log(`  → Results found with selector: ${sel}`);
      break;
    } catch {}
  }

  return await extractHotelListings(page);
}

/**
 * Fill date fields
 */
async function fillDates(page, checkIn, checkOut) {
  const dateSelectors = {
    checkIn: [
      'input[name="checkIn"]',
      'input[name="startDate"]',
      'input[name="d1"]',
      '#check-in',
      'input[data-testid="date-input-start"]',
      'button[data-testid="date_form_field-start"]',
    ],
    checkOut: [
      'input[name="checkOut"]',
      'input[name="endDate"]',
      'input[name="d2"]',
      '#check-out',
      'input[data-testid="date-input-end"]',
      'button[data-testid="date_form_field-end"]',
    ],
  };

  // Try to fill check-in
  for (const sel of dateSelectors.checkIn) {
    const el = await page.$(sel);
    if (el) {
      const tagName = await page.evaluate(e => e.tagName.toLowerCase(), el);
      if (tagName === 'button') {
        await el.click();
        await delay(1000);
        // Try to navigate calendar to the right month and click the day
        await selectDateFromCalendar(page, checkIn);
      } else {
        await el.click({ clickCount: 3 });
        await el.type(formatDateForInput(checkIn), { delay: 20 });
      }
      break;
    }
  }

  await delay(500);

  // Try to fill check-out
  for (const sel of dateSelectors.checkOut) {
    const el = await page.$(sel);
    if (el) {
      const tagName = await page.evaluate(e => e.tagName.toLowerCase(), el);
      if (tagName === 'button') {
        await el.click();
        await delay(1000);
        await selectDateFromCalendar(page, checkOut);
      } else {
        await el.click({ clickCount: 3 });
        await el.type(formatDateForInput(checkOut), { delay: 20 });
      }
      break;
    }
  }

  await delay(500);
}

/**
 * Try to select a date from a calendar widget
 */
async function selectDateFromCalendar(page, isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);

  // Try to find and click the day button
  const daySelectors = [
    `button[data-day="${day}"][data-month="${month - 1}"]`,
    `button[aria-label*="${day}"]`,
    `td[data-day="${day}"]`,
    `.calendar-day[data-date="${isoDate}"]`,
  ];

  for (const sel of daySelectors) {
    try {
      const dayEl = await page.$(sel);
      if (dayEl) {
        await dayEl.click();
        return;
      }
    } catch {}
  }
}

/**
 * Fill guest fields
 */
async function fillGuests(page, adultos, criancas, idadesCriancas) {
  const guestBtnSelectors = [
    '.guests-btn',
    '[data-stid="open-room-picker"]',
    '.travelers-field',
    'button[data-testid="travelers_form_field"]',
    'button[aria-label*="viajantes"]',
    'button[aria-label*="Travelers"]',
    'button[aria-label*="hospedes"]',
  ];

  const guestsBtn = await findElement(page, guestBtnSelectors, 3000);
  if (!guestsBtn) return;

  await guestsBtn.click();
  await delay(1000);

  // Try to set adults
  const adultsSelectors = [
    'input[name="adults"]',
    '#adults',
    'input[data-testid="adults-input"]',
  ];

  for (const sel of adultsSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ clickCount: 3 });
      await el.type(String(adultos));
      break;
    }
  }

  // Try increment/decrement buttons for adults
  if (adultos > 2) {
    const adultPlusBtn = await page.$('button[aria-label*="adult" i][aria-label*="increase" i], button[data-testid="adults-plus"]');
    if (adultPlusBtn) {
      for (let i = 2; i < adultos; i++) {
        await adultPlusBtn.click();
        await delay(200);
      }
    }
  }

  // Try to set children
  if (criancas > 0) {
    const childSelectors = [
      'input[name="children"]',
      '#children',
      'input[data-testid="children-input"]',
    ];

    for (const sel of childSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(String(criancas));
        break;
      }
    }

    // Try increment button for children
    const childPlusBtn = await page.$('button[aria-label*="child" i][aria-label*="increase" i], button[data-testid="children-plus"]');
    if (childPlusBtn) {
      for (let i = 0; i < criancas; i++) {
        await childPlusBtn.click();
        await delay(200);
      }
    }
  }

  // Close the guest picker (click "Done" or click outside)
  const doneBtn = await page.$('button[data-testid="guests-done"], .done-btn, button:has-text("Done"), button:has-text("Pronto")');
  if (doneBtn) {
    await doneBtn.click();
  }

  await delay(500);
}

/**
 * Extract hotel data from search results page
 */
async function extractHotelListings(page) {
  return await page.evaluate(() => {
    const hotels = [];

    // Try common selectors for hotel cards
    const selectors = [
      '[data-stid="property-listing"]',
      '[data-testid="property-card"]',
      '.hotel-card',
      '.property-listing',
      '.uitk-card',
      '.result-item',
      '.hotel-result',
      '.property-card',
      'article[data-hotelid]',
      'li[data-resultid]',
    ];

    let cards = [];
    for (const sel of selectors) {
      cards = document.querySelectorAll(sel);
      if (cards.length > 0) break;
    }

    if (cards.length === 0) {
      console.log('No hotel cards found with known selectors');
      return [];
    }

    cards.forEach((card, index) => {
      if (index >= 15) return;

      // Extract hotel name
      const nameSelectors = [
        'h2', 'h3', 'h4',
        '.hotel-name', '.property-name',
        '[data-stid="content-hotel-title"]',
        '[data-testid="hotel-name"]',
        '.listing-title',
      ];
      let name = '';
      for (const sel of nameSelectors) {
        const el = card.querySelector(sel);
        if (el?.textContent?.trim()) {
          name = el.textContent.trim();
          break;
        }
      }

      // Extract price
      const priceSelectors = [
        '.price', '.hotel-price',
        '[data-stid="content-hotel-price"]',
        '[data-testid="price"]',
        '.price-total', '.current-price',
        '.amount',
      ];
      let priceText = '';
      for (const sel of priceSelectors) {
        const el = card.querySelector(sel);
        if (el?.textContent?.trim()) {
          priceText = el.textContent.trim();
          break;
        }
      }

      // Extract rating
      const ratingSelectors = [
        '.rating', '.review-score',
        '[data-stid="content-hotel-review-rating"]',
        '[data-testid="review-score"]',
        '.guest-rating',
      ];
      let ratingText = '';
      for (const sel of ratingSelectors) {
        const el = card.querySelector(sel);
        if (el?.textContent?.trim()) {
          ratingText = el.textContent.trim();
          break;
        }
      }

      // Extract photo
      const imgEl = card.querySelector('img[src*="http"], img[data-src*="http"]');
      const photo = imgEl?.src || imgEl?.dataset?.src || '';

      // Extract location
      const locSelectors = ['.neighborhood', '.location', '.address', '.subtitle'];
      let location = '';
      for (const sel of locSelectors) {
        const el = card.querySelector(sel);
        if (el?.textContent?.trim()) {
          location = el.textContent.trim();
          break;
        }
      }

      // Parse price
      const priceClean = priceText.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
      const pricePerNight = parseFloat(priceClean) || 0;

      // Parse rating
      const ratingMatch = ratingText.match(/[\d.,]+/);
      const rating = ratingMatch ? parseFloat(ratingMatch[0].replace(',', '.')) : 0;

      if (name) {
        hotels.push({
          name,
          location,
          rating,
          pricePerNight,
          priceTotal: priceText,
          photos: photo ? [photo] : [],
          description: '',
          roomType: 'Standard',
          amenities: [],
        });
      }
    });

    return hotels;
  });
}

/**
 * Filter results based on user preferences
 */
function filterResults(hotels, { estilos, prioridades, orcamento }) {
  let filtered = [...hotels];
  const budget = BUDGET_RANGES[orcamento] || BUDGET_RANGES.sem_limite;

  // Filter by budget
  if (budget.max !== Infinity || budget.min > 0) {
    filtered = filtered.filter(h => {
      if (!h.pricePerNight) return true;
      return h.pricePerNight >= budget.min && h.pricePerNight <= budget.max;
    });
  }

  // Sort based on priorities
  if (prioridades && prioridades.includes('preco')) {
    filtered.sort((a, b) => (a.pricePerNight || 999999) - (b.pricePerNight || 999999));
  } else if (prioridades && prioridades.includes('luxo')) {
    filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  } else {
    filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }

  return filtered.slice(0, 10);
}

/**
 * Build direct search URL for Expedia TAAP
 */
function buildSearchUrl(destino, checkIn, checkOut, adultos, criancas, idadesCriancas) {
  const params = new URLSearchParams({
    destination: destino,
    startDate: checkIn,
    endDate: checkOut,
    adults: String(adultos),
    children: String(criancas || 0),
  });

  if (idadesCriancas && idadesCriancas.length > 0) {
    params.set('childAges', idadesCriancas.join(','));
  }

  return `${EXPEDIA_TAAP_URL}/hotels?${params.toString()}`;
}

/**
 * Format date for input fields (DD/MM/YYYY)
 */
function formatDateForInput(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

module.exports = { searchExpedia };
