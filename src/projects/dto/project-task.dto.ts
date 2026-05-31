import { ProjectTaskStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateProjectTaskDto {
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(ProjectTaskStatus)
  status?: ProjectTaskStatus;

  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @IsOptional()
  @IsString()
  artifactId?: string;
}

export class UpdateProjectTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(ProjectTaskStatus)
  status?: ProjectTaskStatus;

  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @IsOptional()
  @IsString()
  artifactId?: string;
}
