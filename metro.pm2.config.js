/*
 * Metro under pm2 (owner, 2026-10-03): one Metro, always up, restarted by
 * itself when the dependencies change.
 *
 *   pm2 start metro.pm2.config.js     start (or: pm2 restart ok-rn-metro)
 *   pm2 logs ok-rn-metro              watch it
 *   pm2 stop ok-rn-metro              stop it
 *
 * WHY THE WATCH: a lib re-pin swaps node_modules/node-onlykey-lib under a
 * running Metro, and a stale Metro red-screens "could not be found" (memory:
 * restart Metro after a lib re-pin). A re-pin edits package.json FIRST and
 * reinstalls after; npm writes package-lock.json at the END of the install.
 * So both are watched, and watch_delay waits for the install to settle
 * before the restart - restarting on package.json alone would come too early.
 *
 * Only those two files: Metro reloads the app on source changes itself, so
 * src/ and the rest are not watched here (a restart would only cost a cold
 * bundle).
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'ok-rn-metro',
      cwd: __dirname,
      script: path.join(__dirname, 'node_modules', 'react-native', 'cli.js'),
      /*
       * --max-workers 1: Metro transforms in its own process instead of a
       * worker farm. On WINDOWS pm2's daemon has no console, so every worker
       * Node forks gets a visible CMD window of its own - a screenful of them
       * on the first start (owner, 2026-10-03). In-band costs some speed on a
       * cold bundle; warm reloads barely notice.
       */
      /* --reset-cache (owner, 2026-10-03): every restart - a re-pin's too - starts from a clean transform cache */
      args: 'start --max-workers 1 --reset-cache',
      interpreter: 'node',
      windowsHide: true,
      watch: ['package.json', 'package-lock.json'],
      watch_delay: 8000,
      autorestart: true,
      /* the same log the tools already read */
      out_file: path.join(__dirname, '..', 'logs', 'metro.log'),
      error_file: path.join(__dirname, '..', 'logs', 'metro.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
