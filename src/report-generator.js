const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '5511999999999';

/**
 * Generate HTML report for the quotation (shareable with client)
 */
async function generateReport(data) {
  const {
    quotationId,
    numero,
    cliente,
    destino,
    checkIn,
    checkOut,
    adultos,
    criancas,
    estilos,
    prioridades,
    orcamentos,
    observacoes,
    hotels,
  } = data;

  const nights = calculateNights(checkIn, checkOut);
  const checkInFormatted = formatDate(checkIn);
  const checkOutFormatted = formatDate(checkOut);
  const now = new Date();
  const generatedAt = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  // Build preferences tags
  const allPrefs = [...(estilos || []), ...(prioridades || [])];
  const prefLabels = {
    resort: 'Resort',
    boutique: 'Boutique',
    hotel_urbano: 'Hotel Urbano',
    apart_hotel: 'Apart-Hotel',
    pousada: 'Pousada',
    all_inclusive: 'All-Inclusive',
    localizacao: 'Localização Central',
    luxo: 'Luxo',
    preco: 'Preço Baixo',
    amenities: 'Amenities',
    vista: 'Vista',
    silencio: 'Silêncio',
    familia: 'Família',
    romantico: 'Romântico',
  };

  const preferenceTags = allPrefs
    .map(p => prefLabels[p] || p)
    .map(label => `<span class="tag">${label}</span>`)
    .join('');

  // Build budget tags
  const budgetLabels = {
    economico: 'Econômico (até R$ 400)',
    moderado: 'Moderado (R$ 400-800)',
    confortavel: 'Confortável (R$ 800-1.500)',
    premium: 'Premium (R$ 1.500-3.000)',
    luxo: 'Luxo (acima de R$ 3.000)',
    sem_limite: 'Sem limite',
  };
  const budgetTags = (orcamentos || [])
    .map(o => budgetLabels[o] || o)
    .map(label => `<span class="tag tag-budget">${label}</span>`)
    .join('');

  // Build hotel cards
  const hotelCards = hotels.map(hotel => buildHotelCard(hotel, checkInFormatted, checkOutFormatted, nights, adultos)).join('');

  // Guest text
  let guestText = `${adultos} adulto${adultos > 1 ? 's' : ''}`;
  if (criancas > 0) {
    guestText += ` + ${criancas} criança${criancas > 1 ? 's' : ''}`;
  }

  // WhatsApp message
  const whatsappMsg = encodeURIComponent(
    `Olá! Vi a cotação #${numero || ''} para ${destino} (${checkInFormatted} - ${checkOutFormatted}) e gostaria de mais informações.`
  );
  const whatsappUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${whatsappMsg}`;

  // Observations section
  const observacoesHtml = observacoes
    ? `<div class="report-observations">
        <h3>Observações</h3>
        <p>${escapeHtml(observacoes)}</p>
      </div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cotação #${numero || ''} - ${escapeHtml(destino)} - GW Travel</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/styles.css">
  <style>
    body { background: #f5f5f5; }
    .report-container { background: #fff; padding: 32px 24px; border-radius: 8px; margin: 16px auto; box-shadow: 0 2px 20px rgba(0,0,0,0.08); }
    .tag-budget { background: #F0F7FF; border-color: #B3D4FC; color: #1565C0; }
    .report-observations { background: #FFFDF7; border: 1px solid #E0D5B8; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; }
    .report-observations h3 { font-size: 14px; font-weight: 600; color: #333; margin-bottom: 8px; }
    .report-observations p { font-size: 13px; color: #555; line-height: 1.6; }
    .payment-info { background: #F8FFF8; border: 1px solid #C8E6C9; border-radius: 8px; padding: 16px 20px; margin: 24px 0; }
    .payment-info h3 { font-size: 15px; font-weight: 600; color: #2E7D32; margin-bottom: 12px; }
    .payment-info ul { list-style: none; padding: 0; }
    .payment-info li { font-size: 13px; color: #333; margin: 6px 0; padding-left: 20px; position: relative; }
    .payment-info li::before { content: '\\2713'; position: absolute; left: 0; color: #2E7D32; font-weight: 700; }
    .report-number { font-size: 13px; color: #999; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="report-container">

    <div class="report-header">
      <div class="logo">
        <img src="/assets/gw-logo.png" alt="GW Travel" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
        <div class="logo-fallback" style="display:none;">
          <span class="logo-text">GW</span>
          <span class="logo-sub">TRAVEL</span>
        </div>
      </div>
    </div>

    <div class="report-meta">
      <h1>Cotação para ${escapeHtml(cliente.nome)}</h1>
      <p class="report-number">Cotação #${numero || ''}</p>
      <p>Destino: <strong>${escapeHtml(destino)}</strong></p>
      <p>${checkInFormatted} &rarr; ${checkOutFormatted} (${nights} noite${nights > 1 ? 's' : ''})</p>
      <p>${guestText}</p>
      ${preferenceTags ? `<div class="report-preferences">${preferenceTags}</div>` : ''}
      ${budgetTags ? `<div class="report-preferences" style="margin-top:8px;">${budgetTags}</div>` : ''}
    </div>

    ${observacoesHtml}

    ${hotelCards}

    <div class="payment-info">
      <h3>Forma de Pagamento</h3>
      <ul>
        <li>Cartão de crédito em até 12x sem juros</li>
      </ul>
      <p style="font-size:12px; color:#777; margin-top:12px;">* Valores sujeitos a alteração conforme disponibilidade no momento da reserva.</p>
      <p style="font-size:12px; color:#777;">* Taxas e impostos podem ser cobrados separadamente conforme política do hotel.</p>
    </div>

    <div class="report-cta">
      <h2>Gostou? Fale com a gente!</h2>
      <a href="${whatsappUrl}" target="_blank" class="btn-whatsapp">&#128172; CHAMAR NO WHATSAPP</a>
      <div class="report-contact">
        <p>&#128231; atendimento@gwtravel.com.br</p>
        <p>&#128222; (11) 9999-9999</p>
      </div>
    </div>

    <div class="report-footer">
      <p><strong>GW Travel</strong> - Viagens Personalizadas</p>
      <p>Cotação válida por 24h | #${numero || ''}</p>
      <p>Gerado em: ${generatedAt}</p>
    </div>
  </div>
</body>
</html>`;

  // Save to outputs directory
  const outputDir = path.join(__dirname, '..', 'outputs');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, `${quotationId}.html`);
  fs.writeFileSync(outputPath, html, 'utf-8');

  const reportUrl = `${BASE_URL}/cotacao/${quotationId}`;
  return reportUrl;
}

/**
 * Build a single hotel card HTML
 */
function buildHotelCard(hotel, checkIn, checkOut, nights, adultos) {
  const tierStars = {
    3: '&#11088;&#11088;&#11088;',
    4: '&#11088;&#11088;&#11088;&#11088;',
    5: '&#11088;&#11088;&#11088;&#11088;&#11088;',
  };

  const tierNames = {
    3: 'Econômico',
    4: 'Conforto',
    5: 'Premium',
  };

  const tierLabel = tierStars[hotel.tier] || '&#11088;&#11088;&#11088;';
  const tierName = tierNames[hotel.tier] || '';

  // Photos
  let photosHtml = '';
  if (hotel.photos && hotel.photos.length > 0) {
    const photos = hotel.photos.slice(0, 3);
    photosHtml = `<div class="hotel-photos">
      ${photos.map(src => `<img src="${escapeHtml(src)}" alt="${escapeHtml(hotel.name)}" loading="lazy">`).join('')}
    </div>`;
  }

  // Ratings
  let ratingsHtml = '';
  if (hotel.reviews) {
    const r = hotel.reviews;
    if (r.locationScore) {
      ratingsHtml += `<p>&#128205; Localização: <span class="stars">${renderStars(r.locationScore)}</span></p>`;
    }
    if (r.cleanlinessScore) {
      ratingsHtml += `<p>&#129529; Limpeza: <span class="stars">${renderStars(r.cleanlinessScore)}</span></p>`;
    }
    if (r.serviceScore) {
      ratingsHtml += `<p>&#128588; Serviço: <span class="stars">${renderStars(r.serviceScore)}</span></p>`;
    }
    if (r.rating && r.reviewCount) {
      ratingsHtml += `<p>&#11088; ${r.rating.toFixed(1)} (${r.reviewCount} avaliações)</p>`;
    }
  }

  return `
    <div class="hotel-card">
      <div class="hotel-tier">${tierLabel} <span style="margin-left:8px; font-size:13px; letter-spacing:1px;">${tierName}</span></div>
      ${photosHtml}
      <div class="hotel-info">
        <h3 class="hotel-name">${escapeHtml(hotel.name)}</h3>
        ${hotel.description ? `<p class="hotel-desc">"${escapeHtml(hotel.description)}"</p>` : ''}
        ${ratingsHtml ? `<div class="hotel-ratings">${ratingsHtml}</div>` : ''}
      </div>
      <div class="hotel-booking">
        <p>${checkIn} - ${checkOut} (${nights} noite${nights > 1 ? 's' : ''})</p>
        <p>${adultos} adulto${adultos > 1 ? 's' : ''} - ${escapeHtml(hotel.roomType || 'Quarto Standard')}</p>
        <p class="hotel-price">
          ${hotel.priceTotal ? `Total: ${escapeHtml(String(hotel.priceTotal))}` : 'Sob consulta'}
          ${hotel.pricePerNight ? `<span class="hotel-price-note"> (R$ ${hotel.pricePerNight.toFixed(2).replace('.', ',')}/noite)</span>` : ''}
        </p>
      </div>
    </div>`;
}

/**
 * Render star ratings (out of 5)
 */
function renderStars(score) {
  const maxStars = 5;
  const normalizedScore = Math.min(score, maxStars);
  const full = Math.floor(normalizedScore);
  const half = normalizedScore % 1 >= 0.5 ? 1 : 0;
  const empty = maxStars - full - half;

  return '&#9733;'.repeat(full) + (half ? '&#9734;' : '') + '&#9734;'.repeat(empty);
}

/**
 * Calculate number of nights between two ISO dates
 */
function calculateNights(checkIn, checkOut) {
  const diff = new Date(checkOut) - new Date(checkIn);
  return Math.max(1, Math.round(diff / (1000 * 60 * 60 * 24)));
}

/**
 * Format ISO date to DD/MM/YYYY
 */
function formatDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Escape HTML entities
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { generateReport };
