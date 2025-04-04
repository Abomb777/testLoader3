const fs = require('fs');
const { exec, spawn } = require('child_process');
const path = require('path');

const pkg = require(path.join(process.cwd(), 'package.json'));
const config = pkg.selfUpdater || {};

const BRANCH = config.watchBranch || 'main';
const INTERVAL = config.checkInterval || 10000;
const FILE = config.mainFile || 'app.js';
const PM2_NAME = config.pm2Name || pkg.name;
const HEALTH_FILE = path.join(process.cwd(), config.healthFile || '.alive');

let lastCommit = '';
let backupCommit = '';
const FAIL_TIMEOUT = 20000;

function log(...args) {
  console.log(`[Updater]`, ...args);
}

function detectRuntime() {
  if (process.env.PM2_HOME || process.env.pm_id !== undefined) return 'pm2';
  if ((process.env._ || '').includes('nodemon')) return 'nodemon';
  return 'node';
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
  exec(`git reset --hard ${commit}`, (err) => {
    if (err) return cb(false);
    log('🔙 Rolled back to:', commit);
    cb(true);
  });
}

function restartApp(runtime) {
  if (runtime === 'pm2') {
    exec(`pm2 restart ${PM2_NAME}`, (err) => {
      if (err) log('❌ PM2 restart failed:', err.message);
      else log('🔁 Restarted with PM2');
    });
  } else if (runtime === 'nodemon') {
    exec(`touch ${FILE}`, (err) => {
      if (err) log('❌ Touch failed:', err.message);
      else log(`🛠️  Touched ${FILE} for nodemon`);
    });
  } else {
    log('🚀 Spawning new node process');
    const child = spawn('node', [FILE], {
      detached: true,
      stdio: 'inherit'
    });
    child.on('exit', code => {
      log(`⚠️  App exited with code ${code}`);
    });
    // Do NOT exit here — keep updater alive
  }
}

function isAppHealthy() {
  if (!fs.existsSync(HEALTH_FILE)) return false;
  const lastPing = parseInt(fs.readFileSync(HEALTH_FILE, 'utf-8'));
  return (Date.now() - lastPing) < FAIL_TIMEOUT;
}

function checkAppAfterUpdate(runtime, newCommit) {
  log('🧪 Waiting for health check...');
  setTimeout(() => {
    if (!isAppHealthy()) {
      log('❌ Health check failed. Rolling back...');
      gitReset(backupCommit, () => restartApp(runtime));
    } else {
      log('✅ App healthy with new commit:', newCommit);
      lastCommit = newCommit;
    }
  }, FAIL_TIMEOUT);
}

function checkForUpdate(runtime) {
  gitPull(success => {
    if (!success) return;

    getCommitHash(newHash => {
      if (newHash && newHash !== lastCommit) {
        log(`📦 Update: ${lastCommit} → ${newHash}`);
        backupCommit = lastCommit;
        restartApp(runtime);
        checkAppAfterUpdate(runtime, newHash);
      }
    });
  });
}

function startWatcher(runtime) {
  getCommitHash(hash => {
    lastCommit = hash;
    backupCommit = hash;
    log(`👀 Watching '${BRANCH}' every ${INTERVAL / 1000}s using ${runtime}...`);
    setInterval(() => checkForUpdate(runtime), INTERVAL);
  });
}

// 🚀 Init
const runtime = detectRuntime();
startWatcher(runtime);
