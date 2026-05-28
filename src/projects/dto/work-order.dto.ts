import { WorkOrderAgentType, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateWorkOrderDto {
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  title!: string;

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsEnum(WorkOrderAgentType)
  agentType!: WorkOrderAgentType;

  @IsOptional()
  @IsEnum(WorkOrderPriority)
  priority?: WorkOrderPriority;

  @IsOptional()
  @IsString()
  taskId?: string;

  @IsOptional()
  @IsString()
  artifactId?: string;
}

export class UpdateWorkOrderDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  title?: string;

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsOptional()
  @IsEnum(WorkOrderAgentType)
  agentType?: WorkOrderAgentType;

  @IsOptional()
  @IsEnum(WorkOrderPriority)
  priority?: WorkOrderPriority;

  @IsOptional()
  @IsEnum(WorkOrderStatus)
  status?: WorkOrderStatus;

  @IsOptional()
  @IsString()
  taskId?: string;

  @IsOptional()
  @IsString()
  artifactId?: string;
}
