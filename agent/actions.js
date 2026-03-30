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
const { exec } = require("child_process");

function restartDeployment() {
  console.log(" Restarting Kubernetes deployment...");

  exec("kubectl rollout restart deployment app-deployment", (err, stdout, stderr) => {
    if (err) {
      console.log(" Restart failed:", err.message);
      return;
    }
    console.log("Deployment restarted");
  });
}

function scaleDeployment() {
  console.log("Scaling deployment to 3 replicas...");

  exec("kubectl scale deployment app-deployment --replicas=3", (err, stdout, stderr) => {
    if (err) {
      console.log(" Scaling failed:", err.message);
      return;
    }
    console.log("✅ Deployment scaled");
  });
}

function scaleDownDeployment() {
  console.log("Scaling deployment down to 1 replica...");

  exec("kubectl scale deployment app-deployment --replicas=1", (err, stdout, stderr) => {
    if (err) {
      console.log(" Scale down failed:", err.message);
      return;
    }
    console.log("✅ Deployment scaled down");
  });
}

module.exports = { restartDeployment, scaleDeployment, scaleDownDeployment };