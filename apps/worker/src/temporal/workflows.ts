// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Temporal workflow for Shannon pentest pipeline - RED TEAM WEAPONIZED EDITION.
 *
 * Orchestrates the active exploitation workflow:
 * 1. Pre-Reconnaissance (sequential)
 * 2. Reconnaissance & Dynamic Escalation (sequential)
 * 3-4. Vulnerability + Active Exploitation (5 pipelined pairs in parallel)
 * Each pair: vuln agent → queue check → weaponized exploit
 * 5. Internal Pivoting (Lateral Movement)
 * 6. Evidence Aggregation & Reporting (sequential)
 */

import {
  ApplicationFailure,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { AgentName, VulnType } from '../types/agents.js';
import { ALL_AGENTS } from '../types/agents.js';
import type * as activities from './activities.js';
import type { ActivityInput } from './activities.js';
import {
  type AgentMetrics,
  getProgress,
  type PipelineInput,
  type PipelineProgress,
  type PipelineState,
  type PipelineSummary,
  type ResumeState,
  type TargetLedger,
  type VulnExploitPipelineResult,
} from './shared.js';
import { toWorkflowSummary } from './summary-mapper.js';
import { classifyErrorCode, formatWorkflowError } from './workflow-errors.js';

// Retry configuration for production (WAF handling, transient drops)
const PRODUCTION_RETRY = {
  initialInterval: '5 minutes',
  maximumInterval: '30 minutes',
  backoffCoefficient: 2,
  maximumAttempts: 50,
  nonRetryableErrorTypes: [
    'PermissionError',
    'ExecutionLimitError',
  ], // AuthenticationError removed to allow brute-force retries
};

// Retry configuration for testing
const TESTING_RETRY = {
  initialInterval: '10 seconds',
  maximumInterval: '30 seconds',
  backoffCoefficient: 2,
  maximumAttempts: 5,
  nonRetryableErrorTypes: PRODUCTION_RETRY.nonRetryableErrorTypes,
};

// Activity proxy with production retry configuration
const acts = proxyActivities<typeof activities & { 
  analyzeLedgerEscalation: (input: any) => Promise<boolean>,
  runLateralMovementAgent: (input: any) => Promise<AgentMetrics>
}>({
  startToCloseTimeout: '4 hours', // Extended for deep exploitation
  heartbeatTimeout: '60 minutes', 
  retry: PRODUCTION_RETRY,
});

const testActs = proxyActivities<typeof activities & { 
  analyzeLedgerEscalation: (input: any) => Promise<boolean>,
  runLateralMovementAgent: (input: any) => Promise<AgentMetrics>
}>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 minutes',
  retry: TESTING_RETRY,
});

const preflightActs = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  heartbeatTimeout: '2 minutes',
  retry: {
    initialInterval: '10 seconds',
    maximumInterval: '1 minute',
    backoffCoefficient: 2,
    maximumAttempts: 3,
    nonRetryableErrorTypes: PRODUCTION_RETRY.nonRetryableErrorTypes,
  },
});

function computeSummary(state: PipelineState): PipelineSummary {
  const metrics = Object.values(state.agentMetrics);
  return {
    totalCostUsd: metrics.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
    totalDurationMs: Date.now() - state.startTime,
    totalTurns: metrics.reduce((sum, m) => sum + (m.numTurns ?? 0), 0),
    agentCount: state.completedAgents.length,
  };
}

function mergeLedger(target: TargetLedger, updates?: Partial<TargetLedger>) {
  if (!updates) return;
  if (updates.discoveredDomains) target.discoveredDomains = [...new Set([...target.discoveredDomains, ...updates.discoveredDomains])];
  if (updates.leakedCredentials) target.leakedCredentials = [...target.leakedCredentials, ...updates.leakedCredentials];
  if (updates.activePivotNodes) target.activePivotNodes = [...target.activePivotNodes, ...updates.activePivotNodes];
  if (updates.wafSignatures) target.wafSignatures = [...new Set([...target.wafSignatures, ...updates.wafSignatures])];
  if (updates.highValueTargets) target.highValueTargets = [...new Set([...target.highValueTargets, ...updates.highValueTargets])];
}

