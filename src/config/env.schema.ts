import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  AGENT_PROVIDER: z.enum(['mock', 'llm']).optional().default('mock'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  OPENAI_API_KEY: z.string().optional().default(''),
  GITHUB_APP_ID: z.string().optional().default(''),
  GITHUB_PRIVATE_KEY: z.string().optional().default(''),
  GITHUB_INSTALLATION_ID: z.string().optional().default(''),
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
}).superRefine((env, ctx) => {
  if (env.AGENT_PROVIDER !== 'llm') return;

  const requiredForLlm: Array<keyof typeof env> = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GITHUB_APP_ID',
    'GITHUB_PRIVATE_KEY',
    'GITHUB_INSTALLATION_ID',
  ];

  for (const key of requiredForLlm) {
    if (!env[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when AGENT_PROVIDER=llm`,
      });
    }
  }
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
