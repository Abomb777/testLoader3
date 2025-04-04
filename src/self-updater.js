const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

const pkg = require(path.join(process.cwd(), 'package.json'));
const config = pkg.selfUpdater || {};

const TYPE = config.type || 'pm2';
const BRANCH = config.watchBranch || 'main';
const INTERVAL = config.checkInterval || 10000;
const FILE = config.mainFile || 'app.js';
const PM2_NAME = config.pm2Name || pkg.name;
const HEALTH_FILE = path.join(process.cwd(), config.healthFile || '.alive');

let lastCommit = '';
let backupCommit = '';
const FAIL_TIMEOUT = 20000; // 20 seconds

function log(...args) {
  console.log(`[Updater]`, ...args);
}

function getCommitHash(cb) {
  exec('git rev-parse HEAD', (err, stdout) => {
    if (err) return cb(null);
    cb(stdout.trim());
  });
}

function gitPull(cb) {
  exec(`git pull origin ${BRANCH}`, (err, stdout) => {
    if (err) {
      log('❌ Git pull failed:', err.message);
      return cb(false);
    }
    if (!stdout.includes('Already up to date')) {
      log('📥 Git pulled:\n' + stdout.trim());
    }
    cb(true);
  });
}

function gitReset(commit, cb) {
  exec(`git reset --hard ${commit}`, (err, stdout) => {
    if (err) return cb(false);
    log('🔙 Rolled back to previous commit:', commit);
    cb(true);
  });
}

function restartApp() {
  if (TYPE === 'pm2') {
    exec(`pm2 restart ${PM2_NAME}`, (err, stdout) => {
      if (err) return log('❌ PM2 restart failed:', err.message);
      log('🔁 PM2 restarted:', PM2_NAME);
    });
  } else if (TYPE === 'nodemon') {
    exec(`touch ${FILE}`, (err) => {
      if (err) return log('❌ Could not touch file:', err.message);
      log(`🛠️  Touched ${FILE} to trigger nodemon restart`);
    });
  }
}

function isAppHealthy() {
  if (!fs.existsSync(HEALTH_FILE)) return false;

  const lastPing = parseInt(fs.readFileSync(HEALTH_FILE, 'utf-8'));
  return (Date.now() - lastPing) < FAIL_TIMEOUT;
}

function checkAppAfterUpdate(newCommit) {
  log('🧪 Waiting for health check...');
  setTimeout(() => {
    if (!isAppHealthy()) {
      log('❌ App failed health check, rolling back...');
      gitReset(backupCommit, () => {
        restartApp();
      });
    } else {
      log('✅ App is healthy. Running commit:', newCommit);
      lastCommit = newCommit;
    }
  }, FAIL_TIMEOUT);
}

function checkForUpdate() {
  gitPull(success => {
    if (!success) return;

    getCommitHash(newHash => {
      if (newHash && newHash !== lastCommit) {
        log(`📦 Update detected: ${lastCommit} → ${newHash}`);
        backupCommit = lastCommit;
        lastCommit = newHash;

        restartApp();
        checkAppAfterUpdate(newHash);
      }
    });
  });
}

// Start watching
getCommitHash(hash => {
  lastCommit = hash;
  backupCommit = hash;
  log(`👀 Watching '${BRANCH}' for changes every ${INTERVAL / 1000}s [type=${TYPE}]...`);
  setInterval(checkForUpdate, INTERVAL);
});