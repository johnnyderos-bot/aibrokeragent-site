const {
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TopicInfoQuery,
} = require('@hashgraph/sdk');
require('dotenv').config();

let client;

function getClient() {
  if (client) return client;

  client = Client.forTestnet();
  client.setOperator(
    process.env.HEDERA_ACCOUNT_ID,
    PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY),
  );
  return client;
}

// Create a new HCS topic for an agent's vault
async function createVaultTopic(agentId) {
  const tx = await new TopicCreateTransaction()
    .setTopicMemo(`BrokerAGEnt Context Vault - ${agentId}`)
    .execute(getClient());

  const receipt = await tx.getReceipt(getClient());
  return receipt.topicId.toString();
}

// Anchor a record hash to HCS
async function anchorRecord(topicId, payload) {
  const message = JSON.stringify(payload);

  const tx = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .execute(getClient());

  const receipt = await tx.getReceipt(getClient());
  return {
    sequenceNumber: receipt.topicSequenceNumber.toString(),
    transactionId: tx.transactionId.toString(),
  };
}

module.exports = { createVaultTopic, anchorRecord };
