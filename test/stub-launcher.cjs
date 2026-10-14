// Test stand-in for pi-launcher.js. STUB_MODE=echo prints args and stdin as JSON;
// STUB_MODE=hang starts a long-lived grandchild (like the real launcher's spawnSync) and writes its pid to STUB_PIDFILE.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
if (process.env.STUB_MODE === 'hang') {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  fs.writeFileSync(process.env.STUB_PIDFILE, String(g.pid));
  setInterval(() => {}, 1000);
} else {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => console.log(JSON.stringify(['Echo-Name', 'args' + process.argv.length, input.length > 0 ? 'gotstdin' : 'nostdin'])));
}
