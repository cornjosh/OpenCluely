const fs = require('fs');
const path = require('path');
const { AzureCompatibleSpeechAdapter } = require('../src/services/adapters/speech-recognition.adapter');

describe('AzureCompatibleSpeechAdapter', () => {
  test('loads JSON backend config', () => {
    const configPath = path.join(__dirname, 'tmp-speech-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ speech: { provider: 'azure' } }), 'utf8');

    const loaded = AzureCompatibleSpeechAdapter.loadBackendConfig(configPath);
    expect(loaded.speech.provider).toBe('azure');
    fs.unlinkSync(configPath);
  });

  test('transcribes with Azure-compatible response shape', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        RecognitionStatus: 'Success',
        DisplayText: 'hello world',
        Duration: 100,
        Offset: 5
      })
    });

    const adapter = new AzureCompatibleSpeechAdapter({
      backend: 'azure',
      fetchImpl: fetchMock,
      azure: { key: 'k', region: 'eastus' }
    });

    const result = await adapter.transcribe({
      audioBuffer: Buffer.from('test'),
      audioFormat: 'pcm',
      language: 'en-US'
    });

    expect(result.DisplayText).toBe('hello world');
    expect(result.RecognitionStatus).toBe('Success');
  });
});
