const puppeteer = require('puppeteer');

/**
 * Fetch reviews for a hotel from TripAdvisor and Expedia public pages
 */
async function fetchReviews(hotelName, location) {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Try TripAdvisor first, then Expedia public
    let reviews = await fetchFromTripAdvisor(page, hotelName, location);

    if (!reviews.rating) {
      reviews = await fetchFromExpediaPublic(page, hotelName, location);
    }

    return reviews;

  } catch (error) {
    console.warn(`Review fetch error for "${hotelName}":`, error.message);
    return {
      rating: 0,
      reviewCount: 0,
      locationScore: null,
      cleanlinessScore: null,
      serviceScore: null,
      summary: '',
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Fetch reviews from TripAdvisor search
 */
async function fetchFromTripAdvisor(page, hotelName, location) {
  const searchQuery = encodeURIComponent(`${hotelName} ${location} hotel`);
  const url = `https://www.tripadvisor.com.br/Search?q=${searchQuery}`;

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Click first hotel result
    const firstResult = await page.$('.result-title, .listing_title a, [data-test-target="property-title"]');
    if (firstResult) {
      await firstResult.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      await page.waitForTimeout(1500);
    }

    // Extract review data
    return await page.evaluate(() => {
      const ratingEl = document.querySelector('.reviewOverall, [data-test-target="review-rating"], .bDJCe');
      const countEl = document.querySelector('.reviewCount, [data-test-target="review-count"]');

      // Category scores
      const categories = document.querySelectorAll('.sub-rating, .prw_rup [data-test-target="review-subrating"]');
      const scores = {};
      categories.forEach(cat => {
        const label = cat.querySelector('.name, .sub-rating-label')?.textContent?.trim()?.toLowerCase() || '';
        const scoreEl = cat.querySelector('.ui_bubble_rating, .score');
        const scoreClass = scoreEl?.className || '';
        const scoreMatch = scoreClass.match(/bubble_(\d+)/);
        const score = scoreMatch ? parseInt(scoreMatch[1]) / 10 : null;

        if (label.includes('localiza')) scores.locationScore = score;
        else if (label.includes('limpeza') || label.includes('clean')) scores.cleanlinessScore = score;
        else if (label.includes('servi') || label.includes('service')) scores.serviceScore = score;
      });

      // Rating
      const ratingText = ratingEl?.textContent?.trim() || '';
      const ratingMatch = ratingText.match(/[\d.,]+/);
      const rating = ratingMatch ? parseFloat(ratingMatch[0].replace(',', '.')) : 0;

      // Count
      const countText = countEl?.textContent?.trim() || '';
      const countMatch = countText.match(/[\d.,]+/);
      const reviewCount = countMatch ? parseInt(countMatch[0].replace(/\D/g, '')) : 0;

      return {
        rating,
        reviewCount,
        locationScore: scores.locationScore || null,
        cleanlinessScore: scores.cleanlinessScore || null,
        serviceScore: scores.serviceScore || null,
        summary: '',
      };
    });

  } catch (err) {
    console.warn('TripAdvisor fetch failed:', err.message);
    return { rating: 0, reviewCount: 0, locationScore: null, cleanlinessScore: null, serviceScore: null, summary: '' };
  }
}

/**
 * Fetch reviews from Expedia public search
 */
async function fetchFromExpediaPublic(page, hotelName, location) {
  const searchQuery = encodeURIComponent(`${hotelName} ${location}`);
  const url = `https://www.expedia.com.br/Hotel-Search?destination=${searchQuery}`;

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Click first result
    const firstCard = await page.$('[data-stid="property-listing"] h3, .hotel-name');
    if (firstCard) {
      await firstCard.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      await page.waitForTimeout(1500);
    }

    return await page.evaluate(() => {
      const ratingEl = document.querySelector('[data-stid="content-hotel-review-rating"], .review-score');
      const countEl = document.querySelector('[data-stid="content-hotel-review-total"], .review-count');

      const ratingText = ratingEl?.textContent?.trim() || '';
      const ratingMatch = ratingText.match(/[\d.,]+/);
      const rating = ratingMatch ? parseFloat(ratingMatch[0].replace(',', '.')) : 0;

      const countText = countEl?.textContent?.trim() || '';
      const countMatch = countText.match(/[\d.]+/);
      const reviewCount = countMatch ? parseInt(countMatch[0].replace(/\D/g, '')) : 0;

      return {
        rating,
        reviewCount,
        locationScore: null,
        cleanlinessScore: null,
        serviceScore: null,
        summary: '',
      };
    });

  } catch (err) {
    console.warn('Expedia public fetch failed:', err.message);
    return { rating: 0, reviewCount: 0, locationScore: null, cleanlinessScore: null, serviceScore: null, summary: '' };
  }
}

module.exports = { fetchReviews };
