const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const openapi = require('../openapi.json');
const demoData = require('./data');

const app = express();
const port = Number(process.env.PORT || 5100);
const context = process.env.API_CONTEXT || '/api/v1';
const apiName = process.env.API_NAME || 'mock-api';
let healthMode = 'healthy';

app.use(cors());
app.use(express.json());
app.use(morgan('combined'));

function now() {
  return new Date().toISOString();
}

function envelope(data) {
  return {
    traceId: uuidv4(),
    service: apiName,
    timestamp: now(),
    data
  };
}

app.get(`${context}/health`, (req, res) => {
  const latency = Number(req.query.latencyMs || 0);
  setTimeout(() => {
    if (healthMode === 'down') {
      return res.status(503).json({ status: 'DOWN', service: apiName, timestamp: now(), reason: 'Simulated outage' });
    }
    if (healthMode === 'wrongPayload') {
      return res.status(200).json({ ok: true, serviceName: apiName, timestamp: now() });
    }
    if (healthMode === 'degraded') {
      return res.status(200).json({ status: 'DEGRADED', service: apiName, timestamp: now(), checks: { database: 'UP', dependency: 'SLOW' } });
    }
    return res.status(200).json({ status: 'UP', service: apiName, timestamp: now(), checks: { database: 'UP', dependency: 'UP' } });
  }, latency);
});

app.get(`${context}/openapi.json`, (req, res) => res.json(openapi));

app.post(`${context}/__admin/health-mode`, (req, res) => {
  const allowed = ['healthy', 'degraded', 'wrongPayload', 'down'];
  const mode = req.body?.mode;
  if (!allowed.includes(mode)) {
    return res.status(400).json({ message: `mode must be one of ${allowed.join(', ')}` });
  }
  healthMode = mode;
  return res.json({ service: apiName, mode: healthMode, updatedAt: now() });
});

app.get(`${context}/accounts/:customerId`, (req, res) => res.json(envelope(demoData.accounts(req.params.customerId))));
app.get(`${context}/accounts/:accountId/transactions`, (req, res) => res.json(envelope(demoData.transactions(req.params.accountId))));

app.get(`${context}/payments/:paymentId`, (req, res) => res.json(envelope(demoData.payment(req.params.paymentId))));
app.post(`${context}/payments`, (req, res) => res.status(201).json(envelope(demoData.createPayment(req.body))));

app.get(`${context}/customers/:customerId`, (req, res) => res.json(envelope(demoData.customer(req.params.customerId))));
app.get(`${context}/customers/:customerId/profile`, (req, res) => res.json(envelope(demoData.profile(req.params.customerId))));

app.get(`${context}/cards/:customerId`, (req, res) => res.json(envelope(demoData.cards(req.params.customerId))));
app.get(`${context}/cards/:cardId/limits`, (req, res) => res.json(envelope(demoData.cardLimits(req.params.cardId))));

app.get(`${context}/loans/:customerId`, (req, res) => res.json(envelope(demoData.loans(req.params.customerId))));
app.post(`${context}/loans/simulations`, (req, res) => res.status(201).json(envelope(demoData.loanSimulation(req.body))));

app.use((req, res) => res.status(404).json({ message: 'Not found', path: req.path, service: apiName }));

app.listen(port, () => {
  console.log(`${apiName} listening on ${port} with context ${context}`);
});
