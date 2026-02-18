const { searchExpedia } = require('./expedia-scraper');
const { fetchReviews } = require('./review-fetcher');
const { generateReport } = require('./report-generator');

/**
 * Main orchestrator: receives form data, coordinates scraping,
 * generates report, and sends real-time progress events.
 *
 * @param {object} data - Form data + quotationId + numero
 * @param {function} onProgress - Callback(event, data) for SSE progress
 */
async function processQuotation(data, onProgress) {
  const quotationId = data.quotationId;
  const emit = onProgress || function() {};

  console.log(`[${quotationId}] Starting quotation #${data.numero} for ${data.cliente.nome} → ${data.destino}`);

  try {
    // Step 1: Search Expedia TAAP
    console.log(`[${quotationId}] Step 1: Searching Expedia TAAP...`);
    emit('progress', {
      step: 'search',
      status: 'active',
      message: 'Buscando hotéis na Expedia...',
      progress: 10,
      clienteNome: data.cliente.nome,
      destino: data.destino,
    });

    // Handle multiple budget ranges
    const orcamentos = data.orcamentos || [data.orcamento || 'sem_limite'];
    let allResults = [];

    for (const orcamento of orcamentos) {
      const results = await searchExpedia({
        destino: data.destino,
        checkIn: data.checkIn,
        checkOut: data.checkOut,
        adultos: data.adultos,
        criancas: data.criancas,
        idadesCriancas: data.idadesCriancas,
        estilos: data.estilos,
        prioridades: data.prioridades,
        orcamento: orcamento,
      });
      allResults = allResults.concat(results);
    }

    // Remove duplicates by hotel name
    const seen = new Set();
    const expediaResults = allResults.filter(hotel => {
      if (seen.has(hotel.name)) return false;
      seen.add(hotel.name);
      return true;
    });

    console.log(`[${quotationId}] Expedia returned ${expediaResults.length} unique results`);
    emit('progress', {
      step: 'search',
      status: 'done',
      message: `${expediaResults.length} hotéis encontrados`,
      progress: 35,
    });

    // Step 2: Fetch reviews for top candidates
    console.log(`[${quotationId}] Step 2: Fetching reviews...`);
    emit('progress', {
      step: 'reviews',
      status: 'active',
      message: 'Coletando avaliações...',
      progress: 40,
    });

    const hotelsWithReviews = await enrichWithReviews(expediaResults);
    console.log(`[${quotationId}] Reviews enriched for ${hotelsWithReviews.length} hotels`);
    emit('progress', {
      step: 'reviews',
      status: 'done',
      message: `Avaliações coletadas para ${hotelsWithReviews.length} hotéis`,
      progress: 60,
    });

    // Step 3: Select tier options
    console.log(`[${quotationId}] Step 3: Selecting tier options...`);
    emit('progress', {
      step: 'select',
      status: 'active',
      message: 'Selecionando melhores opções...',
      progress: 65,
    });

    const selectedHotels = selectTierOptions(hotelsWithReviews, data);

    // Send live hotel previews
    selectedHotels.forEach(hotel => {
      const tierLabels = { 3: 'Econômico', 4: 'Conforto', 5: 'Premium' };
      emit('hotel_found', {
        name: hotel.name,
        location: hotel.location,
        pricePerNight: hotel.pricePerNight,
        tierLabel: tierLabels[hotel.tier] || 'Opção',
      });
    });

    emit('progress', {
      step: 'select',
      status: 'done',
      message: `${selectedHotels.length} opções selecionadas`,
      progress: 75,
    });

    // Step 4: Generate HTML report
    console.log(`[${quotationId}] Step 4: Generating report...`);
    emit('progress', {
      step: 'report',
      status: 'active',
      message: 'Montando cotação...',
      progress: 80,
    });

    const reportUrl = await generateReport({
      quotationId,
      numero: data.numero,
      cliente: data.cliente,
      destino: data.destino,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      adultos: data.adultos,
      criancas: data.criancas,
      estilos: data.estilos,
      prioridades: data.prioridades,
      orcamentos: data.orcamentos,
      observacoes: data.observacoes,
      hotels: selectedHotels,
    });

    console.log(`[${quotationId}] Report generated: ${reportUrl}`);
    emit('progress', {
      step: 'report',
      status: 'done',
      message: 'Cotação gerada com sucesso!',
      progress: 100,
    });

    console.log(`[${quotationId}] Quotation #${data.numero} complete!`);
    return { quotationId, reportUrl };

  } catch (error) {
    console.error(`[${quotationId}] Error:`, error.message);
    emit('progress', {
      step: 'error',
      status: 'error',
      message: error.message,
    });
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
 * Select hotels: one for each tier (3-star value, 4-star comfort, 5-star premium)
 * If multiple budget ranges selected, try to pick from different ranges
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
