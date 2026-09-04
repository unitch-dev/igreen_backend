import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TodoStatus } from '@prisma/client';

export class TodoEmployeeSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  empCode: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiPropertyOptional({ nullable: true })
  departmentName?: string | null;
}

export class TodoIncentiveRuleSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  rate: number;
}

export class TodoResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  employeeId: string;

  @ApiProperty({ type: TodoEmployeeSummaryDto, nullable: true })
  employee: TodoEmployeeSummaryDto | null;

  @ApiProperty({ nullable: true })
  incentiveRuleId: string | null;

  @ApiProperty({ type: TodoIncentiveRuleSummaryDto, nullable: true })
  incentiveRule: TodoIncentiveRuleSummaryDto | null;

  @ApiProperty()
  title: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  quantity: number | null;

  @ApiProperty({ nullable: true })
  unit: string | null;

  @ApiProperty({ nullable: true })
  dueDate: Date | null;

  @ApiProperty({ enum: TodoStatus })
  status: TodoStatus;

  @ApiProperty({ nullable: true })
  submittedAt: Date | null;

  @ApiProperty({ nullable: true })
  reviewedBy: string | null;

  @ApiProperty({ nullable: true })
  reviewedAt: Date | null;

  @ApiProperty({ nullable: true })
  rejectionNote: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
