<div align="center">

```diff
-         ███████╗██╗  ██╗██████╗ ███████╗██████╗ 
-         ██╔════╝██║ ██╔╝██╔══██╗██╔════╝██╔══██╗
-         █████╗  █████╔╝ ██████╔╝█████╗  ██║  ██║
-         ██╔══╝  ██╔═██╗ ██╔══██╗██╔══╝  ██║  ██║
-         ██║     ██║  ██╗██║  ██║███████╗██████╔╝
-         ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═════╝ 
-   A U T O N O M O U S   O F F E N S I V E   F R A M E W O R K
```

</div>

**FKReD** is an elite, multi-modal Artificial Intelligence Red Teaming framework. Powered by an autonomous agent architecture and a durable execution engine (Temporal), FKReD acts as an intelligent, persistent threat emulator designed to stress-test web applications, internal networks, and infrastructure at scale.

Unlike traditional vulnerability scanners that rely on static signatures, FKReD "thinks" like a human operator. It discovers, analyzes, dynamically mutates payloads to bypass active defenses (WAFs/Firewalls), and pivots into internal environments.

---

## Disclaimer & Rules of Engagement

**FKReD is a weaponized framework.** It is explicitly designed for authorized offensive security validation, penetration testing, and Red Team operations. **Do not point FKReD at infrastructure you do not own or do not have explicit, written authorization to test.** All execution loops are strictly instructed to prevent destructive actions (e.g., DoS, data wiping), but active exploitation carries inherent risks.

---

## Core Capabilities

* **Adaptive Reconnaissance & Escalation:** Initiates wide surface mapping and autonomously escalates to DEEP scan modes upon identifying high-value targets (e.g., exposed `.env` files, admin panels).
* **The "Mental Ledger":** Utilizes a durable cross-agent memory state. Intelligence gathered in Phase 1 (Recon) is perfectly retained and weaponized in Phase 4 (Lateral Movement).
* **Autonomous WAF Evasion:** If a payload is dropped by network defenses (403/Blocked), the AI intercepts the error and autonomously re-strikes using obfuscation (chunking, unicode encoding) without manual intervention.
* **Black-Box & White-Box Modes:** Operates flawlessly with full source-code access (White-Box) or purely through dynamic network exploitation with no prior knowledge (Black-Box).
* **Internal Pivoting (Lateral Movement):** Deploys proxy tunnels (Chisel, SSH) through compromised external nodes to route attacks into isolated internal subnets.

---

## Architecture

FKReD is broken into a dual-layer architecture:

1. **The Command & Control (CLI):** Orchestrates the engagement parameters and provisions the isolated workspace environments.
2. **The Execution Engine (Temporal Worker):** A durable, containerized state-machine that spawns Claude-powered agents, tracks the `TargetLedger`, and manages the git-based proof-of-concept (PoC) deliverables.

---

## Installation

Ensure you have **Node.js (v22+)**, **pnpm**, and **Docker** installed.

**1. Clone the repository**
```bash
git clone [https://github.com/your-org/fkred.git](https://github.com/your-org/fkred.git)
cd fkred
```

**2. Install dependencies**
```bash
pnpm install
```

**3. Build the framework**
```bash
pnpm run build
```

---

## Quick Start Configuration

You will need an Anthropic API Key (Claude 3.5/3.7 Sonnet) to power the cognitive engine.

**Export your API key:**
```bash
export FKRED_API_KEY="sk-ant-api03-..."
```

**Or place it durably in a global config file:**
```bash
mkdir -p ~/.fkred
echo "FKRED_API_KEY=sk-ant-api03-..." > ~/.fkred/.env
```

---

## Usage & Operations

Launch engagements using the newly minted `fkred` wrapper script.

### 1. Black-Box Engagement (External Threat Emulator)
Perform a pure dynamic attack against a target without source code.
```bash
./fkred start --mode black-box -u [https://target-application.com](https://target-application.com)
```

### 2. Deep Exploitation & Lateral Movement
Instruct the framework to actively look for footholds and attempt internal network pivoting.
```bash
./fkred start --mode black-box -u [https://target-application.com](https://target-application.com) \
  --depth aggressive \
  --allow-pivoting \
  --target-ip 10.0.0.100
```

### 3. White-Box / Source-Assisted Engagement
Map a local source code repository and correlate code flaws with live exploitation.
```bash
./fkred start --mode white-box -u [https://target-application.com](https://target-application.com) -r ./local-source-repo
```

### 4. Session Monitoring & Intelligence
FKReD manages state using named workspaces. If a workflow drops, it automatically resumes.

**View active target workspaces:**
```bash
./fkred workspaces
```

**Tail the execution logs of an active engagement:**
```bash
./fkred logs <workspace-id>
```

---

## Output & Deliverables

All intelligence, ledgers, and exploitation evidence are durably stored in the execution workspace (`~/.fkred/workspaces/`).

At the end of an engagement, the **Report Agent** aggregates the internal `TargetLedger` and generates an executive-ready `comprehensive_security_assessment_report.md` detailing the kill-chain, PoCs, and remediation tactics.

---
<div align="center">
  <i>Built for Security. Weaponized for Validation.</i>
</div>
