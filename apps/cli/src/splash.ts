/**
 * FKReD Visual Identity & Splash Screen
 */

import { getMode } from './mode.js';

export function displaySplash(version?: string): void {
  const mode = getMode();
  const vText = version ? ` v${version}` : ' (Local Dev)';

  const banner = `
\x1b[31m
███████╗██╗  ██╗██████╗ ███████╗██████╗ 
██╔════╝██║ ██╔╝██╔══██╗██╔════╝██╔══██╗
█████╗  █████╔╝ ██████╔╝█████╗  ██║  ██║
██╔══╝  ██╔═██╗ ██╔══██╗██╔══╝  ██║  ██║
██║     ██║  ██╗██║  ██║███████╗██████╔╝
╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═════╝ 
\x1b[0m`;

  console.log(banner);
  console.log(`\x1b[1m  FKReD Autonomous Offensive Framework\x1b[0m\x1b[38;5;240m${vText}\x1b[0m`);
  console.log(`\x1b[38;5;240m  Mode: ${mode === 'local' ? 'Local Build' : 'Production'} | Architecture: Black-Box Ready\x1b[0m`);
  console.log('');
  
  if (mode === 'local') {
    console.log('\x1b[33m  [WARNING] Operating in Local Developer Mode\x1b[0m');
    console.log('');
  }
}