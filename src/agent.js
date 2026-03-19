const { searchHotelsAmadeus, isConfigured: amadeusConfigured } = require('./amadeus-search');
const { searchMysnow } = require('./mysnow-scraper');
const { fetchReviews } = require('./review-fetcher');
const { generateReport } = require('./report-generator');

const BUDGET_RANGES = {
  economico: { min: 0, max: 400 },
  moderado: { min: 400, max: 800 },
  confortavel: { min: 800, max: 1500 },
  premium: { min: 1500, max: 3000 },
  luxo: { min: 3000, max: Infinity },
  sem_limite: { min: 0, max: Infinity },
};

/**
 * Main orchestrator: receives form data, coordinates search,
 * generates report, and sends real-time progress events.
 */
async function processQuotation(data, onProgress) {
  const quotationId = data.quotationId;
  const emit = onProgress || function() {};

  console.log(`[${quotationId}] Starting quotation #${data.numero} for ${data.cliente.nome} → ${data.destino}`);

  try {
    // Step 1: Search hotels
    console.log(`[${quotationId}] Step 1: Searching hotels...`);
    emit('progress', {
      step: 'search',
      status: 'active',
      message: 'Buscando hotéis...',
      progress: 10,
      clienteNome: data.cliente.nome,
      destino: data.destino,
    });

    const orcamentos = data.orcamentos || [data.orcamento || 'sem_limite'];
    let allResults = [];

    // Strategy 1: Mysnow scraper (primary - use with residential proxy for best results)
    console.log(`[${quotationId}] Trying Mysnow scraper...`);
    emit('progress', {
      step: 'search',
      status: 'active',
      message: 'Buscando na Mysnow...',
      progress: 15,
    });

    for (const orcamento of orcamentos) {
      const results = await searchMysnow({
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

    // Strategy 2: Amadeus API fallback (if Mysnow returned nothing)
    if (allResults.length === 0) {
      if (amadeusConfigured()) {
        console.log(`[${quotationId}] Mysnow returned 0, falling back to Amadeus API...`);
        emit('progress', {
          step: 'search',
          status: 'active',
          message: 'Buscando via Amadeus API...',
          progress: 25,
        });

        allResults = await searchHotelsAmadeus({
          destino: data.destino,
          checkIn: data.checkIn,
          checkOut: data.checkOut,
          adultos: data.adultos,
          criancas: data.criancas,
        });
      } else {
        console.log(`[${quotationId}] ⚠ Amadeus NOT configured — set AMADEUS_API_KEY and AMADEUS_API_SECRET in env vars for fallback`);
        console.log(`[${quotationId}] Will use smart placeholders instead`);
      }
    }

    // Remove duplicates by name
    const seen = new Set();
    let searchResults = allResults.filter(hotel => {
      if (seen.has(hotel.name)) return false;
      seen.add(hotel.name);
      return true;
    });

    // Filter by budget
    searchResults = filterByBudget(searchResults, orcamentos);

    console.log(`[${quotationId}] Search returned ${searchResults.length} results (with room details from Phase 2)`);
    emit('progress', {
      step: 'search',
      status: 'done',
      message: `${searchResults.length} hotéis encontrados com detalhes de quartos`,
      progress: 50,
    });

    // Step 2: Enrich with reviews
    console.log(`[${quotationId}] Step 2: Enriching with reviews...`);
    emit('progress', {
      step: 'reviews',
      status: 'active',
      message: 'Coletando avaliações...',
      progress: 55,
    });

    const hotelsWithReviews = await enrichWithReviews(searchResults);
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
 * Filter results by budget ranges
 */
function filterByBudget(hotels, orcamentos) {
  if (!orcamentos || orcamentos.length === 0 || orcamentos.includes('sem_limite')) {
    return hotels;
  }

  // Merge all budget ranges
  let minPrice = Infinity;
  let maxPrice = 0;
  for (const orc of orcamentos) {
    const range = BUDGET_RANGES[orc];
    if (range) {
      minPrice = Math.min(minPrice, range.min);
      maxPrice = Math.max(maxPrice, range.max);
    }
  }

  if (maxPrice === 0) return hotels;

  return hotels.filter(h => {
    if (!h.pricePerNight) return true; // Keep hotels without price info
    return h.pricePerNight >= minPrice && h.pricePerNight <= maxPrice;
  });
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
          reviewCount: reviews.reviewCount || hotel.reviewCount || 0,
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
          reviewCount: hotel.reviewCount || 0,
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
 */
function selectTierOptions(hotels, data) {
  if (hotels.length === 0) {
    return getSmartPlaceholders(data);
  }

  // Sort by rating descending
  const sorted = [...hotels].sort((a, b) =>
    (b.reviews?.rating || b.rating || 0) - (a.reviews?.rating || a.rating || 0)
  );

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

  // 3-star tier (best value - lowest price or lowest rated)
  if (sorted.length >= 3) {
    tiers.push({ ...sorted[sorted.length - 1], tier: 3 });
  }

  while (tiers.length < 3 && tiers.length < sorted.length) {
    tiers.push({ ...sorted[tiers.length], tier: 3 + tiers.length });
  }

  return tiers.sort((a, b) => a.tier - b.tier);
}

/**
 * Smart placeholders with real hotel names per destination.
 * Used when all search strategies fail (no API keys, scraper blocked).
 */
function getSmartPlaceholders(data) {
  const dest = (data.destino || '').toLowerCase();

  // Known hotels per destination for realistic placeholders
  const hotelDB = {
    'paris': [
      { name: 'Hôtel Le Marais', rating: 3, price: 450, room: 'Standard' },
      { name: 'Hôtel Plaza Athénée', rating: 5, price: 2800, room: 'Deluxe' },
      { name: 'Novotel Paris Centre Tour Eiffel', rating: 4, price: 890, room: 'Superior' },
    ],
    'cancun': [
      { name: 'Hotel NYX Cancún', rating: 3, price: 380, room: 'Standard' },
      { name: 'Hyatt Zilara Cancún', rating: 5, price: 2200, room: 'Suite Ocean View' },
      { name: 'Grand Fiesta Americana Coral Beach', rating: 4, price: 1200, room: 'Deluxe Ocean' },
    ],
    'orlando': [
      { name: 'Holiday Inn Resort Orlando Suites', rating: 3, price: 350, room: 'Standard Suite' },
      { name: 'Waldorf Astoria Orlando', rating: 5, price: 2500, room: 'Deluxe King' },
      { name: 'Hilton Orlando Bonnet Creek', rating: 4, price: 900, room: 'Resort View' },
    ],
    'miami': [
      { name: 'Hampton Inn Miami Beach', rating: 3, price: 420, room: 'Standard' },
      { name: 'Faena Hotel Miami Beach', rating: 5, price: 3200, room: 'Ocean Front Suite' },
      { name: 'Loews Miami Beach Hotel', rating: 4, price: 1100, room: 'Ocean View' },
    ],
    'roma': [
      { name: 'Hotel Lancelot', rating: 3, price: 380, room: 'Classic' },
      { name: 'Hotel de Russie', rating: 5, price: 2600, room: 'Deluxe' },
      { name: 'Hotel Artemide', rating: 4, price: 750, room: 'Superior' },
    ],
    'londres': [
      { name: 'Point A Hotel London Kings Cross', rating: 3, price: 400, room: 'Standard' },
      { name: 'The Savoy', rating: 5, price: 3500, room: 'Deluxe River View' },
      { name: 'The Tower Hotel London', rating: 4, price: 950, room: 'Superior' },
    ],
    'maldivas': [
      { name: 'Arena Beach Hotel', rating: 3, price: 600, room: 'Beach View' },
      { name: 'Soneva Fushi', rating: 5, price: 8000, room: 'Beach Villa' },
      { name: 'Centara Grand Island Resort', rating: 4, price: 2500, room: 'Water Villa' },
    ],
    'dubai': [
      { name: 'Rove Downtown Dubai', rating: 3, price: 450, room: 'Rover Room' },
      { name: 'Burj Al Arab Jumeirah', rating: 5, price: 5000, room: 'Deluxe Suite' },
      { name: 'JW Marriott Marquis Hotel Dubai', rating: 4, price: 1200, room: 'Deluxe King' },
    ],
    'punta cana': [
      { name: 'Whala! Bávaro', rating: 3, price: 380, room: 'Standard All Inclusive' },
      { name: 'Secrets Cap Cana Resort & Spa', rating: 5, price: 2800, room: 'Junior Suite Ocean View' },
      { name: 'Hard Rock Hotel & Casino Punta Cana', rating: 4, price: 1400, room: 'Deluxe Gold' },
    ],
    'rio de janeiro': [
      { name: 'Hotel Atlântico Copacabana', rating: 3, price: 320, room: 'Standard' },
      { name: 'Copacabana Palace', rating: 5, price: 3200, room: 'Deluxe Ocean View' },
      { name: 'Windsor Atlantica Hotel', rating: 4, price: 850, room: 'Superior Ocean' },
    ],
    'buenos aires': [
      { name: 'Hotel Madero Buenos Aires', rating: 3, price: 280, room: 'Standard' },
      { name: 'Alvear Palace Hotel', rating: 5, price: 1800, room: 'Deluxe Suite' },
      { name: 'Palacio Duhau Park Hyatt', rating: 4, price: 900, room: 'Park King' },
    ],
    'barcelona': [
      { name: 'Hotel Jazz', rating: 3, price: 420, room: 'Standard' },
      { name: 'Hotel Arts Barcelona', rating: 5, price: 2400, room: 'Deluxe Sea View' },
      { name: 'H10 Casa Mimosa', rating: 4, price: 850, room: 'Superior' },
    ],
  };

  // Find matching destination
  let hotels = null;
  for (const [key, value] of Object.entries(hotelDB)) {
    if (dest.includes(key)) {
      hotels = value;
      break;
    }
  }

  // Default generic placeholders
  if (!hotels) {
    hotels = [
      { name: 'Hotel econômico selecionado', rating: 3, price: 400, room: 'Standard' },
      { name: 'Hotel conforto selecionado', rating: 4, price: 1000, room: 'Superior' },
      { name: 'Hotel premium selecionado', rating: 5, price: 2500, room: 'Deluxe' },
    ];
  }

  return hotels.map((h, i) => ({
    tier: 3 + i,
    name: h.name,
    description: 'Cotação com valores de referência. Confirme disponibilidade e preço atualizado antes de fechar.',
    location: data.destino,
    rating: h.rating,
    photos: [],
    pricePerNight: h.price,
    priceTotal: `R$ ${(h.price * calculateNights(data.checkIn, data.checkOut)).toFixed(2)}`,
    roomType: h.room,
    reviews: {
      rating: h.rating,
      reviewCount: 0,
      locationScore: null,
      cleanlinessScore: null,
      serviceScore: null,
      summary: '',
    },
  }));
}

function calculateNights(checkIn, checkOut) {
  const d1 = new Date(checkIn);
  const d2 = new Date(checkOut);
  const diff = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
  return diff > 0 ? diff : 1;
}

module.exports = { processQuotation };
