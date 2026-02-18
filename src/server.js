require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { processQuotation } = require('./agent');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use('/assets', express.static(path.join(__dirname, '..', 'frontend', 'assets')));
app.use('/outputs', express.static(path.join(__dirname, '..', 'outputs')));

// ===== Data store (JSON file) =====
const DATA_FILE = path.join(__dirname, '..', 'data', 'quotations.json');

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadQuotations() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveQuotations(quotations) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(quotations, null, 2), 'utf-8');
}

function getNextNumber() {
  const quotations = loadQuotations();
  if (quotations.length === 0) return 1001;
  const maxNum = Math.max(...quotations.map(q => q.numero || 0));
  return maxNum + 1;
}

// ===== SSE connections for real-time progress =====
const sseClients = new Map(); // quotationId -> [response objects]

function sendSSE(quotationId, event, data) {
  const clients = sseClients.get(quotationId);
  if (clients) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach(res => {
      try { res.write(message); } catch {}
    });
  }
}

// ===== Pages =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'intake.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'dashboard.html'));
});

app.get('/processando/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'processando.html'));
});

// Report viewer (shareable link for clients)
app.get('/cotacao/:id', (req, res) => {
  const reportPath = path.join(__dirname, '..', 'outputs', `${req.params.id}.html`);
  res.sendFile(reportPath, (err) => {
    if (err) {
      res.status(404).send('Cotação não encontrada ou expirada.');
    }
  });
});

// ===== API: Create quotation =====
app.post('/api/cotacao', (req, res) => {
  try {
    const data = req.body;

    // Basic validation (no email required anymore)
    if (!data.cliente?.nome || !data.destino || !data.checkIn || !data.checkOut) {
      return res.status(400).json({ success: false, error: 'Campos obrigatórios não preenchidos.' });
    }

    const crypto = require('crypto');
    const quotationId = crypto.randomUUID();
    const numero = getNextNumber();

    // Save to data store
    const quotations = loadQuotations();
    quotations.unshift({
      id: quotationId,
      numero: numero,
      clienteNome: data.cliente.nome,
      destino: data.destino,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      adultos: data.adultos,
      criancas: data.criancas,
      orcamentos: data.orcamentos || ['sem_limite'],
      status: 'processing',
      reportUrl: null,
      createdAt: new Date().toISOString(),
    });
    saveQuotations(quotations);

    // Respond with quotation ID so frontend can connect to SSE
    res.json({ success: true, quotationId, numero });

    // Process asynchronously with progress events
    const onProgress = (event, progressData) => {
      sendSSE(quotationId, event, progressData);
    };

    processQuotation({ ...data, quotationId, numero }, onProgress)
      .then(result => {
        // Update data store
        const q = loadQuotations();
        const idx = q.findIndex(x => x.id === quotationId);
        if (idx !== -1) {
          q[idx].status = 'completed';
          q[idx].reportUrl = result.reportUrl;
          q[idx].completedAt = new Date().toISOString();
          saveQuotations(q);
        }

        // Notify SSE clients
        sendSSE(quotationId, 'complete', { reportUrl: result.reportUrl });

        // Clean up SSE connections
        const clients = sseClients.get(quotationId);
        if (clients) {
          clients.forEach(r => { try { r.end(); } catch {} });
          sseClients.delete(quotationId);
        }
      })
      .catch(err => {
        console.error('Error processing quotation:', err);

        const q = loadQuotations();
        const idx = q.findIndex(x => x.id === quotationId);
        if (idx !== -1) {
          q[idx].status = 'error';
          q[idx].error = err.message;
          saveQuotations(q);
        }

        sendSSE(quotationId, 'error_event', { message: err.message });

        const clients = sseClients.get(quotationId);
        if (clients) {
          clients.forEach(r => { try { r.end(); } catch {} });
          sseClients.delete(quotationId);
        }
      });

  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ success: false, error: 'Erro interno.' });
  }
});

// ===== API: SSE progress endpoint =====
app.get('/api/cotacao/:id/progress', (req, res) => {
  const quotationId = req.params.id;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send initial connection event
  const quotations = loadQuotations();
  const quotation = quotations.find(q => q.id === quotationId);

  if (quotation) {
    res.write(`event: progress\ndata: ${JSON.stringify({
      step: 'init',
      status: 'active',
      clienteNome: quotation.clienteNome,
      destino: quotation.destino,
      message: 'Conectado',
    })}\n\n`);

    // If already completed, send complete event immediately
    if (quotation.status === 'completed' && quotation.reportUrl) {
      res.write(`event: complete\ndata: ${JSON.stringify({ reportUrl: quotation.reportUrl })}\n\n`);
      res.end();
      return;
    }
  }

  // Register SSE client
  if (!sseClients.has(quotationId)) {
    sseClients.set(quotationId, []);
  }
  sseClients.get(quotationId).push(res);

  // Keep alive
  const keepAlive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const clients = sseClients.get(quotationId);
    if (clients) {
      const idx = clients.indexOf(res);
      if (idx !== -1) clients.splice(idx, 1);
      if (clients.length === 0) sseClients.delete(quotationId);
    }
  });
});

// ===== API: Get quotation status =====
app.get('/api/cotacao/:id/status', (req, res) => {
  const quotations = loadQuotations();
  const quotation = quotations.find(q => q.id === req.params.id);
  if (!quotation) {
    return res.status(404).json({ error: 'Cotação não encontrada.' });
  }
  res.json({
    id: quotation.id,
    numero: quotation.numero,
    status: quotation.status,
    reportUrl: quotation.reportUrl,
  });
});

// ===== API: List all quotations (dashboard) =====
app.get('/api/cotacoes', (req, res) => {
  const quotations = loadQuotations();
  res.json({ quotations });
});

// ===== API: Delete quotation =====
app.delete('/api/cotacao/:id', (req, res) => {
  const quotations = loadQuotations();
  const idx = quotations.findIndex(q => q.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Cotação não encontrada.' });
  }
  quotations.splice(idx, 1);
  saveQuotations(quotations);
  res.json({ success: true });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`GW Travel - ExpediaAG running on ${BASE_URL}`);
});
