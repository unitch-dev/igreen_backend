import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { OrganizationId } from '@common/decorators/organization.decorator';
import { ChatService, RequestingUser } from './chat.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';
import { SendMessageDto } from './dto/send-message.dto';

// No @RequirePermissions on any route in this controller: access to chat rooms
// and messages is enforced by room-membership checks inside ChatService, not by
// a static permission string. Any authenticated, active employee may use chat.
@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('rooms')
  @ApiOperation({
    summary: 'Create (or dedupe-find) a chat room',
    description:
      'DIRECT rooms are deduped — creating a DIRECT room for the same two members returns the ' +
      'existing room. DEPARTMENT rooms auto-enroll all ACTIVE employees of the department.',
  })
  @ApiResponse({
    status: 201,
    description: 'Room created (or existing DIRECT/DEPARTMENT room returned)',
    schema: {
      example: {
        status: true,
        message: 'Success',
        data: {
          id: 'b6e2b1a0-...-room',
          type: 'GROUP',
          name: 'Marketing Standup',
          departmentId: null,
          isActive: true,
          createdAt: '2026-07-13T10:00:00.000Z',
          members: [
            {
              employeeId: 'emp-1',
              name: 'Jane Doe',
              role: 'admin',
              joinedAt: '2026-07-13T10:00:00.000Z',
              revokedAt: null,
            },
          ],
          lastMessage: null,
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, or room-type business rule violation (e.g. DIRECT room with != 1 ' +
      'other member, GROUP room missing name/members, DEPARTMENT room missing departmentId, ' +
      'unknown member employee IDs)',
    schema: {
      example: {
        status: false,
        message: 'DIRECT rooms require exactly one other member',
        data: { statusCode: 400, path: '/api/v1/chat/rooms', method: 'POST' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 404,
    description: 'Department not found (DEPARTMENT rooms only)',
    schema: {
      example: {
        status: false,
        message: 'Department not found',
        data: { statusCode: 404, path: '/api/v1/chat/rooms', method: 'POST' },
      },
    },
  })
  createRoom(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Body() dto: CreateRoomDto,
  ) {
    return this.chatService.createRoom(organizationId, currentUser, dto);
  }

  @Get('employees')
  @ApiOperation({
    summary: 'List org employees available to start a chat with',
    description:
      "Active employees in the caller's organization (excluding the caller), for the " +
      '"start a new chat" member picker. Not gated by `employee:read` — any authenticated, ' +
      "active employee may use chat, matching this controller's access model.",
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  listEmployees(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
  ) {
    return this.chatService.listEmployeesForPicker(organizationId, currentUser);
  }

  @Get('rooms')
  @ApiOperation({
    summary: 'List chat rooms the current employee is an active member of',
    description:
      'Returns all DIRECT/GROUP/DEPARTMENT rooms the current employee has an active ' +
      '(non-revoked) membership in, sorted by most recent message first.',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of room summaries (each including members and last message, if any)',
    schema: {
      example: {
        status: true,
        message: 'Success',
        data: [
          {
            id: 'b6e2b1a0-...-room',
            type: 'DIRECT',
            name: null,
            departmentId: null,
            isActive: true,
            createdAt: '2026-07-10T09:00:00.000Z',
            members: [
              {
                employeeId: 'emp-1',
                name: 'Jane Doe',
                role: 'member',
                joinedAt: '2026-07-10T09:00:00.000Z',
                revokedAt: null,
              },
              {
                employeeId: 'emp-2',
                name: 'John Smith',
                role: 'member',
                joinedAt: '2026-07-10T09:00:00.000Z',
                revokedAt: null,
              },
            ],
            lastMessage: {
              id: 'msg-1',
              roomId: 'b6e2b1a0-...-room',
              senderId: 'emp-2',
              senderName: 'John Smith',
              content: 'See you at 3pm',
              messageType: 'text',
              fileUrl: null,
              fileName: null,
              sentAt: '2026-07-13T08:00:00.000Z',
              editedAt: null,
              deletedAt: null,
            },
          },
        ],
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  listMyRooms(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
  ) {
    return this.chatService.listMyRooms(organizationId, currentUser);
  }

  @Get('rooms/:id/messages')
  @ApiOperation({
    summary: 'Paginated message history for a room (membership required)',
    description:
      'Returns messages newest-first. Deleted messages are returned with content/fileUrl/' +
      'fileName nulled out rather than omitted, to preserve the timeline.',
  })
  @ApiParam({ name: 'id', description: 'Chat room UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Paginated message list',
    schema: {
      example: {
        status: true,
        message: 'Success',
        data: {
          data: [
            {
              id: 'msg-1',
              roomId: 'b6e2b1a0-...-room',
              senderId: 'emp-2',
              senderName: 'John Smith',
              content: 'See you at 3pm',
              messageType: 'text',
              fileUrl: null,
              fileName: null,
              sentAt: '2026-07-13T08:00:00.000Z',
              editedAt: null,
              deletedAt: null,
            },
          ],
          meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Not an active member of this chat room',
    schema: {
      example: {
        status: false,
        message: 'You are not an active member of this chat room',
        data: { statusCode: 403, path: '/api/v1/chat/rooms/{id}/messages', method: 'GET' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Chat room not found',
    schema: {
      example: {
        status: false,
        message: 'Chat room not found',
        data: { statusCode: 404, path: '/api/v1/chat/rooms/{id}/messages', method: 'GET' },
      },
    },
  })
  getMessages(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Param('id') id: string,
    @Query() query: QueryMessagesDto,
  ) {
    return this.chatService.getMessages(organizationId, currentUser, id, query);
  }

  @Post('rooms/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Send a text message via REST (complements the socket send)',
    description:
      'Persists a message the same way the `chat:message` socket event does, but does NOT ' +
      'fan out over Redis pub/sub to other connected clients — use the socket event for ' +
      'real-time delivery. Prefer this endpoint only when a socket connection is unavailable.',
  })
  @ApiParam({ name: 'id', description: 'Chat room UUID' })
  @ApiResponse({
    status: 201,
    description: 'Message created',
    schema: {
      example: {
        status: true,
        message: 'Success',
        data: {
          id: 'msg-2',
          roomId: 'b6e2b1a0-...-room',
          senderId: 'emp-1',
          senderName: 'Jane Doe',
          content: 'Hey, are you free for a quick call?',
          messageType: 'text',
          fileUrl: null,
          fileName: null,
          sentAt: '2026-07-13T10:05:00.000Z',
          editedAt: null,
          deletedAt: null,
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or message has neither content nor an attachment',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Not an active member of this chat room',
    schema: {
      example: {
        status: false,
        message: 'You are not an active member of this chat room',
        data: { statusCode: 403, path: '/api/v1/chat/rooms/{id}/messages', method: 'POST' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Chat room not found',
    schema: {
      example: {
        status: false,
        message: 'Chat room not found',
        data: { statusCode: 404, path: '/api/v1/chat/rooms/{id}/messages', method: 'POST' },
      },
    },
  })
  sendMessage(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.sendMessage(organizationId, currentUser, id, { content: dto.content });
  }

  @Post('rooms/:id/attachment')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a file attachment as a chat message',
    description:
      'Uploads the file (tagged as a FileAsset under the CHAT_ATTACHMENT entity type) then ' +
      'creates a message of type "file" pointing at its URL. Does not fan out over the ' +
      'real-time socket channel — only the REST response reflects the new message immediately.',
  })
  @ApiParam({ name: 'id', description: 'Chat room UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Attachment uploaded and message created',
    schema: {
      example: {
        status: true,
        message: 'Success',
        data: {
          id: 'msg-3',
          roomId: 'b6e2b1a0-...-room',
          senderId: 'emp-1',
          senderName: 'Jane Doe',
          content: null,
          messageType: 'file',
          fileUrl: 'https://api.example.com/uploads/CHAT_ATTACHMENT/org-1/room-1/uuid-timesheet.pdf',
          fileName: 'timesheet.pdf',
          sentAt: '2026-07-13T10:10:00.000Z',
          editedAt: null,
          deletedAt: null,
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'No file provided, or file upload failed validation' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Not an active member of this chat room',
    schema: {
      example: {
        status: false,
        message: 'You are not an active member of this chat room',
        data: { statusCode: 403, path: '/api/v1/chat/rooms/{id}/attachment', method: 'POST' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Chat room not found',
    schema: {
      example: {
        status: false,
        message: 'Chat room not found',
        data: { statusCode: 404, path: '/api/v1/chat/rooms/{id}/attachment', method: 'POST' },
      },
    },
  })
  uploadAttachment(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.chatService.uploadAttachment(organizationId, currentUser, id, file);
  }
}
