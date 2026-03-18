class AdapterError extends Error {
  constructor(message, { code = 'adapter_error', status = 500, provider = 'unknown', details = {} } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.status = status;
    this.provider = provider;
    this.details = details;
  }
}

class AuthenticationError extends AdapterError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'authentication_error', status: options.status || 401 });
    this.name = 'AuthenticationError';
  }
}

class RateLimitError extends AdapterError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'rate_limit_error', status: options.status || 429 });
    this.name = 'RateLimitError';
  }
}

class ValidationError extends AdapterError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'validation_error', status: options.status || 400 });
    this.name = 'ValidationError';
  }
}

function mapHttpErrorToAdapterError(responseStatus, message, provider, details = {}) {
  if (responseStatus === 401 || responseStatus === 403) {
    return new AuthenticationError(message, { provider, status: responseStatus, details });
  }

  if (responseStatus === 429) {
    return new RateLimitError(message, { provider, status: responseStatus, details });
  }

  if (responseStatus >= 400 && responseStatus < 500) {
    return new ValidationError(message, { provider, status: responseStatus, details });
  }

  return new AdapterError(message, {
    provider,
    status: responseStatus || 500,
    details
  });
}

module.exports = {
  AdapterError,
  AuthenticationError,
  RateLimitError,
  ValidationError,
  mapHttpErrorToAdapterError
};
