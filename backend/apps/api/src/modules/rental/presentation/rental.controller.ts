import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsIn, IsInt, IsISO8601, IsNumberString, IsObject, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AccessTokenGuard } from '../../../common/auth/access-token.guard';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '@platform/contracts';
import { RentalService } from '../application/rental.service';

/**
 * Gate P — Rental API (Milestone 1: lease foundation; Milestone 3: post-
 * commencement schedule management).
 *
 * Exact-decimal money policy (repository-wide convention): every API decimal is
 * a STRING — never a JS number, never a float. DTO-level string bounds carry
 * the shape (@IsString + @Length, mirroring the RecordRentPaymentDto
 * precedent); the exact numeric(20,4) contract (scale ≤ 4, ≤ 16 integer digits,
 * deterministically handled leading zeros) is owned by ONE authoritative layer
 * in the service (assertNonNegativeDecimalString for schedule amounts,
 * assertPositiveDecimalString for receipt amounts) so a value that would
 * require rounding is rejected with an explicit client domain error BEFORE
 * anything is written — never rounded or truncated. The controller never
 * converts amounts; values reach the numeric(20,4) columns as the exact
 * strings the client sent. Date columns are validated as exact 'YYYY-MM-DD'
 * strings (the frozen `date` columns; no timezone drift).
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
  @ApiProperty({
    type: 'string',
    minLength: 10,
    maxLength: 10,
    description:
      "Exact 'YYYY-MM-DD' due date (frozen date column). Unique per lease — the frozen UNIQUE (lease_id, due_date) " +
      'is the concurrency-safe duplicate authority; a duplicate date is rejected with 409 LEASE_SCHEDULE_DUPLICATE.',
    example: '2031-02-01',
  })
  @IsString() @Length(10, 10) dueDate!: string;
  /**
   * >= 0 — exact decimal string (numeric(20,4) column); lease currency.
   * Milestone 3: the DTO deliberately carries @IsString, NOT @IsNumberString —
   * the exact numeric(20,4) contract is owned by ONE authoritative layer:
   * RentalService.assertNonNegativeDecimalString.
   */
  @ApiProperty({
    type: 'string',
    minLength: 1,
    maxLength: 64,
    description:
      'Exact non-negative decimal amount as a STRING (never a JSON number). Exact numeric(20,4) contract: ' +
      '1-64 characters, digits with an optional fractional part — no sign, exponent, grouping separators or whitespace; ' +
      'at most 16 integer digits (harmless leading zeros are stripped deterministically) and at most 4 fractional digits ' +
      '(maximum representable value 9999999999999999.9999). ZERO is valid (the frozen schedule CHECK is amount >= 0). ' +
      'A value that would require rounding when persisted (more than 4 fractional digits) or exceeds the range is ' +
      'rejected with 422 LEASE_SCHEDULE_AMOUNT_INVALID BEFORE anything is written — never rounded, truncated or capped. ' +
      'Must equal the lease currency (422 LEASE_SCHEDULE_CURRENCY_MISMATCH on mismatch; no FX conversion).',
    example: '1250.0000',
  })
  @IsString() @Length(1, 64) amount!: string;
  /** Must equal the lease currency (exact consistency, no conversion). */
  @ApiProperty({
    type: 'string',
    minLength: 3,
    maxLength: 3,
    description:
      "Exactly 3 characters. Must equal the lease's own currency — no FX conversion is performed. " +
      'Mismatch → 422 LEASE_SCHEDULE_CURRENCY_MISMATCH.',
    example: 'EUR',
  })
  @IsString() @Length(3, 3) currencyCode!: string;
}

export class AddRentSchedulesDto {
  @ApiProperty({
    type: [RentScheduleItemDto],
    minItems: 1,
    maxItems: 200,
    description:
      'One to 200 schedule rows to add (validated as a whole — a request with any invalid row, duplicate date or ' +
      'currency mismatch writes NOTHING).',
  })
  @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RentScheduleItemDto)
  items!: RentScheduleItemDto[];
}

