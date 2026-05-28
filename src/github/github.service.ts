import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { GitHubArtifact } from './github.types';

export interface GithubDeliveryStatus {
  configured: boolean;
  available: boolean;
  owner: string | null;
  ownerSource: 'env' | 'installation' | null;
  missingRequirements: string[];
  reason: string | null;
}

const CI_WORKFLOW_CONTENT = `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build --if-present
      - name: Test
        run: npm test --if-present
`;

@Injectable()
export class GithubService implements OnModuleInit {
  private readonly logger = new Logger(GithubService.name);
  private octokit!: Octokit;
  private installationId!: number;
  private ownerLogin!: string;
  private ownerSource: GithubDeliveryStatus['ownerSource'] = null;
  private hasAppId = false;
  private hasPrivateKey = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const appId = this.configService.get<string>('github.appId');
    const privateKey = this.configService.get<string>('github.privateKey');
    this.hasAppId = Boolean(appId);
    this.hasPrivateKey = Boolean(privateKey);
    this.installationId = this.configService.get<number>(
      'github.installationId',
    ) ?? 0;
    this.ownerLogin = this.configService.get<string>('github.org') ?? '';
    this.ownerSource = this.ownerLogin ? 'env' : null;

    if (!appId || !privateKey || !this.installationId) {
      this.logger.warn(
        'GitHub App credentials are not configured; GitHub commit automation is disabled',
      );
      return;
    }

    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey,
        installationId: this.installationId,
      },
    });
  }

  getDeliveryStatus(): GithubDeliveryStatus {
    const missingRequirements = this.missingRequirements();
    const configured = missingRequirements.length === 0;
    return {
      configured,
      available: configured,
      owner: this.ownerLogin || null,
      ownerSource: this.ownerSource,
      missingRequirements,
      reason: configured
        ? null
        : `GitHub delivery requires ${missingRequirements.join(', ')}.`,
    };
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  buildRepoName(companyName: string, projectId: string): string {
    return `${this.slugify(companyName)}-${projectId}`;
  }

  private async getOwner(): Promise<string> {
    this.assertConfigured();
    if (this.ownerLogin) return this.ownerLogin;
    const { data } = await this.octokit.apps.getInstallation({
      installation_id: this.installationId,
    });
    this.ownerLogin =
      data.account && 'login' in data.account ? data.account.login : '';
    this.ownerSource = 'installation';
    return this.ownerLogin;
  }

  async createRepo(name: string): Promise<string> {
    this.assertConfigured();
    this.logger.log(`Creating repository: ${name}`);
    const owner = await this.getOwner();
    const { data } = await this.octokit.repos.createInOrg({
      org: owner,
      name,
      private: true,
      auto_init: true,
      description: `Scaffolded by DevFlow`,
    });
    this.logger.log(`Repository created: ${data.clone_url}`);
    return data.clone_url;
  }

  async commitFiles(
    repoName: string,
    artifacts: GitHubArtifact[],
    message: string,
  ): Promise<void> {
    this.assertConfigured();
    this.logger.log(
      `Committing ${artifacts.length} files to ${repoName}: "${message}"`,
    );
    const owner = await this.getOwner();

    const { data: refData } = await this.octokit.git.getRef({
      owner,
      repo: repoName,
      ref: 'heads/main',
    });
    const latestCommitSha = refData.object.sha;

    const { data: commitData } = await this.octokit.git.getCommit({
      owner,
      repo: repoName,
      commit_sha: latestCommitSha,
    });
    const baseTreeSha = commitData.tree.sha;

    const treeItems = await Promise.all(
      artifacts.map(async (artifact) => {
        const { data: blobData } = await this.octokit.git.createBlob({
          owner,
          repo: repoName,
          content: Buffer.from(artifact.content).toString('base64'),
          encoding: 'base64',
        });
        return {
          path: artifact.filePath,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blobData.sha,
        };
      }),
    );

    const { data: treeData } = await this.octokit.git.createTree({
      owner,
      repo: repoName,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    const { data: newCommit } = await this.octokit.git.createCommit({
      owner,
      repo: repoName,
      message,
      tree: treeData.sha,
      parents: [latestCommitSha],
    });

    await this.octokit.git.updateRef({
      owner,
      repo: repoName,
      ref: 'heads/main',
      sha: newCommit.sha,
    });

    this.logger.log(`Committed ${artifacts.length} files to ${repoName}`);
  }

  async injectCiWorkflow(repoName: string): Promise<void> {
    await this.commitFiles(
      repoName,
      [
        {
          filePath: '.github/workflows/ci.yml',
          content: CI_WORKFLOW_CONTENT,
        },
      ],
      'ci: add GitHub Actions workflow',
    );
  }

  private assertConfigured(): void {
    const missingRequirements = this.missingRequirements();
    if (missingRequirements.length > 0) {
      throw new ServiceUnavailableException(
        `GitHub commit automation is not configured: missing ${missingRequirements.join(', ')}`,
      );
    }
  }

  private missingRequirements(): string[] {
    const missing: string[] = [];
    if (!this.hasAppId) missing.push('GITHUB_APP_ID');
    if (!this.hasPrivateKey) missing.push('GITHUB_PRIVATE_KEY');
    if (!this.installationId) missing.push('GITHUB_INSTALLATION_ID');
    if (!this.ownerLogin) missing.push('GITHUB_ORG');
    return [...new Set(missing)];
  }
}
