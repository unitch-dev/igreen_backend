import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { IncentiveRulesController } from './incentive-rules.controller';
import { IncentiveRulesService } from './incentive-rules.service';
import { IncentiveLedgerController } from './incentive-ledger.controller';
import { IncentiveLedgerService } from './incentive-ledger.service';

@Module({
  imports: [PrismaModule],
  controllers: [IncentiveRulesController, IncentiveLedgerController],
  providers: [IncentiveRulesService, IncentiveLedgerService],
  exports: [IncentiveLedgerService],
})
export class IncentivesModule {}