/**
 * Milestone 3 — controlled amendment of a pristine schedule row. The request
 * REPLACES the editable schedule fields (dueDate, amount). Currency is NOT a
 * request field: it is immutable and always stays the lease currency. The
 * pristine-state contract (parent lease draft | pending_signature | active;
 * schedule status exactly 'scheduled'; paid_at NULL; zero recorded rent
 * payments) is owned by RentalService.amendSchedule.
 */
export class AmendRentScheduleDto {
  /** Exact 'YYYY-MM-DD' (frozen date column); unique per lease. */
  @ApiProperty({
    type: 'string',
    minLength: 10,
    maxLength: 10,
    description:
      "Exact 'YYYY-MM-DD' due date (frozen date column) REPLACING the schedule's due date. Unique per lease — the " +
      'frozen UNIQUE (lease_id, due_date) is the concurrency-safe duplicate authority: amending onto a date that ' +
      'another schedule row (or a concurrent amendment winner) already holds is rejected with ' +
      '409 LEASE_SCHEDULE_DUPLICATE — exactly one concurrent winner.',
    example: '2031-08-01',
  })
  @IsString() @Length(10, 10) dueDate!: string;
  /** >= 0 — exact decimal string (numeric(20,4) column); lease currency (immutable). */
  @ApiProperty({
    type: 'string',
    minLength: 1,
    maxLength: 64,
    description:
      'Exact non-negative decimal amount as a STRING (never a JSON number) REPLACING the schedule amount. Exact ' +
      'numeric(20,4) contract: 1-64 characters, digits with an optional fractional part — no sign, exponent, grouping ' +
      'separators or whitespace; at most 16 integer digits (harmless leading zeros are stripped deterministically) and ' +
      'at most 4 fractional digits (maximum representable value 9999999999999999.9999). ZERO is valid (the frozen ' +
      'schedule CHECK is amount >= 0). A value that would require rounding when persisted (more than 4 fractional ' +
      'digits) or exceeds the range is rejected with 422 LEASE_SCHEDULE_AMOUNT_INVALID BEFORE anything is written — ' +
      'never rounded, truncated or capped. The currency is immutable: it is not part of this request and always ' +
      'remains the lease currency. Only pristine schedules can be amended (422 LEASE_SCHEDULE_NOT_AMENDABLE otherwise).',
    example: '1250.0000',
  })
  @IsString() @Length(1, 64) amount!: string;
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

