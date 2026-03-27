const { exec } = require("child_process");

/*
Restarts the Docker container for the phase-1 application.
Executes a Docker restart command and logs the result to the console.
If the restart fails, logs the error message.
*/

/* we now the name for now, as we run through containers through docker compose 
Docker compose has a fix pattern for naming: ${project}-${service}-${index}

So auto-ops-agent-1 means:
project auto-ops
service agent
first instance

*/
function restartService() {
  console.log(" Restarting service...");


  exec(`docker restart auto-ops-app-1`, (err, stdout, stderr) => {
    if (err) {
      console.log(" Restart failed:", err.message);
      return;
    }
    console.log(" Service restarted");
  });
}

function scaleService() {
  console.log(" Scaling service (simulated)");
}

module.exports = { restartService, scaleService };