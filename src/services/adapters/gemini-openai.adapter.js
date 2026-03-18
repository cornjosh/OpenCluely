const logger = require('../../core/logger').createServiceLogger('GEMINI_ADAPTER');
const {
  AdapterError,
  ValidationError,
  mapHttpErrorToAdapterError
} = require('./adapter.errors');

class GeminiOpenAIAdapter {
  constructor({ apiKey, model = 'gemini-2.5-flash', fetchImpl = global.fetch } = {}) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
    this.model = model;
    this.fetch = fetchImpl;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  }

  ensureConfigured() {
    if (!this.fetch) {
      throw new AdapterError('Fetch implementation is required for Gemini adapter', {
        provider: 'gemini',
        status: 500
      });
    }

    if (!this.apiKey) {
      throw new ValidationError('Gemini API key is missing', {
        provider: 'gemini'
      });
    }
  }

  mapOpenAIToGeminiRequest(openAIRequest = {}) {
    const { messages = [], temperature, max_tokens, top_p, top_k, stream = false } = openAIRequest;

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ValidationError('messages must be a non-empty array', { provider: 'gemini' });
    }

    const systemMessages = messages.filter((message) => message.role === 'system');
    const chatMessages = messages.filter((message) => message.role !== 'system');

    const contents = chatMessages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: this.mapMessageContentToGeminiParts(message.content)
    }));

    const request = {
      contents,
      generationConfig: {
        temperature,
        topP: top_p,
        topK: top_k,
        maxOutputTokens: max_tokens
      }
    };

    if (systemMessages.length) {
      request.systemInstruction = {
        parts: [{ text: systemMessages.map((message) => message.content).join('\n') }]
      };
    }

    request.generationConfig = Object.fromEntries(
      Object.entries(request.generationConfig).filter(([, value]) => value !== undefined && value !== null)
    );

    return {
      request,
      stream: !!stream
    };
  }

  mapMessageContentToGeminiParts(content) {
    if (typeof content === 'string') {
      return [{ text: content }];
    }

    if (!Array.isArray(content)) {
      return [{ text: '' }];
    }

    const parts = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push({ text: block.text });
      }

      if (block?.type === 'image_url' && typeof block?.image_url?.url === 'string') {
        const match = block.image_url.url.match(/^data:(.+?);base64,(.+)$/);
        if (!match) {
          continue;
        }
        const [, mimeType, data] = match;
        parts.push({
          inlineData: {
            mimeType,
            data
          }
        });
      }
    }

    return parts.length ? parts : [{ text: '' }];
  }

  mapGeminiToOpenAIResponse(openAIRequest, geminiJson) {
    const candidates = Array.isArray(geminiJson?.candidates) ? geminiJson.candidates : [];
    const firstCandidate = candidates[0];
    const content = Array.isArray(firstCandidate?.content?.parts)
      ? firstCandidate.content.parts.map((part) => part.text || '').join('\n').trim()
      : '';

    return {
      id: `chatcmpl-gemini-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: openAIRequest.model || this.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: firstCandidate?.finishReason || 'stop'
        }
      ],
      usage: {
        prompt_tokens: geminiJson?.usageMetadata?.promptTokenCount || 0,
        completion_tokens: geminiJson?.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: geminiJson?.usageMetadata?.totalTokenCount || 0
      }
    };
  }

  async createChatCompletion(openAIRequest = {}) {
    this.ensureConfigured();
    const startTime = Date.now();
    const { request, stream } = this.mapOpenAIToGeminiRequest(openAIRequest);

    if (stream) {
      return this.createChatCompletionStream(openAIRequest);
    }

    const endpoint = `${this.baseUrl}/models/${encodeURIComponent(openAIRequest.model || this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const response = await this.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      const body = await response.text();
      throw mapHttpErrorToAdapterError(response.status, `Gemini request failed: ${body}`, 'gemini', {
        endpoint,
        body
      });
    }

    const responseJson = await response.json();
    const normalized = this.mapGeminiToOpenAIResponse(openAIRequest, responseJson);
    logger.debug('Gemini chat completion normalized to OpenAI format', {
      action: 'chat_completion',
      role: 'system',
      durationMs: Date.now() - startTime,
      model: openAIRequest.model || this.model
    });
    return normalized;
  }

  async *createChatCompletionStream(openAIRequest = {}) {
    this.ensureConfigured();
    const { request } = this.mapOpenAIToGeminiRequest({ ...openAIRequest, stream: false });

    const endpoint = `${this.baseUrl}/models/${encodeURIComponent(openAIRequest.model || this.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
    const response = await this.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      const body = await response.text();
      throw mapHttpErrorToAdapterError(response.status, `Gemini stream request failed: ${body}`, 'gemini', {
        endpoint,
        body
      });
    }

    if (!response.body || !response.body.getReader) {
      throw new AdapterError('Gemini stream response does not provide a readable stream', {
        provider: 'gemini',
        status: 500
      });
    }

    const reader = response.body.getReader();
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
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          continue;
        }

        let json;
        try {
          json = JSON.parse(payload);
        } catch (error) {
          logger.warn('Skipped non-JSON Gemini SSE payload', {
            action: 'stream_parse',
            role: 'system',
            payload
          });
          continue;
        }

        const candidate = Array.isArray(json.candidates) ? json.candidates[0] : null;
        const deltaText = Array.isArray(candidate?.content?.parts)
          ? candidate.content.parts.map((part) => part.text || '').join('')
          : '';

        yield {
          id: `chatcmpl-gemini-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: openAIRequest.model || this.model,
          choices: [
            {
              index: 0,
              delta: deltaText ? { content: deltaText } : {},
              finish_reason: candidate?.finishReason || null
            }
          ]
        };
      }
    }

    yield {
      id: `chatcmpl-gemini-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: openAIRequest.model || this.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    };
  }
}

module.exports = {
  GeminiOpenAIAdapter
};
