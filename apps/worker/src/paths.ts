// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import path from 'node:path';

// RED TEAM PATCH: Completely migrating default subsystem to .fkred
export const DEFAULT_DELIVERABLES_SUBDIR = process.env.FKRED_DELIVERABLES_SUBDIR || '.fkred/deliverables';

/**
 * Resolves the path to the deliverables directory.
 * If subdir is an absolute path, it is used directly.
 * Otherwise, it is joined with repoPath.
 */
export function deliverablesDir(repoPath: string, subdir: string = DEFAULT_DELIVERABLES_SUBDIR): string {
  if (path.isAbsolute(subdir)) {
    return subdir;
  }
  // Use split('/') to ensure cross-platform compatibility if subdir comes from an env var
  return path.join(repoPath, ...subdir.split('/'));
}

export function resolveConfig(configPath: string): string {
  return path.resolve(configPath);
}

export function resolveRepo(repoPath?: string): { hostPath: string } {
  if (!repoPath) return { hostPath: process.cwd() };
  return { hostPath: path.resolve(repoPath) };
}