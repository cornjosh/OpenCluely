const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const wav = require('node-wav');
const logger = require('../../core/logger').createServiceLogger('SPEECH_ADAPTER');
const { AdapterError, ValidationError, mapHttpErrorToAdapterError } = require('./adapter.errors');

class AzureCompatibleSpeechAdapter {
  constructor({
    backend = 'azure',
    azure = {},
    volcengine = {},
    fetchImpl = global.fetch
  } = {}) {
    this.backend = backend;
    this.fetch = fetchImpl;
    this.azureConfig = azure;
    this.volcengineConfig = volcengine;
  }

  static loadBackendConfig(configFilePath) {
    if (!configFilePath) {
      return {};
    }

    const absolutePath = path.resolve(configFilePath);
    if (!fs.existsSync(absolutePath)) {
      throw new ValidationError(`Speech config file not found: ${absolutePath}`, { provider: 'speech' });
    }

    const raw = fs.readFileSync(absolutePath, 'utf8');
    if (absolutePath.endsWith('.yaml') || absolutePath.endsWith('.yml')) {
      return yaml.load(raw) || {};
    }

    return JSON.parse(raw);
  }

  setBackend(backend) {
    this.backend = backend;
  }

  normalizeAudioBuffer(audioBuffer, audioFormat = 'pcm') {
    if (!Buffer.isBuffer(audioBuffer)) {
      throw new ValidationError('audioBuffer must be a Buffer', { provider: this.backend });
    }

    if (audioFormat.toLowerCase() !== 'wav') {
      return {
        pcmBuffer: audioBuffer,
        format: 'pcm',
        sampleRate: 16000
      };
    }

    const decoded = wav.decode(audioBuffer);
    const firstChannel = decoded.channelData?.[0];
    if (!firstChannel) {
      throw new ValidationError('WAV audio has no channels', { provider: this.backend });
    }

    const pcm16 = Buffer.alloc(firstChannel.length * 2);
    for (let index = 0; index < firstChannel.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, firstChannel[index]));
      pcm16.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7fff, index * 2);
    }

    return {
      pcmBuffer: pcm16,
      format: 'pcm',
      sampleRate: decoded.sampleRate || 16000
    };
  }

  async transcribe({
    audioBuffer,
    audioFormat = 'pcm',
    language = 'en-US',
    requestId = `speech-${Date.now()}`
  }) {
    if (!this.fetch) {
      throw new AdapterError('Fetch implementation is required for speech adapter', {
        provider: this.backend,
        status: 500
      });
    }

    const normalizedAudio = this.normalizeAudioBuffer(audioBuffer, audioFormat);

    if (this.backend === 'azure') {
      return this.transcribeWithAzure({ ...normalizedAudio, language, requestId });
    }

    if (this.backend === 'volcengine') {
      return this.transcribeWithVolcengine({ ...normalizedAudio, language, requestId });
    }

    throw new ValidationError(`Unsupported speech backend: ${this.backend}`, { provider: this.backend });
  }

  async transcribeWithAzure({ pcmBuffer, language, requestId, sampleRate }) {
    const subscriptionKey = this.azureConfig.key || process.env.AZURE_SPEECH_KEY;
    const region = this.azureConfig.region || process.env.AZURE_SPEECH_REGION;
    if (!subscriptionKey || !region) {
      throw new ValidationError('Azure key/region not configured', { provider: 'azure' });
    }

    const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'Content-Type': `audio/wav; codecs=audio/pcm; samplerate=${sampleRate || 16000}`,
        Accept: 'application/json'
      },
      body: pcmBuffer
    });

    if (!response.ok) {
      const body = await response.text();
      throw mapHttpErrorToAdapterError(response.status, `Azure speech request failed: ${body}`, 'azure', { body });
    }

    const json = await response.json();
    return {
      RecognitionStatus: json.RecognitionStatus || 'Success',
      DisplayText: json.DisplayText || '',
      Duration: json.Duration || 0,
      Offset: json.Offset || 0,
      requestId
    };
  }

  buildVolcengineAuthorization({ body, timestamp }) {
    const accessKey = this.volcengineConfig.accessKey || process.env.VOLCENGINE_ACCESS_KEY;
    const secretKey = this.volcengineConfig.secretKey || process.env.VOLCENGINE_SECRET_KEY;
    if (!accessKey || !secretKey) {
      throw new ValidationError('Volcengine accessKey/secretKey not configured', { provider: 'volcengine' });
    }

    const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
    const signingString = `${timestamp}\n${payloadHash}`;
    const signature = crypto.createHmac('sha256', secretKey).update(signingString).digest('hex');
    return `HMAC-SHA256 Credential=${accessKey}, Signature=${signature}`;
  }

  async transcribeWithVolcengine({ pcmBuffer, language, requestId, sampleRate }) {
    const endpoint = this.volcengineConfig.endpoint || 'https://openspeech.bytedance.com/api/v1/vc/ata/submit';
    const requestBody = JSON.stringify({
      app: { appid: this.volcengineConfig.appId || process.env.VOLCENGINE_APP_ID || '' },
      user: { uid: requestId },
      audio: {
        format: 'pcm',
        sample_rate: sampleRate || 16000,
        language,
        data: pcmBuffer.toString('base64')
      }
    });

    const timestamp = new Date().toISOString();
    const authorization = this.buildVolcengineAuthorization({ body: requestBody, timestamp });

    const response = await this.fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        'X-Date': timestamp
      },
      body: requestBody
    });

    if (!response.ok) {
      const body = await response.text();
      throw mapHttpErrorToAdapterError(response.status, `Volcengine speech request failed: ${body}`, 'volcengine', {
        body
      });
    }

    const json = await response.json();
    const isSuccess = json.code === 0 || json.code === '0';

    if (!isSuccess) {
      throw new AdapterError(json.message || 'Volcengine transcription failed', {
        code: json.code || 'volcengine_error',
        provider: 'volcengine',
        status: 400,
        details: json
      });
    }

    const resultText = json.result?.text || json.text || '';
    logger.info('Volcengine transcription mapped to Azure-compatible shape', {
      action: 'speech_transcribe',
      role: 'system',
      backend: 'volcengine',
      textLength: resultText.length
    });

    return {
      RecognitionStatus: 'Success',
      DisplayText: resultText,
      Duration: json.result?.duration || 0,
      Offset: json.result?.offset || 0,
      requestId
    };
  }
}

module.exports = {
  AzureCompatibleSpeechAdapter
};
