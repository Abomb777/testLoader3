require('./self-updater');
const pa = require('../package.json');

async function running(){
	console.log(". "+pa.version);
}
(async ()=>{
	
})();

setInterval(running,2000);

// ✅ This line keeps the process from exiting
process.stdin.resume();