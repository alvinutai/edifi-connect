const { Service } = require('node-windows');
const path = require('path');

const svc = new Service({
  name: 'EDiFiConnect',
  script: path.join(__dirname, 'bridge.js'),
});

svc.on('uninstall', () => {
  console.log('EDiFi Connect Service uninstalled.');
});

svc.on('error', (e) => {
  console.error('Uninstall error:', e);
});

svc.uninstall();
