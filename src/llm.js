'use strict';

const config = require('./config');

/**
 * Minimal OpenAI-compatible chat client (works with LiteLLM).
 */
async function chatCompletion({ system, user, maxTokens }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);

  try {
    const res = await fetch(`${config.litellmBaseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.litellmApiKey ? { Authorization: `Bearer ${config.litellmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.litellmModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens || config.llmMaxTokens,
        temperature: config.llmTemperature,
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`LLM API ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('LLM response has no content');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chatCompletion };
