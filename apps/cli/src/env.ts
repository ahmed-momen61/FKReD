import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(): void {
  // Load from current working directory first
  dotenv.config();

  // Also try loading from global ~/.fkred/.env
  const homeEnv = path.join(process.env.HOME || process.env.USERPROFILE || '', '.fkred', '.env');
  if (fs.existsSync(homeEnv)) {
    const envConfig = dotenv.parse(fs.readFileSync(homeEnv));
    for (const k in envConfig) {
      if (!process.env[k]) {
        process.env[k] = envConfig[k];
      }
    }
  }
}

export function validateCredentials(): { valid: boolean; error?: string } {
  const key = process.env.ANTHROPIC_API_KEY || process.env.FKRED_API_KEY;
  if (!key) {
    return { valid: false, error: 'ANTHROPIC_API_KEY or FKRED_API_KEY environment variable is required' };
  }
  return { valid: true };
}

export function buildEnvFlags(): string[] {
  const flags: string[] = [];
  
  if (process.env.ANTHROPIC_API_KEY) {
    flags.push('-e', 'ANTHROPIC_API_KEY');
  } else if (process.env.FKRED_API_KEY) {
    flags.push('-e', `ANTHROPIC_API_KEY=${process.env.FKRED_API_KEY}`);
  }

  // Pass through other necessary environment variables safely
  const passThrough = [
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'TAVILY_API_KEY',
  ];

  for (const envVar of passThrough) {
    if (process.env[envVar]) {
      flags.push('-e', envVar);
    }
  }

  return flags;
}

interface CredentialValidation {
  valid: boolean;
  error?: string;
  mode: 'api-key' | 'oauth' | 'custom-base-url' | 'bedrock' | 'vertex';
}

/** Check if a custom Anthropic-compatible base URL is configured. */
function isCustomBaseUrlConfigured(): boolean {
  return !!(process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Detect which providers are configured via environment variables. */
function detectProviders(): string[] {
  const providers: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) providers.push('Anthropic API key');
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) providers.push('Anthropic OAuth');
  if (isCustomBaseUrlConfigured()) providers.push('Custom Base URL');
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') providers.push('AWS Bedrock');
  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') providers.push('Google Vertex');
  return providers;
}

/**
 * Validate that exactly one authentication method is configured.
 */
export function validateCredentials(): CredentialValidation {
  // Reject multiple providers
  const providers = detectProviders();
  if (providers.length > 1) {
    return {
      valid: false,
      mode: 'api-key',
      error: `Multiple providers detected: ${providers.join(', ')}. Only one provider can be active at a time.`,
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return { valid: true, mode: 'api-key' };
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { valid: true, mode: 'oauth' };
  }
  if (isCustomBaseUrlConfigured()) {
    return { valid: true, mode: 'custom-base-url' };
  }
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') {
    const missing: string[] = [];
    if (!process.env.AWS_REGION) missing.push('AWS_REGION');
    if (!process.env.AWS_BEARER_TOKEN_BEDROCK) missing.push('AWS_BEARER_TOKEN_BEDROCK');
    if (!process.env.ANTHROPIC_SMALL_MODEL) missing.push('ANTHROPIC_SMALL_MODEL');
    if (!process.env.ANTHROPIC_MEDIUM_MODEL) missing.push('ANTHROPIC_MEDIUM_MODEL');
    if (!process.env.ANTHROPIC_LARGE_MODEL) missing.push('ANTHROPIC_LARGE_MODEL');
    if (missing.length > 0) {
      return {
        valid: false,
        mode: 'bedrock',
        error: `Bedrock mode requires: ${missing.join(', ')}`,
      };
    }
    return { valid: true, mode: 'bedrock' };
  }
  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') {
    const missing: string[] = [];
    if (!process.env.CLOUD_ML_REGION) missing.push('CLOUD_ML_REGION');
    if (!process.env.ANTHROPIC_VERTEX_PROJECT_ID) missing.push('ANTHROPIC_VERTEX_PROJECT_ID');
    if (!process.env.ANTHROPIC_SMALL_MODEL) missing.push('ANTHROPIC_SMALL_MODEL');
    if (!process.env.ANTHROPIC_MEDIUM_MODEL) missing.push('ANTHROPIC_MEDIUM_MODEL');
    if (!process.env.ANTHROPIC_LARGE_MODEL) missing.push('ANTHROPIC_LARGE_MODEL');
    if (missing.length > 0) {
      return {
        valid: false,
        mode: 'vertex',
        error: `Vertex AI mode requires: ${missing.join(', ')}`,
      };
    }
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      return {
        valid: false,
        mode: 'vertex',
        error: 'Vertex AI mode requires GOOGLE_APPLICATION_CREDENTIALS',
      };
    }
    return { valid: true, mode: 'vertex' };
  }

  const hint =
    getMode() === 'local'
      ? `No credentials found. Set ANTHROPIC_API_KEY in .env or export it.`
      : `Authentication not configured. Export variables or run 'npx @keygraph/shannon setup'.`;
  return {
    valid: false,
    mode: 'api-key',
    error: hint,
  };
}
