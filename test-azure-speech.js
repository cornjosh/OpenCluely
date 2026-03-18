const speechService = require('./src/services/speech.service');

async function run() {
  try {
    if (!speechService.isAvailable()) {
      console.log('Azure speech service is not configured. Skipping connectivity test.');
      process.exit(0);
    }

    const result = await speechService.testConnection();
    if (result.success) {
      console.log('Azure speech connectivity test passed.');
      process.exit(0);
      return;
    }

    console.error(`Azure speech connectivity test failed: ${result.message}`);
    process.exit(1);
  } catch (error) {
    console.error(`Azure speech connectivity test error: ${error.message}`);
    process.exit(1);
  }
}

run();
