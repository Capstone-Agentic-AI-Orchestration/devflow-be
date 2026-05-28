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

    const output = this.parseOutput(content, model);
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
          `filePath must start with work-orders/${context.workOrder.id}/`,
          `filePath must end with one of: ${contract.requiredExtensions.join(', ')}`,
          `language must be ${contract.language}.`,
          `The content must satisfy these checks: ${contract.requiredSignals.map((signal) => signal.message).join('; ')}.`,
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
        return 'Generate a focused React/Next.js component. Include an exported component and renderable JSX.';
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

    const record = parsed as Record<string, unknown>;
    if (
      typeof record.filePath !== 'string' ||
      typeof record.displayName !== 'string' ||
      typeof record.language !== 'string' ||
      typeof record.content !== 'string'
    ) {
      throw new Error(
        `OpenRouter ${model} response must include string filePath, displayName, language, and content fields.`,
      );
    }

    const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : {};

    return {
      filePath: record.filePath,
      displayName: record.displayName,
      language: record.language,
      content: record.content,
      metadata: metadata as Prisma.InputJsonObject,
    };
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
