import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './common/config/env.validation';
import { ObservabilityModule } from './common/observability/observability.module';
import { AuthModule } from './common/auth/auth.module';
import { MetricsController } from './common/observability/metrics.controller';
import { DatabaseModule } from './infrastructure/database.module';
import { HealthModule } from './modules/health/health.module';
import { PropertiesModule } from './modules/properties/properties.module';
import { ListingsModule } from './modules/listings/listings.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { CrmModule } from './modules/crm/crm.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ValuationModule } from './modules/valuation/valuation.module';
import { SearchModule } from './modules/search/search.module';
import { IamModule } from './modules/iam/iam.module';
import { AuthorizationModule } from './modules/authorization/authorization.module';
import { CommissionModule } from './modules/commission/commission.module';
import { BillingModule } from './modules/billing/billing.module';
import { AdvertisingModule } from './modules/advertising/advertising.module';
import { I18nModule } from './modules/i18n/i18n.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { MediaModule } from './modules/media/media.module';
import { LegalModule } from './modules/legal/legal.module';
import { AdminModule } from './modules/admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    ObservabilityModule,
    AuthModule,
    DatabaseModule,
    HealthModule,
    IamModule,
    AuthorizationModule,
    PropertiesModule,
    ListingsModule,
    MessagingModule,
    CrmModule, ProjectsModule, ValuationModule,
    SearchModule,
    CommissionModule,
    BillingModule,
    AdvertisingModule,
    I18nModule,
    NotificationsModule,
    MediaModule,
    LegalModule,
    AdminModule,
  ],
  controllers: [MetricsController],
})
export class AppModule implements NestModule {
  configure(_consumer: MiddlewareConsumer): void {
    // Request lifecycle hooks (request id, trace id, timing, metrics) are
    // registered as Fastify hooks in main.ts — they must wrap ALL routes
    // including Swagger, which Nest middleware does not cover.
  }
}
