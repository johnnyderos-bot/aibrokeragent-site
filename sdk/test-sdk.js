const { VaultClient, registerAgent } = require('./vault-client');

async function run() {
  console.log('--- Registering agents ---');
  const agentA = await registerAgent('SDK Test Agent A');
  const agentB = await registerAgent('SDK Test Agent B');
  console.log('Agent A:', agentA.agent_id, '| key:', agentA.api_key);
  console.log('Agent B:', agentB.agent_id);

  const vaultA = new VaultClient({ apiKey: agentA.api_key });
  const vaultB = new VaultClient({ apiKey: agentB.api_key });

  console.log('\n--- Agent A stores a record ---');
  const record = await vaultA.store('sdk test', 'Hello from the SDK. Anchored on Hedera.');
  console.log('Stored:', record);

  console.log('\n--- Agent A lists records ---');
  const list = await vaultA.list();
  console.log('Records:', list.length, 'found');

  console.log('\n--- Agent B tries to read (should fail) ---');
  try {
    await vaultB.read(record.id);
  } catch (err) {
    console.log('Correctly blocked:', err.message);
  }

  console.log('\n--- Agent A grants Agent B access ---');
  await vaultA.grant(record.id, agentB.agent_id);
  console.log('Permission granted');

  console.log('\n--- Agent B reads (should succeed) ---');
  const data = await vaultB.read(record.id);
  console.log('Content:', data.content);
  console.log('Hedera topic:', data.hcs_topic_id, '| sequence:', data.hcs_sequence);

  console.log('\n--- Agent A revokes access ---');
  await vaultA.revoke(record.id, agentB.agent_id);

  console.log('\n--- Agent B tries again (should fail) ---');
  try {
    await vaultB.read(record.id);
  } catch (err) {
    console.log('Correctly blocked:', err.message);
  }

  console.log('\nAll SDK tests passed.');
}

run().catch(console.error);