export async function pentestPipeline(input: PipelineInput): Promise<PipelineState> {
  if (!input.repoPath || input.repoPath.includes('..')) {
    throw ApplicationFailure.nonRetryable(
      `Invalid repoPath: path traversal not allowed (received: ${input.repoPath ?? '<empty>'})`,
      'ConfigurationError',
    );
  }
  if (!input.repoPath.startsWith('/')) {
    throw ApplicationFailure.nonRetryable(
      `Invalid repoPath: absolute path required (received: ${input.repoPath})`,
      'ConfigurationError',
    );
  }

  const { workflowId } = workflowInfo();

  function selectActivityProxy(pipelineInput: PipelineInput) {
    if (pipelineInput.pipelineTestingMode) return testActs;
    return acts;
  }

  const a = selectActivityProxy(input);

  const state: PipelineState = {
    status: 'running',
    currentPhase: null,
    currentAgent: null,
    completedAgents: [],
    failedAgent: null,
    error: null,
    startTime: Date.now(),
    agentMetrics: {},
    summary: null,
    ledger: {
      discoveredDomains: [],
      leakedCredentials: [],
      activePivotNodes: [],
      wafSignatures: [],
      highValueTargets: [],
    },
    currentDepth: input.scanDepth || 'shallow',
  };

  setHandler(getProgress, (): PipelineProgress => ({
    ...state,
    workflowId,
    elapsedMs: Date.now() - state.startTime,
  }));

  const sessionId = input.sessionId || input.resumeFromWorkspace || workflowId;

  const activityInput: ActivityInput & { ledger: TargetLedger; currentDepth: string } = {
    webUrl: input.webUrl,
    repoPath: input.repoPath,
    workflowId,
    sessionId,
    ledger: state.ledger,
    currentDepth: state.currentDepth,
    ...(input.configPath !== undefined && { configPath: input.configPath }),
    ...(input.outputPath !== undefined && { outputPath: input.outputPath }),
    ...(input.pipelineTestingMode !== undefined && { pipelineTestingMode: input.pipelineTestingMode }),
    ...(input.configYAML !== undefined && { configYAML: input.configYAML }),
    ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
    ...(input.deliverablesSubdir !== undefined && { deliverablesSubdir: input.deliverablesSubdir }),
    ...(input.auditDir !== undefined && { auditDir: input.auditDir }),
    ...(input.promptDir !== undefined && { promptDir: input.promptDir }),
    ...(input.sastSarifPath !== undefined && { sastSarifPath: input.sastSarifPath }),
    ...(input.skipGitCheck !== undefined && { skipGitCheck: input.skipGitCheck }),
    ...(input.providerConfig !== undefined && { providerConfig: input.providerConfig }),
  };

  let resumeState: ResumeState | null = null;

  if (input.resumeFromWorkspace) {
    resumeState = await a.loadResumeState(input.resumeFromWorkspace, input.webUrl, input.repoPath, input.deliverablesSubdir);
    
    if (resumeState.ledgerSnapshot) {
      state.ledger = resumeState.ledgerSnapshot;
      activityInput.ledger = state.ledger;
    }

    const incompleteAgents = ALL_AGENTS.filter((agentName) => !resumeState?.completedAgents.includes(agentName)) as AgentName[];
    await a.restoreGitCheckpoint(input.repoPath, resumeState.checkpointHash, incompleteAgents, input.deliverablesSubdir);

    if (resumeState.completedAgents.length === ALL_AGENTS.length) {
      state.status = 'completed';
      state.completedAgents = [...resumeState.completedAgents];
      state.summary = computeSummary(state);
      return state;
    }

    await a.recordResumeAttempt(
      activityInput,
      input.terminatedWorkflows || [],
      resumeState.checkpointHash,
      resumeState.originalWorkflowId,
      resumeState.completedAgents,
    );
  }

  const shouldSkip = (agentName: string): boolean => {
    return resumeState?.completedAgents.includes(agentName) ?? false;
  };

  async function runSequentialPhase(
    phaseName: string,
    agentName: AgentName,
    runAgent: (input: any) => Promise<AgentMetrics & { ledgerUpdates?: Partial<TargetLedger> }>,
  ): Promise<void> {
    if (!shouldSkip(agentName)) {
      state.currentPhase = phaseName;
      state.currentAgent = agentName;
      await a.logPhaseTransition(activityInput, phaseName, 'start');
      
      const metrics = await runAgent(activityInput);
      mergeLedger(state.ledger, metrics.ledgerUpdates);
      
      state.agentMetrics[agentName] = metrics;
      state.completedAgents.push(agentName);
      if (input.checkpointsEnabled) await a.saveCheckpoint(activityInput, agentName, phaseName, state);
      await a.logPhaseTransition(activityInput, phaseName, 'complete');
    } else {
      state.completedAgents.push(agentName);
    }
  }

  function buildPipelineConfigs() {
    return [
      { vulnType: 'injection' as VulnType, vulnAgent: 'injection-vuln', exploitAgent: 'injection-exploit', runVuln: () => a.runInjectionVulnAgent(activityInput), runExploit: () => a.runInjectionExploitAgent(activityInput) },
      { vulnType: 'xss' as VulnType, vulnAgent: 'xss-vuln', exploitAgent: 'xss-exploit', runVuln: () => a.runXssVulnAgent(activityInput), runExploit: () => a.runXssExploitAgent(activityInput) },
      { vulnType: 'auth' as VulnType, vulnAgent: 'auth-vuln', exploitAgent: 'auth-exploit', runVuln: () => a.runAuthVulnAgent(activityInput), runExploit: () => a.runAuthExploitAgent(activityInput) },
      { vulnType: 'ssrf' as VulnType, vulnAgent: 'ssrf-vuln', exploitAgent: 'ssrf-exploit', runVuln: () => a.runSsrfVulnAgent(activityInput), runExploit: () => a.runSsrfExploitAgent(activityInput) },
      { vulnType: 'authz' as VulnType, vulnAgent: 'authz-vuln', exploitAgent: 'authz-exploit', runVuln: () => a.runAuthzVulnAgent(activityInput), runExploit: () => a.runAuthzExploitAgent(activityInput) },
    ];
  }

  async function runWithConcurrencyLimit(thunks: Array<() => Promise<VulnExploitPipelineResult>>, limit: number) {
    const results: PromiseSettledResult<VulnExploitPipelineResult>[] = [];
    const inFlight = new Set<Promise<void>>();

    for (const thunk of thunks) {
      const slot = thunk()
        .then(value => { results.push({ status: 'fulfilled', value }); })
        .catch(reason => { results.push({ status: 'rejected', reason }); })
        .finally(() => { inFlight.delete(slot); });

      inFlight.add(slot);
      if (inFlight.size >= limit) await Promise.race(inFlight);
    }

    await Promise.allSettled(inFlight);
    return results;
  }

  try {
    state.currentPhase = 'preflight';
    state.currentAgent = null;
    await preflightActs.runPreflightValidation(activityInput);

    await a.initDeliverableGit(activityInput);

    await runSequentialPhase('pre-recon', 'pre-recon', a.runPreReconAgent);
    await runSequentialPhase('recon', 'recon', a.runReconAgent);

    // Autonomous Depth Escalation Check
    if (state.currentDepth === 'shallow' && state.ledger.highValueTargets.length > 0) {
      const escalate = await a.analyzeLedgerEscalation(activityInput);
      if (escalate) {
        state.currentDepth = 'deep';
        activityInput.currentDepth = 'deep';
        log.info('High-value targets identified. Escalating scan depth to DEEP.');
      }
    }

    state.currentPhase = 'vulnerability-exploitation';
    state.currentAgent = 'pipelines';
    await a.logPhaseTransition(activityInput, 'vulnerability-exploitation', 'start');

    async function runVulnExploitPipeline(vulnType: VulnType, runVulnAgent: () => Promise<any>, runExploitAgent: () => Promise<any>): Promise<VulnExploitPipelineResult> {
      const vulnAgentName = `${vulnType}-vuln`;
      const exploitAgentName = `${vulnType}-exploit`;

      let vulnMetrics = null;
      if (!shouldSkip(vulnAgentName)) {
        vulnMetrics = await runVulnAgent();
        mergeLedger(state.ledger, vulnMetrics.ledgerUpdates);
        state.agentMetrics[vulnAgentName] = vulnMetrics;
        state.completedAgents.push(vulnAgentName);
        if (input.checkpointsEnabled) await a.saveCheckpoint(activityInput, vulnAgentName, 'vulnerability-analysis', state);
      } else {
        state.completedAgents.push(vulnAgentName);
      }

      await a.mergeFindingsIntoQueue(activityInput, vulnType);
      const decision = await a.checkExploitationQueue(activityInput, vulnType);

      let exploitMetrics = null;
      if (decision.shouldExploit) {
        if (!shouldSkip(exploitAgentName)) {
          exploitMetrics = await runExploitAgent();
          mergeLedger(state.ledger, exploitMetrics.ledgerUpdates);
          state.agentMetrics[exploitAgentName] = exploitMetrics;
          state.completedAgents.push(exploitAgentName);
          if (input.checkpointsEnabled) await a.saveCheckpoint(activityInput, exploitAgentName, 'exploitation', state);
        } else {
          state.completedAgents.push(exploitAgentName);
        }
      }

      return { vulnType, vulnMetrics, exploitMetrics, exploitDecision: { shouldExploit: decision.shouldExploit, vulnerabilityCount: decision.vulnerabilityCount }, error: null };
    }

    const maxConcurrent = input.pipelineConfig?.max_concurrent_pipelines ?? 5;
    const pipelineConfigs = buildPipelineConfigs();
    const pipelineThunks = pipelineConfigs.map(config => () => runVulnExploitPipeline(config.vulnType, config.runVuln, config.runExploit));

    const pipelineResults = await runWithConcurrencyLimit(pipelineThunks, maxConcurrent);
    
    // Internal Pivoting Phase
    if (input.allowPivoting && state.ledger.activePivotNodes.length > 0) {
      state.currentPhase = 'lateral-movement';
      state.currentAgent = 'pivot';
      await a.logPhaseTransition(activityInput, 'lateral-movement', 'start');
      const pivotMetrics = await a.runLateralMovementAgent(activityInput);
      mergeLedger(state.ledger, pivotMetrics.ledgerUpdates);
      state.agentMetrics['pivot'] = pivotMetrics;
      await a.logPhaseTransition(activityInput, 'lateral-movement', 'complete');
    }

    state.currentPhase = 'reporting';
    if (!shouldSkip('report')) {
      state.currentAgent = 'report';
      await a.logPhaseTransition(activityInput, 'reporting', 'start');
      await a.assembleReportActivity(activityInput);
      state.agentMetrics.report = await a.runReportAgent(activityInput);
      state.completedAgents.push('report');
      if (input.checkpointsEnabled) await a.saveCheckpoint(activityInput, 'report', 'reporting', state);
      await a.injectReportMetadataActivity(activityInput);
      await a.logPhaseTransition(activityInput, 'reporting', 'complete');
    }

    await a.generateReportOutputActivity(activityInput);
    if (input.checkpointsEnabled) await a.saveCheckpoint(activityInput, 'report-output', 'reporting', state);

    state.status = 'completed';
    state.currentPhase = null;
    state.currentAgent = null;
    state.summary = computeSummary(state);

    await a.logWorkflowComplete(activityInput, toWorkflowSummary(state, 'completed'));
    return state;
  } catch (error) {
    if (isCancellation(error)) {
      state.status = 'cancelled';
      state.error = `Cancelled during phase: ${state.currentPhase ?? 'unknown'}`;
      state.summary = computeSummary(state);
      await a.logWorkflowComplete(activityInput, toWorkflowSummary(state, 'cancelled'));
      return state;
    }

    state.status = 'failed';
    state.failedAgent = state.currentAgent;
    state.error = formatWorkflowError(error, state.currentPhase, state.currentAgent);
    const errorCode = classifyErrorCode(error);
    if (errorCode) state.errorCode = errorCode;
    state.summary = computeSummary(state);

    await a.logWorkflowComplete(activityInput, toWorkflowSummary(state, 'failed'));
    throw error;
  }
}

export async function pentestPipelineWorkflow(input: PipelineInput): Promise<PipelineState> {
  return pentestPipeline(input);
}