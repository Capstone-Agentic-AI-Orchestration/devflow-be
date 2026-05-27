import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { ApproveGateDto } from './dto/approve-gate.dto';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  create(@Body() dto: CreateProjectDto) {
    return this.projectsService.create(dto);
  }

  @Get()
  findAll() {
    return this.projectsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.projectsService.findOne(id);
  }

  @Get(':id/artifacts')
  findArtifacts(@Param('id') id: string) {
    return this.projectsService.findArtifacts(id);
  }

  @Post(':id/gates/architecture')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  approveGate1(@Param('id') id: string, @Body() dto: ApproveGateDto) {
    return this.projectsService.approveGate1(id, dto.approved, dto.notes);
  }

  @Post(':id/gates/code')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  approveGate2(@Param('id') id: string, @Body() dto: ApproveGateDto) {
    return this.projectsService.approveGate2(id, dto.approved, dto.notes);
  }

  @Get(':id/status')
  getStatus(@Param('id') id: string) {
    return this.projectsService.getStatus(id);
  }
}
