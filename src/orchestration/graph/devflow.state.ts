import { Annotation } from '@langchain/langgraph';

// ─── Domain Types ─────────────────────────────────────────────────────────────

export interface TechStack {
  frontend: string;
  backend: string;
  database: string;
  styling: string;
}

export interface RequirementsDocument {
  projectType: string;
  features: string[];
  techStack: TechStack;
  complexity: 'simple' | 'medium' | 'complex';
  estimatedFiles: number;
}

export interface ProjectContract {
  projectId: string;
  projectName: string;
  description: string;
  requirements: RequirementsDocument;
  fileManifest: string[];
  acceptanceCriteria: string[];
  lockedAt: string;
}

export interface GeneratedArtifact {
  agentType: 'frontend' | 'backend' | 'database' | 'architecture';
  filePath: string;
  content: string;
  language: string;
}

// ─── LangGraph State Annotation ───────────────────────────────────────────────

export const DevFlowState = Annotation.Root({
  projectId: Annotation<string>(),
  runId: Annotation<string>(),
  brief: Annotation<string>(),
  stackKey: Annotation<string>(),
  companyName: Annotation<string>(),

  requirements: Annotation<RequirementsDocument | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),

  contract: Annotation<ProjectContract | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),

  artifacts: Annotation<GeneratedArtifact[]>({
    default: () => [],
    reducer: (existing, next) => [...existing, ...next],
  }),

  gate1Approved: Annotation<boolean>({
    default: () => false,
    reducer: (_, next) => next,
  }),

  gate2Approved: Annotation<boolean>({
    default: () => false,
    reducer: (_, next) => next,
  }),

  gate1Notes: Annotation<string>({
    default: () => '',
    reducer: (_, next) => next,
  }),

  gate2Notes: Annotation<string>({
    default: () => '',
    reducer: (_, next) => next,
  }),

  retryCount: Annotation<number>({
    default: () => 0,
    reducer: (_, next) => next,
  }),

  repoUrl: Annotation<string | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),

  /**
   * Top-level complexity derived from the parsed requirements.
   * Set by RequirementsParserNode after parsing. Drives the Phase 2D
   * conditional fan-out: 'complex' → parallel code generation via Send(),
   * 'simple' | 'medium' → sequential execution.
   */
  complexity: Annotation<'simple' | 'medium' | 'complex' | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),

  error: Annotation<string | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),
});

export type DevFlowStateType = typeof DevFlowState.State;
