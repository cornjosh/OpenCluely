describe('LLMService unified OpenAICompatibleChatClient flow', () => {
  test('processTextWithSkill uses OpenAICompatibleChatClient response path', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';

    const createChatCompletionMock = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'mocked unified response' }, finish_reason: 'stop' }]
    });

    jest.resetModules();
    jest.doMock('../src/services/adapters/openai-compatible-chat.client', () => ({
      OpenAICompatibleChatClient: jest.fn().mockImplementation(() => ({
        getProvider: () => 'gemini',
        createChatCompletion: createChatCompletionMock
      }))
    }));

    const llmService = require('../src/services/llm.service');

    const result = await llmService.processTextWithSkill('hello', 'dsa', [], 'cpp');
    expect(result.response).toContain('mocked unified response');
    expect(createChatCompletionMock).toHaveBeenCalled();
  });
});
