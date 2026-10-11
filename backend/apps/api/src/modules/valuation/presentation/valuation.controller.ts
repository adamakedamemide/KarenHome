import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsIn, IsInt, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AccessTokenGuard } from '../../../common/auth/access-token.guard';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '@platform/contracts';
import { ValuationService } from '../application/valuation.service';

/**
 * Gate 5.1 Phase E — Valuation API.
 *
 * Exact-decimal money policy (repository-wide convention): every API decimal is
 * a STRING and validated with @IsNumberString — never a JS number, never a
 * float. The controller never converts amounts; values reach the numeric(20,4)
 * columns as the exact strings the client sent.
 */

export class CreateValuationCaseDto {
  @IsUUID() organizationId!: string;
  @IsUUID() propertyId!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) method?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) modelVersion?: string;
}

export class ListValuationCasesQuery {
  @IsOptional() @IsUUID() organizationId?: string | undefined;
  @IsOptional() @IsUUID() propertyId?: string | undefined;
  @IsOptional() @IsIn(['requested', 'processing', 'completed', 'failed', 'expired']) status?: string | undefined;
  @IsOptional() @IsInt() @Min(1) @Max(200) limit?: number;
}

export class ListPropertyValuationCasesQuery {
  @IsOptional() @IsUUID() organizationId?: string | undefined;
  @IsOptional() @IsInt() @Min(1) @Max(200) limit?: number;
}

export class UpdateValuationCaseDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) method?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) modelVersion?: string;
}

export class ValuationCaseStatusDto {
  @IsIn(['processing', 'completed', 'failed', 'expired']) toStatus!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** Meaningful only when completing/expiring (0040 G5); ISO-8601. */
  @IsOptional() @IsISO8601() expiresAt?: string;
}

export class RecordValuationResultDto {
  @IsNumberString() minValue!: string;
  @IsNumberString() estimatedValue!: string;
  @IsNumberString() maxValue!: string;
  @IsString() @Length(3) currencyCode!: string;
  /** 0..100 — exact decimal string (numeric(6,2) column). */
  @IsOptional() @IsNumberString() confidence?: string;
  /** >= 0 — exact decimal string (numeric(20,4) column). */
  @IsOptional() @IsNumberString() pricePerM2?: string;
}

export class ComparableItemDto {
  @IsUUID() comparablePropertyId!: string;
  @IsOptional() @IsUUID() comparableListingId?: string;
  /** 0..100 — exact decimal string (numeric(6,2) column). */
  @IsOptional() @IsNumberString() similarityScore?: string;
  /** >= 0 — exact decimal string (numeric(12,2) column). */
  @IsOptional() @IsNumberString() distanceM?: string;
  /** >= 0 — exact decimal string (numeric(20,4) column); same currency as the parent result. */
  @IsOptional() @IsNumberString() adjustedPrice?: string;
}

export class AddComparablesDto {
  @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ComparableItemDto)
  items!: ComparableItemDto[];
}

@Controller('valuation')
@UseGuards(AccessTokenGuard)
export class ValuationController {
  constructor(private readonly valuations: ValuationService) {}

  @Post('cases')
  async createCase(@Body() dto: CreateValuationCaseDto, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.valuations.createCase(dto, user) };
  }

  @Get('cases')
  async listCases(@Query() query: ListValuationCasesQuery, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.valuations.listCases(user, query) };
  }

  @Get('cases/:id')
  async getCase(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.valuations.getCase(id, user) };
  }

  @Put('cases/:id')
  async updateCase(@Param('id') id: string, @Body() dto: UpdateValuationCaseDto, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.valuations.updateCaseMeta(id, dto, user) };
  }

  @Post('cases/:id/status')
  async changeStatus(@Param('id') id: string, @Body() dto: ValuationCaseStatusDto, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.valuations.changeCaseStatus(id, dto.toStatus, user, { reason: dto.reason, expiresAt: dto.expiresAt }) };
  }

  @Put('cases/:id/result')
  async recordResult(@Param('id') id: string, @Body() dto: RecordValuationResultDto, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.valuations.recordResult(id, dto, user) };
  }

  @Post('cases/:id/comparables')
  async addComparables(@Param('id') id: string, @Body() dto: AddComparablesDto, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.valuations.addComparables(id, dto.items, user) };
  }

  @Get('properties/:propertyId/cases')
  async listPropertyHistory(@Param('propertyId') propertyId: string, @Query() query: ListPropertyValuationCasesQuery, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.valuations.listPropertyCaseHistory(propertyId, user, query) };
  }
}
