import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { DepartmentsController } from './departments/departments.controller';
import { DepartmentsService } from './departments/departments.service';
import { DesignationsController } from './designations/designations.controller';
import { DesignationsService } from './designations/designations.service';
import { TaxRulesController } from './tax-rules/tax-rules.controller';
import { TaxRulesService } from './tax-rules/tax-rules.service';
import { PayrollStructuresController } from './payroll-structures/payroll-structures.controller';
import { PayrollStructuresService } from './payroll-structures/payroll-structures.service';
import { CurrenciesController } from './currencies/currencies.controller';
import { LeavePoliciesController } from './leave-policies/leave-policies.controller';
import { LeavePoliciesService } from './leave-policies/leave-policies.service';
import { WorkLocationsController } from './work-locations/work-locations.controller';
import { WorkLocationsService } from './work-locations/work-locations.service';
import { ZonesController } from './zones/zones.controller';
import { ZonesService } from './zones/zones.service';
import { AutoLogoutScheduler } from './auto-logout.scheduler';

@Module({
  imports: [MulterModule.register({ storage: memoryStorage() })],
  controllers: [
    OrganizationsController,
    CurrenciesController,
    DepartmentsController,
    DesignationsController,
    TaxRulesController,
    PayrollStructuresController,
    LeavePoliciesController,
    WorkLocationsController,
    ZonesController,
  ],
  providers: [
    OrganizationsService,
    DepartmentsService,
    DesignationsService,
    TaxRulesService,
    PayrollStructuresService,
    LeavePoliciesService,
    WorkLocationsService,
    ZonesService,
    AutoLogoutScheduler,
  ],
  exports: [
    DepartmentsService,
    DesignationsService,
    TaxRulesService,
    PayrollStructuresService,
    LeavePoliciesService,
    WorkLocationsService,
    ZonesService,
  ],
})
export class OrganizationsModule {}
