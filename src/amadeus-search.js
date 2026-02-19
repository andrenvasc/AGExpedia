/**
 * Amadeus Hotel Search API integration.
 *
 * Requires free account at https://developers.amadeus.com
 * Set env vars: AMADEUS_API_KEY, AMADEUS_API_SECRET
 * Optional: AMADEUS_ENV=production (default: test)
 *
 * Test environment: unlimited calls, test data
 * Production: 2000 calls/month free tier, real data
 */

const AMADEUS_BASE = process.env.AMADEUS_ENV === 'production'
  ? 'https://api.amadeus.com'
  : 'https://test.api.amadeus.com';

let cachedToken = null;
let tokenExpiry = 0;

function isConfigured() {
  return !!(process.env.AMADEUS_API_KEY && process.env.AMADEUS_API_SECRET);
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(`${AMADEUS_BASE}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AMADEUS_API_KEY,
      client_secret: process.env.AMADEUS_API_SECRET,
    }),
  });

  if (!res.ok) {
    throw new Error(`Amadeus auth failed: ${res.status}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function amadeusGet(path, token) {
  const res = await fetch(`${AMADEUS_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Amadeus API ${res.status}: ${text.substring(0, 200)}`);
  }

  return res.json();
}

/**
 * Search hotels via Amadeus API
 */
async function searchHotelsAmadeus(params) {
  const { destino, checkIn, checkOut, adultos, criancas } = params;

  if (!isConfigured()) {
    console.log('  → Amadeus: not configured (missing API keys)');
    return [];
  }

  try {
    console.log('  → Amadeus: authenticating...');
    const token = await getToken();

    // Step 1: Get city code from destination name
    const cityCode = await getCityCode(token, destino);
    if (!cityCode) {
      console.log('  → Amadeus: city code not found for', destino);
      return [];
    }
    console.log(`  → Amadeus: city code = ${cityCode}`);

    // Step 2: Get hotel IDs for the city
    const hotelIds = await getHotelIds(token, cityCode);
    if (hotelIds.length === 0) {
      console.log('  → Amadeus: no hotels found for city', cityCode);
      return [];
    }
    console.log(`  → Amadeus: ${hotelIds.length} hotels in city`);

    // Step 3: Get offers for top hotels (limit to 20 for speed)
    const hotels = await getHotelOffers(token, hotelIds.slice(0, 20), {
      checkIn,
      checkOut,
      adultos: adultos || 2,
    });
    console.log(`  → Amadeus: ${hotels.length} hotels with offers`);
    return hotels;

  } catch (error) {
    console.error('  → Amadeus error:', error.message);
    return [];
  }
}

async function getCityCode(token, destination) {
  // Common city codes lookup (avoid API call for popular destinations)
  const commonCodes = {
    'paris': 'PAR', 'londres': 'LON', 'london': 'LON', 'nova york': 'NYC',
    'new york': 'NYC', 'roma': 'ROM', 'rome': 'ROM', 'madri': 'MAD',
    'madrid': 'MAD', 'barcelona': 'BCN', 'lisboa': 'LIS', 'lisbon': 'LIS',
    'cancun': 'CUN', 'cancún': 'CUN', 'miami': 'MIA', 'orlando': 'ORL',
    'buenos aires': 'BUE', 'santiago': 'SCL', 'lima': 'LIM', 'bogota': 'BOG',
    'bogotá': 'BOG', 'dubai': 'DXB', 'tokyo': 'TYO', 'tóquio': 'TYO',
    'bangkok': 'BKK', 'bali': 'DPS', 'maldivas': 'MLE', 'maldives': 'MLE',
    'punta cana': 'PUJ', 'cartagena': 'CTG', 'rio de janeiro': 'RIO',
    'são paulo': 'SAO', 'sao paulo': 'SAO', 'florianópolis': 'FLN',
    'florianopolis': 'FLN', 'salvador': 'SSA', 'recife': 'REC',
    'fortaleza': 'FOR', 'natal': 'NAT', 'maceió': 'MCZ', 'maceio': 'MCZ',
    'gramado': 'CXJ', 'porto seguro': 'BPS', 'foz do iguaçu': 'IGU',
    'foz do iguacu': 'IGU', 'amsterdam': 'AMS', 'berlim': 'BER',
    'berlin': 'BER', 'viena': 'VIE', 'vienna': 'VIE', 'praga': 'PRG',
    'prague': 'PRG', 'atenas': 'ATH', 'athens': 'ATH', 'istambul': 'IST',
    'istanbul': 'IST', 'cairo': 'CAI', 'marrakech': 'RAK',
    'cidade do cabo': 'CPT', 'cape town': 'CPT', 'singapura': 'SIN',
    'singapore': 'SIN', 'hong kong': 'HKG', 'sydney': 'SYD',
    'los angeles': 'LAX', 'las vegas': 'LAS', 'san francisco': 'SFO',
    'toronto': 'YTO', 'vancouver': 'YVR', 'montreal': 'YMQ',
    'cidade do mexico': 'MEX', 'mexico city': 'MEX', 'playa del carmen': 'CUN',
    'cusco': 'CUZ', 'cuzco': 'CUZ', 'bariloche': 'BRC',
    'montevideu': 'MVD', 'montevideo': 'MVD',
  };

  // Clean destination: "Paris, França" → "paris"
  const clean = destination.split(',')[0].trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Try common codes first
  for (const [key, code] of Object.entries(commonCodes)) {
    const cleanKey = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (clean === cleanKey || clean.includes(cleanKey)) {
      return code;
    }
  }

  // Fall back to Amadeus Location API
  try {
    const keyword = destination.split(',')[0].trim();
    const data = await amadeusGet(
      `/v1/reference-data/locations?keyword=${encodeURIComponent(keyword)}&subType=CITY&page%5Blimit%5D=1`,
      token
    );
    return data?.data?.[0]?.iataCode || null;
  } catch {
    return null;
  }
}

async function getHotelIds(token, cityCode) {
  const data = await amadeusGet(
    `/v1/reference-data/locations/hotels/by-city?cityCode=${cityCode}&radius=30&radiusUnit=KM&hotelSource=ALL`,
    token
  );
  return (data?.data || []).map(h => h.hotelId).filter(Boolean);
}

async function getHotelOffers(token, hotelIds, params) {
  const queryParams = new URLSearchParams({
    hotelIds: hotelIds.join(','),
    checkInDate: params.checkIn,
    checkOutDate: params.checkOut,
    adults: String(params.adultos || 2),
    roomQuantity: '1',
    currency: 'BRL',
    bestRateOnly: 'true',
  });

  const data = await amadeusGet(`/v3/shopping/hotel-offers?${queryParams}`, token);
  const nights = calculateNights(params.checkIn, params.checkOut);

  return (data?.data || []).map(hotel => {
    const offer = hotel.offers?.[0];
    const totalPrice = parseFloat(offer?.price?.total || '0');
    const perNight = nights > 0 ? totalPrice / nights : totalPrice;

    return {
      name: hotel.hotel?.name || '',
      location: hotel.hotel?.cityCode || '',
      rating: parseInt(hotel.hotel?.rating || '0'),
      pricePerNight: Math.round(perNight * 100) / 100,
      priceTotal: totalPrice > 0 ? `R$ ${totalPrice.toFixed(2)}` : '',
      photos: [],
      description: offer?.room?.description?.text || '',
      roomType: offer?.room?.typeEstimated?.category || 'Standard',
      amenities: [],
      reviewCount: 0,
      source: 'amadeus',
    };
  }).filter(h => h.name && h.pricePerNight > 0);
}

function calculateNights(checkIn, checkOut) {
  const d1 = new Date(checkIn);
  const d2 = new Date(checkOut);
  const diff = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
  return diff > 0 ? diff : 1;
}

module.exports = { searchHotelsAmadeus, isConfigured };
