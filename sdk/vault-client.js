/**
 * BrokerAGEnt Context Vault SDK
 * Lets any agent interact with the Context Vault without writing raw HTTP.
 *
 * Usage:
 *   const { VaultClient } = require('./sdk/vault-client');
 *   const vault = new VaultClient({ apiKey: 'bav1_...' });
 *
 *   const record = await vault.store('label', 'content');
 *   const data   = await vault.read(record.id);
 *   const list   = await vault.list();
 *   await vault.grant(record.id, 'agent_xyz');
 *   await vault.revoke(record.id, 'agent_xyz');
 */

class VaultClient {
  constructor({ apiKey, baseUrl = 'http://localhost:3000' } = {}) {
    if (!apiKey) throw new Error('VaultClient requires an apiKey');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async _request(method, path, body) {
    const res = await fetch(`${this.baseUrl}/vault${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': this.apiKey,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const data = await res.json();

    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    return data;
  }

  // Store a new context record — anchors to Hedera automatically
  store(label, content) {
    return this._request('POST', '/records', { label, content });
  }

  // Read a record by ID (must be owner or have permission)
  read(recordId) {
    return this._request('GET', `/records/${recordId}`);
  }

  // List all records owned by this agent (metadata only, no content)
  list() {
    return this._request('GET', '/records');
  }

  // Grant another agent read access to a record
  grant(recordId, granteeAgentId) {
    return this._request('POST', `/records/${recordId}/grant`, { grantee_agent_id: granteeAgentId });
  }

  // Revoke another agent's read access
  revoke(recordId, granteeAgentId) {
    return this._request('POST', `/records/${recordId}/revoke`, { grantee_agent_id: granteeAgentId });
  }
}

// Register a new agent (no auth needed — call once, save the key)
async function registerAgent(name, baseUrl = 'http://localhost:3000') {
  const res = await fetch(`${baseUrl}/vault/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

module.exports = { VaultClient, registerAgent };
