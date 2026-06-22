'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const { runDecisionCheckpoint } = require('./decision-checkpoint');

const app = express();
app.use(express.json());

// ── Protocol routers ───────────────────────────────────────────────────────────
app.use('/alr',       require('./alr').router);
app.use('/acc',         require('./acc').router);
app.use('/dual-attest', require('./dual-attest').router);
app.use('/crp',       require('./crp-routes').router);
app.use('/bsp',       require('./bsp-routes').router);
app.use('/flash-tag', require('./flash-tag-routes').router);
app.use('/aiia',      require('./aiia').router);
app.use('/ocp',       require('./ocp').router);
app.use('/adcp',      require('./adcp').router);
app.use('/alp',       require('./alp').router);
app.use('/soc',       require('./soc').router);
app.use('/tpbp',      require('./tpbp').router);
app.use('/dsap',      require('./dsap').router);
app.use('/pep',       require('./pep').router);
app.use('/mpr',       require('./mpr').router);
app.use('/acp',       require('./acp-attribution').router);
app.use('/msfp',      require('../msfp').router);

// ── Decision Checkpoint ────────────────────────────────────────────────────────
// POST /checkpoint — broker enforcement loop for every LLM-proposed action.
// The LLM never calls this. The broker does.
app.post('/checkpoint', async (req, res) => {
  try {
    const result = await runDecisionCheckpoint(req.body);
    if (result.tampered) {
      return res.status(403).json({ error: 'tamper_detected', ...result });
    }
    res.json(result);
  } catch (err) {
    console.error('[checkpoint]', err.message);
    const status = err.message.includes('required') ? 400 : 500;
    res.status(status).json({ error: 'checkpoint_failed', detail: err.message });
  }
});

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const PORT = process.env.BROKER_PORT || 4000;
app.listen(PORT, () => console.log(`[broker] running on :${PORT}`));

module.exports = app;
