import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import {
  PostgresDatabase, IamRepository, IamHardeningRepository, PropertyRepository, ListingRepository, MessagingRepository, CrmRepository, ProjectsRepository, ValuationRepository, RentalRepository, OutboxRepository,
  AuditRepository, JobRepository, CommissionRepository, BillingRepository, AdvertisingRepository,
  NotificationRepository, MediaRepository, SearchIndexRepository, PublicationPolicyRepository, AntiBotRepository,
} from '@platform/db';
import { AppConfig } from '../common/config/app-config';

@Global()
@Module({
  providers: [
    AppConfig,
    {
      provide: PostgresDatabase,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new PostgresDatabase({
        connectionString: config.databaseUrl,
        max: config.databasePoolMax,
        ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
      }),
    },
    { provide: IamRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new IamRepository(db) },
    { provide: IamHardeningRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new IamHardeningRepository(db) },
    { provide: PropertyRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new PropertyRepository(db) },
    { provide: ListingRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new ListingRepository(db) },
    { provide: MessagingRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new MessagingRepository(db) },
    { provide: CrmRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new CrmRepository(db) },
    { provide: ProjectsRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new ProjectsRepository(db) },
    { provide: ValuationRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new ValuationRepository(db) },
    { provide: RentalRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new RentalRepository(db) },
    { provide: OutboxRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new OutboxRepository(db) },
    { provide: AuditRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new AuditRepository(db) },
    { provide: JobRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new JobRepository(db) },
    { provide: CommissionRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new CommissionRepository(db) },
    { provide: BillingRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new BillingRepository(db) },
    { provide: AdvertisingRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new AdvertisingRepository(db) },
    { provide: NotificationRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new NotificationRepository(db) },
    { provide: MediaRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new MediaRepository(db) },
    { provide: SearchIndexRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new SearchIndexRepository(db) },
    { provide: PublicationPolicyRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new PublicationPolicyRepository(db) },
    { provide: AntiBotRepository, inject: [PostgresDatabase], useFactory: (db: PostgresDatabase) => new AntiBotRepository(db) },
  ],
  exports: [
    AppConfig, PostgresDatabase, IamRepository, IamHardeningRepository, PropertyRepository, ListingRepository, MessagingRepository, CrmRepository, ProjectsRepository, ValuationRepository, RentalRepository, OutboxRepository,
    AuditRepository, JobRepository, CommissionRepository, BillingRepository, AdvertisingRepository,
    NotificationRepository, MediaRepository, SearchIndexRepository, PublicationPolicyRepository, AntiBotRepository,
  ],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(private readonly db: PostgresDatabase) {}
  async onApplicationShutdown(): Promise<void> { await this.db.close(); }
}
