import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CollaborationService } from './collaboration.service';
import {
  CreateCollaborationDocumentDto,
  CreateConversationDto,
  CreateMessageDto,
  ReviewCollaborationDocumentDto,
  UpdateCollaborationDocumentDto,
} from './dto/collaboration.dto';

@Controller('projects/:projectId')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class CollaborationController {
  constructor(private readonly collaborationService: CollaborationService) {}

  @Get('conversations')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  listConversations(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.collaborationService.listConversations(projectId, user);
  }

  @Post('conversations')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  createConversation(
    @Param('projectId') projectId: string,
    @Body() dto: CreateConversationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.collaborationService.createConversation(projectId, user, dto);
  }

  @Get('conversations/:conversationId/messages')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  listMessages(
    @Param('projectId') projectId: string,
    @Param('conversationId') conversationId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.collaborationService.listMessages(projectId, conversationId, user);
  }

  @Post('conversations/:conversationId/messages')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  addMessage(
    @Param('projectId') projectId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: CreateMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.collaborationService.addMessage(projectId, conversationId, user, dto);
  }

  @Patch('conversations/:conversationId/read')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  markConversationRead(
    @Param('projectId') projectId: string,
    @Param('conversationId') conversationId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.collaborationService.markConversationRead(projectId, conversationId, user);
  }

  @Get('documents')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  listDocuments(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.collaborationService.listDocuments(projectId, user);
  }

  @Post('documents')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.DEV, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  createDocument(
    @Param('projectId') projectId: string,
    @Body() dto: CreateCollaborationDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.collaborationService.createDocument(projectId, user, dto);
  }

  @Patch('documents/:documentId')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  updateDocument(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Body() dto: UpdateCollaborationDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.collaborationService.updateDocument(projectId, documentId, user, dto);
  }

  @Post('documents/:documentId/review')
  @Roles(UserRole.CLIENT, UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  reviewDocument(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Body() dto: ReviewCollaborationDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.collaborationService.reviewDocument(projectId, documentId, user, dto);
  }
}
