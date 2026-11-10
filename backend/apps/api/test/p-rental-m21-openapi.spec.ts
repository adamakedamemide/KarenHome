import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

/**
 * Rental M2.1 — OpenAPI contract regression (documentation-only correction).
 *
 * The published artifact previously exposed the defective empty schema
 * `RecordRentPaymentDto.properties = {}`, so clients and SDK generators could
 * not discover the actual request fields of
 * POST /api/v1/rental/leases/{id}/schedules/{scheduleId}/payments.
 *
 * These tests pin the CORRECTED committed artifact (backend/apps/api/openapi.json,
 * regenerated from the @nestjs/swagger source-of-truth decorators on
 * RecordRentPaymentDto / RentalController.recordRentPayment) so the empty
 * schema can never silently return. They also pin the GET payment operation
 * and assert the request-body $ref — documentation only, no runtime semantics.
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
  description?: string;
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

const PAYMENTS_PATH = '/api/v1/rental/leases/{id}/schedules/{scheduleId}/payments';
const DTO = 'RecordRentPaymentDto';

function op(method: 'post' | 'get'): OpenApiOperation {
  const item = spec.paths[PAYMENTS_PATH];
  const operation = item?.[method];
  if (!operation) throw new Error(`expected ${method} on ${PAYMENTS_PATH} in the committed OpenAPI artifact`);
  return operation;
}

describe('Rental M2.1 — RecordRentPaymentDto OpenAPI contract regression', () => {
  it('the committed OpenAPI artifact parses and is an OpenAPI 3.0 document with the payments path', () => {
    expect(spec.openapi).toBe('3.0.0');
    expect(spec.paths[PAYMENTS_PATH]).toBeDefined();
    expect(spec.components.schemas[DTO]).toBeDefined();
  });

  it('the POST payment request body references RecordRentPaymentDto', () => {
    const post = op('post');
    expect(post.operationId).toBe('RentalController_recordRentPayment');
    expect(post.requestBody?.required).toBe(true);
    expect(post.requestBody?.content?.['application/json']?.schema?.$ref).toBe(`#/components/schemas/${DTO}`);
  });

  it('RecordRentPaymentDto documents all four request fields — the empty schema can never return', () => {
    const schema = spec.components.schemas[DTO];
    if (!schema) throw new Error(`expected ${DTO} in the committed OpenAPI artifact`);
    expect(schema.type).toBe('object');
    const properties = schema.properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(['amount', 'currencyCode', 'externalPaymentId', 'paidAt']);

    const amount = properties.amount ?? {};
    expect(amount).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 });
    expect(amount.description ?? '').toContain('numeric(20,4)');
    expect(amount.description ?? '').toContain('9999999999999999.9999');
    expect(amount.description ?? '').toContain('RENT_PAYMENT_AMOUNT_INVALID');
    expect(amount.description ?? '').toContain('never rounded, truncated or capped');

    const currencyCode = properties.currencyCode ?? {};
    expect(currencyCode).toMatchObject({ type: 'string', minLength: 3, maxLength: 3 });
    expect(currencyCode.description ?? '').toContain('RENT_PAYMENT_CURRENCY_MISMATCH');

    const externalPaymentId = properties.externalPaymentId ?? {};
    expect(externalPaymentId).toMatchObject({ type: 'string', format: 'uuid' });
    expect(externalPaymentId.description ?? '').toContain('RENT_PAYMENT_EXTERNAL_PROVENANCE_UNVERIFIABLE');
    expect(externalPaymentId.description ?? '').toContain('fails closed');

    const paidAt = properties.paidAt ?? {};
    expect(paidAt).toMatchObject({ type: 'string', format: 'date-time' });
    expect(paidAt.description ?? '').toContain('now()');
  });

  it('the required array contains exactly amount and currencyCode', () => {
    expect([...(spec.components.schemas[DTO]?.required ?? [])].sort()).toEqual(['amount', 'currencyCode']);
  });

  it('the POST payment operation documents its response and the relevant error behavior', () => {
    const post = op('post');
    expect(post.summary).toBeTruthy();
    expect(post.description).toContain('never initiates a payment-provider transaction');
    expect(post.responses?.['201']?.description).toContain('Rent receipt recorded');
    expect(post.responses?.['422']?.description).toContain('RENT_PAYMENT_OVERPAYMENT');
    expect(post.responses?.['422']?.description).toContain('RENT_PAYMENT_EXTERNAL_PROVENANCE_UNVERIFIABLE');
    expect(post.responses?.['404']?.description).toContain('LEASE_SCHEDULE_NOT_FOUND');
    expect(post.responses?.['409']?.description).toContain('RENT_PAYMENT_DUPLICATE_EXTERNAL');
  });

  it('the existing GET payment operation remains the unchanged retrieval skeleton (no request body)', () => {
    const get = op('get');
    expect(get.operationId).toBe('RentalController_listRentPayments');
    expect(get.requestBody).toBeUndefined();
    expect(get.responses).toEqual({ '200': { description: '' } });
    expect(get.summary).toBeUndefined();
    expect(get.description).toBeUndefined();
  });
});
