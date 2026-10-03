const path = require('path');
const createJiti = require('jiti');

const jiti = createJiti(path.join(__dirname, 'run-tests.cjs'), {
  alias: {
    '~': path.resolve(__dirname, '..'),
    '~~': path.resolve(__dirname, '..')
  }
});

jiti('./batch-scenarios.test.ts');
