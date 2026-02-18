const puppeteer = require('puppeteer');

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
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();

    // Set viewport and user agent
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Step 1: Login to Expedia TAAP
    console.log('  → Logging into Expedia TAAP...');
    await login(page);

    // Step 2: Navigate to hotel search
    console.log('  → Searching hotels...');
    const results = await searchHotels(page, {
      destino,
      checkIn,
      checkOut,
      adultos,
      criancas,
      idadesCriancas,
    });

    // Step 3: Apply filters and collect data
    console.log('  → Applying filters and collecting data...');
    const filtered = filterResults(results, { estilos, prioridades, orcamento });

    return filtered;

  } catch (error) {
    console.error('Expedia scraper error:', error.message);
    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Login to Expedia TAAP
 */
async function login(page) {
  if (!EXPEDIA_USER || !EXPEDIA_PASS) {
    throw new Error('Expedia TAAP credentials not configured in .env');
  }

  await page.goto(EXPEDIA_TAAP_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for login form
  await page.waitForSelector('input[type="email"], input[name="email"], #email', { timeout: 10000 });

  // Enter credentials
  const emailInput = await page.$('input[type="email"], input[name="email"], #email');
  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(EXPEDIA_USER, { delay: 50 });
  }

  const passInput = await page.$('input[type="password"], input[name="password"], #password');
  if (passInput) {
    await passInput.click({ clickCount: 3 });
    await passInput.type(EXPEDIA_PASS, { delay: 50 });
  }

  // Click login button
  const loginBtn = await page.$('button[type="submit"], input[type="submit"], .login-btn, #login-btn');
  if (loginBtn) {
    await loginBtn.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
  }

  console.log('  → Login successful');
}

/**
 * Search for hotels on Expedia TAAP
 */
async function searchHotels(page, params) {
  const { destino, checkIn, checkOut, adultos, criancas, idadesCriancas } = params;

  // Navigate to hotel search or use the search form on the dashboard
  const searchUrl = buildSearchUrl(destino, checkIn, checkOut, adultos, criancas, idadesCriancas);

  try {
    // Try filling out the search form on the current page
    const destinationInput = await page.$('input[name="destination"], input[placeholder*="destino"], #destination, .search-destination');
    if (destinationInput) {
      await destinationInput.click({ clickCount: 3 });
      await destinationInput.type(destino, { delay: 30 });
      await page.waitForTimeout(1500);

      // Select first suggestion if dropdown appears
      const suggestion = await page.$('.suggestion-item, .autocomplete-result, [data-stid="destination-result"]');
      if (suggestion) {
        await suggestion.click();
        await page.waitForTimeout(500);
      }
    }

    // Set check-in date
    const checkInField = await page.$('input[name="checkIn"], input[name="startDate"], #check-in');
    if (checkInField) {
      await checkInField.click({ clickCount: 3 });
      await checkInField.type(formatDateForInput(checkIn));
    }

    // Set check-out date
    const checkOutField = await page.$('input[name="checkOut"], input[name="endDate"], #check-out');
    if (checkOutField) {
      await checkOutField.click({ clickCount: 3 });
      await checkOutField.type(formatDateForInput(checkOut));
    }

    // Set guests
    const guestsBtn = await page.$('.guests-btn, [data-stid="open-room-picker"], .travelers-field');
    if (guestsBtn) {
      await guestsBtn.click();
      await page.waitForTimeout(500);

      // Set adults
      const adultsInput = await page.$('input[name="adults"], #adults');
      if (adultsInput) {
        await adultsInput.click({ clickCount: 3 });
        await adultsInput.type(String(adultos));
      }

      // Set children
      if (criancas > 0) {
        const childrenInput = await page.$('input[name="children"], #children');
        if (childrenInput) {
          await childrenInput.click({ clickCount: 3 });
          await childrenInput.type(String(criancas));
        }
      }
    }

    // Click search button
    const searchBtn = await page.$('button[type="submit"], .search-btn, #search-btn');
    if (searchBtn) {
      await searchBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    }

  } catch (err) {
    console.warn('  → Could not use search form, trying direct URL...');
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  }

  // Wait for results to load
  await page.waitForTimeout(3000);

  // Extract hotel listings
  return await extractHotelListings(page);
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
      '.hotel-card',
      '.property-listing',
      '.uitk-card',
      '.result-item',
      '.hotel-result',
    ];

    let cards = [];
    for (const sel of selectors) {
      cards = document.querySelectorAll(sel);
      if (cards.length > 0) break;
    }

    cards.forEach((card, index) => {
      if (index >= 15) return; // Limit to first 15

      const nameEl = card.querySelector('h2, h3, .hotel-name, .property-name, [data-stid="content-hotel-title"]');
      const priceEl = card.querySelector('.price, .hotel-price, [data-stid="content-hotel-price"]');
      const ratingEl = card.querySelector('.rating, .review-score, [data-stid="content-hotel-review-rating"]');
      const imgEl = card.querySelector('img');
      const locationEl = card.querySelector('.neighborhood, .location, .address');

      const name = nameEl?.textContent?.trim() || '';
      const priceText = priceEl?.textContent?.trim() || '';
      const ratingText = ratingEl?.textContent?.trim() || '';
      const photo = imgEl?.src || '';
      const location = locationEl?.textContent?.trim() || '';

      // Parse price (try to extract number)
      const priceMatch = priceText.replace(/[^\d.,]/g, '').replace('.', '').replace(',', '.');
      const pricePerNight = parseFloat(priceMatch) || 0;

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
      if (!h.pricePerNight) return true; // Keep if price unknown
      return h.pricePerNight >= budget.min && h.pricePerNight <= budget.max;
    });
  }

  // Sort based on priorities
  if (prioridades.includes('preco')) {
    filtered.sort((a, b) => (a.pricePerNight || 999999) - (b.pricePerNight || 999999));
  } else if (prioridades.includes('luxo')) {
    filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  } else {
    // Default: sort by rating
    filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }

  // Return top results (we need at least 3 for tier selection)
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
