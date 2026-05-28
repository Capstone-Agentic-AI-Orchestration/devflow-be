import { Injectable } from '@nestjs/common';
import { Prisma, WorkOrderAgentType } from '@prisma/client';
import {
  GeneratedWorkOrderOutput,
  WorkOrderAgentContext,
  WorkOrderAgentProvider,
} from './agent-provider.types';
import {
  agentArtifactContractFor,
  ORCHESTRATION_CONTRACT_VERSION,
} from './agent-contracts';

interface OpenRouterChatMessage {
  role: 'system' | 'user';
  content: string;
}

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
}

interface AnthropicMessageResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  error?: {
    message?: string;
  };
}

type LlmProviderName = 'openrouter' | 'openai' | 'anthropic' | 'opencode';

@Injectable()
export class LlmAgentProvider implements WorkOrderAgentProvider {
  readonly mode = 'llm' as const;

  providerName(): LlmProviderName {
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

  missingRequirements(): string[] {
    if (this.providerName() === 'anthropic') {
      return process.env.ANTHROPIC_API_KEY?.trim()
        ? []
        : ['ANTHROPIC_API_KEY'];
    }

    if (this.providerName() === 'openai') {
      return process.env.OPENAI_API_KEY?.trim()
        ? []
        : ['OPENAI_API_KEY'];
    }

    if (this.providerName() === 'opencode') {
      return process.env.OPENCODE_API_KEY?.trim()
        ? []
        : ['OPENCODE_API_KEY'];
    }

    return process.env.OPENROUTER_API_KEY?.trim()
      ? []
      : ['OPENROUTER_API_KEY'];
  }

  isAvailable(): boolean {
    return this.missingRequirements().length === 0;
  }

  unavailableReason(): string | null {
    const missing = this.missingRequirements();
    if (missing.length === 0) return null;
    return `${this.providerLabel()} provider requires ${missing.join(' and ')}.`;
  }

  async generateWorkOrderOutput(
    context: WorkOrderAgentContext,
  ): Promise<GeneratedWorkOrderOutput> {
    const missing = this.missingRequirements();
    if (missing.length > 0) {
      throw new Error(`${this.providerLabel()} provider is unavailable: missing ${missing.join(', ')}`);
    }

    const primaryError = await this.tryGenerateWithModel(this.model(), context)
      .then((output) => ({ output, error: null }))
      .catch((error: unknown) => ({ output: null, error }));

    if (primaryError.output) {
      return primaryError.output;
    }

    const fallbackModel = this.fallbackModel();
    if (!fallbackModel || fallbackModel === this.model()) {
      throw primaryError.error;
    }

    return this.tryGenerateWithModel(fallbackModel, context, primaryError.error);
  }

  private async tryGenerateWithModel(
    model: string,
    context: WorkOrderAgentContext,
    primaryError?: unknown,
  ): Promise<GeneratedWorkOrderOutput> {
    const response = await fetch(this.url(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(model, this.messagesFor(context), 0.2, 'work_order_output')),
    });

    const payload = await response.json().catch(() => null) as OpenRouterChatResponse | AnthropicMessageResponse | null;
    if (!response.ok) {
      const detail = payload && 'error' in payload ? payload.error?.message || response.statusText : response.statusText;
      const fallbackNote = primaryError
        ? ` Fallback after primary failure: ${this.errorMessage(primaryError)}.`
        : '';
      throw new Error(`${this.providerLabel()} ${model} request failed (${response.status}): ${detail}.${fallbackNote}`);
    }

    const content = this.contentFromPayload(payload);
    if (!content?.trim()) {
      throw new Error(`${this.providerLabel()} ${model} returned an empty response.`);
    }

    const output = await this.parseOutputOrRepair(content, model, context);
    return {
      ...output,
      metadata: {
        ...(output.metadata ?? {}),
        providerMode: this.mode,
        provider: this.providerName(),
        model,
        contractVersion: ORCHESTRATION_CONTRACT_VERSION,
        agentType: context.workOrder.agentType,
      },
    };
  }

