import { ApiProperty } from '@nestjs/swagger';

export class AttendanceTrackLogRowDto {
  @ApiProperty()
  employeeId: string;

  @ApiProperty()
  empCode: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  date: string;

  @ApiProperty({ nullable: true })
  checkInAt: string | null;

  @ApiProperty({ nullable: true })
  checkOutAt: string | null;

  @ApiProperty({ nullable: true })
  checkInLat: number | null;

  @ApiProperty({ nullable: true })
  checkInLng: number | null;

  @ApiProperty({ nullable: true })
  checkInLocationName: string | null;

  @ApiProperty({ nullable: true })
  checkOutLat: number | null;

  @ApiProperty({ nullable: true })
  checkOutLng: number | null;

  @ApiProperty({ nullable: true })
  checkOutLocationName: string | null;

  @ApiProperty()
  source: string;

  @ApiProperty()
  status: string;

  @ApiProperty({ nullable: true })
  totalHours: number | null;
}

export class LiveTrackEntryDto {
  @ApiProperty()
  employeeId: string;

  @ApiProperty()
  empCode: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;

  @ApiProperty()
  recordedAt: string;
}

export class AttendanceTrackReportDto {
  @ApiProperty({ description: 'Period start date (ISO)' })
  from: string;

  @ApiProperty({ description: 'Period end date (ISO)' })
  to: string;

  @ApiProperty({ type: [AttendanceTrackLogRowDto], description: 'Paginated attendance log rows' })
  rows: AttendanceTrackLogRowDto[];

  @ApiProperty()
  meta: { total: number; page: number; limit: number; totalPages: number };

  @ApiProperty({
    type: [LiveTrackEntryDto],
    description:
      'Latest LiveLocation per employee recorded within the last 30 minutes, capped at 200 employees',
  })
  liveNow: LiveTrackEntryDto[];
}
