import { Injectable } from '@nestjs/common';

type JsonShape = 'object' | 'array';

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
    code?: string | number;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface AnthropicMessageResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  error?: {
    message?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

type GraphLlmProviderName = 'openrouter' | 'openai' | 'anthropic' | 'opencode';

export interface GraphLlmJsonOptions {
  agentName: string;
  systemPrompt: string;
  userPrompt: string;
  expectedShape: JsonShape;
  maxTokens?: number;
}

export interface GraphLlmJsonResult<T> {
  value: T;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface GraphLlmProviderVerification {
  ok: boolean;
  provider: GraphLlmProviderName;
  model: string;
  fallbackModel: string | null;
  baseUrl: string;
  reason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
  } | null;
}

@Injectable()
export class GraphLlmProvider {
  providerName(): GraphLlmProviderName {
    if (process.env.LLM_PROVIDER === 'anthropic') return 'anthropic';
    if (process.env.LLM_PROVIDER === 'opencode') return 'opencode';
    return process.env.LLM_PROVIDER === 'openai' ? 'openai' : 'openrouter';
  }

  model(): string {
    if (this.providerName() === 'anthropic') {
      return process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
    }

    if (this.providerName() === 'openai') {
      return process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    }

    if (this.providerName() === 'opencode') {
      return process.env.OPENCODE_MODEL || 'deepseek-v4-flash';
    }

    return process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash:free';
  }

  fallbackModel(): string | null {
    if (this.providerName() === 'anthropic') {
      return process.env.ANTHROPIC_FALLBACK_MODEL?.trim() || null;
    }

    if (this.providerName() === 'openai') {
      return process.env.OPENAI_FALLBACK_MODEL?.trim() || null;
    }

    if (this.providerName() === 'opencode') {
      return process.env.OPENCODE_FALLBACK_MODEL?.trim() || null;
    }

    return process.env.OPENROUTER_FALLBACK_MODEL?.trim() || null;
  }

  baseUrl(): string {
    if (this.providerName() === 'anthropic') {
      return (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, '');
    }

    if (this.providerName() === 'openai') {
      return (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    }

    if (this.providerName() === 'opencode') {
      return (process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/go/v1').replace(/\/$/, '');
    }

    return (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey());
  }

  async verifyConnection(): Promise<GraphLlmProviderVerification> {
    const provider = this.providerName();
    const model = this.model();
    const fallbackModel = this.fallbackModel();
    const baseUrl = this.baseUrl();

    if (!this.apiKey()) {
      return {
        ok: false,
        provider,
        model,
        fallbackModel,
        baseUrl,
        reason: `Graph LLM provider requires ${this.apiKeyName()}.`,
        usage: null,
      };
    }

    try {
      const result = await this.generateJson<{ ok?: boolean }>({
        agentName: 'provider_preflight',
        systemPrompt: 'Return one minimal JSON object only.',
        userPrompt: 'Return {"ok":true}.',
        expectedShape: 'object',
        maxTokens: 32,
      });

      return {
        ok: true,
        provider,
        model: result.model,
        fallbackModel,
        baseUrl,
        reason: null,
        usage: result.usage,
      };
    } catch (error) {
      return {
        ok: false,
        provider,
        model,
        fallbackModel,
        baseUrl,
        reason: this.errorMessage(error),
        usage: null,
      };
    }
  }

  async generateJson<T>(options: GraphLlmJsonOptions): Promise<GraphLlmJsonResult<T>> {
    if (!this.apiKey()) {
      throw new Error(`Graph LLM provider requires ${this.apiKeyName()}.`);
    }

    const primaryResult = await this.tryGenerateWithModel<T>(this.model(), options)
      .then((result) => ({ result, error: null }))
      .catch((error: unknown) => ({ result: null, error }));

    if (primaryResult.result) {
      return primaryResult.result;
    }

    const fallbackModel = this.fallbackModel();
    if (!fallbackModel || fallbackModel === this.model()) {
      throw primaryResult.error;
    }

    return this.tryGenerateWithModel<T>(fallbackModel, options, primaryResult.error);
  }

  private async tryGenerateWithModel<T>(
    model: string,
    options: GraphLlmJsonOptions,
    primaryError?: unknown,
  ): Promise<GraphLlmJsonResult<T>> {
    const response = await fetch(this.url(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(model, [
          {
            role: 'system',
            content: [
              options.systemPrompt,
              '',
              `Return exactly one valid JSON ${options.expectedShape}.`,
              'Do not include markdown fences, comments, or prose outside JSON.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: options.userPrompt,
          },
        ], options, 0.2)),
    });

    const payload = await response.json().catch(() => null) as OpenRouterChatResponse | AnthropicMessageResponse | null;
    if (!response.ok) {
      const detail = payload && 'error' in payload ? payload.error?.message || response.statusText : response.statusText;
      const fallbackNote = primaryError
        ? ` Fallback after primary failure: ${this.errorMessage(primaryError)}.`
        : '';
      throw new Error(`${this.providerLabel()} ${model} ${options.agentName} request failed (${response.status}): ${detail}.${fallbackNote}`);
    }

    const content = this.contentFromPayload(payload);
    if (!content?.trim()) {
      throw new Error(`${this.providerLabel()} ${model} ${options.agentName} returned an empty response.`);
    }

    const value = await this.parseOrRepair<T>(model, content, options);
    const usage = this.usageFromPayload(payload);
    return {
      value,
      model,
      usage,
    };
  }

  private async parseOrRepair<T>(
    model: string,
    content: string,
    options: GraphLlmJsonOptions,
  ): Promise<T> {
    try {
      return this.parseJson<T>(content, options.expectedShape);
    } catch (error) {
      return this.repairJson<T>(model, content, options, error);
    }
  }

  private async repairJson<T>(
    model: string,
    content: string,
    options: GraphLlmJsonOptions,
    originalError: unknown,
  ): Promise<T> {
    const response = await fetch(this.url(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(model, [
          {
            role: 'system',
            content: [
              `Repair this ${options.agentName} output into one valid JSON ${options.expectedShape}.`,
              'Preserve useful file content and data from the invalid output.',
              'Do not include markdown fences, comments, or prose outside JSON.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              parseError: this.errorMessage(originalError),
              invalidOutput: content.slice(0, 12000),
            }),
          },
        ], options, 0)),
    });

    const payload = await response.json().catch(() => null) as OpenRouterChatResponse | AnthropicMessageResponse | null;
    if (!response.ok) {
      const detail = payload && 'error' in payload ? payload.error?.message || response.statusText : response.statusText;
      throw new Error(
        `${this.providerLabel()} ${model} ${options.agentName} repair failed (${response.status}): ${detail}. Original output error: ${this.errorMessage(originalError)}`,
      );
    }

    const repaired = this.contentFromPayload(payload);
    if (!repaired?.trim()) {
      throw new Error(
        `${this.providerLabel()} ${model} ${options.agentName} repair returned an empty response. Original output error: ${this.errorMessage(originalError)}`,
      );
    }

    try {
      return this.parseJson<T>(repaired, options.expectedShape);
    } catch (repairError) {
      throw new Error(
        `${this.providerLabel()} ${model} ${options.agentName} repair returned invalid JSON: ${this.errorMessage(repairError)}. Original output error: ${this.errorMessage(originalError)}`,
      );
    }
  }

  private apiKey(): string {
    if (this.providerName() === 'anthropic') {
      return process.env.ANTHROPIC_API_KEY?.trim() ?? '';
    }

    if (this.providerName() === 'opencode') {
      return process.env.OPENCODE_API_KEY?.trim() ?? '';
    }

    return this.providerName() === 'openai'
      ? process.env.OPENAI_API_KEY?.trim() ?? ''
      : process.env.OPENROUTER_API_KEY?.trim() ?? '';
  }

  private apiKeyName(): string {
    if (this.providerName() === 'anthropic') return 'ANTHROPIC_API_KEY';
    if (this.providerName() === 'opencode') return 'OPENCODE_API_KEY';
    return this.providerName() === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY';
  }

  private headers(): Record<string, string> {
    if (this.providerName() === 'anthropic') {
      return {
        'x-api-key': this.apiKey(),
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
        'Content-Type': 'application/json',
      };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey()}`,
      'Content-Type': 'application/json',
    };

    if (this.providerName() === 'openrouter') {
      headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL || 'http://localhost:4000';
      headers['X-Title'] = process.env.OPENROUTER_APP_NAME || 'DevFlow';
    }

    return headers;
  }

  private url(): string {
    return this.providerName() === 'anthropic'
      ? `${this.baseUrl()}/messages`
      : `${this.baseUrl()}/chat/completions`;
  }

  private requestBody(
    model: string,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options: GraphLlmJsonOptions,
    temperature: number,
  ): Record<string, unknown> {
    if (this.providerName() === 'anthropic') {
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const user = messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n\n');

      return {
        model,
        system,
        messages: [{ role: 'user', content: user }],
        temperature,
        max_tokens: options.maxTokens ?? 4096,
      };
    }

    return {
      model,
      messages,
      temperature,
      max_tokens: options.maxTokens ?? 4096,
      ...this.responseFormat(options),
    };
  }

  private responseFormat(options: GraphLlmJsonOptions): Record<string, unknown> {
    if (this.providerName() === 'openai' || this.providerName() === 'opencode') {
      return {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: `${options.agentName}_${options.expectedShape}`,
            strict: false,
            schema: options.expectedShape === 'array'
              ? { type: 'array', items: { type: 'object', additionalProperties: true } }
              : { type: 'object', additionalProperties: true },
          },
        },
      };
    }

    return options.expectedShape === 'object'
      ? { response_format: { type: 'json_object' } }
      : {};
  }

  private providerLabel(): string {
    if (this.providerName() === 'anthropic') return 'Anthropic';
    if (this.providerName() === 'opencode') return 'OpenCode';
    return this.providerName() === 'openai' ? 'OpenAI' : 'OpenRouter';
  }

  private contentFromPayload(payload: OpenRouterChatResponse | AnthropicMessageResponse | null): string | null {
    if (!payload) return null;
    if ('choices' in payload) return payload.choices?.[0]?.message?.content ?? null;
    if ('content' in payload) {
      return payload.content?.find((block) => block.type === 'text' && block.text)?.text ?? null;
    }
    return null;
  }

  private usageFromPayload(payload: OpenRouterChatResponse | AnthropicMessageResponse | null) {
    if (!payload?.usage) return { inputTokens: 0, outputTokens: 0 };
    if ('prompt_tokens' in payload.usage || 'completion_tokens' in payload.usage) {
      const usage = payload.usage as OpenRouterChatResponse['usage'];
      return {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      };
    }

    const usage = payload.usage as AnthropicMessageResponse['usage'];
    return {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
    };
  }

  private parseJson<T>(content: string, expectedShape: JsonShape): T {
    const parsed = JSON.parse(this.extractJson(content, expectedShape)) as unknown;
    if (expectedShape === 'array' && !Array.isArray(parsed)) {
      throw new Error('Expected a JSON array.');
    }
    if (expectedShape === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error('Expected a JSON object.');
    }

    return parsed as T;
  }

  private extractJson(content: string, expectedShape: JsonShape): string {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced?.[1]) return fenced[1].trim();

    const open = expectedShape === 'array' ? '[' : '{';
    const close = expectedShape === 'array' ? ']' : '}';
    const first = trimmed.indexOf(open);
    const last = trimmed.lastIndexOf(close);
    if (first >= 0 && last > first) {
      return trimmed.slice(first, last + 1);
    }

    return trimmed;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
