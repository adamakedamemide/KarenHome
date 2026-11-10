import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

/**
 * Rental M3 — OpenAPI contract regression.
 *
 * Pins the regenerated committed artifact (backend/apps/api/openapi.json) for
 * the post-commencement schedule-management milestone:
 *   - the NEW amendment operation
 *     PUT /api/v1/rental/leases/{id}/schedules/{scheduleId} references
 *     AmendRentScheduleDto and documents its real request/response/error codes;
 *   - the extended append operation POST .../schedules references the
 *     fully-documented AddRentSchedulesDto (the previously empty-properties
 *     request schema defect cannot return) with RentScheduleItemDto pinned;
 *   - the DELETE operation documents the preserved pre-commencement-only
 *     deletion semantics (active-lease rejection + frozen RESTRICT authority);
 *   - the M2.1 rent-payment contract (RecordRentPaymentDto + payment operation)
 *     remains EXACTLY as published — this milestone must not disturb it.
 */

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, { description?: string }>;
}

interface SchemaProperty {
  type?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
  example?: string;
}

interface DtoSchema {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

interface OpenApiSpec {
  openapi: string;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, DtoSchema> };
}

const spec = JSON.parse(readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8')) as OpenApiSpec;

const SCHEDULES_PATH = '/api/v1/rental/leases/{id}/schedules';
const SCHEDULE_PATH = '/api/v1/rental/leases/{id}/schedules/{scheduleId}';
const PAYMENTS_PATH = '/api/v1/rental/leases/{id}/schedules/{scheduleId}/payments';

function op(path: string, method: string): OpenApiOperation {
  const operation = spec.paths[path]?.[method];
  if (!operation) throw new Error(`expected ${method} on ${path} in the committed OpenAPI artifact`);
  return operation;
}

describe('Rental M3 — amendment operation (PUT schedules/{scheduleId}) contract', () => {
  it('the artifact parses, keeps 134 paths and exposes the NEW put method alongside the preserved delete', () => {
    expect(spec.openapi).toBe('3.0.0');
    expect(Object.keys(spec.paths)).toHaveLength(134);
    const methods = Object.keys(spec.paths[SCHEDULE_PATH] ?? {}).sort();
    expect(methods).toEqual(['delete', 'put']);
  });

  it('the PUT amendment request body references AmendRentScheduleDto with exactly [amount, dueDate] required', () => {
    const put = op(SCHEDULE_PATH, 'put');
    expect(put.operationId).toBe('RentalController_amendSchedule');
    expect(put.requestBody?.required).toBe(true);
    expect(put.requestBody?.content?.['application/json']?.schema?.$ref).toBe('#/components/schemas/AmendRentScheduleDto');
    const schema = spec.components.schemas['AmendRentScheduleDto'];
    if (!schema) throw new Error('expected AmendRentScheduleDto in the committed OpenAPI artifact');
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['amount', 'dueDate']);
    expect([...(schema.required ?? [])].sort()).toEqual(['amount', 'dueDate']);
    // currency is immutable — never a request field
    expect(schema.properties?.['currencyCode']).toBeUndefined();
  });

  it('AmendRentScheduleDto documents the exact non-negative numeric(20,4) amount contract and the unique due date', () => {
    const props = spec.components.schemas['AmendRentScheduleDto']!.properties!;
    expect(props.amount).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 });
    expect(props.amount!.description ?? '').toContain('numeric(20,4)');
    expect(props.amount!.description ?? '').toContain('9999999999999999.9999');
    expect(props.amount!.description ?? '').toContain('LEASE_SCHEDULE_AMOUNT_INVALID');
    expect(props.amount!.description ?? '').toContain('never rounded, truncated or capped');
    expect(props.amount!.description ?? '').toContain('ZERO is valid');
    expect(props.amount!.description ?? '').toContain('immutable');
    expect(props.dueDate).toMatchObject({ type: 'string', minLength: 10, maxLength: 10 });
    expect(props.dueDate!.description ?? '').toContain('YYYY-MM-DD');
    expect(props.dueDate!.description ?? '').toContain('LEASE_SCHEDULE_DUPLICATE');
  });

  it('the PUT operation documents its real response and error codes (pristine gate, duplicate authority, frozen CHECK)', () => {
    const put = op(SCHEDULE_PATH, 'put');
    expect(put.summary).toBeTruthy();
    expect(put.description ?? '').toContain('ZERO rows');
    expect(put.description ?? '').toContain('FOR UPDATE');
    expect(put.description ?? '').toContain('currency is immutable');
    expect(put.responses?.['200']?.description).toContain('Schedule amended');
    expect(put.responses?.['404']?.description).toContain('LEASE_SCHEDULE_NOT_FOUND');
    expect(put.responses?.['409']?.description).toContain('LEASE_SCHEDULE_DUPLICATE');
    expect(put.responses?.['422']?.description).toContain('LEASE_SCHEDULE_AMOUNT_INVALID');
    expect(put.responses?.['422']?.description).toContain('LEASE_SCHEDULE_NOT_AMENDABLE');
    expect(put.responses?.['422']?.description).toContain('LEASE_SCHEDULE_RANGE_INVALID');
  });
});

