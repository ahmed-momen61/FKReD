// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Temporal activities for Shannon agent execution.
 * RED TEAM WEAPONIZED EDITION.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ApplicationFailure, Context, heartbeat } from '@temporalio/activity';
import { AuditSession } from '../audit/index.js';
import type { ResumeAttempt } from '../audit/metrics-tracker.js';
import type { SessionMetadata } from '../audit/utils.js';
import type { WorkflowSummary } from '../audit/workflow-logger.js';
import type { ContainerConfig, ProviderConfig } from '../types/config.js';
import type { CheckpointContext } from '../interfaces/checkpoint-provider.js';
import { getContainer, getOrCreateContainer, removeContainer } from '../services/container.js';
import { classifyErrorForTemporal, PentestError } from '../services/error-handling.js';
import { ExploitationCheckerService } from '../services/exploitation-checker.js';
import { executeGitCommandWithRetry } from '../services/git-manager.js';
import { runPreflightChecks } from '../services/preflight.js';
import type { ExploitationDecision, VulnType } from '../services/queue-validation.js';
import { assembleFinalReport, injectModelIntoReport } from '../services/reporting.js';
import { AGENTS } from '../session-manager.js';
import type { AgentName } from '../types/agents.js';
import { ALL_AGENTS } from '../types/agents.js';
import { ErrorCode } from '../types/errors.js';
import { isErr } from '../types/result.js';
import { DEFAULT_DELIVERABLES_SUBDIR, deliverablesDir } from '../paths.js';
import { fileExists, readJson } from '../utils/file-io.js';
import { createActivityLogger } from './activity-logger.js';
import type { AgentMetrics, PipelineState, ResumeState, TargetLedger } from './shared.js';

const MAX_ERROR_MESSAGE_LENGTH = 2000;
const MAX_STACK_TRACE_LENGTH = 1000;
const MAX_OUTPUT_VALIDATION_RETRIES = 3;
const HEARTBEAT_INTERVAL_MS = 2000;

export interface ActivityInput {
  webUrl: string;
  repoPath: string;
  configPath?: string;
  outputPath?: string;
  pipelineTestingMode?: boolean;
  workflowId: string;
  sessionId: string;

  // Red Team Extensions
  ledger: TargetLedger;
  currentDepth: string;

  configYAML?: string;
  apiKey?: string;
  deliverablesSubdir?: string;
  auditDir?: string;
  promptDir?: string;
  sastSarifPath?: string;
  skipGitCheck?: boolean;
  providerConfig?: ProviderConfig;
}

