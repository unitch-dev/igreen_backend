import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IncentiveSource } from '@prisma/client';
import { TodoEmployeeSummaryDto } from '../../todos/dto/todo-response.dto';

export class IncentiveLedgerTodoSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;
}

export class IncentiveLedgerResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  employeeId: string;

  @ApiProperty({ type: TodoEmployeeSummaryDto, nullable: true })
  employee: TodoEmployeeSummaryDto | null;

  @ApiProperty({ nullable: true })
  todoId: string | null;

  @ApiProperty({ type: IncentiveLedgerTodoSummaryDto, nullable: true })
  todo: IncentiveLedgerTodoSummaryDto | null;

  @ApiProperty({ enum: IncentiveSource })
  source: IncentiveSource;

  @ApiProperty()
  totalAmount: number;

  @ApiProperty()
  holdAmount: number;

  @ApiProperty()
  releaseAmount: number;

  @ApiProperty()
  payrollMonth: number;

  @ApiProperty()
  payrollYear: number;

  @ApiProperty()
  isHeld: boolean;

  @ApiProperty()
  isReleased: boolean;

  @ApiProperty()
  isDeducted: boolean;

  @ApiPropertyOptional({ nullable: true })
  payrollEntryId: string | null;

  @ApiPropertyOptional({ nullable: true })
  releasedAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}
