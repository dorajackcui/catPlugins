import type {
  ApiResponse,
  ContentRequest
} from '../shared/message-types.ts';
import {
  isGientTransUrl,
  isMemsourceEditorFrameUrl,
  isMemoqUrl,
  isSupportedEditorUrl
} from './editor-url.ts';

export interface PreparedEditorTab {
  id: number;
  url?: string;
  frameId?: number;
}

export interface EditorRunTarget {
  tabId?: number | null;
  frameId?: number | null;
}

export interface BackgroundEditorSessionPort {
  queryActiveTab(): Promise<{ id: number; url?: string }>;
  executeScript(
    tabId: number,
    files: string[],
    options?: { allFrames?: boolean; frameIds?: number[] }
  ): Promise<void>;
  getAllFrames(
    tabId: number
  ): Promise<Array<{ frameId: number; parentFrameId: number; url?: string }>>;
  sendTabMessage<TRequest, TResponse>(
    tabId: number,
    message: TRequest,
    options?: { frameId?: number }
  ): Promise<TResponse>;
  logInfo(message: string, payload: Record<string, unknown>): void;
}

/** Prepares an editor page and owns routing to its content-script frame. */
export class BackgroundEditorSession {
  constructor(private readonly port: BackgroundEditorSessionPort) {}

  async prepare(): Promise<PreparedEditorTab> {
    const tab = await this.port.queryActiveTab();

    if (!isSupportedEditorUrl(tab.url)) {
      this.port.logInfo('Rejected active tab for CAT run.', { url: tab.url });
      throw new Error(
        'Open a Phrase, memoQ, or GientTrans editor tab before running Preview, Fill, or Export.'
      );
    }

    await this.port.executeScript(tab.id, ['content-script.js'], {
      allFrames: true
    });

    const frames = await this.port.getAllFrames(tab.id);
    const editorFrame = frames.find((frame) =>
      isMemsourceEditorFrameUrl(frame.url)
    );
    this.port.logInfo('Prepared editor tab for CAT run.', {
      tabId: tab.id,
      url: tab.url,
      platform: isGientTransUrl(tab.url)
        ? 'gientrans'
        : isMemoqUrl(tab.url)
          ? 'memoq'
          : 'phrase',
      frameId: editorFrame?.frameId ?? null
    });

    return {
      ...tab,
      frameId: editorFrame?.frameId
    };
  }

  async request<TResult>(
    tab: PreparedEditorTab,
    message: ContentRequest
  ): Promise<TResult> {
    const response = await this.port.sendTabMessage<
      ContentRequest,
      ApiResponse<TResult>
    >(
      tab.id,
      message,
      tab.frameId ? { frameId: tab.frameId } : undefined
    );

    if (!response.ok) {
      throw new Error(response.error);
    }

    return response.data;
  }

  async stop(target: EditorRunTarget): Promise<void> {
    const tabId = target.tabId;
    if (typeof tabId !== 'number') {
      const tab = await this.prepare();
      await this.sendStop(
        tab.id,
        tab.frameId ? { frameId: tab.frameId } : undefined
      );
      return;
    }

    await this.sendStop(
      tabId,
      typeof target.frameId === 'number'
        ? { frameId: target.frameId }
        : undefined
    );
  }

  private async sendStop(
    tabId: number,
    options?: { frameId?: number }
  ): Promise<void> {
    await this.port.sendTabMessage<ContentRequest, ApiResponse<null>>(
      tabId,
      { type: 'CONTENT_STOP' },
      options
    );
  }
}
