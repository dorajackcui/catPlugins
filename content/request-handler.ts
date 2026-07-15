import { normalizeFillOptions } from '../domain/fill-options.ts';
import type {
  ApiResponse,
  ContentRequest
} from '../shared/message-types.ts';
import type {
  FillOptions,
  FillRunResult,
  PageSegment,
  TranslationEntry
} from '../shared/translation-types.ts';
import type {
  ContentFillOptions,
  ContentScanOptions
} from './run-service.ts';

export interface ContentRequestService {
  scanSegments(
    runId: string,
    options?: ContentScanOptions
  ): Promise<PageSegment[]>;
  fillAll(
    runId: string,
    entries: TranslationEntry[],
    fillOptions: FillOptions,
    plannedFillCount: number | null,
    options?: ContentFillOptions
  ): Promise<FillRunResult>;
  stopCurrentRun(): void;
}

/** Routes the content-script protocol without depending on Chrome globals. */
export class ContentRequestHandler {
  constructor(private readonly service: ContentRequestService) {}

  async handle(request: ContentRequest): Promise<ApiResponse<unknown>> {
    switch (request.type) {
      case 'CONTENT_SCAN': {
        const segments = await this.service.scanSegments(
          request.payload.runId,
          {
            maxPasses: request.payload.maxPasses,
            maxSegments: request.payload.maxSegments,
            scanFromTop: request.payload.scanFromTop
          }
        );
        return { ok: true, data: segments };
      }

      case 'CONTENT_FILL': {
        const result = await this.service.fillAll(
          request.payload.runId,
          request.payload.entries,
          normalizeFillOptions(request.payload.fillOptions),
          request.payload.plannedFillCount ?? null,
          {
            maxPasses: request.payload.maxPasses,
            maxSegments: request.payload.maxSegments,
            scanFromTop: request.payload.scanFromTop,
            startFromMarker: true
          }
        );
        return { ok: true, data: result };
      }

      case 'CONTENT_STOP': {
        this.service.stopCurrentRun();
        return { ok: true, data: null };
      }

      default: {
        return {
          ok: false,
          error: 'Unsupported content-script request.'
        };
      }
    }
  }
}
