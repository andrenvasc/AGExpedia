require('dotenv').config();
const express = require('express');
const path = require('path');
const { processQuotation } = require('./agent');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use('/assets', express.static(path.join(__dirname, '..', 'frontend', 'assets')));
app.use('/outputs', express.static(path.join(__dirname, '..', 'outputs')));

// Pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'intake.html'));
});

app.get('/confirmacao', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'confirmacao.html'));
});

// Report viewer
app.get('/cotacao/:id', (req, res) => {
  const reportPath = path.join(__dirname, '..', 'outputs', `${req.params.id}.html`);
  res.sendFile(reportPath, (err) => {
    if (err) {
      res.status(404).send('Cotação não encontrada ou expirada.');
    }
  });
});

// API: Receive quotation request
app.post('/api/cotacao', async (req, res) => {
  try {
    const data = req.body;

    // Basic validation
    if (!data.cliente?.nome || !data.cliente?.email || !data.destino || !data.checkIn || !data.checkOut) {
      return res.status(400).json({ success: false, error: 'Campos obrigatórios não preenchidos.' });
    }

    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.cliente.email)) {
      return res.status(400).json({ success: false, error: 'Formato de e-mail inválido.' });
    }

    // Respond immediately to the client
    res.json({ success: true, message: 'Cotação em processamento.' });

    // Process asynchronously
    processQuotation(data).catch(err => {
      console.error('Error processing quotation:', err);
    });

  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ success: false, error: 'Erro interno.' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`GW Travel - ExpediaAG running on http://localhost:${PORT}`);
});