  private async parseOutputOrRepair(
    content: string,
    model: string,
    context: WorkOrderAgentContext,
  ): Promise<GeneratedWorkOrderOutput> {
    try {
      return this.parseOutput(content, model);
    } catch (error) {
      return this.repairOutput(model, content, context, error);
    }
  }

  private async repairOutput(
    model: string,
    content: string,
    context: WorkOrderAgentContext,
    originalError: unknown,
  ): Promise<GeneratedWorkOrderOutput> {
    const contract = agentArtifactContractFor(context.workOrder.agentType);
    const response = await fetch(this.url(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(model, [
          {
            role: 'system',
            content: [
              'Repair this DevFlow model output into one strict JSON object only.',
              'Do not include markdown fences or commentary.',
              'Use exactly this schema:',
              '{"filePath":"string","displayName":"string","language":"string","content":"string","metadata":{}}',
              `filePath must be work-orders/${context.workOrder.id}/${contract.fileName}`,
              `language must be ${contract.language}.`,
              `content must satisfy: ${contract.requiredSignals
                .map((signal) => signal.anyOf.map((value) => `"${value}"`).join(' or '))
                .join('; ')}.`,
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              parseError: this.errorMessage(originalError),
              invalidOutput: content.slice(0, 8000),
              workOrder: {
                id: context.workOrder.id,
                title: context.workOrder.title,
                instructions: context.workOrder.instructions,
                agentType: context.workOrder.agentType,
              },
            }),
          },
        ], 0, 'work_order_repair')),
    });

    const payload = await response.json().catch(() => null) as OpenRouterChatResponse | AnthropicMessageResponse | null;
    if (!response.ok) {
      const detail = payload && 'error' in payload ? payload.error?.message || response.statusText : response.statusText;
      throw new Error(
        `${this.providerLabel()} ${model} repair request failed (${response.status}): ${detail}. Original output error: ${this.errorMessage(originalError)}`,
      );
    }

    const repairedContent = this.contentFromPayload(payload);
    if (!repairedContent?.trim()) {
      throw new Error(
        `${this.providerLabel()} ${model} repair returned an empty response. Original output error: ${this.errorMessage(originalError)}`,
      );
    }

    try {
      return this.parseOutput(repairedContent, model);
    } catch (repairError) {
      throw new Error(
        `${this.providerLabel()} ${model} repair returned invalid artifact JSON: ${this.errorMessage(repairError)}. Original output error: ${this.errorMessage(originalError)}`,
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
    messages: OpenRouterChatMessage[],
    temperature: number,
    schemaName: string,
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
        max_tokens: 1200,
      };
    }

    return {
      model,
      messages,
      temperature,
      max_tokens: 1200,
      response_format: this.responseFormat(schemaName),
    };
  }

  private responseFormat(name: string): Record<string, unknown> {
    if (this.providerName() === 'openai' || this.providerName() === 'opencode') {
      return {
        type: 'json_schema',
        json_schema: {
          name,
          strict: false,
          schema: {
            type: 'object',
            additionalProperties: true,
          },
        },
      };
    }

    return { type: 'json_object' };
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

  private messagesFor(context: WorkOrderAgentContext): OpenRouterChatMessage[] {
    const contract = agentArtifactContractFor(context.workOrder.agentType);
    return [
      {
        role: 'system',
        content: [
          'You are a DevFlow implementation agent.',
          'Return one strict JSON object only. Do not include markdown fences or commentary.',
          'The JSON schema is:',
          '{"filePath":"string","displayName":"string","language":"string","content":"string","metadata":{}}',
          'The content field must contain the complete generated file content as a string, not a summary.',
          `filePath must start with work-orders/${context.workOrder.id}/`,
          `filePath must end with one of: ${contract.requiredExtensions.join(', ')}`,
          `language must be ${contract.language}.`,
          `The content must satisfy these exact signal requirements: ${contract.requiredSignals
            .map((signal) => signal.anyOf.map((value) => `"${value}"`).join(' or '))
            .join('; ')}.`,
          this.agentInstruction(context.workOrder.agentType),
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          project: context.project,
          workOrder: context.workOrder,
          task: context.task,
          sourceArtifact: context.sourceArtifact
            ? {
                filePath: context.sourceArtifact.filePath,
                displayName: context.sourceArtifact.displayName,
                content: context.sourceArtifact.content.slice(0, 12000),
              }
            : null,
          executionRunId: context.executionRunId,
          outputContract: {
            version: ORCHESTRATION_CONTRACT_VERSION,
            filePath: `work-orders/${context.workOrder.id}/${contract.fileName}`,
            displayName: `${context.workOrder.title} output`,
            language: contract.language,
            handoffChecklist: contract.handoffChecklist,
          },
        }),
      },
    ];
  }

  private agentInstruction(agentType: WorkOrderAgentType): string {
    switch (agentType) {
      case WorkOrderAgentType.FRONTEND:
        return [
          'Generate a focused React/Next.js component.',
          'The content string must include "export function" and render JSX containing a <section> or <div>.',
          'Use this shape: export function WorkOrderOutput() { return (<section><div>...</div></section>); }',
        ].join(' ');
      case WorkOrderAgentType.BACKEND:
        return 'Generate a focused NestJS-compatible TypeScript service or controller. Include @Injectable, export class, or a Controller contract.';
      case WorkOrderAgentType.DATABASE:
        return 'Generate SQL DDL with CREATE TABLE or ALTER TABLE statements and semicolon terminators.';
      case WorkOrderAgentType.ARCHITECTURE:
        return 'Generate markdown with # or ## sections, Objective, and Delivery Notes.';
      case WorkOrderAgentType.CONTRACT:
        return 'Generate markdown with Scope and Acceptance Checklist sections.';
      default:
        return 'Generate a concise implementation artifact that follows the output contract.';
    }
  }

  private parseOutput(content: string, model: string): GeneratedWorkOrderOutput {
    const jsonText = this.extractJson(content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      throw new Error(`OpenRouter ${model} returned invalid JSON: ${this.errorMessage(error)}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`OpenRouter ${model} response must be a JSON object.`);
    }

    const record = this.outputRecordFrom(parsed);
    const filePath = this.stringField(record, ['filePath', 'file_path', 'path']);
    const displayName = this.stringField(record, ['displayName', 'display_name', 'name', 'title'])
      ?? (filePath ? filePath.split('/').pop() : null);
    const language = this.stringField(record, ['language', 'lang'])
      ?? this.languageFromFilePath(filePath);
    const generatedContent = this.stringField(record, ['content', 'code', 'source', 'body']);

    if (!filePath || !displayName || !language || !generatedContent) {
      throw new Error(
        `OpenRouter ${model} response must include string filePath, displayName, language, and content fields.`,
      );
    }

    const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : {};

    return {
      filePath,
      displayName,
      language,
      content: generatedContent,
      metadata: metadata as Prisma.InputJsonObject,
    };
  }

  private outputRecordFrom(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('OpenRouter response must be a JSON object.');
    }

    const record = value as Record<string, unknown>;
    if (
      this.stringField(record, ['filePath', 'file_path', 'path']) ||
      this.stringField(record, ['content', 'code', 'source', 'body'])
    ) {
      return record;
    }

    for (const key of ['artifact', 'output', 'result', 'file', 'data']) {
      const nested = record[key];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return this.outputRecordFrom(nested);
      }
    }

    return record;
  }

  private stringField(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }

    return null;
  }

  private languageFromFilePath(filePath: string | null): string | null {
    if (!filePath) return null;
    if (filePath.endsWith('.sql')) return 'sql';
    if (filePath.endsWith('.md')) return 'markdown';
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts')) {
      return 'typescript';
    }

    return null;
  }

  private extractJson(content: string): string {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced?.[1]) return fenced[1].trim();

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1);
    }

    return trimmed;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
