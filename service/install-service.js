const { Service } = require('node-windows');
const path = require('path');

const svc = new Service({
  name: 'EDiFiConnect',
  description: 'EDiFi Connect Bridge — keeps the office tunnel to EDiFi Cloud alive 24/7',
  script: path.join(__dirname, 'bridge.js'),
  nodeOptions: ['--max_old_space_size=256'],
  wait: 2,
  grow: 0.5,
});

svc.on('install', () => {
  svc.start();
  console.log('');
  console.log('EDiFi Connect Service installed and started.');
  console.log('It will auto-start on every reboot.');
  console.log('');
  console.log('Check status:  sc query EDiFiConnect');
  console.log('Stop service:  sc stop EDiFiConnect');
  console.log('Start service: sc start EDiFiConnect');
  console.log('View logs:     %APPDATA%\\edifi-connect\\edifi-connect.log');
});

svc.on('alreadyinstalled', () => {
  console.log('Service already installed. Run uninstall-service.js first to reinstall.');
});

svc.on('error', (e) => {
  console.error('Service install error:', e);
});

svc.install();
