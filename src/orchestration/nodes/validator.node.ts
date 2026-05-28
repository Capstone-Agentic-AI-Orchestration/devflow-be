import { Injectable, Logger } from '@nestjs/common';
import { DevFlowStateType } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';

// ─── Validation Result ────────────────────────────────────────────────────────

interface ValidationResult {
  valid: boolean;
  missingFiles: string[];
  syntaxIssues: string[];
  schemaIssues: string[];
  failingAgent: 'frontend' | 'backend' | 'database' | 'architecture' | null;
}

// ─── Node ─────────────────────────────────────────────────────────────────────

@Injectable()
export class ValidatorNode {
  private readonly logger = new Logger(ValidatorNode.name);
  private static readonly MAX_RETRIES = 3;

  constructor(private readonly memory: MemoryService) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    this.logger.log(
      `[${state.projectId}] Validating outputs (attempt ${state.retryCount + 1}/${ValidatorNode.MAX_RETRIES})`,
    );

    if (!state.contract) {
      return { error: 'ValidatorNode: contract is null' };
    }

    try {
      const result = this.validate(state);

      if (result.valid) {
        this.logger.log(`[${state.projectId}] Validation passed`);
        return {};
      }

      this.logger.warn(
        `[${state.projectId}] Validation failed: missing=${result.missingFiles.length}, syntax=${result.syntaxIssues.length}, schema=${result.schemaIssues.length}`,
      );

      // ── Write validation errors as MISTAKE memories for each affected agent ─
      // These records teach future runs which patterns led to validator failures,
      // reducing the likelihood of the same structural errors recurring.
      const validationIssueText = [
        ...result.missingFiles.map((f) => `MISSING FILE: ${f}`),
        ...result.syntaxIssues.map((s) => `SYNTAX: ${s}`),
        ...result.schemaIssues.map((s) => `SCHEMA: ${s}`),
      ].join('\n');

      // Determine which agent types were implicated in the failure
      const impliedAgents: Set<string> = new Set();
      if (result.failingAgent) {
        impliedAgents.add(result.failingAgent);
      }
      // Additional cross-agent attribution based on file types
      if (result.syntaxIssues.length > 0) impliedAgents.add('backend');
      if (result.schemaIssues.length > 0) impliedAgents.add('database');

      const stackKey = state.stackKey ?? 'unknown';
      await Promise.allSettled(
        Array.from(impliedAgents).map((agentType) =>
          this.memory.writeMistake({
            agentType,
            rejectedContent: validationIssueText,
            rejectionNotes: `Validator rejected output at retry ${state.retryCount}: ${validationIssueText.slice(0, 300)}`,
            projectId: state.projectId,
            gateType: 'GATE_2',
            stackKey,
          }),
        ),
      );

      if (state.retryCount < ValidatorNode.MAX_RETRIES - 1) {
        const nextRetry = state.retryCount + 1;
        this.logger.log(
          `[${state.projectId}] Scheduling retry ${nextRetry} for agent: ${result.failingAgent ?? 'unknown'}`,
        );
        // Use RETRY: prefix so the graph router can distinguish from a terminal error
        return {
          retryCount: nextRetry,
          error: `RETRY:${result.failingAgent ?? 'frontend'}`,
        };
      }

      // Max retries reached — surface as a warning and continue to gate 2
      this.logger.warn(
        `[${state.projectId}] Max retries reached, proceeding with partial validation`,
      );
      return {
        error: `Validation exceeded max retries. Issues: ${[
          ...result.missingFiles.map((f) => `missing:${f}`),
          ...result.syntaxIssues,
          ...result.schemaIssues,
        ].join('; ')}`,
        retryCount: state.retryCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Validator failed: ${message}`);
      return { error: `ValidatorNode failed: ${message}` };
    }
  }

  private validate(state: DevFlowStateType): ValidationResult {
    if (process.env.MOCK_MODE === 'true') {
      return {
        valid: true,
        missingFiles: [],
        syntaxIssues: [],
        schemaIssues: [],
        failingAgent: null
      };
    }

    const contract = state.contract!;
    const generatedPaths = new Set(state.artifacts.map((a) => a.filePath));

    // Check 1: All manifest files present
    const missingFiles = contract.fileManifest.filter(
      (f) => !generatedPaths.has(f),
    );

    // Check 2: Basic TypeScript syntax issues (regex-based, no tsc)
    const syntaxIssues: string[] = [];
    const tsArtifacts = state.artifacts.filter((a) =>
      a.filePath.endsWith('.ts') || a.filePath.endsWith('.tsx'),
    );
    for (const artifact of tsArtifacts) {
      const issues = this.checkBasicTsSyntax(artifact.filePath, artifact.content);
      syntaxIssues.push(...issues);
    }

    // Check 3: Prisma schema conflicts
    const schemaIssues: string[] = [];
    const prismaArtifact = state.artifacts.find((a) =>
      a.filePath.endsWith('.prisma'),
    );
    if (prismaArtifact) {
      schemaIssues.push(...this.checkPrismaSchema(prismaArtifact.content));
    }

    const valid =
      missingFiles.length === 0 &&
      syntaxIssues.length === 0 &&
      schemaIssues.length === 0;

    // Identify which agent is responsible for failures
    let failingAgent: ValidationResult['failingAgent'] = null;
    if (!valid) {
      if (missingFiles.some((f) => /\.(tsx|jsx|css)$/.test(f))) {
        failingAgent = 'frontend';
      } else if (missingFiles.some((f) => /\.(module|controller|service)\.ts$/.test(f))) {
        failingAgent = 'backend';
      } else if (missingFiles.some((f) => /\.(prisma|sql)$/.test(f)) || schemaIssues.length > 0) {
        failingAgent = 'database';
      } else if (missingFiles.some((f) => /\.(md)$/.test(f))) {
        failingAgent = 'architecture';
      } else if (syntaxIssues.length > 0) {
        failingAgent = 'backend';
      }
    }

    return { valid, missingFiles, syntaxIssues, schemaIssues, failingAgent };
  }

  private checkBasicTsSyntax(filePath: string, content: string): string[] {
    const issues: string[] = [];

    // Unclosed braces check (rough heuristic)
    const openBraces = (content.match(/\{/g) ?? []).length;
    const closeBraces = (content.match(/\}/g) ?? []).length;
    if (Math.abs(openBraces - closeBraces) > 3) {
      issues.push(`${filePath}: unbalanced braces (open=${openBraces}, close=${closeBraces})`);
    }

    // Missing imports for common NestJS decorators
    if (
      content.includes('@Injectable()') &&
      !content.includes("from '@nestjs/common'")
    ) {
      issues.push(`${filePath}: @Injectable used without @nestjs/common import`);
    }

    // Unclosed template literals
    const backtickCount = (content.match(/`/g) ?? []).length;
    if (backtickCount % 2 !== 0) {
      issues.push(`${filePath}: odd number of backticks — possible unclosed template literal`);
    }

    return issues;
  }

  private checkPrismaSchema(content: string): string[] {
    const issues: string[] = [];

    // Check for duplicate model names
    const modelMatches = content.match(/^model\s+(\w+)/gm) ?? [];
    const modelNames = modelMatches.map((m) => m.replace(/^model\s+/, ''));
    const duplicates = modelNames.filter(
      (name, idx) => modelNames.indexOf(name) !== idx,
    );
    if (duplicates.length > 0) {
      issues.push(`Duplicate Prisma model names: ${duplicates.join(', ')}`);
    }

    // Check for missing @id fields
    const modelBlocks = content.split(/^model\s+/m).slice(1);
    for (const block of modelBlocks) {
      if (!/@id/.test(block.split('}')[0] ?? '')) {
        const name = block.split(/\s/)[0];
        issues.push(`Prisma model "${name}" may be missing @id field`);
      }
    }

    return issues;
  }
}
