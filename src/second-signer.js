'use strict';

// second-signer.js — second LLM provider for dual attestation
// Priority: xAI Grok (XAI_API_KEY) → OpenAI GPT-4o (OPENAI_API_KEY) → Claude Haiku fallback
// The fallback uses a different Anthropic model to maintain behavioral difference
// for demo purposes. Real cross-provider use requires XAI_API_KEY or OPENAI_API_KEY.

let _openaiClient = null;

function getOpenAIClient() {
  if (_openaiClient) return _openaiClient;
  const OpenAI = require('openai');
  if (process.env.XAI_API_KEY) {
    _openaiClient = {
      client: new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1' }),
      model: 'grok-2-latest',
      provider: 'xai',
    };
  } else if (process.env.OPENAI_API_KEY) {
    _openaiClient = {
      client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
      model: 'gpt-4o',
      provider: 'openai',
    };
  }
  return _openaiClient;
}

async function runTask(task, context) {
  const cfg = getOpenAIClient();

  if (cfg) {
    const messages = [
      {
        role: 'system',
        content: 'You are an independent attestation agent. Complete the given task accurately and concisely.',
      },
      {
        role: 'user',
        content: context ? `${task}\n\nContext: ${context}` : task,
      },
    ];
    const completion = await cfg.client.chat.completions.create({
      model: cfg.model,
      max_tokens: 1024,
      messages,
    });
    return {
      output: completion.choices[0].message.content,
      model_id: cfg.model,
      provider: cfg.provider,
    };
  }

  // Fallback: Anthropic Haiku (different model = behaviorally distinct for demo)
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You are an independent attestation agent. Complete the given task accurately and concisely.',
    messages: [{ role: 'user', content: context ? `${task}\n\nContext: ${context}` : task }],
  });
  return {
    output: msg.content[0].text,
    model_id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic-haiku-fallback',
  };
}

module.exports = { runTask };
