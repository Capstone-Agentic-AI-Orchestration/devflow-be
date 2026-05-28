import { envSchema, EnvSchema } from './env.schema';

let _config: EnvSchema | null = null;

export function getConfig(): EnvSchema {
  if (!_config) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const formatted = result.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');
      throw new Error(`Configuration error: ${formatted}`);
    }
    _config = result.data;
  }
  return _config;
}

export default () => {
  const env = envSchema.safeParse(process.env);
  if (!env.success) {
    return {};
  }
  return {
    port: env.data.PORT,
    nodeEnv: env.data.NODE_ENV,
    database: {
      url: env.data.DATABASE_URL,
    },
    supabase: {
      url: env.data.SUPABASE_URL,
    },
    anthropic: {
      apiKey: env.data.ANTHROPIC_API_KEY,
    },
    openai: {
      apiKey: env.data.OPENAI_API_KEY,
    },
    github: {
      appId: env.data.GITHUB_APP_ID,
      privateKey: Buffer.from(env.data.GITHUB_PRIVATE_KEY, 'base64').toString(
        'utf-8',
      ),
      installationId: parseInt(env.data.GITHUB_INSTALLATION_ID, 10),
    },
    // Phase 2E — LangSmith tracing (auto-instrumented via env vars)
    langsmith: {
      apiKey: process.env.LANGCHAIN_API_KEY,
      tracingEnabled: process.env.LANGCHAIN_TRACING_V2 === 'true',
      project: process.env.LANGCHAIN_PROJECT ?? 'devflow',
    },
  };
};
