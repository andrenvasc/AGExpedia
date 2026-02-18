const { searchExpedia } = require('./expedia-scraper');
const { fetchReviews } = require('./review-fetcher');
const { generateReport } = require('./report-generator');
const { sendQuotationEmail } = require('./email-sender');
const crypto = require('crypto');

/**
 * Main orchestrator: receives form data, coordinates scraping,
 * generates report, and sends email.
 */
async function processQuotation(data) {
  const quotationId = crypto.randomUUID();
  console.log(`[${quotationId}] Starting quotation for ${data.cliente.nome} → ${data.destino}`);

  try {
    // Step 1: Search Expedia TAAP
    console.log(`[${quotationId}] Step 1: Searching Expedia TAAP...`);
    const expediaResults = await searchExpedia({
      destino: data.destino,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      adultos: data.adultos,
      criancas: data.criancas,
      idadesCriancas: data.idadesCriancas,
      estilos: data.estilos,
      prioridades: data.prioridades,
      orcamento: data.orcamento,
    });
    console.log(`[${quotationId}] Expedia returned ${expediaResults.length} results`);

    // Step 2: Fetch reviews for top candidates
    console.log(`[${quotationId}] Step 2: Fetching reviews...`);
    const hotelsWithReviews = await enrichWithReviews(expediaResults);
    console.log(`[${quotationId}] Reviews enriched for ${hotelsWithReviews.length} hotels`);

    // Step 3: Select 3 tiers (3-star, 4-star, 5-star quality)
    console.log(`[${quotationId}] Step 3: Selecting tier options...`);
    const selectedHotels = selectTierOptions(hotelsWithReviews, data);

    // Step 4: Generate HTML report
    console.log(`[${quotationId}] Step 4: Generating report...`);
    const reportUrl = await generateReport({
      quotationId,
      cliente: data.cliente,
      destino: data.destino,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      adultos: data.adultos,
      criancas: data.criancas,
      estilos: data.estilos,
      prioridades: data.prioridades,
      hotels: selectedHotels,
    });
    console.log(`[${quotationId}] Report generated: ${reportUrl}`);

    // Step 5: Send email
    console.log(`[${quotationId}] Step 5: Sending email...`);
    await sendQuotationEmail({
      to: data.cliente.email,
      nome: data.cliente.nome,
      destino: data.destino,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      adultos: data.adultos,
      reportUrl,
    });
    console.log(`[${quotationId}] Email sent to ${data.cliente.email}`);

    console.log(`[${quotationId}] Quotation complete!`);
    return { quotationId, reportUrl };

  } catch (error) {
    console.error(`[${quotationId}] Error:`, error.message);
    throw error;
  }
}

/**
 * Enrich hotel results with review data
 */
async function enrichWithReviews(hotels) {
  const enriched = [];

  for (const hotel of hotels) {
    try {
      const reviews = await fetchReviews(hotel.name, hotel.location);
      enriched.push({
        ...hotel,
        reviews: {
          rating: reviews.rating || hotel.rating,
          reviewCount: reviews.reviewCount || 0,
          locationScore: reviews.locationScore || null,
          cleanlinessScore: reviews.cleanlinessScore || null,
          serviceScore: reviews.serviceScore || null,
          summary: reviews.summary || '',
        },
      });
    } catch (err) {
      console.warn(`Could not fetch reviews for ${hotel.name}:`, err.message);
      enriched.push({
        ...hotel,
        reviews: {
          rating: hotel.rating,
          reviewCount: 0,
          locationScore: null,
          cleanlinessScore: null,
          serviceScore: null,
          summary: '',
        },
      });
    }
  }

  return enriched;
}

/**
 * Select 3 hotels: one for each tier (3-star value, 4-star comfort, 5-star premium)
 */
function selectTierOptions(hotels, data) {
  if (hotels.length === 0) {
    return getPlaceholderHotels(data);
  }

  // Sort by rating
  const sorted = [...hotels].sort((a, b) => (b.reviews?.rating || b.rating || 0) - (a.reviews?.rating || a.rating || 0));

  const tiers = [];

  // 5-star tier (best rated)
  if (sorted.length >= 1) {
    tiers.push({ ...sorted[0], tier: 5 });
  }

  // 4-star tier (mid-range)
  const midIndex = Math.floor(sorted.length / 2);
  if (sorted.length >= 2) {
    tiers.push({ ...sorted[midIndex], tier: 4 });
  }

  // 3-star tier (best value)
  if (sorted.length >= 3) {
    tiers.push({ ...sorted[sorted.length - 1], tier: 3 });
  }

  // If we don't have 3 results, pad with what we have
  while (tiers.length < 3 && tiers.length < sorted.length) {
    tiers.push({ ...sorted[tiers.length], tier: 3 + tiers.length });
  }

  // Sort by tier ascending for display (3 → 4 → 5)
  return tiers.sort((a, b) => a.tier - b.tier);
}

/**
 * Placeholder hotels when scraper returns no results (fallback)
 */
function getPlaceholderHotels(data) {
  return [
    {
      tier: 3,
      name: 'Resultado pendente',
      description: 'A busca não retornou resultados automáticos. Nossa equipe fará a cotação manualmente.',
      location: data.destino,
      rating: 3,
      photos: [],
      priceTotal: 'Sob consulta',
      roomType: 'Standard',
      reviews: { rating: 0, reviewCount: 0, locationScore: null, cleanlinessScore: null, serviceScore: null, summary: '' },
    },
    {
      tier: 4,
      name: 'Resultado pendente',
      description: 'A busca não retornou resultados automáticos. Nossa equipe fará a cotação manualmente.',
      location: data.destino,
      rating: 4,
      photos: [],
      priceTotal: 'Sob consulta',
      roomType: 'Superior',
      reviews: { rating: 0, reviewCount: 0, locationScore: null, cleanlinessScore: null, serviceScore: null, summary: '' },
    },
    {
      tier: 5,
      name: 'Resultado pendente',
      description: 'A busca não retornou resultados automáticos. Nossa equipe fará a cotação manualmente.',
      location: data.destino,
      rating: 5,
      photos: [],
      priceTotal: 'Sob consulta',
      roomType: 'Deluxe',
      reviews: { rating: 0, reviewCount: 0, locationScore: null, cleanlinessScore: null, serviceScore: null, summary: '' },
    },
  ];
}

module.exports = { processQuotation };
