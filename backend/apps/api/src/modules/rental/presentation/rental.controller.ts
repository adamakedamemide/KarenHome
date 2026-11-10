import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsIn, IsInt, IsISO8601, IsNumberString, IsObject, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
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

/**
 * Milestone 2 — record an already-confirmed rent receipt.
 *
 * Amount policy (Review Fix 1): the DTO deliberately carries @IsString, NOT
 * @IsNumberString — the exact numeric(20,4) contract (shape, scale ≤ 4,
 * range ≤ 16 integer digits, positivity, deterministic leading-zero handling)
 * is owned by ONE authoritative layer: RentalService.assertPositiveDecimalString.
 * A value that would require rounding is rejected with an explicit client
 * domain error before anything is written — never rounded or truncated.
 */
export class RecordRentPaymentDto {
  /** Exact decimal string, strictly positive, ≤ 4 fractional digits, ≤ 16 integer digits. */
  @ApiProperty({
    type: 'string',
    minLength: 1,
    maxLength: 64,
    description:
      'Exact positive decimal amount as a STRING (never a JSON number). Exact numeric(20,4) contract: ' +
      '1-64 characters, digits with an optional fractional part — no sign, exponent, grouping separators or whitespace; ' +
      'at most 16 integer digits (harmless leading zeros are stripped deterministically) and at most 4 fractional digits ' +
      '(maximum representable value 9999999999999999.9999). A value that would require rounding when persisted ' +
      '(more than 4 fractional digits) or exceeds the range is rejected with 422 RENT_PAYMENT_AMOUNT_INVALID ' +
      'BEFORE anything is written — never rounded, truncated or capped. The same canonical exact value flows into ' +
      'persistence, the overpayment comparison, reconciliation totals, audit and event payloads.',
    example: '1250.0000',
  })
  @IsString() @Length(1, 64) amount!: string;
  /** Must equal the schedule currency (exact consistency, no conversion). */
  @ApiProperty({
    type: 'string',
    minLength: 3,
    maxLength: 3,
    description:
      'Exactly 3 characters. Must equal the rent schedule\'s currency — no FX conversion is performed ' +
      '(the frozen trg_rent_payment_currency trigger stays the DB authority). ' +
      'Mismatch → 422 RENT_PAYMENT_CURRENCY_MISMATCH.',
    example: 'EUR',
  })
  @IsString() @Length(3, 3) currencyCode!: string;
  /**
   * Optional reference to a billing.payments row. Review Fix 2: the frozen
   * billing schema establishes no rent-specific link between billing orders
   * and rental leases, so rent-payment intent cannot be verified — the
   * external path fails closed with RENT_PAYMENT_EXTERNAL_PROVENANCE_UNVERIFIABLE
   * (see the service provenance chain). Omit it to record a confirmed receipt
   * manually — the supported model.
   */
  @ApiPropertyOptional({
    type: 'string',
    format: 'uuid',
    description:
      'Optional UUID of a billing.payments row. NOT a supported recording path in the current implementation: ' +
      'the frozen billing schema establishes no rent-specific link between billing orders and rental leases, ' +
      'so rent-payment intent cannot be verified from repository evidence. A request carrying this field runs the ' +
      'provenance chain (payment exists → status succeeded → currency equal → amount exactly equal → order paid → ' +
      'order owned by the lease tenant) and then ALWAYS fails closed with ' +
      '422 RENT_PAYMENT_EXTERNAL_PROVENANCE_UNVERIFIABLE. Omit this field to record an already-confirmed ' +
      'receipt manually — the supported model (documented limitation).',
  })
  @IsOptional() @IsUUID() externalPaymentId?: string;
  /** Optional ISO-8601 timestamp of the confirmed receipt; defaults to now(). */
  @ApiPropertyOptional({
    type: 'string',
    format: 'date-time',
    description:
      'Optional ISO-8601 date-time of the confirmed receipt (strict ISO-8601 validation). ' +
      'When omitted, the service/database default (now()) applies.',
    example: '2026-11-10T09:30:00.000Z',
  })
  @IsOptional() @IsISO8601({ strict: true }) paidAt?: string;
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

