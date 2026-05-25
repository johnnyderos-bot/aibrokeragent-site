'use strict';
/**
 * x402 payment middleware for AIbrokerAGEnt.
 *
 * x402 is an HTTP-native stablecoin payment protocol using HTTP 402 Payment Required.
 * Flow: Agent requests resource → Server returns 402 + X-PAYMENT-REQUIRED →
 *       Agent pays → Re-requests with X-PAYMENT header → Server verifies → 200 OK
 *
 * Simulation mode (X402_WALLET_ADDRESS not set): any X-Payment header is accepted.
 * Live mode: verifies payment via Coinbase facilitator at x402.org.
 *
 * Config via .env:
 *   X402_WALLET_ADDRESS — your USDC receiving address (e.g. 0xYourAddress)
 *   X402_NETWORK        — network identifier (default: base-sepolia)
 *   X402_FACILITATOR_URL — override facilitator (default: https://x402.org/facilitator)
 */

const WALLET_ADDRESS = process.env.X402_WALLET_ADDRESS || null;
const NETWORK = process.env.X402_NETWORK || 'base-sepolia';
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';

// USDC contract addresses per network
const USDC_CONTRACTS = {
  'base-sepolia':  '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'base':          '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-mainnet':  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'polygon':       '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  'solana':        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

const SIMULATION_MODE = !WALLET_ADDRESS;

if (SIMULATION_MODE) {
  console.log('[x402] Simulation mode — no wallet configured. Set X402_WALLET_ADDRESS in .env for live USDC payments.');
}

/**
 * Build a base64-encoded X-PAYMENT-REQUIRED header value.
 * amount: USDC amount as decimal string, e.g. '0.002'
 */
function buildPaymentSpec(amount, description, resource) {
  const amountMicro = Math.round(parseFloat(amount) * 1_000_000).toString();

  const spec = {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        maxAmountRequired: amountMicro,
        resource: resource || 'https://ai-broker-agent.com',
        description: description || 'AIbrokerAGEnt API access',
        mimeType: 'application/json',
        payTo: WALLET_ADDRESS || '0x0000000000000000000000000000000000000000',
        maxTimeoutSeconds: 300,
        asset: USDC_CONTRACTS[NETWORK] || USDC_CONTRACTS['base-sepolia'],
        extra: { name: 'USDC', version: '2' },
      },
    ],
  };

  return Buffer.from(JSON.stringify(spec)).toString('base64');
}

/**
 * Verify an X-PAYMENT header value.
 * Simulation mode: accepts any non-empty value.
 * Live mode: calls Coinbase facilitator /verify endpoint.
 */
async function verifyPayment(paymentHeader, specBase64) {
  if (!paymentHeader) return { valid: false, reason: 'missing X-Payment header' };

  if (SIMULATION_MODE) {
    console.log(`[x402-sim] Payment accepted (simulation). Header prefix: ${paymentHeader.slice(0, 48)}...`);
    return { valid: true, simulated: true };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${FACILITATOR_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: 1,
        paymentHeader,
        paymentRequiredHeader: specBase64,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const result = await response.json();
    return {
      valid: result.isValid === true,
      reason: result.invalidReason,
      txHash: result.txHash,
    };
  } catch (err) {
    console.error('[x402] facilitator verify error:', err.message);
    return { valid: false, reason: `facilitator error: ${err.message}` };
  }
}

/**
 * Express middleware factory — enforces x402 payment for a route.
 * amount: USDC decimal string (e.g. '0.002')
 * description: shown to the paying agent
 */
function x402Required(amount, description) {
  return async (req, res, next) => {
    const paymentHeader = req.headers['x-payment'];
    const resource = `https://ai-broker-agent.com${req.path}`;
    const specBase64 = buildPaymentSpec(amount, description, resource);

    if (!paymentHeader) {
      const spec = JSON.parse(Buffer.from(specBase64, 'base64').toString());
      return res.status(402)
        .setHeader('X-PAYMENT-REQUIRED', specBase64)
        .setHeader('Access-Control-Allow-Origin', '*')
        .json({
          error: 'Payment Required',
          x402: true,
          amount_usdc: parseFloat(amount),
          network: NETWORK,
          description: description || 'AIbrokerAGEnt API access',
          payment_spec: spec,
          how_to_pay: 'Include X-Payment header with a valid x402 payment payload. See https://x402.org for client SDKs (@x402/fetch for TypeScript, pip install x402 for Python).',
          simulation_mode: SIMULATION_MODE,
          ...(SIMULATION_MODE && {
            simulation_note: 'Wallet not configured — any X-Payment header value will be accepted. Set X402_WALLET_ADDRESS in .env for live USDC.',
          }),
        });
    }

    const verification = await verifyPayment(paymentHeader, specBase64);
    if (!verification.valid) {
      return res.status(402)
        .setHeader('X-PAYMENT-REQUIRED', specBase64)
        .json({ error: 'Payment verification failed', reason: verification.reason, x402: true });
    }

    req.x402 = {
      verified: true,
      simulated: verification.simulated || false,
      amount_usdc: parseFloat(amount),
      txHash: verification.txHash || null,
      network: NETWORK,
    };
    next();
  };
}

/**
 * Build a payment spec for the hire flow (agent-to-agent, not server-to-client).
 * Returns the full spec object (not base64) for embedding in the AICP contract.
 */
function buildHirePaymentSpec(amount, sellingAgentId, description) {
  const amountMicro = Math.round(parseFloat(amount) * 1_000_000).toString();
  return {
    x402Version: 1,
    scheme: 'exact',
    network: NETWORK,
    amount_usdc: parseFloat(amount),
    amount_micro: amountMicro,
    payTo: WALLET_ADDRESS || '0x0000000000000000000000000000000000000000',
    asset: USDC_CONTRACTS[NETWORK] || USDC_CONTRACTS['base-sepolia'],
    selling_agent_id: sellingAgentId,
    description: description || 'Agent hire payment',
    simulated: SIMULATION_MODE,
    created_at: new Date().toISOString(),
  };
}

module.exports = {
  x402Required,
  buildPaymentSpec,
  buildHirePaymentSpec,
  verifyPayment,
  SIMULATION_MODE,
  NETWORK,
};
