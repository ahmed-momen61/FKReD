// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import { fs, path } from 'zx';
import { type ClaudePromptResult, runClaudePrompt, validateAgentOutput } from '../ai/claude-executor.js';
import { getOutputFormat, getQueueFilename } from '../ai/queue-schemas.js';
import type { AuditSession } from '../audit/index.js';
import { AGENTS } from '../session-manager.js';
import type { ActivityLogger } from '../types/activity-logger.js';
import type { AgentName } from '../types/agents.js';
import type { AgentEndResult } from '../types/audit.js';
import { ErrorCode, type PentestErrorType } from '../types/errors.js';
import type { AgentMetrics } from '../types/metrics.js';
import { err, isErr, ok, type Result } from '../types/result.js';
import { isSpendingCapBehavior } from '../utils/billing-detection.js';
import type { ConfigLoaderService } from './config-loader.js';
import { PentestError } from './error-handling.js';
import { commitGitSuccess, createGitCheckpoint, getGitCommitHash, rollbackGitWorkspace } from './git-manager.js';
import { loadPrompt } from './prompt-manager.js';
import type { TargetLedger } from '../temporal/shared.js';

export interface AgentExecutionInput {
  webUrl: string;
  repoPath: string;
  deliverablesPath: string;
  configPath?: string | undefined;
  configData?: import('../types/config.js').DistributedConfig | undefined;
  configYAML?: string | undefined;
  pipelineTestingMode?: boolean | undefined;
  attemptNumber: number;
  apiKey?: string | undefined;
  promptDir?: string | undefined;
  providerConfig?: import('../types/config.js').ProviderConfig | undefined;
  
  // Red Team Context Injection
  ledger?: TargetLedger;
  currentDepth?: string;
}

interface FailAgentOpts {
  attemptNumber: number;
  result: ClaudePromptResult;
  rollbackReason: string;
  errorMessage: string;
  errorCode: ErrorCode;
  category: PentestErrorType;
  retryable: boolean;
  context: Record<string, unknown>;
}

export class AgentExecutionService {
  private readonly configLoader: ConfigLoaderService;

  constructor(configLoader: ConfigLoaderService) {
    this.configLoader = configLoader;
  }

