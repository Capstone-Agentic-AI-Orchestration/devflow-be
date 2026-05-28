import { IsOptional, IsString } from 'class-validator';

export class ProjectDeliveryReviewNoteDto {
  @IsOptional()
  @IsString()
  note?: string;
}
