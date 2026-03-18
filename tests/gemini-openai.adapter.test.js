const { GeminiOpenAIAdapter } = require('../src/services/adapters/gemini-openai.adapter');

describe('GeminiOpenAIAdapter', () => {
  test('maps OpenAI request to Gemini request shape', () => {
    const adapter = new GeminiOpenAIAdapter({ apiKey: 'test-key', fetchImpl: jest.fn() });
    const { request } = adapter.mapOpenAIToGeminiRequest({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'hello' }
      ],
      temperature: 0.1,
      max_tokens: 32
    });

    expect(request.systemInstruction.parts[0].text).toContain('You are helpful');
    expect(request.contents[0].role).toBe('user');
    expect(request.generationConfig.maxOutputTokens).toBe(32);
  });

  test('normalizes Gemini response to OpenAI response', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Hi' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }
      })
    });

    const adapter = new GeminiOpenAIAdapter({ apiKey: 'test-key', fetchImpl: fetchMock });
    const response = await adapter.createChatCompletion({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }]
    });

    expect(response.object).toBe('chat.completion');
    expect(response.choices[0].message.content).toBe('Hi');
    expect(response.usage.total_tokens).toBe(7);
  });

  test('maps OpenAI image content blocks to Gemini inlineData parts', () => {
    const adapter = new GeminiOpenAIAdapter({ apiKey: 'test-key', fetchImpl: jest.fn() });
    const { request } = adapter.mapOpenAIToGeminiRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'analyze image' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,Zm9vYmFy' } }
          ]
        }
      ]
    });

    expect(request.contents[0].parts[0].text).toBe('analyze image');
    expect(request.contents[0].parts[1].inlineData.mimeType).toBe('image/png');
    expect(request.contents[0].parts[1].inlineData.data).toBe('Zm9vYmFy');
  });
});
