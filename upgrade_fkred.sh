#!/usr/bin/env bash

# ==============================================================================
# FKReD WEAPONIZATION SCRIPT
# This script applies the Black-Box / Red Team architectural upgrades
# and completely overwrites the legacy passive framework.
# ==============================================================================

set -e

echo "[*] Initiating FKReD Architectural Cutover..."

# 1. Rename root executable
if [ -f "shannon" ]; then
    echo "[*] Renaming root executable to fkred..."
    mv shannon fkred
fi

# 2. Re-write the root executable wrapper
echo "[*] Writing fkred CLI wrapper..."
cat << 'EOF' > fkred
#!/usr/bin/env bash

# FKReD CLI Wrapper
npm run build --prefix apps/cli --silent
node apps/cli/dist/index.js "$@"
EOF
chmod +x fkred

# 3. Inject Critical Files
echo "[*] Injecting core architectural files..."

# -- apps/cli/src/home.ts --
cat << 'EOF' > apps/cli/src/home.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getHomeDir(): string {
  return path.join(os.homedir(), '.fkred');
}

export function getWorkspacesDir(): string {
  return path.join(getHomeDir(), 'workspaces');
}

export function getCredentialsPath(): string {
  return path.join(getHomeDir(), 'google-sa-key.json');
}

export function initHome(): void {
  const homeDir = getHomeDir();
  if (!fs.existsSync(homeDir)) {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.chmodSync(homeDir, 0o777);
  }
}
EOF

# -- apps/cli/src/docker.ts --
cat << 'EOF' > apps/cli/src/docker.ts
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { getMode } from './mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NPX_IMAGE_REPO = 'keygraph/fkred';
const DEV_IMAGE = 'fkred-worker';

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
  try { execFileSync(cmd, args, { stdio: 'pipe' }); return true; } catch { return false; }
}

function runOutput(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf-8' }).trim(); } catch { return ''; }
}

export async function ensureInfra(): Promise<void> {
  const composeFile = getComposeFile();
  console.log('Starting FKReD infrastructure...');
  execFileSync('docker', ['compose', '-f', composeFile, 'up', '-d'], { stdio: 'inherit' });
  await sleep(2000);
}

export function ensureImage(version: string): void {
  const mode = getMode();
  if (mode === 'local') {
    console.log('Building local FKReD worker image...');
    execFileSync('docker', ['build', '-t', DEV_IMAGE, '.'], { stdio: 'inherit' });
  } else {
    const image = `${NPX_IMAGE_REPO}:${version}`;
    console.log(`Pulling worker image ${image}...`);
    execFileSync('docker', ['pull', image], { stdio: 'inherit' });
    pruneOldImages(version);
  }
}

export function stopWorkers(): void {
  const workers = runOutput('docker', ['ps', '-q', '--filter', 'name=fkred-worker-']);
  if (!workers) return;
  const ids = workers.split('\n').filter(Boolean);
  console.log('Stopping FKReD worker containers...');
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
  for (const tag of stale) runQuiet('docker', ['rmi', `${NPX_IMAGE_REPO}:${tag}`]);
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
  const network = 'fkred_default'; 

  const isBlackBox = opts.envFlags.some(flag => flag.includes('FKRED_BLACKBOX_MODE=true'));

  const args = [
    'run', '-d',
    '--name', opts.containerName,
    '--network', network,
    '-e', `TEMPORAL_TASK_QUEUE=${opts.taskQueue}`,
    '-e', `FKRED_TARGET_URL=${opts.url}`,
    '-e', `FKRED_WORKSPACE_ID=${opts.workspace}`,
    ...opts.envFlags
  ];

  if (isBlackBox) {
    args.push(
      '-v', `${opts.workspacesDir}/${opts.workspace}:/app/workspace`,
      '-e', 'FKRED_REPO_PATH=/app/workspace',
      '-w', '/app/workspace'
    );
  } else {
    args.push(
      '-v', `${opts.repo.hostPath}:/app/repo:ro`,
      '-v', `${opts.workspacesDir}/${opts.workspace}/deliverables:/app/repo/.fkred/deliverables`,
      '-v', `${opts.workspacesDir}/${opts.workspace}/scratchpad:/app/repo/.fkred/scratchpad`,
      '-v', `${opts.workspacesDir}/${opts.workspace}/.playwright-cli:/app/repo/.fkred/.playwright-cli`,
      '-v', `${opts.workspacesDir}/${opts.workspace}:/app/workspace`,
      '-e', 'FKRED_REPO_PATH=/app/repo',
      '-w', '/app/repo'
    );
  }

  if (opts.config) args.push('-v', `${opts.config}:/app/config.yaml:ro`, '-e', 'FKRED_CONFIG_PATH=/app/config.yaml');
  if (opts.credentials) args.push('-v', `${opts.credentials}:/app/credentials/google-sa-key.json:ro`);
  if (opts.promptsDir) args.push('-v', `${opts.promptsDir}:/app/prompts:ro`, '-e', 'FKRED_PROMPTS_DIR=/app/prompts');
  if (opts.outputDir) args.push('-v', `${opts.outputDir}:/app/output`, '-e', 'FKRED_OUTPUT_PATH=/app/output');
  if (opts.pipelineTesting) args.push('-e', 'FKRED_PIPELINE_TESTING=true');

  args.push(image);

  return spawn('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(os.platform() === 'win32' && { MSYS_NO_PATHCONV: '1' }) },
  });
}
EOF