describe('Rental M3 — extended append operation (POST schedules) contract', () => {
  it('AddRentSchedulesDto is fully documented — the empty request schema cannot return', () => {
    const post = op(SCHEDULES_PATH, 'post');
    expect(post.operationId).toBe('RentalController_addSchedules');
    expect(post.requestBody?.required).toBe(true);
    expect(post.requestBody?.content?.['application/json']?.schema?.$ref).toBe('#/components/schemas/AddRentSchedulesDto');
    const schema = spec.components.schemas['AddRentSchedulesDto'];
    expect(Object.keys(schema?.properties ?? {})).toEqual(['items']);
    const items = schema!.properties!['items']!;
    expect(items).toMatchObject({ type: 'array', minItems: 1, maxItems: 200 });
    expect((items as unknown as { items?: { $ref?: string } }).items?.$ref).toBe('#/components/schemas/RentScheduleItemDto');
  });

  it('RentScheduleItemDto documents dueDate, amount and currencyCode with the exact bounds', () => {
    const schema = spec.components.schemas['RentScheduleItemDto'];
    if (!schema) throw new Error('expected RentScheduleItemDto in the committed OpenAPI artifact');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['amount', 'currencyCode', 'dueDate']);
    expect([...(schema.required ?? [])].sort()).toEqual(['amount', 'currencyCode', 'dueDate']);
    expect(schema.properties!['dueDate']).toMatchObject({ type: 'string', minLength: 10, maxLength: 10 });
    expect(schema.properties!['amount']).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 });
    expect(schema.properties!['amount']!.description ?? '').toContain('numeric(20,4)');
    expect(schema.properties!['amount']!.description ?? '').toContain('LEASE_SCHEDULE_AMOUNT_INVALID');
    expect(schema.properties!['currencyCode']).toMatchObject({ type: 'string', minLength: 3, maxLength: 3 });
    expect(schema.properties!['currencyCode']!.description ?? '').toContain('LEASE_SCHEDULE_CURRENCY_MISMATCH');
  });

  it('the POST operation documents the ACTIVE-lease append and the real error codes', () => {
    const post = op(SCHEDULES_PATH, 'post');
    expect(post.summary).toBeTruthy();
    expect(post.description ?? '').toContain('ACTIVE leases accept');
    expect(post.description ?? '').toContain('expired | terminated | cancelled leases REJECT');
    expect(post.description ?? '').toContain('FOR UPDATE');
    expect(post.responses?.['201']?.description).toContain('Schedules added');
    expect(post.responses?.['409']?.description).toContain('LEASE_SCHEDULE_DUPLICATE');
    expect(post.responses?.['422']?.description).toContain('LEASE_SCHEDULE_AMOUNT_INVALID');
    expect(post.responses?.['422']?.description).toContain('LEASE_SCHEDULE_CURRENCY_MISMATCH');
    expect(post.responses?.['422']?.description).toContain('LEASE_NOT_MUTABLE');
  });
});

describe('Rental M3 — preserved deletion semantics (DELETE schedules/{scheduleId}) contract', () => {
  it('the DELETE operation documents pre-commencement-only deletion: active-lease rejection + RESTRICT authority', () => {
    const del = op(SCHEDULE_PATH, 'delete');
    expect(del.operationId).toBe('RentalController_removeSchedule');
    expect(del.requestBody).toBeUndefined();
    expect(del.description ?? '').toContain('pre-commencement');
    expect(del.description ?? '').toContain('LEASE_NOT_MUTABLE');
    expect(del.responses?.['409']?.description).toContain('LEASE_SCHEDULE_IN_USE');
    expect(del.responses?.['422']?.description).toContain('LEASE_NOT_MUTABLE');
  });
});

describe('Rental M3 — the published M2/M2.1 rent-payment contract remains EXACTLY as published', () => {
  it('RecordRentPaymentDto keeps its four documented fields and required array', () => {
    const schema = spec.components.schemas['RecordRentPaymentDto'];
    if (!schema) throw new Error('expected RecordRentPaymentDto in the committed OpenAPI artifact');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['amount', 'currencyCode', 'externalPaymentId', 'paidAt']);
    expect([...(schema.required ?? [])].sort()).toEqual(['amount', 'currencyCode']);
    expect(schema.properties!['amount']!.description ?? '').toContain('RENT_PAYMENT_AMOUNT_INVALID');
    expect(schema.properties!['externalPaymentId']!.description ?? '').toContain('RENT_PAYMENT_EXTERNAL_PROVENANCE_UNVERIFIABLE');
  });

  it('the POST payment operation keeps its operationId, documented error behavior and the GET retrieval skeleton', () => {
    const post = op(PAYMENTS_PATH, 'post');
    expect(post.operationId).toBe('RentalController_recordRentPayment');
    expect(post.requestBody?.content?.['application/json']?.schema?.$ref).toBe('#/components/schemas/RecordRentPaymentDto');
    expect(post.responses?.['422']?.description).toContain('RENT_PAYMENT_OVERPAYMENT');
    expect(post.responses?.['422']?.description).toContain('RENT_PAYMENT_EXTERNAL_PROVENANCE_UNVERIFIABLE');

    const get = op(PAYMENTS_PATH, 'get');
    expect(get.operationId).toBe('RentalController_listRentPayments');
    expect(get.requestBody).toBeUndefined();
    expect(get.summary).toBeUndefined();
  });
});