  async execute(
    agentName: AgentName,
    input: AgentExecutionInput,
    auditSession: AuditSession,
    logger: ActivityLogger,
  ): Promise<Result<AgentEndResult, PentestError>> {
    const { webUrl, repoPath, deliverablesPath, configPath, configData, configYAML, pipelineTestingMode = false, attemptNumber, apiKey, promptDir, providerConfig, ledger, currentDepth } = input;

    const configResult = await this.configLoader.loadOptional(configPath, configData, configYAML);
    if (isErr(configResult)) return configResult;
    const distributedConfig = configResult.value;

    const promptTemplate = agentName === 'pivot' ? 'pivot-lateral.txt' : AGENTS[agentName].promptTemplate;
    let prompt: string;
    try {
      prompt = await loadPrompt(promptTemplate, { webUrl, repoPath }, distributedConfig, pipelineTestingMode, logger, promptDir);
    } catch (error) {
      return err(new PentestError(`Failed to load prompt`, 'prompt', false, { agentName }, ErrorCode.PROMPT_LOAD_FAILED));
    }

    try {
      await createGitCheckpoint(deliverablesPath, agentName, attemptNumber, logger);
    } catch (error) {
      return err(new PentestError(`Git check point failed`, 'filesystem', false, { agentName }, ErrorCode.GIT_CHECKPOINT_FAILED));
    }

    await auditSession.startAgent(agentName, prompt, attemptNumber);

    // RED TEAM: Inject Ledger State into Claude's System Context
    const systemContext = `
[RED TEAM MISSION DIRECTIVE]
TARGET DEPTH: ${currentDepth || 'shallow'}
[CURRENT TARGET LEDGER]
${JSON.stringify(ledger || {}, null, 2)}

Analyze this state deeply. Do not re-discover known credentials or signatures. Exploit them immediately.
`;

    const outputFormat = getOutputFormat(agentName);
    const result: ClaudePromptResult = await runClaudePrompt(
      prompt,
      repoPath,
      systemContext, 
      agentName, 
      agentName,
      auditSession,
      logger,
      agentName === 'pivot' ? 'high' : AGENTS[agentName].modelTier,
      outputFormat,
      apiKey,
      path.relative(repoPath, deliverablesPath),
      providerConfig,
    );

    if (result.success && (result.turns ?? 0) <= 2 && (result.cost || 0) === 0) {
      const resultText = result.result || '';
      if (isSpendingCapBehavior(result.turns ?? 0, result.cost || 0, resultText)) {
        return this.failAgent(agentName, deliverablesPath, auditSession, logger, { attemptNumber, result, rollbackReason: 'spending cap', errorMessage: `Spending cap reached`, errorCode: ErrorCode.SPENDING_CAP_REACHED, category: 'billing', retryable: true, context: { agentName } });
      }
    }

    if (!result.success) {
      return this.failAgent(agentName, deliverablesPath, auditSession, logger, { attemptNumber, result, rollbackReason: 'execution failure', errorMessage: result.error || 'Execution failed', errorCode: ErrorCode.AGENT_EXECUTION_FAILED, category: 'validation', retryable: result.retryable ?? true, context: { agentName } });
    }

    // Extract potential ledger updates if the agent produced a specific structure
    let ledgerUpdates: Partial<TargetLedger> | undefined = undefined;
    if (result.structuredOutput) {
      const output = result.structuredOutput as any;
      if (output.ledgerUpdates) ledgerUpdates = output.ledgerUpdates;
    }

    const queueFilename = getQueueFilename(agentName);
    if (result.structuredOutput !== undefined && queueFilename) {
      await fs.ensureDir(deliverablesPath);
      await fs.writeFile(path.join(deliverablesPath, queueFilename), JSON.stringify(result.structuredOutput, null, 2), 'utf8');
    }

    // Validate
    if (agentName !== 'pivot') {
      const validationPassed = await validateAgentOutput(result, agentName, deliverablesPath, logger);
      if (!validationPassed) {
        return this.failAgent(agentName, deliverablesPath, auditSession, logger, { attemptNumber, result, rollbackReason: 'validation failure', errorMessage: `Validation failed`, errorCode: ErrorCode.OUTPUT_VALIDATION_FAILED, category: 'validation', retryable: true, context: { agentName } });
      }
    }

    await commitGitSuccess(deliverablesPath, agentName, logger);
    const commitHash = await getGitCommitHash(deliverablesPath);

    const endResult: AgentEndResult & { ledgerUpdates?: Partial<TargetLedger> } = {
      attemptNumber, duration_ms: result.duration, cost_usd: result.cost || 0, success: true, model: result.model, ledgerUpdates, ...(commitHash && { checkpoint: commitHash })
    };
    await auditSession.endAgent(agentName, endResult);

    return ok(endResult);
  }

  private async failAgent(agentName: string, deliverablesPath: string, auditSession: AuditSession, logger: ActivityLogger, opts: FailAgentOpts): Promise<Result<AgentEndResult, PentestError>> {
    await rollbackGitWorkspace(deliverablesPath, opts.rollbackReason, logger);
    const endResult: AgentEndResult = { attemptNumber: opts.attemptNumber, duration_ms: opts.result.duration, cost_usd: opts.result.cost || 0, success: false, model: opts.result.model, error: opts.errorMessage };
    await auditSession.endAgent(agentName, endResult);
    return err(new PentestError(opts.errorMessage, opts.category, opts.retryable, opts.context, opts.errorCode));
  }

  async executeOrThrow(agentName: AgentName, input: AgentExecutionInput, auditSession: AuditSession, logger: ActivityLogger): Promise<AgentEndResult & { ledgerUpdates?: Partial<TargetLedger> }> {
    const result = await this.execute(agentName, input, auditSession, logger);
    if (isErr(result)) throw result.error;
    return result.value;
  }
}