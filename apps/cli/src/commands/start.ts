/**
 * `shannon start` command — launch a pentest scan. (RED TEAM ENABLED)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureImage, ensureInfra, randomSuffix, spawnWorker } from '../docker.js';
import { buildEnvFlags, loadEnv, validateCredentials } from '../env.js';
import { getCredentialsPath, getWorkspacesDir, initHome } from '../home.js';
import { isLocal } from '../mode.js';
import { resolveConfig, resolveRepo } from '../paths.js';
import { displaySplash } from '../splash.js';

export interface StartArgs {
  url: string;
  repo?: string;
  mode: string;
  config?: string;
  workspace?: string;
  output?: string;
  pipelineTesting: boolean;
  debug: boolean;
  version: string;
  
  // Red Team Options
  depth?: string;
  allowPivoting?: boolean;
  targetIp?: string;
}

export async function start(args: StartArgs): Promise<void> {
  initHome();
  loadEnv();

  const creds = validateCredentials();
  if (!creds.valid) {
    console.error(`ERROR: ${creds.error}`);
    process.exit(1);
  }

  // Black-Box logic: Provide a dummy repo path if none is supplied
  const repoString = args.mode === 'black-box' ? (args.repo || process.cwd()) : args.repo!;
  const repo = resolveRepo(repoString);
  
  const config = args.config ? resolveConfig(args.config) : undefined;
  const workspacesDir = getWorkspacesDir();
  fs.mkdirSync(workspacesDir, { recursive: true });
  fs.chmodSync(workspacesDir, 0o777);

  ensureImage(args.version);
  await ensureInfra();

  const suffix = randomSuffix();
  const taskQueue = `shannon-${suffix}`;
  const containerName = `shannon-worker-${suffix}`;
  const workspace = args.workspace ?? `${new URL(args.url).hostname.replace(/[^a-zA-Z0-9-]/g, '-')}_shannon-${Date.now()}`;

  const workspacePath = path.join(workspacesDir, workspace);
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.chmodSync(workspacePath, 0o777);
  for (const dir of ['deliverables', 'scratchpad', '.playwright-cli']) {
    const dirPath = path.join(workspacePath, dir);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.chmodSync(dirPath, 0o777);
  }

  const shannonDir = path.join(repo.hostPath, '.shannon');
  if (args.mode !== 'black-box') {
    for (const dir of ['deliverables', 'scratchpad', '.playwright-cli']) {
      fs.mkdirSync(path.join(shannonDir, dir), { recursive: true });
    }
  }

  const credentialsPath = getCredentialsPath();
  const hasCredentials = fs.existsSync(credentialsPath);
  if (hasCredentials) process.env.GOOGLE_APPLICATION_CREDENTIALS = '/app/credentials/google-sa-key.json';

  const outputDir = args.output ? path.resolve(args.output) : undefined;
  if (outputDir) fs.mkdirSync(outputDir, { recursive: true });

  const promptsDir = isLocal() ? path.resolve('apps/worker/prompts') : undefined;

  displaySplash(isLocal() ? undefined : args.version);

  // RED TEAM: Inject variables into Docker Env Flags
  const envFlags = buildEnvFlags();
  if (args.depth) envFlags.push('-e', `SHANNON_SCAN_DEPTH=${args.depth}`);
  if (args.allowPivoting) envFlags.push('-e', `SHANNON_ALLOW_PIVOTING=true`);
  if (args.targetIp) envFlags.push('-e', `SHANNON_TARGET_IP=${args.targetIp}`);
  if (args.mode === 'black-box') envFlags.push('-e', `SHANNON_BLACKBOX_MODE=true`);

  const proc = spawnWorker({
    version: args.version,
    url: args.url,
    repo,
    workspacesDir,
    taskQueue,
    containerName,
    envFlags,
    ...(config && { config }),
    ...(hasCredentials && { credentials: credentialsPath }),
    ...(promptsDir && { promptsDir }),
    ...(outputDir && { outputDir }),
    workspace,
    ...(args.pipelineTesting && { pipelineTesting: true }),
    ...(args.debug && { debug: true }),
  });

  const dockerExitCode = await new Promise<number>((resolve) => {
    proc.once('exit', (code) => resolve(code ?? 1));
    proc.once('error', (err) => {
      console.error(`Failed to start worker: ${err.message}`);
      resolve(1);
    });
  });

  if (dockerExitCode !== 0) process.exit(1);

  const sessionJson = path.join(workspacesDir, workspace, 'session.json');
  const isResume = fs.existsSync(sessionJson);
  let initialResumeCount = 0;
  if (isResume) {
    try {
      const session = JSON.parse(fs.readFileSync(sessionJson, 'utf-8'));
      initialResumeCount = session.session?.resumeAttempts?.length ?? 0;
    } catch {}
  }

  process.stdout.write(`Waiting for workflow to start in ${args.mode.toUpperCase()} mode...`);
  let workflowId = '';
  let started = false;
  let attempts = 0;
  const pollInterval = setInterval(() => {
    attempts++;
    if (attempts > 60) {
      clearInterval(pollInterval);
      process.stdout.write('\n');
      console.error('Timeout waiting for workflow to start');
      process.exit(1);
    }

    try {
      const session = JSON.parse(fs.readFileSync(sessionJson, 'utf-8'));
      const resumeAttempts: { workflowId: string }[] = session.session?.resumeAttempts ?? [];
      const ready = isResume ? resumeAttempts.length > initialResumeCount : !!session.session?.originalWorkflowId;

      if (ready) {
        clearInterval(pollInterval);
        started = true;
        workflowId = resumeAttempts.at(-1)?.workflowId ?? session.session?.originalWorkflowId ?? '';
        process.stdout.write('\r\x1b[K');
        printInfo(args, workspace, workflowId, repo.hostPath, workspacesDir);
        return;
      }
    } catch {}
    process.stdout.write('.');
  }, 2000);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned || started) return;
    cleaned = true;
    clearInterval(pollInterval);
    console.log(`\nStopping worker ${containerName}...`);
    try { execFileSync('docker', ['stop', containerName], { stdio: 'pipe' }); } catch {}
    if (args.debug) printDebugHint(containerName);
  };

  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);
}

function printDebugHint(containerName: string): void {
  console.log(`\n  Worker container preserved: ${containerName}\n    Inspect logs: docker logs ${containerName}\n    Remove:       docker rm ${containerName}\n`);
}

function printInfo(args: StartArgs, workspace: string, workflowId: string, repoPath: string, workspacesDir: string): void {
  const logsCmd = isLocal() ? `./shannon logs ${workspace}` : `npx @keygraph/shannon logs ${workspace}`;
  const reportsPath = path.join(workspacesDir, workspace);
  console.log(`  Target:     ${args.url}`);
  if (args.mode !== 'black-box') console.log(`  Repository: ${repoPath}`);
  console.log(`  Workspace:  ${workspace}`);
  if (args.depth) console.log(`  Depth:      ${args.depth.toUpperCase()}`);
  if (args.allowPivoting) console.log(`  Pivoting:   ENABLED`);
  console.log('');
  console.log('  Monitor:');
  console.log(`    Web UI:  http://localhost:8233${workflowId ? `/namespaces/default/workflows/${workflowId}` : ''}`);
  console.log(`    Logs:    ${logsCmd}\n`);
  console.log('  Output:');
  console.log(`    Reports: ${reportsPath}/\n`);
}