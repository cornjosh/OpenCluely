const logger = require('../../core/logger').createServiceLogger('CHAT_CLIENT');
const { GeminiOpenAIAdapter } = require('./gemini-openai.adapter');
const { AdapterError, ValidationError, mapHttpErrorToAdapterError } = require('./adapter.errors');

class OpenAICompatibleChatClient {
  constructor({
    provider = 'gemini',
    gemini = {},
    openai = {},
    fetchImpl = global.fetch
  } = {}) {
    this.provider = provider;
    this.fetch = fetchImpl;
    this.geminiAdapter = new GeminiOpenAIAdapter({ ...gemini, fetchImpl });
    this.openaiConfig = {
      apiKey: openai.apiKey || process.env.OPENAI_API_KEY,
      baseUrl: openai.baseUrl || 'https://api.openai.com/v1',
      model: openai.model || 'gpt-4o-mini'
    };
  }

  setProvider(provider) {
    this.provider = provider;
  }

  getProvider() {
    return this.provider;
  }

  async createChatCompletion(request = {}) {
    if (!request || typeof request !== 'object') {
      throw new ValidationError('request must be an object', { provider: this.provider });
    }

    if (this.provider === 'gemini') {
      return this.geminiAdapter.createChatCompletion(request);
    }

    if (this.provider !== 'openai') {
      throw new AdapterError(`Unsupported chat provider: ${this.provider}`, {
        provider: this.provider,
        status: 400
      });
    }

    if (request.stream) {
      return this.createChatCompletionStream(request);
    }

    const url = `${this.openaiConfig.baseUrl}/chat/completions`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openaiConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...request,
        model: request.model || this.openaiConfig.model
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw mapHttpErrorToAdapterError(response.status, `OpenAI request failed: ${body}`, 'openai', { body });
    }

    return response.json();
  }

  async *createChatCompletionStream(request = {}) {
    if (this.provider === 'gemini') {
      yield* this.geminiAdapter.createChatCompletionStream(request);
      return;
    }

    if (this.provider !== 'openai') {
      throw new AdapterError(`Unsupported chat provider: ${this.provider}`, {
        provider: this.provider,
        status: 400
      });
    }

    const url = `${this.openaiConfig.baseUrl}/chat/completions`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openaiConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...request,
        model: request.model || this.openaiConfig.model,
        stream: true
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw mapHttpErrorToAdapterError(response.status, `OpenAI stream request failed: ${body}`, 'openai', { body });
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
      throw new AdapterError('OpenAI stream response does not provide a readable stream', {
        provider: 'openai',
        status: 500
      });
    }

    const decoder = new TextDecoder();
    let pending = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) {
          continue;
        }

        const payload = line.slice(6).trim();
        if (payload === '[DONE]' || !payload) {
          continue;
        }

        try {
          yield JSON.parse(payload);
        } catch (error) {
          logger.warn('Skipped invalid OpenAI stream payload', {
            action: 'stream_parse',
            role: 'system',
            payload
          });
        }
      }
    }
  }
}

module.exports = {
  OpenAICompatibleChatClient
};
