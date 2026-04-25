// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import { fs, path } from 'zx';

import { validateQueueAndDeliverable } from './services/queue-validation.js';
import type { ActivityLogger } from './types/activity-logger.js';
import type { AgentDefinition, AgentName, AgentValidator, PlaywrightSession, VulnType } from './types/index.js';

// Agent definitions according to PRD
export const AGENTS: Readonly<Record<AgentName, AgentDefinition>> = Object.freeze({
  'pre-recon': {
    name: 'pre-recon',
    displayName: 'Pre-recon agent',
    prerequisites: [],
    promptTemplate: 'pre-recon-code',
    deliverableFilename: 'pre_recon_deliverable.md',
    modelTier: 'large',
  },
  recon: {
    name: 'recon',
    displayName: 'Recon agent',
    prerequisites: ['pre-recon'],
    promptTemplate: 'recon',
    deliverableFilename: 'recon_deliverable.md',
  },
  'injection-vuln': {
    name: 'injection-vuln',
    displayName: 'Injection vuln agent',
    prerequisites: ['recon'],
    promptTemplate: 'vuln-injection',
    deliverableFilename: 'injection_analysis_deliverable.md',
  },
  'xss-vuln': {
    name: 'xss-vuln',
    displayName: 'XSS vuln agent',
    prerequisites: ['recon'],
    promptTemplate: 'vuln-xss',
    deliverableFilename: 'xss_analysis_deliverable.md',
  },
  'auth-vuln': {
    name: 'auth-vuln',
    displayName: 'Auth vuln agent',
    prerequisites: ['recon'],
    promptTemplate: 'vuln-auth',
    deliverableFilename: 'auth_analysis_deliverable.md',
  },
  'ssrf-vuln': {
    name: 'ssrf-vuln',
    displayName: 'SSRF vuln agent',
    prerequisites: ['recon'],
    promptTemplate: 'vuln-ssrf',
    deliverableFilename: 'ssrf_analysis_deliverable.md',
  },
  'authz-vuln': {
    name: 'authz-vuln',
    displayName: 'Authz vuln agent',
    prerequisites: ['recon'],
    promptTemplate: 'vuln-authz',
    deliverableFilename: 'authz_analysis_deliverable.md',
  },
  'injection-exploit': {
    name: 'injection-exploit',
    displayName: 'Injection exploit agent',
    prerequisites: ['injection-vuln'],
    promptTemplate: 'exploit-injection',
    deliverableFilename: 'injection_exploitation_deliverable.md',
  },
  'xss-exploit': {
    name: 'xss-exploit',
    displayName: 'XSS exploit agent',
    prerequisites: ['xss-vuln'],
    promptTemplate: 'exploit-xss',
    deliverableFilename: 'xss_exploitation_deliverable.md',
  },
  'auth-exploit': {
    name: 'auth-exploit',
    displayName: 'Auth exploit agent',
    prerequisites: ['auth-vuln'],
    promptTemplate: 'exploit-auth',
    deliverableFilename: 'auth_exploitation_deliverable.md',
  },
  'ssrf-exploit': {
    name: 'ssrf-exploit',
    displayName: 'SSRF exploit agent',
    prerequisites: ['ssrf-vuln'],
    promptTemplate: 'exploit-ssrf',
    deliverableFilename: 'ssrf_exploitation_deliverable.md',
  },
  'authz-exploit': {
    name: 'authz-exploit',
    displayName: 'Authz exploit agent',
    prerequisites: ['authz-vuln'],
    promptTemplate: 'exploit-authz',
    deliverableFilename: 'authz_exploitation_deliverable.md',
  },
  'pivot': {
    name: 'pivot',
    displayName: 'Lateral Movement Pivot Agent',
    prerequisites: ['recon'],
    promptTemplate: 'pivot-lateral.txt',
    deliverableFilename: 'pivot_deliverable.md',
    modelTier: 'large',
  },
  report: {
    name: 'report',
    displayName: 'Executive report agent',
    prerequisites: [
      'injection-exploit',
      'xss-exploit',
      'auth-exploit',
      'ssrf-exploit',
      'authz-exploit',
      'pivot',
    ],
    promptTemplate: 'report-executive',
    deliverableFilename: 'comprehensive_security_assessment_report.md',
  },
});

function createVulnValidator(type: VulnType): AgentValidator {
  return async (sourceDir: string, logger: ActivityLogger): Promise<boolean> => {
    return validateQueueAndDeliverable(type, sourceDir, logger);
  };
}

function createExploitValidator(type: VulnType): AgentValidator {
  return async (sourceDir: string): Promise<boolean> => {
    const deliverableName = `${type}_exploitation_deliverable.md`;
    const deliverablePath = path.join(sourceDir, deliverableName);
    return await fs.pathExists(deliverablePath);
  };
}

export const AGENT_VALIDATORS: Record<AgentName, AgentValidator> = Object.freeze({
  'pre-recon': async (sourceDir: string): Promise<boolean> => {
    const codeAnalysisFile = path.join(sourceDir, 'pre_recon_deliverable.md');
    return await fs.pathExists(codeAnalysisFile);
  },

  recon: async (sourceDir: string): Promise<boolean> => {
    const reconFile = path.join(sourceDir, 'recon_deliverable.md');
    return await fs.pathExists(reconFile);
  },

  'injection-vuln': createVulnValidator('injection'),
  'xss-vuln': createVulnValidator('xss'),
  'auth-vuln': createVulnValidator('auth'),
  'ssrf-vuln': createVulnValidator('ssrf'),
  'authz-vuln': createVulnValidator('authz'),

  'injection-exploit': createExploitValidator('injection'),
  'xss-exploit': createExploitValidator('xss'),
  'auth-exploit': createExploitValidator('auth'),
  'ssrf-exploit': createExploitValidator('ssrf'),
  'authz-exploit': createExploitValidator('authz'),

  'pivot': async (sourceDir: string): Promise<boolean> => {
    const pivotFile = path.join(sourceDir, 'pivot_deliverable.md');
    return await fs.pathExists(pivotFile);
  },

  report: async (sourceDir: string, logger: ActivityLogger): Promise<boolean> => {
    const reportFile = path.join(sourceDir, 'comprehensive_security_assessment_report.md');
    const reportExists = await fs.pathExists(reportFile);
    if (!reportExists) {
      logger.error('Final report file not found');
    }
    return reportExists;
  },
});