  /** Milestone 2 — record an already-confirmed receipt (never initiates a payment-provider transaction). */
  @ApiOperation({
    summary: 'Record a rent payment (an already-confirmed receipt)',
    description:
      'Records an already-confirmed rent receipt against a rent schedule and reconciles the schedule in ONE transaction: ' +
      'the schedule status is derived from confirmed payment facts (paid when the exact paid total equals the scheduled ' +
      'amount, partially_paid otherwise). The API never initiates a payment-provider transaction, and submitting the ' +
      'request is not itself evidence that money moved (actor and facts are audited). Overpayment is REJECTED — never ' +
      'capped, split, refunded or absorbed (422 RENT_PAYMENT_OVERPAYMENT). Waived/cancelled schedules are never reopened ' +
      'by a payment (422 RENT_PAYMENT_SCHEDULE_NOT_PAYABLE). Concurrency-safe: the schedule row is locked FOR UPDATE and ' +
      'every invariant is re-validated under the lock; a failed transaction leaves NO payment row, NO outbox event and ' +
      'NO audit record. Org-scoped: requires the rental.update permission (rental.manage implied) within the landlord ' +
      'organization; out-of-scope identifiers answer 404 without leaking existence.',
  })
  @ApiResponse({
    status: 201,
    description:
      'Rent receipt recorded. Returns { data: { payment, schedule, paidTotal, scheduleStatusBefore } }: the payment row ' +
      '(exact decimal strings end-to-end, amount/currencyCode echoed back), the reconciled schedule, the exact paid ' +
      'total after the receipt and the schedule status before it. Errors follow the code-based error model.',
  })
  @ApiResponse({ status: 400, description: 'Request body validation failed (unknown/forbidden properties rejected by the validation pipe).' })
  @ApiResponse({ status: 403, description: 'Authenticated but missing the required rental.update (or rental.manage) permission in the landlord organization.' })
  @ApiResponse({
    status: 404,
    description:
      'LEASE_NOT_FOUND / LEASE_SCHEDULE_NOT_FOUND — the lease or schedule does not exist or is outside the caller scope ' +
      '(existence is never leaked).',
  })
  @ApiResponse({
    status: 409,
    description:
      'RENT_PAYMENT_DUPLICATE_EXTERNAL — the same external billing payment can never be applied twice (migration 0042 ' +
      'unique partial index authority); RENT_PAYMENT_SCHEDULE_CONFLICT — the referenced schedule no longer exists.',
  })
  @ApiResponse({
    status: 422,
    description:
      'Domain rejection (code-based error model): RENT_PAYMENT_AMOUNT_INVALID (exact numeric(20,4) contract violated, ' +
      'including any value that would require rounding); RENT_PAYMENT_CURRENCY_MISMATCH; RENT_PAYMENT_SCHEDULE_NOT_PAYABLE ' +
      '(waived/cancelled are never reopened); RENT_PAYMENT_OVERPAYMENT (the receipt would exceed the scheduled exact ' +
      'amount); external provenance chain: RENT_PAYMENT_EXTERNAL_INVALID, RENT_PAYMENT_EXTERNAL_NOT_CONFIRMED, ' +
      'RENT_PAYMENT_EXTERNAL_AMOUNT_MISMATCH, RENT_PAYMENT_EXTERNAL_ORDER_NOT_PAID, RENT_PAYMENT_EXTERNAL_ORDER_NOT_TENANT_OWNED, ' +
      'and the documented fail-closed terminal RENT_PAYMENT_EXTERNAL_PROVENANCE_UNVERIFIABLE (no rent-specific ' +
      'billing-order-to-lease relationship exists); RENT_PAYMENT_RECORD_FAILED.',
  })
  @Post('leases/:id/schedules/:scheduleId/payments')
  async recordRentPayment(
    @Param('id') id: string,
    @Param('scheduleId') scheduleId: string,
    @Body() dto: RecordRentPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { data: await this.rental.recordRentPayment(id, scheduleId, dto, user) };
  }

  /** Milestone 2 — retrieval under the lease/schedule hierarchy (org-scoped, IDOR-safe). */
  @Get('leases/:id/schedules/:scheduleId/payments')
  async listRentPayments(
    @Param('id') id: string,
    @Param('scheduleId') scheduleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { data: await this.rental.listRentPayments(id, scheduleId, user) };
  }
}