  /**
   * Milestone 3 — rent schedules are appendable while draft | pending_signature
   * (unchanged M1 behavior) and controlled-appended while active;
   * expired | terminated | cancelled leases reject additions. The lease row is
   * re-read and locked FOR UPDATE inside the transaction, so a concurrent
   * lifecycle move that commits first is honored (a new schedule can never be
   * committed against a lease that is no longer active).
   */
  @ApiOperation({
    summary: 'Add rent schedules to a lease',
    description:
      'Adds rent-schedule rows (exact due date, exact non-negative decimal amount, lease currency) to the lease. ' +
      'Pre-commencement leases (draft | pending_signature) keep the unchanged behavior; ACTIVE leases accept ' +
      'controlled post-commencement additions (every new row carries the lease currency and the frozen database ' +
      'default status — no status transition is invented); expired | terminated | cancelled leases REJECT additions. ' +
      'The lease row is re-read and locked FOR UPDATE inside the write transaction, so a concurrent lifecycle move ' +
      'that commits first is honored and a new schedule can never be committed against a lease that is no longer ' +
      'active. Amounts follow the exact numeric(20,4) contract (values that would require rounding are rejected ' +
      'BEFORE any database access — never rounded or truncated). Org-scoped: requires the rental.update permission ' +
      '(rental.manage implied) within the landlord organization; out-of-scope identifiers answer 404 without ' +
      'leaking existence.',
  })
  @ApiResponse({
    status: 201,
    description:
      'Schedules added. Returns { data: [ schedule, ... ] } — every lease schedule row (exact decimal strings ' +
      'end-to-end; status is the frozen database default). A rental.schedules_added audit record is written in the ' +
      'SAME transaction with the actor, landlord organization, lease ID, due dates, exact amounts and currency; ' +
      'schedule sub-resource changes carry audit only (no outbox event).',
  })
  @ApiResponse({ status: 400, description: 'Request body validation failed (unknown/forbidden properties rejected by the validation pipe).' })
  @ApiResponse({ status: 403, description: 'Authenticated but missing the required rental.update (or rental.manage) permission in the landlord organization.' })
  @ApiResponse({
    status: 404,
    description: 'LEASE_NOT_FOUND — the lease does not exist or is outside the caller scope (existence is never leaked).',
  })
  @ApiResponse({
    status: 409,
    description:
      'LEASE_SCHEDULE_DUPLICATE — the same (lease_id, due_date) already exists (frozen UNIQUE authority; a duplicate ' +
      'date inside one request or a concurrent winner both map here).',
  })
  @ApiResponse({
    status: 422,
    description:
      'Domain rejection (code-based error model): LEASE_SCHEDULE_AMOUNT_INVALID (exact non-negative numeric(20,4) ' +
      'contract violated, including any value that would require rounding); LEASE_SCHEDULE_CURRENCY_MISMATCH (every ' +
      'schedule must use the lease currency — no FX); LEASE_NOT_MUTABLE (the lease is expired | terminated | ' +
      'cancelled, or the locked re-read lost the race against a concurrent lifecycle move).',
  })
  @Post('leases/:id/schedules')
  async addSchedules(@Param('id') id: string, @Body() dto: AddRentSchedulesDto, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.rental.addSchedules(id, dto.items, user) };
  }

  /**
   * Milestone 3 — controlled amendment of a pristine schedule row. Deletion is
   * NOT extended to active leases by this milestone (see removeSchedule).
   */
  @ApiOperation({
    summary: 'Amend a pristine rent schedule (due date and amount)',
    description:
      'Replaces the editable schedule fields (dueDate, amount) of a PRISTINE rent schedule. The currency is ' +
      'immutable and always remains the lease currency (it is not part of the request and the column is never ' +
      'written). An amendment is allowed only when ALL of the following hold: the parent lease is ' +
      'draft | pending_signature | active; the schedule status is exactly scheduled (pending, late, partially_paid, ' +
      'paid, waived and cancelled schedules are NEVER reopened or modified); paid_at is NULL; and there are ZERO rows ' +
      'in rent_payments — a pristine amendment must never alter a receipt, a payment amount or a reconciled schedule. ' +
      'Amounts follow the exact numeric(20,4) non-negative contract (values that would require rounding are rejected ' +
      'BEFORE any database access). Concurrency-safe: the lease row is locked FOR UPDATE first, then the schedule row ' +
      'FOR UPDATE (the same schedule-row lock discipline the rent-payment recording path uses), and every state ' +
      'invariant is re-validated under the locks — a receipt recorder and a schedule amendment serialize on the ' +
      'schedule row and never both commit based on stale assumptions; concurrent due-date changes resolve through ' +
      'the frozen UNIQUE (lease_id, due_date) with exactly one winner. A failed transaction leaves NO schedule ' +
      'mutation and NO audit record. Org-scoped: requires the rental.update permission (rental.manage implied) ' +
      'within the landlord organization; out-of-scope identifiers answer 404 without leaking existence.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Schedule amended. Returns { data: { id, leaseId, dueDate, amount, currencyCode, status, paidAt } } with exact ' +
      'decimal strings end-to-end and the currency unchanged. A rental.schedule_amended audit record with before/after ' +
      'state (due date, exact amounts, currency, status, paid_at) is written in the SAME transaction; schedule ' +
      'sub-resource changes carry audit only (no outbox event).',
  })
  @ApiResponse({ status: 400, description: 'Request body validation failed (unknown/forbidden properties rejected by the validation pipe).' })
  @ApiResponse({ status: 403, description: 'Authenticated but missing the required rental.update (or rental.manage) permission in the landlord organization.' })
  @ApiResponse({
    status: 404,
    description:
      'LEASE_NOT_FOUND / LEASE_SCHEDULE_NOT_FOUND — the lease or schedule does not exist or is outside the caller ' +
      'scope (existence is never leaked).',
  })
  @ApiResponse({
    status: 409,
    description:
      'LEASE_SCHEDULE_DUPLICATE — the target (lease_id, due_date) is already taken by another schedule row (frozen ' +
      'UNIQUE authority; concurrent due-date changes resolve with exactly one winner); ' +
      'LEASE_SCHEDULE_CONCURRENT_MODIFICATION — defensive guard against a stale write under the row lock.',
  })
  @ApiResponse({
    status: 422,
    description:
      'Domain rejection (code-based error model): LEASE_SCHEDULE_AMOUNT_INVALID (exact non-negative numeric(20,4) ' +
      'contract violated, including any value that would require rounding); LEASE_SCHEDULE_NOT_AMENDABLE (the parent ' +
      'lease is not draft | pending_signature | active, the schedule status is not exactly scheduled, paid_at is set, ' +
      'or recorded rent payments exist); LEASE_SCHEDULE_RANGE_INVALID (frozen CHECK amount >= 0 is the DB authority).',
  })
  @Put('leases/:id/schedules/:scheduleId')
  async amendSchedule(
    @Param('id') id: string,
    @Param('scheduleId') scheduleId: string,
    @Body() dto: AmendRentScheduleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { data: await this.rental.amendSchedule(id, scheduleId, dto, user) };
  }

  /**
   * Pre-commencement schedule deletion ONLY (M1 semantics preserved by M3):
   * draft | pending_signature leases delete unpaid schedule rows; active |
   * expired | terminated | cancelled leases get the documented LEASE_NOT_MUTABLE
   * domain rejection — no active-lease schedule deletion or cancellation is
   * introduced, and the frozen ON DELETE RESTRICT relationship to rent payments
   * stays the authoritative guard against removing receipt-bearing rows.
   */
  @ApiOperation({
    summary: 'Remove a pre-commencement rent schedule',
    description:
      'Deletes an UNPAID schedule row from a pre-commencement lease (draft | pending_signature). For an active, ' +
      'expired, terminated or cancelled lease this is REJECTED with 422 LEASE_NOT_MUTABLE — historical and active ' +
      'contractual obligations are never hard-deleted, and this milestone introduces no active-lease schedule ' +
      'deletion or cancellation. A schedule that already carries recorded rent payments is protected by the frozen ' +
      'ON DELETE RESTRICT relationship (409 LEASE_SCHEDULE_IN_USE).',
  })
  @ApiResponse({
    status: 200,
    description:
      'Schedule removed. Returns { data: { id, leaseId, dueDate, amount, currencyCode, status, paidAt } } (the removed ' +
      'row snapshot). A rental.schedule_removed audit record with the before-snapshot is written in the SAME transaction.',
  })
  @ApiResponse({ status: 403, description: 'Authenticated but missing the required rental.update (or rental.manage) permission in the landlord organization.' })
  @ApiResponse({
    status: 404,
    description: 'LEASE_NOT_FOUND / LEASE_SCHEDULE_NOT_FOUND — the lease or schedule does not exist or is outside the caller scope (existence is never leaked).',
  })
  @ApiResponse({
    status: 409,
    description: 'LEASE_SCHEDULE_IN_USE — the schedule carries recorded rent payments (frozen ON DELETE RESTRICT authority).',
  })
  @ApiResponse({
    status: 422,
    description: 'LEASE_NOT_MUTABLE — the lease is active | expired | terminated | cancelled; pre-commencement deletion only.',
  })
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