# -- apps/cli/src/env.ts --
cat << 'EOF' > apps/cli/src/env.ts
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(): void {
  dotenv.config();
  const homeEnv = path.join(process.env.HOME || process.env.USERPROFILE || '', '.fkred', '.env');
  if (fs.existsSync(homeEnv)) {
    const envConfig = dotenv.parse(fs.readFileSync(homeEnv));
    for (const k in envConfig) {
      if (!process.env[k]) process.env[k] = envConfig[k];
    }
  }
}

export function validateCredentials(): { valid: boolean; error?: string } {
  const key = process.env.ANTHROPIC_API_KEY || process.env.FKRED_API_KEY;
  if (!key) return { valid: false, error: 'ANTHROPIC_API_KEY or FKRED_API_KEY environment variable is required' };
  return { valid: true };
}

export function buildEnvFlags(): string[] {
  const flags: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) {
    flags.push('-e', 'ANTHROPIC_API_KEY');
  } else if (process.env.FKRED_API_KEY) {
    flags.push('-e', `ANTHROPIC_API_KEY=${process.env.FKRED_API_KEY}`);
  }
  const passThrough = ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'TAVILY_API_KEY'];
  for (const envVar of passThrough) {
    if (process.env[envVar]) flags.push('-e', envVar);
  }
  return flags;
}
EOF

# -- apps/worker/src/paths.ts --
cat << 'EOF' > apps/worker/src/paths.ts
import path from 'node:path';

export const DEFAULT_DELIVERABLES_SUBDIR = process.env.FKRED_DELIVERABLES_SUBDIR || '.fkred/deliverables';

export function deliverablesDir(repoPath: string, subdir: string = DEFAULT_DELIVERABLES_SUBDIR): string {
  if (path.isAbsolute(subdir)) return subdir;
  return path.join(repoPath, ...subdir.split('/'));
}

export function resolveConfig(configPath: string): string {
  return path.resolve(configPath);
}

export function resolveRepo(repoPath?: string): { hostPath: string } {
  if (!repoPath) return { hostPath: process.cwd() };
  return { hostPath: path.resolve(repoPath) };
}
EOF

# -- apps/worker/prompts/shared/_target.txt --
cat << 'EOF' > apps/worker/prompts/shared/_target.txt
[TARGET ENVIRONMENT]
Target URL: {{webUrl}}
Working Directory / CWD: {{repoPath}}

[ENGAGEMENT MODE: BLACK-BOX vs WHITE-BOX]
Analyze your working directory. 
1. If source code IS present: You are conducting a White-Box/Gray-Box assessment. Correlate code vulnerabilities with live exploits against the Target URL.
2. If source code is NOT present (BLACK-BOX): You are executing as an external threat actor. Do NOT search for or hallucinate local source code. You must rely entirely on active network reconnaissance. 
   - Use your bash access to write custom Python scripts for payload delivery.
   - Use `curl`, `nmap` (if available), and dynamic web requests to map and exploit the Target URL.
   - Rely strictly on real-time feedback and findings stored in your TargetLedger.
EOF

# -- assets/fkred-banner.svg --
mkdir -p assets
cat << 'EOF' > assets/fkred-banner.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 250" width="100%" height="100%">
  <rect width="800" height="250" fill="#0d1117" />
  <g stroke="#161b22" stroke-width="1">
    <line x1="0" y1="50" x2="800" y2="50" />
    <line x1="0" y1="100" x2="800" y2="100" />
    <line x1="0" y1="150" x2="800" y2="150" />
    <line x1="0" y1="200" x2="800" y2="200" />
    <line x1="200" y1="0" x2="200" y2="250" />
    <line x1="400" y1="0" x2="400" y2="250" />
    <line x1="600" y1="0" x2="600" y2="250" />
  </g>
  <text x="50%" y="130" font-family="monospace" font-size="90" font-weight="900" fill="#ff3333" text-anchor="middle" letter-spacing="8">FKReD</text>
  <text x="50%" y="175" font-family="sans-serif" font-size="18" fill="#8b949e" text-anchor="middle" letter-spacing="6">AUTONOMOUS OFFENSIVE FRAMEWORK</text>
  <line x1="250" y1="200" x2="550" y2="200" stroke="#ff3333" stroke-width="3" />
</svg>
EOF

# 4. Global Regex Replacements for lingering files
echo "[*] Executing global namespace sweep (Shannon -> FKReD)..."

# Ensure we don't mess up git histories or node_modules
find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -name "upgrade_fkred.sh" -exec grep -Il "shannon" {} + | xargs sed -i '' 's/shannon/fkred/g' || true
find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -name "upgrade_fkred.sh" -exec grep -Il "Shannon" {} + | xargs sed -i '' 's/Shannon/FKReD/g' || true
find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -name "upgrade_fkred.sh" -exec grep -Il "SHANNON_" {} + | xargs sed -i '' 's/SHANNON_/FKRED_/g' || true

echo "[*] Installation & Transformation Complete."
echo "[*] Run 'pnpm install' and 'pnpm run build' to finalize."
echo "[*] Weapon is ready at: ./fkred"