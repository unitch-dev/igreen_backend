import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FileEntityType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { paginate } from '@common/dto/pagination.dto';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { UpdateNoticeDto } from './dto/update-notice.dto';
import { QueryNoticeDto } from './dto/query-notice.dto';

export const NOTICE_MANAGE_PERMISSION = 'onboarding:manage';

export interface RequestingUser {
  id: string;
  employeeId: string | null;
  permissions: string[];
}

const NOTICE_WITH_COUNT = {
  _count: { select: { reads: true } },
} satisfies Prisma.NoticeInclude;

type NoticeWithCount = Prisma.NoticeGetPayload<{ include: typeof NOTICE_WITH_COUNT }>;
type NoticePlain = Prisma.NoticeGetPayload<object>;

interface ViewerContext {
  departmentId: string | null;
  roleIds: string[];
}

interface ResponseExtras {
  hasRead?: boolean;
  readCount?: number;
}

@Injectable()
export class NoticesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  private canManage(currentUser: RequestingUser): boolean {
    return (
      currentUser.permissions.includes(NOTICE_MANAGE_PERMISSION) ||
      currentUser.permissions.includes('*')
    );
  }

  async create(organizationId: string, dto: CreateNoticeDto) {
    const targetType = dto.targetType ?? 'ALL';
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;

    let status = 'draft';
    let publishedAt: Date | null = null;
    if (dto.publishNow) {
      status = 'published';
      publishedAt = new Date();
    } else if (scheduledAt) {
      status = 'scheduled';
    }

    const created = await this.prisma.notice.create({
      data: {
        organizationId,
        title: dto.title,
        body: dto.body,
        targetType,
        targetRoles: dto.targetRoles ?? undefined,
        targetDepts: dto.targetDepts ?? undefined,
        scheduledAt,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        status,
        publishedAt,
      },
      include: NOTICE_WITH_COUNT,
    });

    return this.toResponse(created, { readCount: created._count.reads });
  }

  async findAll(organizationId: string, currentUser: RequestingUser, query: QueryNoticeDto) {
    const view = query.view ?? 'board';

    if (view === 'manage') {
      if (!this.canManage(currentUser)) {
        throw new ForbiddenException('You are not permitted to view the notices management list');
      }
      return this.findManage(organizationId, query);
    }

    return this.findBoard(organizationId, currentUser, query);
  }

  private async findManage(organizationId: string, query: QueryNoticeDto) {
    const where: Prisma.NoticeWhereInput = {
      organizationId,
      ...(query.status && { status: query.status }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.notice.findMany({
        where,
        include: NOTICE_WITH_COUNT,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.notice.count({ where }),
    ]);

    return paginate(
      data.map((notice) => this.toResponse(notice, { readCount: notice._count.reads })),
      total,
      query,
    );
  }

  private async findBoard(
    organizationId: string,
    currentUser: RequestingUser,
    query: QueryNoticeDto,
  ) {
    const viewer = await this.getViewerContext(currentUser);
    const now = new Date();

    const where: Prisma.NoticeWhereInput = {
      organizationId,
      OR: [{ status: 'published' }, { status: 'scheduled', scheduledAt: { lte: now } }],
    };

    const all = await this.prisma.notice.findMany({ where, orderBy: { createdAt: 'desc' } });
    const visible = all.filter((notice) => this.isVisibleToViewer(notice, viewer));

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const pageItems = visible.slice((page - 1) * limit, page * limit);

    const employeeId = currentUser.employeeId;
    const readNoticeIds = employeeId
      ? await this.prisma.noticeRead.findMany({
          where: { employeeId, noticeId: { in: pageItems.map((notice) => notice.id) } },
          select: { noticeId: true },
        })
      : [];
    const readSet = new Set(readNoticeIds.map((r) => r.noticeId));

    const data = pageItems.map((notice) =>
      this.toResponse(notice, { hasRead: readSet.has(notice.id) }),
    );

    return paginate(data, visible.length, query);
  }

  async findOne(organizationId: string, currentUser: RequestingUser, id: string) {
    const notice = await this.getNoticeWithCountOrThrow(organizationId, id);

    if (this.canManage(currentUser)) {
      return this.toResponse(notice, { readCount: notice._count.reads });
    }

    if (!this.isDueOrPublished(notice)) {
      throw new NotFoundException('Notice not found');
    }

    const viewer = await this.getViewerContext(currentUser);
    if (!this.isVisibleToViewer(notice, viewer)) {
      throw new NotFoundException('Notice not found');
    }

    const hasRead = currentUser.employeeId
      ? Boolean(
          await this.prisma.noticeRead.findUnique({
            where: { noticeId_employeeId: { noticeId: id, employeeId: currentUser.employeeId } },
          }),
        )
      : false;

    return this.toResponse(notice, { hasRead });
  }

  async update(organizationId: string, id: string, dto: UpdateNoticeDto) {
    const notice = await this.getNoticeOrThrow(organizationId, id);
    if (notice.status === 'published') {
      throw new BadRequestException('Published notices cannot be edited');
    }

    const scheduledAt =
      dto.scheduledAt !== undefined
        ? dto.scheduledAt
          ? new Date(dto.scheduledAt)
          : null
        : undefined;

    const data: Prisma.NoticeUpdateInput = {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.body !== undefined && { body: dto.body }),
      ...(dto.targetType !== undefined && { targetType: dto.targetType }),
      ...(dto.targetRoles !== undefined && { targetRoles: dto.targetRoles }),
      ...(dto.targetDepts !== undefined && { targetDepts: dto.targetDepts }),
      ...(scheduledAt !== undefined && { scheduledAt }),
      ...(dto.expiresAt !== undefined && {
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      }),
    };

    if (dto.publishNow) {
      data.status = 'published';
      data.publishedAt = new Date();
    } else if (scheduledAt !== undefined) {
      data.status = scheduledAt ? 'scheduled' : 'draft';
    }

    const updated = await this.prisma.notice.update({
      where: { id },
      data,
      include: NOTICE_WITH_COUNT,
    });

    return this.toResponse(updated, { readCount: updated._count.reads });
  }

  async publish(organizationId: string, id: string) {
    const notice = await this.getNoticeOrThrow(organizationId, id);
    if (notice.status === 'published') {
      throw new BadRequestException('Notice is already published');
    }

    const updated = await this.prisma.notice.update({
      where: { id },
      data: { status: 'published', publishedAt: new Date() },
      include: NOTICE_WITH_COUNT,
    });

    return this.toResponse(updated, { readCount: updated._count.reads });
  }

  async remove(organizationId: string, id: string) {
    const notice = await this.getNoticeOrThrow(organizationId, id);
    await this.prisma.notice.delete({ where: { id } });

    if (notice.attachmentKey) {
      this.files.deleteFile(notice.attachmentKey).catch(() => {});
    }

    return { id };
  }

  async uploadAttachment(organizationId: string, id: string, file: Express.Multer.File) {
    const notice = await this.getNoticeOrThrow(organizationId, id);

    const asset = await this.files.upload({
      buffer: file.buffer,
      organizationId,
      entityType: FileEntityType.NOTICE_ATTACHMENT,
      entityId: id,
      fileName: file.originalname,
      mimeType: file.mimetype,
    });

    const updated = await this.prisma.notice.update({
      where: { id },
      data: { attachmentUrl: asset.url, attachmentKey: asset.id, attachmentName: asset.fileName },
      include: NOTICE_WITH_COUNT,
    });

    // Best-effort: delete the old attachment (attachmentKey now holds the
    // prior FileAsset id) after the DB update succeeds.
    if (notice.attachmentKey && notice.attachmentKey !== asset.id) {
      this.files.deleteFile(notice.attachmentKey).catch(() => {});
    }

    return this.toResponse(updated, { readCount: updated._count.reads });
  }

  async markRead(organizationId: string, currentUser: RequestingUser, id: string) {
    const employeeId = currentUser.employeeId;
    if (!employeeId) {
      throw new BadRequestException('No employee record found for the current user');
    }

    const notice = await this.getNoticeOrThrow(organizationId, id);
    if (!this.isDueOrPublished(notice)) {
      throw new NotFoundException('Notice not found');
    }

    const viewer = await this.getViewerContext(currentUser);
    if (!this.isVisibleToViewer(notice, viewer)) {
      throw new NotFoundException('Notice not found');
    }

    await this.prisma.noticeRead.upsert({
      where: { noticeId_employeeId: { noticeId: id, employeeId } },
      create: { noticeId: id, employeeId },
      update: {},
    });

    return { id, hasRead: true };
  }

  async getReadReceipts(organizationId: string, id: string, query: QueryNoticeDto) {
    await this.getNoticeOrThrow(organizationId, id);

    const where: Prisma.NoticeReadWhereInput = { noticeId: id };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.noticeRead.findMany({
        where,
        include: {
          employee: { select: { id: true, empCode: true, firstName: true, lastName: true } },
        },
        orderBy: { readAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.noticeRead.count({ where }),
    ]);

    return paginate(
      data.map((row) => ({
        employeeId: row.employeeId,
        employee: row.employee,
        readAt: row.readAt,
      })),
      total,
      query,
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async getViewerContext(currentUser: RequestingUser): Promise<ViewerContext> {
    const [employee, userRoles] = await Promise.all([
      currentUser.employeeId
        ? this.prisma.employee.findUnique({
            where: { id: currentUser.employeeId },
            select: { departmentId: true },
          })
        : Promise.resolve(null),
      this.prisma.userRole.findMany({
        where: { userId: currentUser.id },
        select: { roleId: true },
      }),
    ]);

    return {
      departmentId: employee?.departmentId ?? null,
      roleIds: userRoles.map((ur) => ur.roleId),
    };
  }

  private isVisibleToViewer(notice: NoticePlain, viewer: ViewerContext): boolean {
    if (notice.targetType !== 'TARGETED') return true;

    const targetRoles = Array.isArray(notice.targetRoles) ? (notice.targetRoles as string[]) : [];
    const targetDepts = Array.isArray(notice.targetDepts) ? (notice.targetDepts as string[]) : [];

    const roleMatch = viewer.roleIds.some((roleId) => targetRoles.includes(roleId));
    const deptMatch = viewer.departmentId ? targetDepts.includes(viewer.departmentId) : false;

    return roleMatch || deptMatch;
  }

  private isDueOrPublished(notice: NoticePlain): boolean {
    if (notice.status === 'published') return true;
    return (
      notice.status === 'scheduled' && !!notice.scheduledAt && notice.scheduledAt <= new Date()
    );
  }

  private async getNoticeOrThrow(organizationId: string, id: string): Promise<NoticePlain> {
    const notice = await this.prisma.notice.findFirst({ where: { id, organizationId } });
    if (!notice) throw new NotFoundException('Notice not found');
    return notice;
  }

  private async getNoticeWithCountOrThrow(
    organizationId: string,
    id: string,
  ): Promise<NoticeWithCount> {
    const notice = await this.prisma.notice.findFirst({
      where: { id, organizationId },
      include: NOTICE_WITH_COUNT,
    });
    if (!notice) throw new NotFoundException('Notice not found');
    return notice;
  }

  private toResponse(notice: NoticePlain, extra: ResponseExtras = {}) {
    return {
      id: notice.id,
      title: notice.title,
      body: notice.body,
      status: notice.status,
      targetType: notice.targetType,
      targetRoles: Array.isArray(notice.targetRoles) ? (notice.targetRoles as string[]) : null,
      targetDepts: Array.isArray(notice.targetDepts) ? (notice.targetDepts as string[]) : null,
      scheduledAt: notice.scheduledAt,
      publishedAt: notice.publishedAt,
      expiresAt: notice.expiresAt,
      attachmentUrl: notice.attachmentUrl,
      attachmentName: notice.attachmentName,
      createdAt: notice.createdAt,
      ...(extra.hasRead !== undefined && { hasRead: extra.hasRead }),
      ...(extra.readCount !== undefined && { readCount: extra.readCount }),
    };
  }
}
