/**
 * Docker orchestration — compose lifecycle, network, image pull/build, worker spawning.
 * RED TEAM EDITION: Black-Box infrastructure cutover logic.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { getMode } from './mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NPX_IMAGE_REPO = 'keygraph/shannon';
const DEV_IMAGE = 'shannon-worker';

export function getWorkerImage(version: string): string {
  return getMode() === 'local' ? DEV_IMAGE : `${NPX_IMAGE_REPO}:${version}`;
}

function getComposeFile(): string {
  return getMode() === 'local'
    ? path.resolve('docker-compose.yml')
    : path.resolve(__dirname, '..', 'infra', 'compose.yml');
}

export function randomSuffix(): string {
  return crypto.randomBytes(4).toString('hex');
}

function runQuiet(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function runOutput(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

export async function ensureInfra(): Promise<void> {
  const composeFile = getComposeFile();
  console.log('Starting infrastructure...');
  execFileSync('docker', ['compose', '-f', composeFile, 'up', '-d'], { stdio: 'inherit' });
  await sleep(2000);
}

export function ensureImage(version: string): void {
  const mode = getMode();
  if (mode === 'local') {
    console.log('Building local worker image...');
    execFileSync('docker', ['build', '-t', DEV_IMAGE, '.'], { stdio: 'inherit' });
  } else {
    const image = `${NPX_IMAGE_REPO}:${version}`;
    console.log(`Pulling worker image ${image}...`);
    execFileSync('docker', ['pull', image], { stdio: 'inherit' });
    pruneOldImages(version);
  }
}

export function stopWorkers(): void {
  const workers = runOutput('docker', ['ps', '-q', '--filter', 'name=shannon-worker-']);
  if (!workers) return;
  const ids = workers.split('\n').filter(Boolean);
  console.log('Stopping worker containers...');
  execFileSync('docker', ['stop', ...ids], { stdio: 'inherit' });
}

export function stopInfra(clean: boolean): void {
  const composeFile = getComposeFile();
  const args = ['compose', '-f', composeFile, 'down'];
  if (clean) args.push('-v');
  execFileSync('docker', args, { stdio: 'inherit' });
}

function pruneOldImages(currentVersion: string): void {
  const output = runOutput('docker', ['images', NPX_IMAGE_REPO, '--format', '{{.Tag}}']);
  if (!output) return;
  const stale = output.split('\n').filter((tag) => tag && tag !== currentVersion);
  for (const tag of stale) {
    runQuiet('docker', ['rmi', `${NPX_IMAGE_REPO}:${tag}`]);
  }
}

export interface WorkerOptions {
  version: string;
  url: string;
  repo: { hostPath: string };
  workspacesDir: string;
  taskQueue: string;
  containerName: string;
  envFlags: string[];
  config?: string;
  credentials?: string;
  promptsDir?: string;
  outputDir?: string;
  workspace: string;
  pipelineTesting?: boolean;
  debug?: boolean;
}

export function spawnWorker(opts: WorkerOptions): ChildProcess {
  const image = getWorkerImage(opts.version);
  const network = 'shannon_default';

  // RED TEAM CHECK: Determine if we are bypassing white-box constraints
  const isBlackBox = opts.envFlags.some(flag => flag.includes('SHANNON_BLACKBOX_MODE=true'));

  const args = [
    'run', '-d',
    '--name', opts.containerName,
    '--network', network,
    '-e', `TEMPORAL_TASK_QUEUE=${opts.taskQueue}`,
    '-e', `SHANNON_WEB_URL=${opts.url}`,
    '-e', `SHANNON_SESSION_ID=${opts.workspace}`,
    ...opts.envFlags
  ];

  if (isBlackBox) {
    // Phase 6: The Container Trap bypassed.
    // Mount ONLY the workspace and set it as the primary operating directory.
    args.push(
      '-v', `${opts.workspacesDir}/${opts.workspace}:/app/workspace`,
      '-e', 'SHANNON_REPO_PATH=/app/workspace',
      '-w', '/app/workspace'
    );
  } else {
    // Legacy White-Box configuration
    args.push(
      '-v', `${opts.repo.hostPath}:/app/repo:ro`,
      '-v', `${opts.workspacesDir}/${opts.workspace}/deliverables:/app/repo/.shannon/deliverables`,
      '-v', `${opts.workspacesDir}/${opts.workspace}/scratchpad:/app/repo/.shannon/scratchpad`,
      '-v', `${opts.workspacesDir}/${opts.workspace}/.playwright-cli:/app/repo/.shannon/.playwright-cli`,
      '-v', `${opts.workspacesDir}/${opts.workspace}:/app/workspace`,
      '-e', 'SHANNON_REPO_PATH=/app/repo',
      '-w', '/app/repo'
    );
  }

  if (opts.config) {
    args.push('-v', `${opts.config}:/app/config.yaml:ro`, '-e', 'SHANNON_CONFIG_PATH=/app/config.yaml');
  }
  if (opts.credentials) {
    args.push('-v', `${opts.credentials}:/app/credentials/google-sa-key.json:ro`);
  }
  if (opts.promptsDir) {
    args.push('-v', `${opts.promptsDir}:/app/prompts:ro`, '-e', 'SHANNON_PROMPTS_DIR=/app/prompts');
  }
  if (opts.outputDir) {
    args.push('-v', `${opts.outputDir}:/app/output`, '-e', 'SHANNON_OUTPUT_PATH=/app/output');
  }
  if (opts.pipelineTesting) {
    args.push('-e', 'SHANNON_PIPELINE_TESTING=true');
  }

  args.push(image);

  return spawn('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(os.platform() === 'win32' && { MSYS_NO_PATHCONV: '1' }),
    },
  });
}