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

@Injectable()
export class LlmAgentProvider implements WorkOrderAgentProvider {
  readonly mode = 'llm' as const;

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

  missingRequirements(): string[] {
    if (this.providerName() !== 'openrouter') {
      return ['LLM_PROVIDER=openrouter'];
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
    return `OpenRouter provider requires ${missing.join(' and ')}.`;
  }

  async generateWorkOrderOutput(
    context: WorkOrderAgentContext,
  ): Promise<GeneratedWorkOrderOutput> {
    const missing = this.missingRequirements();
    if (missing.length > 0) {
      throw new Error(`OpenRouter provider is unavailable: missing ${missing.join(', ')}`);
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
        messages: this.messagesFor(context),
        temperature: 0.2,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      }),
    });

    const payload = await response.json().catch(() => null) as OpenRouterChatResponse | null;
    if (!response.ok) {
      const detail = payload?.error?.message || response.statusText;
      const fallbackNote = primaryError
        ? ` Fallback after primary failure: ${this.errorMessage(primaryError)}.`
        : '';
      throw new Error(`OpenRouter ${model} request failed (${response.status}): ${detail}.${fallbackNote}`);
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (!content?.trim()) {
      throw new Error(`OpenRouter ${model} returned an empty response.`);
    }

    const output = await this.parseOutputOrRepair(content, model, context);
    return {
      ...output,
      metadata: {
        ...(output.metadata ?? {}),
        providerMode: this.mode,
        provider: 'openrouter',
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
        ],
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      }),
    });

    const payload = await response.json().catch(() => null) as OpenRouterChatResponse | null;
    if (!response.ok) {
      const detail = payload?.error?.message || response.statusText;
      throw new Error(
        `OpenRouter ${model} repair request failed (${response.status}): ${detail}. Original output error: ${this.errorMessage(originalError)}`,
      );
    }

    const repairedContent = payload?.choices?.[0]?.message?.content;
    if (!repairedContent?.trim()) {
      throw new Error(
        `OpenRouter ${model} repair returned an empty response. Original output error: ${this.errorMessage(originalError)}`,
      );
    }

    try {
      return this.parseOutput(repairedContent, model);
    } catch (repairError) {
      throw new Error(
        `OpenRouter ${model} repair returned invalid artifact JSON: ${this.errorMessage(repairError)}. Original output error: ${this.errorMessage(originalError)}`,
      );
    }
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
