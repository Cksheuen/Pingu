import { runModelCommand, modelHelp } from "./modelCli.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/config.js";
import { runLogin } from "./oauth/login.js";
import { credentialPath } from "./oauth/credentials.js";
import { printDaemonLogs, printDaemonStatus, restartDaemon, startDaemon, stopDaemon } from "./daemon.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];

switch (command) {
  case "models": {
    try { runModelCommand(appRoot, process.argv.slice(3)); }
    catch (error) { console.error(error instanceof Error ? error.message : "Model command failed"); process.exitCode = 1; }
    break;
  }
  case "help":
  case "--help":
  case "-h": {
    console.log("usage: pcpa <login|serve|start|stop|restart|status|logs|models> [--lines N]");
    console.log(modelHelp);
    process.exit(0);
  }
  case "login": {
    const config = loadConfig(appRoot);
    const cred = await runLogin(config.authDir);
    console.log(`login ok: ${cred.email} (project ${cred.project_id})`);
    console.log(`credential saved to ${credentialPath(config.authDir, cred.email)}`);
    process.exit(0);
  }
  case "serve":
  case undefined:
    // Dynamic import keeps the dev-server side-effect (listen) out of the
    // login command above.
    await import("../scripts/dev-server.js");
    break;
  case "start": {
    await startDaemon(appRoot, loadConfig(appRoot));
    break;
  }
  case "stop": {
    await stopDaemon(appRoot);
    break;
  }
  case "restart": {
    await restartDaemon(appRoot, loadConfig(appRoot));
    break;
  }
  case "status": {
    await printDaemonStatus(appRoot);
    break;
  }
  case "logs": {
    const linesArg = process.argv.indexOf("--lines");
    const lines = linesArg >= 0 ? Number.parseInt(process.argv[linesArg + 1] || "80", 10) : 80;
    await printDaemonLogs(appRoot, Number.isFinite(lines) && lines > 0 ? lines : 80);
    break;
  }
  default:
    console.error(`unknown command: ${command}`);
    console.error("usage: pcpa <login|serve|start|stop|restart|status|logs|models> [--lines N]");
    process.exit(1);
}
