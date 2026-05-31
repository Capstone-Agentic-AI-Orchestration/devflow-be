import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  AGENT_PROVIDER: z.enum(['mock', 'llm']).optional().default('mock'),
  LLM_PROVIDER: z.enum(['openrouter', 'openai', 'anthropic', 'opencode']).optional().default('openrouter'),
  OPENROUTER_API_KEY: z.string().optional().default(''),
  OPENROUTER_BASE_URL: z.string().url().optional().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().optional().default('deepseek/deepseek-v4-flash:free'),
  OPENROUTER_FALLBACK_MODEL: z.string().optional().default(''),
  OPENAI_BASE_URL: z.string().url().optional().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().optional().default('gpt-4.1-mini'),
  OPENAI_FALLBACK_MODEL: z.string().optional().default(''),
  ANTHROPIC_BASE_URL: z.string().url().optional().default('https://api.anthropic.com/v1'),
  ANTHROPIC_MODEL: z.string().optional().default('claude-3-5-haiku-20241022'),
  ANTHROPIC_FALLBACK_MODEL: z.string().optional().default(''),
  ANTHROPIC_VERSION: z.string().optional().default('2023-06-01'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  OPENCODE_API_KEY: z.string().optional().default(''),
  OPENCODE_BASE_URL: z.string().url().optional().default('https://opencode.ai/zen/go/v1'),
  OPENCODE_MODEL: z.string().optional().default('deepseek-v4-flash'),
  OPENCODE_FALLBACK_MODEL: z.string().optional().default(''),
  OPENAI_API_KEY: z.string().optional().default(''),
  GITHUB_APP_ID: z.string().optional().default(''),
  GITHUB_PRIVATE_KEY: z.string().optional().default(''),
  GITHUB_INSTALLATION_ID: z.string().optional().default(''),
  GITHUB_ORG: z.string().optional().default(''),
  PORT: z
    .string()
    .optional()
    .default('4000')
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().positive()),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .optional()
    .default('development'),
  CORS_ORIGIN: z.string().optional().default('*'),
  // Phase 2E — LangSmith tracing (optional)
  LANGCHAIN_API_KEY: z.string().optional(),
  LANGCHAIN_TRACING_V2: z.enum(['true', 'false']).optional().default('false'),
  LANGCHAIN_PROJECT: z.string().optional().default('devflow'),
  // Phase 2B — RunSupervisor config
  SUPERVISOR_POLL_INTERVAL_MS: z
    .string()
    .optional()
    .default('30000')
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().positive()),
  SUPERVISOR_STUCK_THRESHOLD_MS: z
    .string()
    .optional()
    .default('300000')
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().positive()),
});

export type EnvSchema = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvSchema {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const formatted = result.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    throw new Error(`Environment validation failed: ${formatted}`);
  }
  return result.data;
}
