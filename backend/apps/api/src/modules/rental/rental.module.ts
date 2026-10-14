import { Module } from '@nestjs/common';
import { RentalService } from './application/rental.service';
import { RentalController } from './presentation/rental.controller';

@Module({
  controllers: [RentalController],
  providers: [RentalService],
  exports: [RentalService],
})
export class RentalModule {}
