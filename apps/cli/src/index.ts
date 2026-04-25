/**
 * FKReD CLI — Autonomous Offensive Framework
 *
 * Unified CLI supporting two modes:
 * Local mode: Run from cloned repo — builds locally, mounts prompts, uses ./workspaces/
 * NPX mode:   Run via npx — pulls from Docker Hub, uses ~/.fkred/
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './commands/build.js';
import { logs } from './commands/logs.js';
import { setup } from './commands/setup.js';
import { start } from './commands/start.js';
import { status } from './commands/status.js';
import { stop } from './commands/stop.js';
import { uninstall } from './commands/uninstall.js';
import { workspaces } from './commands/workspaces.js';
import { getMode } from './mode.js';
import { displaySplash } from './splash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function showHelp(): void {
  const mode = getMode();
  const prefix = mode === 'local' ? './fkred' : 'npx fkred';

  console.log(`
FKReD - Autonomous Offensive Framework (RED TEAM EDITION)

Usage:${
    mode === 'local'
      ? ''
      : `
  ${prefix} setup                                       Configure credentials`
  }
  ${prefix} start --url <url> --repo <path> [options]   Launch an offensive engagement
  ${prefix} stop [--clean]                               Terminate all active agents
  ${prefix} workspaces                                   List all active targets/workspaces
  ${prefix} logs <workspace>                             Tail active execution log
  ${prefix} status                                       Show running agent containers${
    mode === 'local'
      ? `
  ${prefix} build [--no-cache]                           Build execution image`
      : `
  ${prefix} uninstall                                    Remove ~/.fkred/ and all evidence`
  }
  ${prefix} info                                         Show splash screen
  ${prefix} help                                         Show this help

Options for 'start':
  -u, --url <url>           Target URL (required)
  -r, --repo <path>         Repository path (Optional if --mode black-box)
  -m, --mode <mode>         Scan mode ('white-box' or 'black-box')
  -c, --config <path>       Configuration file (YAML)
  -o, --output <path>       Copy deliverables to this directory after engagement
  -w, --workspace <name>    Named workspace (auto-resumes if exists)
  
Red Team / Black-Box Extensions:
      --depth <level>       Escalation depth ('shallow', 'deep', 'aggressive')
      --allow-pivoting      Enable internal network pivoting operations
      --target-ip <ip>      Specific internal IP to target post-foothold
      
Developer Options:
      --pipeline-testing    Use minimal execution paths for fast testing
      --debug               Preserve worker container after exit for log inspection

Examples:
  ${prefix} start -m black-box -u https://example.com
  ${prefix} start -m black-box -u https://example.com --depth aggressive --allow-pivoting --target-ip 10.0.0.1
  ${prefix} start -u https://example.com -r ./target-repo -w q1-engagement
`);
}

interface ParsedStartArgs {
  url: string;
  repo: string;
  mode: string;
  config?: string;
  workspace?: string;
  output?: string;
  pipelineTesting: boolean;
  debug: boolean;
  
  // Red Team Options
  depth?: string;
  allowPivoting?: boolean;
  targetIp?: string;
}

function parseStartArgs(argv: string[]): ParsedStartArgs {
  let url = '';
  let repo = '';
  let mode = 'white-box';
  let config: string | undefined;
  let workspace: string | undefined;
  let output: string | undefined;
  let pipelineTesting = false;
  let debug = false;
  
  let depth: string | undefined;
  let allowPivoting = false;
  let targetIp: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '-u':
      case '--url':
        if (next && !next.startsWith('-')) { url = next; i++; }
        break;
      case '-r':
      case '--repo':
        if (next && !next.startsWith('-')) { repo = next; i++; }
        break;
      case '-m':
      case '--mode':
        if (next && !next.startsWith('-')) { mode = next; i++; }
        break;
      case '-c':
      case '--config':
        if (next && !next.startsWith('-')) { config = next; i++; }
        break;
      case '-w':
      case '--workspace':
        if (next && !next.startsWith('-')) { workspace = next; i++; }
        break;
      case '-o':
      case '--output':
        if (next && !next.startsWith('-')) { output = next; i++; }
        break;
      case '--depth':
        if (next && !next.startsWith('-')) { depth = next; i++; }
        break;
      case '--allow-pivoting':
        allowPivoting = true;
        break;
      case '--target-ip':
        if (next && !next.startsWith('-')) { targetIp = next; i++; }
        break;
      case '--pipeline-testing':
        pipelineTesting = true;
        break;
      case '--debug':
        debug = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  if (!url) {
    console.error('ERROR: --url is required');
    process.exit(1);
  }

  if (mode === 'white-box' && !repo) {
    console.error('ERROR: --repo is required unless using --mode black-box');
    process.exit(1);
  }

  return { url, repo, mode, pipelineTesting, debug, config, workspace, output, depth, allowPivoting, targetIp };
}

// === Main Dispatch ===
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'start': {
    const parsed = parseStartArgs(args.slice(1));
    start({ ...parsed, version: getVersion() });
    break;
  }
  case 'stop':
    stop(args.includes('--clean'));
    break;
  case 'logs': {
    const workspaceId = args[1];
    if (!workspaceId) {
      console.error('ERROR: Workspace ID is required');
      process.exit(1);
    }
    logs(workspaceId);
    break;
  }
  case 'workspaces': workspaces(getVersion()); break;
  case 'status': status(); break;
  case 'setup': setup(); break;
  case 'build': build(args.includes('--no-cache')); break;
  case 'uninstall': uninstall(); break;
  case 'info': displaySplash(getMode() === 'local' ? undefined : getVersion()); break;
  case 'help':
  case '--help':
  case '-h':
  case undefined: showHelp(); break;
  default: console.error(`Unknown command: ${command}`); showHelp(); process.exit(1);
}