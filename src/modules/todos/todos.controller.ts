import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { OrganizationId } from '@common/decorators/organization.decorator';
import { RequirePermissions } from '@common/decorators/permissions.decorator';
import {
  ApiCommonErrorResponses,
  ApiPaginatedResponse,
  ApiSuccessResponse,
} from '@common/swagger/api-responses.decorator';
import { RequestingUser, TodosService } from './todos.service';
import { CreateTodoDto } from './dto/create-todo.dto';
import { QueryTodoDto } from './dto/query-todo.dto';
import { SubmitTodoDto } from './dto/submit-todo.dto';
import { ApproveTodoDto } from './dto/approve-todo.dto';
import { TodoResponseDto } from './dto/todo-response.dto';

@ApiTags('Todos')
@ApiBearerAuth()
@ApiCommonErrorResponses()
@Controller('todos')
export class TodosController {
  constructor(private readonly todosService: TodosService) {}

  @Post()
  @RequirePermissions('todo:create')
  @ApiOperation({
    summary: 'Create a todo',
    description:
      'Creates a PENDING todo for the caller’s own employee record, or on behalf of another ' +
      'employee if the caller holds todo:approve.',
  })
  @ApiSuccessResponse(TodoResponseDto, 'Todo created', 201)
  create(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Body() dto: CreateTodoDto,
  ) {
    return this.todosService.create(organizationId, currentUser, dto);
  }

  @Get()
  @RequirePermissions('todo:read')
  @ApiOperation({
    summary: 'List todos (paginated)',
    description:
      'Users without todo:approve see only their own todos; users with todo:approve see all ' +
      'todos in the organization, optionally filtered by ?employeeId=&status=&incentiveRuleId=.',
  })
  @ApiPaginatedResponse(TodoResponseDto, 'Paginated list of todos')
  findAll(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Query() query: QueryTodoDto,
  ) {
    return this.todosService.findAll(organizationId, currentUser, query);
  }

  @Get(':id')
  @RequirePermissions('todo:read')
  @ApiOperation({ summary: 'Get a single todo' })
  @ApiParam({ name: 'id', description: 'TodoTask UUID' })
  @ApiSuccessResponse(TodoResponseDto, 'Todo detail')
  findOne(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Param('id') id: string,
  ) {
    return this.todosService.findOne(organizationId, currentUser, id);
  }

  @Put(':id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('todo:create')
  @ApiOperation({ summary: 'Submit a completed quantity for review' })
  @ApiParam({ name: 'id', description: 'TodoTask UUID' })
  @ApiSuccessResponse(TodoResponseDto, 'Todo submitted for review')
  submit(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Param('id') id: string,
    @Body() dto: SubmitTodoDto,
  ) {
    return this.todosService.submit(organizationId, currentUser, id, dto);
  }

  @Put(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('todo:approve')
  @ApiOperation({
    summary: 'Approve or reject a SUBMITTED todo',
    description:
      'On approve, creates an IncentiveLedger entry (quantity * rule rate) held or released ' +
      'depending on dto.hold. On reject, no ledger entry is created.',
  })
  @ApiParam({ name: 'id', description: 'TodoTask UUID' })
  @ApiSuccessResponse(TodoResponseDto, 'Todo approved or rejected')
  approve(
    @OrganizationId() organizationId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Param('id') id: string,
    @Body() dto: ApproveTodoDto,
  ) {
    return this.todosService.approve(organizationId, userId, currentUser, id, dto);
  }
}
