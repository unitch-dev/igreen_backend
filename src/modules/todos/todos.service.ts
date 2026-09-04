import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IncentiveSource, Prisma, TodoStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '@common/dto/pagination.dto';
import { CreateTodoDto } from './dto/create-todo.dto';
import { QueryTodoDto } from './dto/query-todo.dto';
import { SubmitTodoDto } from './dto/submit-todo.dto';
import { ApproveTodoDto } from './dto/approve-todo.dto';

export const TODO_APPROVE_PERMISSION = 'todo:approve';

export interface RequestingUser {
  employeeId: string | null;
  permissions: string[];
}

const TODO_WITH_RELATIONS = {
  employee: {
    select: {
      id: true,
      empCode: true,
      firstName: true,
      lastName: true,
      department: { select: { name: true } },
    },
  },
  incentiveRule: {
    select: { id: true, name: true, rate: true },
  },
} satisfies Prisma.TodoTaskInclude;

type TodoTaskWithRelations = Prisma.TodoTaskGetPayload<{
  include: typeof TODO_WITH_RELATIONS;
}>;

@Injectable()
export class TodosService {
  constructor(private readonly prisma: PrismaService) {}

  private hasApprovePermission(currentUser: RequestingUser): boolean {
    return (
      currentUser.permissions.includes(TODO_APPROVE_PERMISSION) ||
      currentUser.permissions.includes('*')
    );
  }

