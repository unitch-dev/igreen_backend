import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChatRoomType, EmployeeStatus, FileEntityType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { paginate } from '@common/dto/pagination.dto';
import { CreateRoomDto } from './dto/create-room.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';

export interface RequestingUser {
  id: string;
  employeeId: string | null;
  permissions: string[];
}

export interface SendMessageInput {
  content?: string;
  fileUrl?: string;
  fileName?: string;
  messageType?: string;
}

type RoomWithMembersAndLastMessage = Prisma.ChatRoomGetPayload<{
  include: {
    members: true;
    messages: true;
  };
}>;

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  // ─── Room creation ──────────────────────────────────────────────────────────

  async createRoom(organizationId: string, currentUser: RequestingUser, dto: CreateRoomDto) {
    const creatorEmployeeId = this.requireEmployeeId(currentUser);

    if (dto.type === ChatRoomType.DIRECT) {
      return this.createDirectRoom(organizationId, creatorEmployeeId, dto);
    }
    if (dto.type === ChatRoomType.GROUP) {
      return this.createGroupRoom(organizationId, creatorEmployeeId, dto);
    }
    return this.createDepartmentRoom(organizationId, creatorEmployeeId, dto);
  }

  private async createDirectRoom(
    organizationId: string,
    creatorEmployeeId: string,
    dto: CreateRoomDto,
  ) {
    if (dto.memberEmployeeIds.length !== 1) {
      throw new BadRequestException('DIRECT rooms require exactly one other member');
    }
    const otherId = dto.memberEmployeeIds[0];
    if (otherId === creatorEmployeeId) {
      throw new BadRequestException('Cannot start a direct chat with yourself');
    }
    await this.assertEmployeesInOrg(organizationId, [otherId]);

    const candidates = await this.prisma.chatRoom.findMany({
      where: {
        organizationId,
        type: ChatRoomType.DIRECT,
        AND: [
          { members: { some: { employeeId: creatorEmployeeId } } },
          { members: { some: { employeeId: otherId } } },
        ],
      },
      include: { members: true },
    });
    const existing = candidates.find((room) => room.members.length === 2);

    if (existing) {
      // Reactivate memberships in case either party's access was previously revoked.
      await this.prisma.chatRoomMember.updateMany({
        where: { roomId: existing.id, employeeId: { in: [creatorEmployeeId, otherId] } },
        data: { revokedAt: null },
      });
      return this.getRoomDetail(existing.id);
    }

    const room = await this.prisma.$transaction(async (tx) => {
      const created = await tx.chatRoom.create({
        data: { organizationId, type: ChatRoomType.DIRECT },
      });
      await tx.chatRoomMember.createMany({
        data: [creatorEmployeeId, otherId].map((employeeId) => ({
          roomId: created.id,
          employeeId,
          role: 'member',
        })),
      });
      return created;
    });

    return this.getRoomDetail(room.id);
  }

  private async createGroupRoom(
    organizationId: string,
    creatorEmployeeId: string,
    dto: CreateRoomDto,
  ) {
    if (!dto.name) {
      throw new BadRequestException('GROUP rooms require a name');
    }
    if (!dto.memberEmployeeIds?.length) {
      throw new BadRequestException('GROUP rooms require at least one other member');
    }
    const memberIds = Array.from(new Set([...dto.memberEmployeeIds, creatorEmployeeId]));
    await this.assertEmployeesInOrg(
      organizationId,
      memberIds.filter((id) => id !== creatorEmployeeId),
    );

    const room = await this.prisma.$transaction(async (tx) => {
      const created = await tx.chatRoom.create({
        data: { organizationId, type: ChatRoomType.GROUP, name: dto.name },
      });
      await tx.chatRoomMember.createMany({
        data: memberIds.map((employeeId) => ({
          roomId: created.id,
          employeeId,
          role: employeeId === creatorEmployeeId ? 'admin' : 'member',
        })),
      });
      return created;
    });

    return this.getRoomDetail(room.id);
  }

  private async createDepartmentRoom(
    organizationId: string,
    creatorEmployeeId: string,
    dto: CreateRoomDto,
  ) {
    if (!dto.departmentId) {
      throw new BadRequestException('DEPARTMENT rooms require a departmentId');
    }
    const department = await this.prisma.department.findFirst({
      where: { id: dto.departmentId, organizationId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!department) throw new NotFoundException('Department not found');

    const existing = await this.prisma.chatRoom.findFirst({
      where: {
        organizationId,
        type: ChatRoomType.DEPARTMENT,
        departmentId: department.id,
        isActive: true,
      },
    });

    const activeEmployees = await this.prisma.employee.findMany({
      where: {
        organizationId,
        departmentId: department.id,
        status: EmployeeStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });
    const memberIds = Array.from(new Set([...activeEmployees.map((e) => e.id), creatorEmployeeId]));

    if (existing) {
      await this.prisma.$transaction(
        memberIds.map((employeeId) =>
          this.prisma.chatRoomMember.upsert({
            where: { roomId_employeeId: { roomId: existing.id, employeeId } },
            create: {
              roomId: existing.id,
              employeeId,
              role: employeeId === creatorEmployeeId ? 'admin' : 'member',
            },
            update: { revokedAt: null },
          }),
        ),
      );
      return this.getRoomDetail(existing.id);
    }

    const room = await this.prisma.$transaction(async (tx) => {
      const created = await tx.chatRoom.create({
        data: {
          organizationId,
          type: ChatRoomType.DEPARTMENT,
          name: department.name,
          departmentId: department.id,
        },
      });
      await tx.chatRoomMember.createMany({
        data: memberIds.map((employeeId) => ({
          roomId: created.id,
          employeeId,
          role: employeeId === creatorEmployeeId ? 'admin' : 'member',
        })),
      });
      return created;
    });

    return this.getRoomDetail(room.id);
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Lightweight org-employee list for the "start a new chat" member picker.
   * Deliberately NOT gated by `employee:read` (unlike `EmployeesService.findAll`)
   * — this controller is intentionally open to any authenticated, active
   * employee (see the module-level comment on `ChatController`), and most
   * seeded roles (e.g. plain `employee`) do not hold `employee:read`. Excludes
   * the caller so they can't pick themselves as a DIRECT chat partner.
   */
  async listEmployeesForPicker(organizationId: string, currentUser: RequestingUser) {
    const employeeId = this.requireEmployeeId(currentUser);
    const employees = await this.prisma.employee.findMany({
      where: {
        organizationId,
        status: EmployeeStatus.ACTIVE,
        deletedAt: null,
        id: { not: employeeId },
      },
      select: { id: true, empCode: true, firstName: true, lastName: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    return employees;
  }

  async listMyRooms(organizationId: string, currentUser: RequestingUser) {
    const employeeId = this.requireEmployeeId(currentUser);

    const memberships = await this.prisma.chatRoomMember.findMany({
      where: { employeeId, revokedAt: null, room: { organizationId } },
      select: { roomId: true },
    });
    const roomIds = memberships.map((m) => m.roomId);
    if (!roomIds.length) return [];

    const rooms = await this.prisma.chatRoom.findMany({
      where: { id: { in: roomIds } },
      include: {
        members: { where: { revokedAt: null } },
        messages: { orderBy: { sentAt: 'desc' }, take: 1 },
      },
    });

    const employeeIds = Array.from(
      new Set(rooms.flatMap((room) => room.members.map((m) => m.employeeId))),
    );
    const employeeMap = await this.getEmployeeNameMap(employeeIds);

    return rooms
      .map((room) => this.toRoomSummary(room, employeeMap))
      .sort((a, b) => {
        const at = a.lastMessage?.sentAt ? new Date(a.lastMessage.sentAt).getTime() : 0;
        const bt = b.lastMessage?.sentAt ? new Date(b.lastMessage.sentAt).getTime() : 0;
        return bt - at;
      });
  }

  async getMessages(
    organizationId: string,
    currentUser: RequestingUser,
    roomId: string,
    query: QueryMessagesDto,
  ) {
    const employeeId = this.requireEmployeeId(currentUser);
    await this.assertRoomInOrg(organizationId, roomId);
    await this.assertActiveMember(roomId, employeeId);

    const where: Prisma.ChatMessageWhereInput = { roomId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.chatMessage.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.chatMessage.count({ where }),
    ]);

    const employeeMap = await this.getEmployeeNameMap(data.map((m) => m.senderId));
    return paginate(
      data.map((m) => this.toMessageResponse(m, employeeMap)),
      total,
      query,
    );
  }

  // ─── Writes ─────────────────────────────────────────────────────────────────

  async sendMessage(
    organizationId: string,
    currentUser: RequestingUser,
    roomId: string,
    input: SendMessageInput,
  ) {
    const employeeId = this.requireEmployeeId(currentUser);
    await this.assertRoomInOrg(organizationId, roomId);
    await this.assertActiveMember(roomId, employeeId);

    if (!input.content && !input.fileUrl) {
      throw new BadRequestException('A message must include content or an attachment');
    }

    const created = await this.prisma.chatMessage.create({
      data: {
        roomId,
        senderId: employeeId,
        content: input.content ?? null,
        messageType: input.messageType ?? 'text',
        fileUrl: input.fileUrl ?? null,
        fileName: input.fileName ?? null,
      },
    });

    const employeeMap = await this.getEmployeeNameMap([employeeId]);
    return this.toMessageResponse(created, employeeMap);
  }

  async uploadAttachment(
    organizationId: string,
    currentUser: RequestingUser,
    roomId: string,
    file: Express.Multer.File,
  ) {
    const employeeId = this.requireEmployeeId(currentUser);
    await this.assertRoomInOrg(organizationId, roomId);
    await this.assertActiveMember(roomId, employeeId);

    const asset = await this.files.upload({
      buffer: file.buffer,
      organizationId,
      entityType: FileEntityType.CHAT_ATTACHMENT,
      entityId: roomId,
      fileName: file.originalname,
      mimeType: file.mimetype,
      uploadedById: currentUser.id,
    });

    return this.sendMessage(organizationId, currentUser, roomId, {
      fileUrl: asset.url,
      fileName: file.originalname,
      messageType: 'file',
    });
  }

  // ─── Guards (reused by the gateway) ─────────────────────────────────────────

  async assertActiveMember(roomId: string, employeeId: string): Promise<void> {
    // Defensive guard: Prisma SILENTLY DROPS a `where` key whose value is
    // `undefined` (it does not generate `IS NULL` or fail — it omits the
    // filter entirely). If `employeeId` were ever `undefined` here (e.g. a
    // caller bug upstream), `{ roomId, employeeId: undefined, revokedAt: null }`
    // would degrade into `{ roomId, revokedAt: null }` and match ANY active
    // member of the room — an authorization bypass, not a "no rows found"
    // failure. Fail closed explicitly instead of relying on Prisma's filter
    // semantics. See `.claude/agents/hrms-backend.md` for the general rule.
    if (!roomId || !employeeId) {
      throw new ForbiddenException('You are not an active member of this chat room');
    }
    const member = await this.prisma.chatRoomMember.findFirst({
      where: { roomId, employeeId, revokedAt: null },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException('You are not an active member of this chat room');
    }
  }

  // ─── Lifecycle hook (exported for EmployeesService.patchStatus) ─────────────

  async revokeAllForEmployee(employeeId: string): Promise<void> {
    await this.prisma.chatRoomMember.updateMany({
      where: { employeeId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private requireEmployeeId(currentUser: RequestingUser): string {
    if (!currentUser.employeeId) {
      throw new BadRequestException('No employee record found for the current user');
    }
    return currentUser.employeeId;
  }

  private async assertRoomInOrg(organizationId: string, roomId: string): Promise<void> {
    const room = await this.prisma.chatRoom.findFirst({
      where: { id: roomId, organizationId },
      select: { id: true },
    });
    if (!room) throw new NotFoundException('Chat room not found');
  }

  private async assertEmployeesInOrg(organizationId: string, employeeIds: string[]): Promise<void> {
    if (!employeeIds.length) return;
    const count = await this.prisma.employee.count({
      where: { id: { in: employeeIds }, organizationId, deletedAt: null },
    });
    if (count !== new Set(employeeIds).size) {
      throw new BadRequestException(
        'One or more member employees were not found in this organization',
      );
    }
  }

  private async getEmployeeNameMap(employeeIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = Array.from(new Set(employeeIds));
    if (!uniqueIds.length) return new Map();
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));
  }

  private async getRoomDetail(roomId: string) {
    const room = await this.prisma.chatRoom.findUnique({
      where: { id: roomId },
      include: {
        members: { where: { revokedAt: null } },
        messages: { orderBy: { sentAt: 'desc' }, take: 1 },
      },
    });
    if (!room) throw new NotFoundException('Chat room not found');

    const employeeMap = await this.getEmployeeNameMap(room.members.map((m) => m.employeeId));
    return this.toRoomSummary(room, employeeMap);
  }

  private toRoomSummary(room: RoomWithMembersAndLastMessage, employeeMap: Map<string, string>) {
    const lastMessageRaw = room.messages?.[0];
    return {
      id: room.id,
      type: room.type,
      name: room.name,
      departmentId: room.departmentId,
      isActive: room.isActive,
      createdAt: room.createdAt,
      members: room.members.map((m) => ({
        employeeId: m.employeeId,
        name: employeeMap.get(m.employeeId) ?? 'Unknown',
        role: m.role,
        joinedAt: m.joinedAt,
        revokedAt: m.revokedAt,
      })),
      lastMessage: lastMessageRaw ? this.toMessageResponse(lastMessageRaw, employeeMap) : null,
    };
  }

  private toMessageResponse(
    message: {
      id: string;
      roomId: string;
      senderId: string;
      content: string | null;
      messageType: string;
      fileUrl: string | null;
      fileName: string | null;
      sentAt: Date;
      editedAt: Date | null;
      deletedAt: Date | null;
    },
    employeeMap: Map<string, string>,
  ) {
    const isDeleted = !!message.deletedAt;
    return {
      id: message.id,
      roomId: message.roomId,
      senderId: message.senderId,
      senderName: employeeMap.get(message.senderId) ?? 'Unknown',
      content: isDeleted ? null : message.content,
      messageType: message.messageType,
      fileUrl: isDeleted ? null : message.fileUrl,
      fileName: isDeleted ? null : message.fileName,
      sentAt: message.sentAt,
      editedAt: message.editedAt,
      deletedAt: message.deletedAt,
    };
  }
}
