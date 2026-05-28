import { WorkOrderAgentType, WorkOrderPriority } from '@prisma/client';

export type AgentProviderMode = 'mock' | 'llm';

export interface WorkOrderAgentContext {
  project: {
    id: string;
    companyName: string;
    brief: string;
    stackKey: string;
  };
  workOrder: {
    id: string;
    title: string;
    instructions: string | null;
    agentType: WorkOrderAgentType;
    priority: WorkOrderPriority;
  };
  task: {
    title: string;
    description: string | null;
  } | null;
  sourceArtifact: {
    filePath: string;
    displayName: string | null;
    content: string;
  } | null;
  executionRunId: string;
}

export interface GeneratedWorkOrderOutput {
  filePath: string;
  displayName: string;
  content: string;
  language: string;
}

export interface WorkOrderAgentProvider {
  readonly mode: AgentProviderMode;
  generateWorkOrderOutput(
    context: WorkOrderAgentContext,
  ): GeneratedWorkOrderOutput | Promise<GeneratedWorkOrderOutput>;
}
