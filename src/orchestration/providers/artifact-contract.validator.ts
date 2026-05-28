import { Injectable } from '@nestjs/common';
import { WorkOrderAgentType } from '@prisma/client';
import { GeneratedWorkOrderOutput, WorkOrderAgentContext } from './agent-provider.types';

export interface ArtifactContractValidationResult {
  valid: boolean;
  summary: string;
  errors: string[];
}

@Injectable()
export class ArtifactContractValidator {
  validate(
    output: GeneratedWorkOrderOutput,
    context: WorkOrderAgentContext,
  ): ArtifactContractValidationResult {
    const errors = [
      ...this.validateBase(output, context),
      ...this.validateByAgent(output, context.workOrder.agentType),
    ];

    return {
      valid: errors.length === 0,
      summary: errors.length === 0
        ? `${context.workOrder.agentType} artifact contract passed`
        : `${context.workOrder.agentType} artifact contract failed`,
      errors,
    };
  }

  private validateBase(
    output: GeneratedWorkOrderOutput,
    context: WorkOrderAgentContext,
  ): string[] {
    const errors: string[] = [];
    const expectedPrefix = `work-orders/${context.workOrder.id}/`;

    if (!output.filePath?.trim()) {
      errors.push('filePath is required');
    } else if (!output.filePath.startsWith(expectedPrefix)) {
      errors.push(`filePath must start with ${expectedPrefix}`);
    }

    if (!output.displayName?.trim()) {
      errors.push('displayName is required');
    }

    if (!output.content?.trim() || output.content.trim().length < 40) {
      errors.push('content must be at least 40 non-empty characters');
    }

    return errors;
  }

  private validateByAgent(
    output: GeneratedWorkOrderOutput,
    agentType: WorkOrderAgentType,
  ): string[] {
    switch (agentType) {
      case WorkOrderAgentType.FRONTEND:
        return [
          ...this.expectExtension(output.filePath, ['.tsx', '.jsx']),
          ...this.expectAny(output.content, ['export function', 'export default'], 'frontend output must export a component'),
          ...this.expectAny(output.content, ['<section', '<div', 'React'], 'frontend output must contain renderable UI'),
        ];
      case WorkOrderAgentType.BACKEND:
        return [
          ...this.expectExtension(output.filePath, ['.ts']),
          ...this.expectAny(output.content, ['export class', 'export function'], 'backend output must export a service or function'),
          ...this.expectAny(output.content, ['@Injectable', 'describeWorkOrder', 'Controller'], 'backend output must include a NestJS-compatible contract signal'),
        ];
      case WorkOrderAgentType.DATABASE:
        return [
          ...this.expectExtension(output.filePath, ['.sql']),
          ...this.expectAny(output.content, ['CREATE TABLE', 'ALTER TABLE'], 'database output must include DDL'),
          ...this.expectAny(output.content, [';'], 'database output must include SQL statement terminators'),
        ];
      case WorkOrderAgentType.ARCHITECTURE:
        return [
          ...this.expectExtension(output.filePath, ['.md']),
          ...this.expectAny(output.content, ['# ', '## Objective'], 'architecture output must be markdown with sections'),
          ...this.expectAny(output.content, ['Delivery Notes', 'Objective'], 'architecture output must include delivery guidance'),
        ];
      case WorkOrderAgentType.CONTRACT:
        return [
          ...this.expectExtension(output.filePath, ['.md']),
          ...this.expectAny(output.content, ['Acceptance Checklist', 'Acceptance'], 'contract output must include acceptance criteria'),
          ...this.expectAny(output.content, ['Scope', 'Delivery Contract'], 'contract output must include scope'),
        ];
      default:
        return [];
    }
  }

  private expectExtension(filePath: string, extensions: string[]): string[] {
    const lower = filePath.toLowerCase();
    return extensions.some((extension) => lower.endsWith(extension))
      ? []
      : [`filePath must end with ${extensions.join(' or ')}`];
  }

  private expectAny(content: string, needles: string[], message: string): string[] {
    return needles.some((needle) => content.includes(needle)) ? [] : [message];
  }
}
