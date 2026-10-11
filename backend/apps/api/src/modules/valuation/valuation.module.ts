import { Module } from '@nestjs/common';
import { ValuationService } from './application/valuation.service';
import { ValuationController } from './presentation/valuation.controller';

@Module({
  controllers: [ValuationController],
  providers: [ValuationService],
  exports: [ValuationService],
})
export class ValuationModule {}
