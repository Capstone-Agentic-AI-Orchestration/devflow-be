import { Injectable } from '@nestjs/common';
import { WorkOrderAgentType } from '@prisma/client';
import {
  GeneratedWorkOrderOutput,
  WorkOrderAgentContext,
  WorkOrderAgentProvider,
} from './agent-provider.types';

@Injectable()
export class MockAgentProvider implements WorkOrderAgentProvider {
  readonly mode = 'mock' as const;

  generateWorkOrderOutput(
    context: WorkOrderAgentContext,
  ): GeneratedWorkOrderOutput {
    const path = this.filePathFor(context);
    return {
      filePath: path.filePath,
      displayName: `${context.workOrder.title} output`,
      language: path.language,
      content: this.contentFor(context),
    };
  }

  private filePathFor(context: WorkOrderAgentContext): {
    filePath: string;
    language: string;
  } {
    const base = `work-orders/${context.workOrder.id}`;
    switch (context.workOrder.agentType) {
      case WorkOrderAgentType.FRONTEND:
        return { filePath: `${base}/frontend-output.tsx`, language: 'typescript' };
      case WorkOrderAgentType.BACKEND:
        return { filePath: `${base}/backend-output.ts`, language: 'typescript' };
      case WorkOrderAgentType.DATABASE:
        return { filePath: `${base}/database-output.sql`, language: 'sql' };
      case WorkOrderAgentType.ARCHITECTURE:
        return { filePath: `${base}/architecture-output.md`, language: 'markdown' };
      case WorkOrderAgentType.CONTRACT:
        return { filePath: `${base}/contract-output.md`, language: 'markdown' };
      default:
        return { filePath: `${base}/agent-output.md`, language: 'markdown' };
    }
  }

  private contentFor(context: WorkOrderAgentContext): string {
    switch (context.workOrder.agentType) {
      case WorkOrderAgentType.FRONTEND:
        return this.frontendContent(context);
      case WorkOrderAgentType.BACKEND:
        return this.backendContent(context);
      case WorkOrderAgentType.DATABASE:
        return this.databaseContent(context);
      case WorkOrderAgentType.ARCHITECTURE:
        return this.architectureContent(context);
      case WorkOrderAgentType.CONTRACT:
        return this.contractContent(context);
      default:
        return this.markdownContent(context);
    }
  }

  private frontendContent(context: WorkOrderAgentContext): string {
    const componentName = this.componentName(context.workOrder.title);
    return [
      "import React from 'react';",
      '',
      `export function ${componentName}() {`,
      '  return (',
      '    <section>',
      `      <h1>${this.escapeText(context.workOrder.title)}</h1>`,
      `      <p>${this.escapeText(context.workOrder.instructions ?? 'Generated frontend work order output.')}</p>`,
      '    </section>',
      '  );',
      '}',
      '',
      `export default ${componentName};`,
      '',
    ].join('\n');
  }

  private backendContent(context: WorkOrderAgentContext): string {
    const className = `${this.componentName(context.workOrder.title)}Service`;
    return [
      "import { Injectable } from '@nestjs/common';",
      '',
      '@Injectable()',
      `export class ${className} {`,
      '  describeWorkOrder() {',
      '    return {',
      `      projectId: ${JSON.stringify(context.project.id)},`,
      `      workOrderId: ${JSON.stringify(context.workOrder.id)},`,
      `      title: ${JSON.stringify(context.workOrder.title)},`,
      `      instructions: ${JSON.stringify(context.workOrder.instructions ?? '')},`,
      '    };',
      '  }',
      '}',
      '',
    ].join('\n');
  }

  private databaseContent(context: WorkOrderAgentContext): string {
    const tableName = this.sqlIdentifier(context.workOrder.title);
    return [
      `-- Mock database migration draft for ${context.project.companyName}`,
      `-- Work order: ${context.workOrder.title}`,
      `-- Instructions: ${context.workOrder.instructions ?? 'No explicit instructions provided.'}`,
      '',
      `CREATE TABLE IF NOT EXISTS ${tableName} (`,
      '  id text PRIMARY KEY,',
      '  project_id text NOT NULL,',
      '  status text NOT NULL DEFAULT \'PENDING\',',
      '  metadata jsonb NOT NULL DEFAULT \'{}\'::jsonb,',
      '  created_at timestamptz NOT NULL DEFAULT now(),',
      '  updated_at timestamptz NOT NULL DEFAULT now()',
      ');',
      '',
      `CREATE INDEX IF NOT EXISTS ${tableName}_project_id_idx ON ${tableName} (project_id);`,
      '',
    ].join('\n');
  }

  private architectureContent(context: WorkOrderAgentContext): string {
    return [
      `# ${context.workOrder.title}`,
      '',
      `Project: ${context.project.companyName}`,
      `Stack: ${context.project.stackKey}`,
      `Execution run: ${context.executionRunId}`,
      '',
      '## Objective',
      context.workOrder.instructions ?? 'Define the architecture output for this work order.',
      '',
      '## Delivery Notes',
      '- Keep PM review before publishing client-visible output.',
      '- Persist generated artifacts and timeline events in DevFlow.',
      '- Treat deployment automation as a separate approved phase.',
      '',
      this.sourceContext(context),
    ].join('\n');
  }

  private contractContent(context: WorkOrderAgentContext): string {
    return [
      `# Delivery Contract: ${context.workOrder.title}`,
      '',
      `Company: ${context.project.companyName}`,
      `Priority: ${context.workOrder.priority}`,
      '',
      '## Scope',
      context.workOrder.instructions ?? 'No explicit scope provided.',
      '',
      '## Acceptance Checklist',
      '- Output is saved as a DevFlow artifact.',
      '- PM reviews before client publication.',
      '- Rework creates a follow-up work order with revision notes.',
      '',
    ].join('\n');
  }

  private markdownContent(context: WorkOrderAgentContext): string {
    return [
      `# ${context.workOrder.title}`,
      '',
      `Execution run: ${context.executionRunId}`,
      `Work order: ${context.workOrder.id}`,
      `Agent: ${context.workOrder.agentType}`,
      '',
      '## Instructions',
      context.workOrder.instructions ?? 'No explicit instructions were provided.',
      '',
      this.sourceContext(context),
    ].join('\n');
  }

  private sourceContext(context: WorkOrderAgentContext): string {
    const lines = [];
    if (context.task) {
      lines.push('## Linked Task', context.task.title);
      if (context.task.description) lines.push('', context.task.description);
    }
    if (context.sourceArtifact) {
      lines.push(
        '## Source Artifact',
        context.sourceArtifact.displayName ?? context.sourceArtifact.filePath,
        '',
        '```',
        context.sourceArtifact.content,
        '```',
      );
    }
    return lines.join('\n');
  }

  private componentName(value: string): string {
    const normalized = value
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
    return normalized ? `${normalized}Output` : 'WorkOrderOutput';
  }

  private sqlIdentifier(value: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return normalized ? `mock_${normalized}` : 'mock_work_order_output';
  }

  private escapeText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
