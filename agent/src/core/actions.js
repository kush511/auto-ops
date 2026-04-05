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
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

async function restartDeployment(deploymentName, namespace = 'default') {
  try {
    const { stdout } = await execPromise(
      `kubectl rollout restart deployment/${deploymentName} -n ${namespace}`
    );
    console.log(`🔄 Deployment restarted: ${stdout.trim()}`);
    return { success: true, output: stdout.trim() };
  } catch (error) {
    console.error('❌ Restart failed:', error.message);
    return { success: false, error: error.message };
  }
}

async function scaleDeployment(deploymentName, namespace = 'default', replicas = 3) {
  try {
    const { stdout } = await execPromise(
      `kubectl scale deployment/${deploymentName} -n ${namespace} --replicas=${replicas}`
    );
    console.log(`📈 Deployment scaled to ${replicas}: ${stdout.trim()}`);
    return { success: true, output: stdout.trim() };
  } catch (error) {
    console.error('❌ Scale failed:', error.message);
    return { success: false, error: error.message };
  }
}

async function scaleDownDeployment(deploymentName, namespace = 'default', replicas = 1) {
  try {
    const { stdout } = await execPromise(
      `kubectl scale deployment/${deploymentName} -n ${namespace} --replicas=${replicas}`
    );
    console.log(`📉 Deployment scaled down to ${replicas}: ${stdout.trim()}`);
    return { success: true, output: stdout.trim() };
  } catch (error) {
    console.error('❌ Scale down failed:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { restartDeployment, scaleDeployment, scaleDownDeployment };