  async create(organizationId: string, currentUser: RequestingUser, dto: CreateTodoDto) {
    const targetEmployeeId = dto.employeeId ?? currentUser.employeeId;
    if (!targetEmployeeId) {
      throw new BadRequestException('No employee record found for the current user');
    }

    if (
      dto.employeeId &&
      dto.employeeId !== currentUser.employeeId &&
      !this.hasApprovePermission(currentUser)
    ) {
      throw new ForbiddenException(
        'You are not permitted to create a todo on behalf of another employee',
      );
    }

    const employee = await this.prisma.employee.findFirst({
      where: { id: targetEmployeeId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    if (dto.incentiveRuleId) {
      const rule = await this.prisma.incentiveRule.findFirst({
        where: { id: dto.incentiveRuleId, organizationId, isActive: true },
      });
      if (!rule) {
        throw new BadRequestException(
          'Incentive rule not found or is inactive for this organization',
        );
      }
    }

    const todo = await this.prisma.todoTask.create({
      data: {
        employeeId: targetEmployeeId,
        incentiveRuleId: dto.incentiveRuleId,
        title: dto.title,
        description: dto.description,
        quantity: dto.quantity,
        unit: dto.unit,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        status: TodoStatus.PENDING,
      },
      include: TODO_WITH_RELATIONS,
    });

    return this.toResponse(todo);
  }

  async findAll(organizationId: string, currentUser: RequestingUser, query: QueryTodoDto) {
    const canSeeAll = this.hasApprovePermission(currentUser);
    const scopedEmployeeId = canSeeAll ? query.employeeId : currentUser.employeeId;

    if (!canSeeAll && !scopedEmployeeId) {
      return paginate([], 0, query);
    }

    const where: Prisma.TodoTaskWhereInput = {
      employee: { organizationId, deletedAt: null },
      ...(scopedEmployeeId && { employeeId: scopedEmployeeId }),
      ...(query.status && { status: query.status }),
      ...(query.incentiveRuleId && { incentiveRuleId: query.incentiveRuleId }),
    };

    const [data, total] = await Promise.all([
      this.prisma.todoTask.findMany({
        where,
        include: TODO_WITH_RELATIONS,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.todoTask.count({ where }),
    ]);

    return paginate(
      data.map((todo) => this.toResponse(todo)),
      total,
      query,
    );
  }

  async findOne(organizationId: string, currentUser: RequestingUser, id: string) {
    const todo = await this.getTodoOrThrow(organizationId, id);
    this.assertVisible(todo, currentUser);
    return this.toResponse(todo);
  }

  async submit(
    organizationId: string,
    currentUser: RequestingUser,
    id: string,
    dto: SubmitTodoDto,
  ) {
    const todo = await this.getTodoOrThrow(organizationId, id);
    this.assertVisible(todo, currentUser);

    if (todo.status !== TodoStatus.PENDING && todo.status !== TodoStatus.REJECTED) {
      throw new BadRequestException('Only a PENDING or REJECTED todo can be submitted for review');
    }

    const updated = await this.prisma.todoTask.update({
      where: { id },
      data: {
        quantity: dto.quantity,
        unit: dto.unit ?? todo.unit,
        status: TodoStatus.SUBMITTED,
        submittedAt: new Date(),
        rejectionNote: null,
      },
      include: TODO_WITH_RELATIONS,
    });

    return this.toResponse(updated);
  }

  async approve(
    organizationId: string,
    userId: string,
    currentUser: RequestingUser,
    id: string,
    dto: ApproveTodoDto,
  ) {
    if (!this.hasApprovePermission(currentUser)) {
      throw new ForbiddenException('You are not permitted to approve or reject todos');
    }

    const todo = await this.getTodoOrThrow(organizationId, id);
    if (currentUser.employeeId && todo.employeeId === currentUser.employeeId) {
      throw new ForbiddenException('You cannot approve or reject your own todo');
    }
    if (todo.status !== TodoStatus.SUBMITTED) {
      throw new BadRequestException('Only a SUBMITTED todo can be approved or rejected');
    }

    if (!dto.approve) {
      const rejected = await this.prisma.todoTask.update({
        where: { id },
        data: {
          status: TodoStatus.REJECTED,
          rejectionNote: dto.rejectionNote,
          reviewedBy: userId,
          reviewedAt: new Date(),
        },
        include: TODO_WITH_RELATIONS,
      });
      return this.toResponse(rejected);
    }

    if (todo.quantity === null) {
      throw new BadRequestException(
        'Cannot approve: todo has no submitted quantity to compute an incentive amount',
      );
    }

    let incentiveRule = todo.incentiveRule;
    if (dto.incentiveRuleId && dto.incentiveRuleId !== todo.incentiveRuleId) {
      incentiveRule = await this.prisma.incentiveRule.findFirst({
        where: { id: dto.incentiveRuleId, organizationId, isActive: true },
      });
      if (!incentiveRule) {
        throw new BadRequestException(
          'Incentive rule not found or is inactive for this organization',
        );
      }
    }
    if (!incentiveRule) {
      throw new BadRequestException(
        'Cannot approve: todo has no linked incentive rule. Attach one to approve.',
      );
    }

    const now = new Date();
    const totalAmount = todo.quantity * incentiveRule.rate;
    const payrollMonth = dto.payrollMonth ?? now.getMonth() + 1;
    const payrollYear = dto.payrollYear ?? now.getFullYear();
    const hold = dto.hold ?? false;

    const [updatedTodo] = await this.prisma.$transaction([
      this.prisma.todoTask.update({
        where: { id },
        data: {
          status: TodoStatus.APPROVED,
          incentiveRuleId: incentiveRule.id,
          reviewedBy: userId,
          reviewedAt: now,
        },
        include: TODO_WITH_RELATIONS,
      }),
      this.prisma.incentiveLedger.create({
        data: {
          employeeId: todo.employeeId,
          todoId: todo.id,
          source: IncentiveSource.TODO,
          totalAmount,
          payrollMonth,
          payrollYear,
          isHeld: hold,
          isReleased: !hold,
          holdAmount: hold ? totalAmount : 0,
          releaseAmount: hold ? 0 : totalAmount,
          releasedAt: hold ? null : now,
        },
      }),
    ]);

    return this.toResponse(updatedTodo);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async getTodoOrThrow(organizationId: string, id: string): Promise<TodoTaskWithRelations> {
    const todo = await this.prisma.todoTask.findFirst({
      where: { id, employee: { organizationId, deletedAt: null } },
      include: TODO_WITH_RELATIONS,
    });
    if (!todo) throw new NotFoundException('Todo not found');
    return todo;
  }

  private assertVisible(todo: { employeeId: string }, currentUser: RequestingUser): void {
    if (this.hasApprovePermission(currentUser)) return;
    if (todo.employeeId !== currentUser.employeeId) {
      throw new ForbiddenException('You can only view your own todos');
    }
  }

  private toResponse(todo: TodoTaskWithRelations) {
    return {
      id: todo.id,
      employeeId: todo.employeeId,
      employee: todo.employee
        ? {
            id: todo.employee.id,
            empCode: todo.employee.empCode,
            firstName: todo.employee.firstName,
            lastName: todo.employee.lastName,
            departmentName: todo.employee.department?.name ?? null,
          }
        : null,
      incentiveRuleId: todo.incentiveRuleId,
      incentiveRule: todo.incentiveRule
        ? {
            id: todo.incentiveRule.id,
            name: todo.incentiveRule.name,
            rate: todo.incentiveRule.rate,
          }
        : null,
      title: todo.title,
      description: todo.description,
      quantity: todo.quantity,
      unit: todo.unit,
      dueDate: todo.dueDate,
      status: todo.status,
      submittedAt: todo.submittedAt,
      reviewedBy: todo.reviewedBy,
      reviewedAt: todo.reviewedAt,
      rejectionNote: todo.rejectionNote,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
    };
  }
}
