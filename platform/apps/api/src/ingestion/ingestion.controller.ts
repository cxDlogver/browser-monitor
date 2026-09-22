import { Body, Controller, Headers, HttpCode, Ip, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { IngestionResult } from './ingestion.service.js';
import { IngestionService } from './ingestion.service.js';

@Controller('api/v2/ingest')
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post(':publicKey/envelopes')
  @HttpCode(202)
  ingestBatch(
    @Param('publicKey') publicKey: string,
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Ip() ip: string,
    @Req() request: FastifyRequest,
  ): Promise<IngestionResult> {
    const requestId = (request as FastifyRequest & { requestId?: string }).requestId ?? request.id;
    return this.ingestion.ingest(publicKey, body, origin, ip, requestId);
  }
}

