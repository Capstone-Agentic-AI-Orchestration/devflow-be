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

@Injectable()
export class GraphLlmProvider {
  providerName(): string {
    return process.env.LLM_PROVIDER || 'openrouter';
  }

  model(): string {
    return process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash:free';
  }

  fallbackModel(): string | null {
    return process.env.OPENROUTER_FALLBACK_MODEL?.trim() || null;
  }

  baseUrl(): string {
    return (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  }

  isAvailable(): boolean {
    return this.providerName() === 'openrouter' && Boolean(process.env.OPENROUTER_API_KEY?.trim());
  }

  async generateJson<T>(options: GraphLlmJsonOptions): Promise<GraphLlmJsonResult<T>> {
    if (this.providerName() !== 'openrouter') {
      throw new Error('Graph LLM provider requires LLM_PROVIDER=openrouter.');
    }

    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      throw new Error('Graph LLM provider requires OPENROUTER_API_KEY.');
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
    const response = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:4000',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'DevFlow',
      },
      body: JSON.stringify({
        model,
        messages: [
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
        ],
        temperature: 0.2,
        max_tokens: options.maxTokens ?? 4096,
        ...(options.expectedShape === 'object'
          ? { response_format: { type: 'json_object' } }
          : {}),
      }),
    });

    const payload = await response.json().catch(() => null) as OpenRouterChatResponse | null;
    if (!response.ok) {
      const detail = payload?.error?.message || response.statusText;
      const fallbackNote = primaryError
        ? ` Fallback after primary failure: ${this.errorMessage(primaryError)}.`
        : '';
      throw new Error(`OpenRouter ${model} ${options.agentName} request failed (${response.status}): ${detail}.${fallbackNote}`);
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (!content?.trim()) {
      throw new Error(`OpenRouter ${model} ${options.agentName} returned an empty response.`);
    }

    const value = await this.parseOrRepair<T>(model, content, options);
    return {
      value,
      model,
      usage: {
        inputTokens: payload?.usage?.prompt_tokens ?? 0,
        outputTokens: payload?.usage?.completion_tokens ?? 0,
      },
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
    const response = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:4000',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'DevFlow',
      },
      body: JSON.stringify({
        model,
        messages: [
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
        ],
        temperature: 0,
        max_tokens: options.maxTokens ?? 4096,
        ...(options.expectedShape === 'object'
          ? { response_format: { type: 'json_object' } }
          : {}),
      }),
    });

    const payload = await response.json().catch(() => null) as OpenRouterChatResponse | null;
    if (!response.ok) {
      const detail = payload?.error?.message || response.statusText;
      throw new Error(
        `OpenRouter ${model} ${options.agentName} repair failed (${response.status}): ${detail}. Original output error: ${this.errorMessage(originalError)}`,
      );
    }

    const repaired = payload?.choices?.[0]?.message?.content;
    if (!repaired?.trim()) {
      throw new Error(
        `OpenRouter ${model} ${options.agentName} repair returned an empty response. Original output error: ${this.errorMessage(originalError)}`,
      );
    }

    try {
      return this.parseJson<T>(repaired, options.expectedShape);
    } catch (repairError) {
      throw new Error(
        `OpenRouter ${model} ${options.agentName} repair returned invalid JSON: ${this.errorMessage(repairError)}. Original output error: ${this.errorMessage(originalError)}`,
      );
    }
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