function truncateErrorMessage(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 20)}\n[truncated]`;
}

function truncateStackTrace(failure: ApplicationFailure): void {
  if (failure.stack && failure.stack.length > MAX_STACK_TRACE_LENGTH) {
    failure.stack = `${failure.stack.slice(0, MAX_STACK_TRACE_LENGTH)}\n[stack truncated]`;
  }
}

function buildSessionMetadata(input: ActivityInput): SessionMetadata {
  const { webUrl, repoPath, outputPath, sessionId } = input;
  return { id: sessionId, webUrl, repoPath, ...(outputPath && { outputPath }) };
}

function buildContainerConfig(input: ActivityInput): ContainerConfig {
  return {
    deliverablesSubdir: input.deliverablesSubdir ?? DEFAULT_DELIVERABLES_SUBDIR,
    auditDir: input.auditDir ?? './workspaces',
    ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
    ...(input.promptDir !== undefined && { promptDir: input.promptDir }),
    ...(input.providerConfig !== undefined && { providerConfig: input.providerConfig }),
  };
}

async function runAgentActivity(agentName: string, input: ActivityInput): Promise<AgentMetrics & { ledgerUpdates?: Partial<TargetLedger> }> {
  const { repoPath, configPath, pipelineTestingMode = false, workflowId, webUrl } = input;

  const skipContainer = getContainer(workflowId) ?? getOrCreateContainer(workflowId, buildSessionMetadata(input), buildContainerConfig(input));
  
  // Pivot agent may not be in standard ALL_AGENTS checklist for CheckpointProvider skip logic, so handle safely
  if (agentName !== 'pivot') {
    const decision = await skipContainer.checkpointProvider.shouldSkipAgent(
      agentName as AgentName,
      repoPath,
      input.deliverablesSubdir ?? DEFAULT_DELIVERABLES_SUBDIR,
    );
    if (decision.skip && decision.metrics) return decision.metrics;
  }

  const startTime = Date.now();
  const attemptNumber = Context.current().info.attempt;

  const heartbeatInterval = setInterval(() => {
    heartbeat({ agent: agentName, elapsedSeconds: Math.floor((Date.now() - startTime) / 1000), attempt: attemptNumber });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const logger = createActivityLogger();
    const sessionMetadata = buildSessionMetadata(input);
    const container = getOrCreateContainer(workflowId, sessionMetadata, buildContainerConfig(input));

    const auditSession = new AuditSession(sessionMetadata);
    await auditSession.initialize(workflowId);

    const deliverablesPath = deliverablesDir(repoPath, container.config.deliverablesSubdir);
    const endResult = await container.agentExecution.executeOrThrow(
      agentName as AgentName,
      {
        webUrl,
        repoPath,
        deliverablesPath,
        configPath,
        pipelineTestingMode,
        attemptNumber,
        ledger: input.ledger,
        currentDepth: input.currentDepth,
        ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
        ...(input.providerConfig !== undefined && { providerConfig: input.providerConfig }),
        ...(input.promptDir !== undefined && {
          promptDir: path.isAbsolute(input.promptDir)
            ? input.promptDir
            : path.resolve(process.env.SHANNON_WORKER_ROOT ?? process.cwd(), input.promptDir),
        }),
        ...(input.configYAML !== undefined && { configYAML: input.configYAML }),
      },
      auditSession,
      logger,
    );

    return {
      durationMs: Date.now() - startTime,
      inputTokens: null,
      outputTokens: null,
      costUsd: endResult.cost_usd,
      numTurns: null,
      model: endResult.model,
      ledgerUpdates: endResult.ledgerUpdates
    };
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;

    if (error instanceof PentestError && error.code === ErrorCode.OUTPUT_VALIDATION_FAILED && attemptNumber >= MAX_OUTPUT_VALIDATION_RETRIES) {
      throw ApplicationFailure.nonRetryable(`Agent ${agentName} failed output validation after ${attemptNumber} attempts`, 'OutputValidationError', [{ agentName, attemptNumber, elapsed: Date.now() - startTime }]);
    }

    const classified = classifyErrorForTemporal(error);
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = truncateErrorMessage(rawMessage);

    if (classified.retryable) {
      const failure = ApplicationFailure.create({ message, type: classified.type, details: [{ agentName, attemptNumber, elapsed: Date.now() - startTime }] });
      truncateStackTrace(failure);
      throw failure;
    } else {
      const failure = ApplicationFailure.nonRetryable(message, classified.type, [{ agentName, attemptNumber, elapsed: Date.now() - startTime }]);
      truncateStackTrace(failure);
      throw failure;
    }
  } finally {
    clearInterval(heartbeatInterval);
  }
}

// Existing Agents
export async function runPreReconAgent(input: ActivityInput) { return runAgentActivity('pre-recon', input); }
export async function runReconAgent(input: ActivityInput) { return runAgentActivity('recon', input); }
export async function runInjectionVulnAgent(input: ActivityInput) { return runAgentActivity('injection-vuln', input); }
export async function runXssVulnAgent(input: ActivityInput) { return runAgentActivity('xss-vuln', input); }
export async function runAuthVulnAgent(input: ActivityInput) { return runAgentActivity('auth-vuln', input); }
export async function runSsrfVulnAgent(input: ActivityInput) { return runAgentActivity('ssrf-vuln', input); }
export async function runAuthzVulnAgent(input: ActivityInput) { return runAgentActivity('authz-vuln', input); }
export async function runInjectionExploitAgent(input: ActivityInput) { return runAgentActivity('injection-exploit', input); }
export async function runXssExploitAgent(input: ActivityInput) { return runAgentActivity('xss-exploit', input); }
export async function runAuthExploitAgent(input: ActivityInput) { return runAgentActivity('auth-exploit', input); }
export async function runSsrfExploitAgent(input: ActivityInput) { return runAgentActivity('ssrf-exploit', input); }
export async function runAuthzExploitAgent(input: ActivityInput) { return runAgentActivity('authz-exploit', input); }
export async function runReportAgent(input: ActivityInput) { return runAgentActivity('report', input); }

// RED TEAM AGENTS
export async function runLateralMovementAgent(input: ActivityInput) {
  return runAgentActivity('pivot', input);
}

export async function analyzeLedgerEscalation(input: ActivityInput): Promise<boolean> {
  // Autonomous logic to decide if scan depth should increase based on ledger intel
  if (input.ledger.highValueTargets && input.ledger.highValueTargets.length > 0) {
    const logger = createActivityLogger();
    logger.info(`Escalation triggers met. High value targets found: ${input.ledger.highValueTargets.join(', ')}`);
    return true;
  }
  return false;
}

export async function runPreflightValidation(input: ActivityInput): Promise<void> {
  const startTime = Date.now();
  const attemptNumber = Context.current().info.attempt;
  const heartbeatInterval = setInterval(() => heartbeat({ phase: 'preflight', elapsedSeconds: Math.floor((Date.now() - startTime) / 1000), attempt: attemptNumber }), HEARTBEAT_INTERVAL_MS);

  try {
    const logger = createActivityLogger();
    const result = await runPreflightChecks(input.webUrl, input.repoPath, input.configPath, logger, input.skipGitCheck, input.apiKey, input.providerConfig);
    if (isErr(result)) throw result.error;
    logger.info('Preflight validation passed');
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;
    const classified = classifyErrorForTemporal(error);
    const failure = ApplicationFailure.nonRetryable(truncateErrorMessage(error instanceof Error ? error.message : String(error)), classified.type, [{ phase: 'preflight', attemptNumber, elapsed: Date.now() - startTime }]);
    truncateStackTrace(failure);
    throw failure;
  } finally {
    clearInterval(heartbeatInterval);
  }
}

export async function initDeliverableGit(input: ActivityInput): Promise<void> {
  const deliverablesPath = deliverablesDir(input.repoPath, input.deliverablesSubdir);
  await fs.mkdir(deliverablesPath, { recursive: true });
  try { await fs.stat(path.join(deliverablesPath, '.git')); return; } catch {}
  await executeGitCommandWithRetry(['git', 'init'], deliverablesPath, 'init deliverables repo');
  await executeGitCommandWithRetry(['git', 'commit', '--allow-empty', '-m', '📍 Initial deliverables checkpoint'], deliverablesPath, 'initial checkpoint');
}

export async function assembleReportActivity(input: ActivityInput): Promise<void> {
  try { await assembleFinalReport(input.repoPath, input.deliverablesSubdir, createActivityLogger()); } catch {}
}

export async function injectReportMetadataActivity(input: ActivityInput): Promise<void> {
  const effectiveOutputPath = input.outputPath ? path.join(input.outputPath, input.sessionId) : path.join('./workspaces', input.sessionId);
  try { await injectModelIntoReport(input.repoPath, input.deliverablesSubdir, effectiveOutputPath, createActivityLogger()); } catch {}
}

export async function checkExploitationQueue(input: ActivityInput, vulnType: VulnType): Promise<ExploitationDecision> {
  const checker = getContainer(input.workflowId)?.exploitationChecker ?? new ExploitationCheckerService();
  return checker.checkQueue(vulnType, deliverablesDir(input.repoPath, input.deliverablesSubdir), createActivityLogger());
}

export async function loadResumeState(workspaceName: string, expectedUrl: string, expectedRepoPath: string, deliverablesSubdir?: string): Promise<ResumeState> {
  const sessionPath = path.join('./workspaces', workspaceName, 'session.json');
  if (!(await fileExists(sessionPath))) throw ApplicationFailure.nonRetryable(`Workspace not found: ${workspaceName}`, 'WorkspaceNotFoundError');

  const session = await readJson<{ session: any; metrics: any; ledgerSnapshot?: TargetLedger }>(sessionPath);
  if (session.session.webUrl !== expectedUrl) throw ApplicationFailure.nonRetryable('URL mismatch', 'URLMismatchError');

  const completedAgents: string[] = [];
  const checkpoints: string[] = [];
  for (const agentName of ALL_AGENTS) {
    if (session.metrics.agents[agentName]?.status === 'success' && await fileExists(path.join(deliverablesDir(expectedRepoPath, deliverablesSubdir), AGENTS[agentName].deliverableFilename))) {
      completedAgents.push(agentName);
      if (session.metrics.agents[agentName].checkpoint) checkpoints.push(session.metrics.agents[agentName].checkpoint);
    }
  }

  if (checkpoints.length === 0) throw ApplicationFailure.nonRetryable('No valid checkpoints found.', 'NoCheckpointsError');

  return {
    workspaceName,
    originalUrl: session.session.webUrl,
    completedAgents,
    checkpointHash: await executeGitCommandWithRetry(['git', 'rev-list', '--max-count=1', ...checkpoints], deliverablesDir(expectedRepoPath, deliverablesSubdir), 'latest commit').then(r => r.stdout.trim()),
    originalWorkflowId: session.session.originalWorkflowId || session.session.id,
    ledgerSnapshot: session.ledgerSnapshot || { discoveredDomains: [], leakedCredentials: [], activePivotNodes: [], wafSignatures: [], highValueTargets: [] }
  };
}

export async function restoreGitCheckpoint(repoPath: string, checkpointHash: string, incompleteAgents: AgentName[], deliverablesSubdir?: string): Promise<void> {
  const deliverablesPath = deliverablesDir(repoPath, deliverablesSubdir);
  try { await executeGitCommandWithRetry(['git', 'rev-parse', '--verify', checkpointHash], repoPath, 'verify'); } catch { return; }
  await executeGitCommandWithRetry(['git', 'reset', '--hard', checkpointHash], deliverablesPath, 'reset');
  await executeGitCommandWithRetry(['git', 'clean', '-fd'], deliverablesPath, 'clean');
}

export async function recordResumeAttempt(input: ActivityInput, terminatedWorkflows: string[], checkpointHash: string, previousWorkflowId: string, completedAgents: string[]): Promise<void> {
  const auditSession = new AuditSession(buildSessionMetadata(input));
  await auditSession.initialize();
  await auditSession.addResumeAttempt(input.workflowId, terminatedWorkflows, checkpointHash);
  await auditSession.logResumeHeader({ previousWorkflowId, newWorkflowId: input.workflowId, checkpointHash, completedAgents });
}

export async function logPhaseTransition(input: ActivityInput, phase: string, event: 'start' | 'complete'): Promise<void> {
  const auditSession = new AuditSession(buildSessionMetadata(input));
  await auditSession.initialize(input.workflowId);
  if (event === 'start') await auditSession.logPhaseStart(phase); else await auditSession.logPhaseComplete(phase);
}

export async function logWorkflowComplete(input: ActivityInput, summary: WorkflowSummary): Promise<void> {
  const auditSession = new AuditSession(buildSessionMetadata(input));
  await auditSession.initialize(input.workflowId);
  await auditSession.updateSessionStatus(summary.status);
  await auditSession.logWorkflowComplete(summary);
  removeContainer(input.workflowId);
}

export async function mergeFindingsIntoQueue(input: ActivityInput, vulnType: VulnType): Promise<{ mergedCount: number }> {
  return getContainer(input.workflowId)?.findingsProvider?.mergeFindingsIntoQueue(input.repoPath, vulnType, input) ?? { mergedCount: 0 };
}

export async function saveCheckpoint(input: ActivityInput, agentName: string, phase: string, state: PipelineState): Promise<void> {
  getContainer(input.workflowId)?.checkpointProvider?.onAgentComplete(agentName, phase, state, { repoPath: input.repoPath, sessionId: input.sessionId, deliverablesSubdir: input.deliverablesSubdir ?? DEFAULT_DELIVERABLES_SUBDIR, ...(input.outputPath && { outputPath: input.outputPath }) });
}

export async function generateReportOutputActivity(input: ActivityInput): Promise<void> {
  const container = getContainer(input.workflowId);
  if (!container?.reportOutputProvider) return;
  await container.reportOutputProvider.generate(input, createActivityLogger());
}