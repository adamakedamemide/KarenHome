import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsIn, IsInt, IsNumberString, IsObject, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AccessTokenGuard } from '../../../common/auth/access-token.guard';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '@platform/contracts';
import { RentalService } from '../application/rental.service';

/**
 * Gate P — Rental API (Milestone 1: lease foundation).
 *
 * Exact-decimal money policy (repository-wide convention): every API decimal is
 * a STRING and validated with @IsNumberString — never a JS number, never a
 * float. The controller never converts amounts; values reach the numeric(20,4)
 * columns as the exact strings the client sent. Date columns are validated as
 * exact 'YYYY-MM-DD' strings (the frozen `date` columns; no timezone drift).
 */

const LEASE_STATUS_VALUES = ['draft', 'pending_signature', 'active', 'expired', 'terminated', 'cancelled'] as const;

export class CreateLeaseDto {
  @IsUUID() organizationId!: string;
  @IsUUID() propertyId!: string;
  /** Exactly one of tenantUserId / tenantOrganizationId (frozen XOR CHECK). */
  @IsOptional() @IsUUID() tenantUserId?: string;
  @IsOptional() @IsUUID() tenantOrganizationId?: string;
  @IsString() @Length(3) currencyCode!: string;
  /** >= 0 — exact decimal string (numeric(20,4) column). */
  @IsNumberString() monthlyRent!: string;
  /** >= 0 — exact decimal string (numeric(20,4) column). */
  @IsOptional() @IsNumberString() depositAmount?: string;
  /** Exact 'YYYY-MM-DD' (frozen date column). */
  @IsString() @Length(10, 10) startDate!: string;
  /** Exact 'YYYY-MM-DD' (frozen date column); must be after startDate. */
  @IsString() @Length(10, 10) endDate!: string;
  @IsOptional() @IsBoolean() autoRenew?: boolean;
  @IsOptional() @IsUUID() sourceListingId?: string;
  @IsOptional() @IsUUID() contractId?: string;
  @IsOptional() @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LeasePartyInputDto)
  parties?: LeasePartyInputDto[];
}

export class LeasePartyInputDto {
  /** Free-text role per the frozen schema (canonical landlord/tenant bindings live on the lease row). */
  @IsString() @MinLength(1) @MaxLength(50) role!: string;
  /** Exactly one of userId / organizationId (frozen XOR CHECK). */
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() organizationId?: string;
  @IsString() @MinLength(1) @MaxLength(200) nameSnapshot!: string;
  @IsOptional() @IsObject() contactSnapshot?: Record<string, unknown>;
}

export class ListLeasesQuery {
  @IsOptional() @IsUUID() organizationId?: string | undefined;
  @IsOptional() @IsUUID() propertyId?: string | undefined;
  @IsOptional() @IsIn(LEASE_STATUS_VALUES) status?: string | undefined;
  @IsOptional() @IsInt() @Min(1) @Max(200) limit?: number;
}

export class UpdateLeaseDto {
  @IsOptional() @IsNumberString() monthlyRent?: string;
  /** Send null to clear the deposit (frozen nullable column). */
  @IsOptional() @IsNumberString() depositAmount?: string | null;
  @IsOptional() @IsString() @Length(10, 10) startDate?: string;
  @IsOptional() @IsString() @Length(10, 10) endDate?: string;
  @IsOptional() @IsBoolean() autoRenew?: boolean;
  @IsOptional() @IsUUID() sourceListingId?: string | null;
  @IsOptional() @IsUUID() contractId?: string | null;
}

export class LeaseStatusDto {
  @IsIn(['pending_signature', 'active', 'expired', 'terminated', 'cancelled']) toStatus!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class AddLeasePartiesDto {
  @ArrayMinSize(1) @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LeasePartyInputDto)
  items!: LeasePartyInputDto[];
}

export class RentScheduleItemDto {
  /** Exact 'YYYY-MM-DD' (frozen date column); unique per lease. */
  @IsString() @Length(10, 10) dueDate!: string;
  /** >= 0 — exact decimal string (numeric(20,4) column); lease currency. */
  @IsNumberString() amount!: string;
  /** Must equal the lease currency (exact consistency, no conversion). */
  @IsString() @Length(3) currencyCode!: string;
}

export class AddRentSchedulesDto {
  @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RentScheduleItemDto)
  items!: RentScheduleItemDto[];
}

@Controller('rental')
@UseGuards(AccessTokenGuard)
export class RentalController {
  constructor(private readonly rental: RentalService) {}

  @Post('leases')
  async createLease(@Body() dto: CreateLeaseDto, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.rental.createLease(dto, user) };
  }

  @Get('leases')
  async listLeases(@Query() query: ListLeasesQuery, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.rental.listLeases(user, query) };
  }

  @Get('leases/:id')
  async getLease(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.rental.getLease(id, user) };
  }

  @Put('leases/:id')
  async updateLease(@Param('id') id: string, @Body() dto: UpdateLeaseDto, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.rental.updateLease(id, dto, user) };
  }

  @Post('leases/:id/status')
  async changeStatus(@Param('id') id: string, @Body() dto: LeaseStatusDto, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.rental.changeLeaseStatus(id, dto.toStatus, user, { reason: dto.reason }) };
  }

  @Get('leases/:id/parties')
  async listParties(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.rental.listParties(id, user) };
  }

  @Post('leases/:id/parties')
  async addParties(@Param('id') id: string, @Body() dto: AddLeasePartiesDto, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.rental.addParties(id, dto.items, user) };
  }

  @Get('leases/:id/schedules')
  async listSchedules(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.rental.listSchedules(id, user) };
  }

  @Post('leases/:id/schedules')
  async addSchedules(@Param('id') id: string, @Body() dto: AddRentSchedulesDto, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.rental.addSchedules(id, dto.items, user) };
  }

  @Delete('leases/:id/schedules/:scheduleId')
  async removeSchedule(@Param('id') id: string, @Param('scheduleId') scheduleId: string, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.rental.removeSchedule(id, scheduleId, user) };
  }
}
