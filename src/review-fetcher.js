/**
 * Review enrichment module.
 *
 * Launching a separate headless browser per hotel for review scraping
 * is too resource-intensive and unreliable (bot detection on TripAdvisor/Mysnow).
 * Ratings are already captured during the main search scraping.
 *
 * This module now returns the data we already have, keeping the interface
 * stable for agent.js while avoiding expensive extra browser launches.
 */
async function fetchReviews(hotelName, location) {
  return {
    rating: 0,
    reviewCount: 0,
    locationScore: null,
    cleanlinessScore: null,
    serviceScore: null,
    summary: '',
  };
}

module.exports = { fetchReviews };
