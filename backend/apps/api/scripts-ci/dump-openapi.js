/**
 * GATE 4.1 (Phase N) — OpenAPI spec dumper.
 * Boots the real Nest application (no network listener) and writes the
 * generated OpenAPI document to a committed artifact so contract drift
 * becomes detectable in CI (regenerate + diff).
 * Usage: node scripts-ci/dump-openapi.js <output.json>
 */
const { randomUUID } = require('node:crypto');
const { ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const { DocumentBuilder, SwaggerModule } = require('@nestjs/swagger');

async function main() {
  const out = process.argv[2] || 'openapi.json';
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dump-openapi-secret-0123456789abcdef0123456789abcdef012345';
  const { AppModule } = require('../dist/app.module');
  const app = await NestFactory.create(AppModule, new FastifyAdapter({ genReqId: () => randomUUID() }), { logger: ['error'] });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const cfg = new DocumentBuilder()
    .setTitle('Enterprise Real Estate Platform API')
    .setVersion('1.1.0')
    .setDescription('Karen Home — Gate 4 backend. All endpoints under /api/v1; errors follow the code-based error model.')
    .addBearerAuth()
    .addTag('auth', 'IAM: registration, login, refresh rotation, MFA, OAuth, verification')
    .addTag('properties')
    .addTag('listings')
    .addTag('search')
    .addTag('commission')
    .addTag('billing')
    .addTag('ads')
    .addTag('notifications')
    .addTag('media')
    .addTag('i18n')
    .addTag('valuation', 'Valuation cases, lifecycle, exact-decimal results and comparable evidence (no invented parameters; IRR=TBD)')
    .addTag('rental', 'Rental leases, parties, schedules and lifecycle (frozen 0018 schema is the authority; no invented financial or legal rules)')
    .addTag('admin')
    .addTag('health')
    .build();
  const document = SwaggerModule.createDocument(app, cfg);
  require('node:fs').writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
  const paths = Object.keys(document.paths ?? {});
  console.log(`openapi dumped: ${out} — paths=${paths.length}`);
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
