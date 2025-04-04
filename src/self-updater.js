const fs = require('fs');
const { exec, spawn } = require('child_process');
const os = require('os');
const path = require('path');

const pkg = require(path.join(process.cwd(), 'package.json'));
const config = pkg.selfUpdater || {};

const BRANCH = config.watchBranch || 'main';
const INTERVAL = config.checkInterval || 10000;
const FILE = config.mainFile || pkg.name || 'app.js';
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
    lastCommit = commit; // 🔁 prevent rollback loop
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
    const isWindows = os.platform() === 'win32';
    const nodePath = process.execPath;
    const appPath = path.resolve(FILE);
/*
    if (isWindows) {
      log(`🚀 Spawning new node process (Windows mode)...`);
      spawn('cmd', ['/c', 'start', '""', `"${nodePath}"`, appPath], {
        cwd: process.cwd(),
        detached: true,
        stdio: 'ignore',
        shell: true
      }).unref();
    } 
	*/
	if (isWindows) {
	  log(`🚀 Spawning new node process (Windows mode with logging)...`);

	  const out = fs.openSync('./out.log', 'a');
	  const err = fs.openSync('./err.log', 'a');

	  const child = spawn(process.execPath, [appPath], {
		detached: true,
		stdio: ['ignore', out, err]
	  });

	  child.unref();

	  log('🧨 Exiting old process');
	  process.exit(0);
	}else {
      log(`🚀 Spawning new node process (Unix-like mode)...`);
      spawn(nodePath, [appPath], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit']
      }).unref();
    }

    log('🧨 Exiting old process');
    process.exit(0);
  }
}

/*
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
    log('🚀 Spawning new node process...');

	const child = spawn(process.execPath, [FILE], {
	  detached: true,
	  stdio: ['ignore', process.stdout, process.stderr] // inherit output
	});

    child.on('error', (err) => {
      log('❌ Failed to spawn new process:', err.message);
    });

    child.unref(); // Let it live independently
    log('🧨 Exiting old process');
    process.exit(0);
  }
}
*/

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
      if (!newHash || newHash === lastCommit) return;

      // Check if only self-updater.js changed
      exec(`git diff --name-only ${lastCommit} ${newHash}`, (err, stdout) => {
        if (err) {
          log('❌ Failed diff check:', err.message);
          return;
        }

        const changedFiles = stdout.trim().split('\n').filter(Boolean);
        const onlySelfUpdated = changedFiles.every(f => f.includes('self-updater.js'));

        if (onlySelfUpdated) {
          log('⚠️ Only self-updater.js changed — skipping restart.');
          lastCommit = newHash; // update to prevent looping
          return;
        }

        log(`📦 Update: ${lastCommit} → ${newHash}`);
        backupCommit = lastCommit;
        lastCommit = newHash;

        restartApp(runtime);
        checkAppAfterUpdate(runtime, newHash);
      });
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
