import type {
  ApiResponse,
  ContentRequest
} from '../shared/message-types.ts';
import { isGientTransEditorFrameUrl, isMemoqWebTransFrameUrl, isMemsourceEditorFrameUrl } from './editor-url.ts';
import { requireEditorPlatform, type EditorPlatform } from '../shared/editor-platform.ts';

export interface PreparedEditorTab {
  id: number;
  url?: string;
  frameId?: number;
}

export interface EditorRunTarget {
  tabId?: number | null;
  frameId?: number | null;
}

function selectEditorFrameId(
  platform: EditorPlatform,
  tabUrl: string | undefined,
  frames: Array<{ frameId: number; url?: string }>
): number | undefined {
  switch (platform) {
    case 'gientrans':
      if (isGientTransEditorFrameUrl(tabUrl)) return 0;
      return frames.find(frame => isGientTransEditorFrameUrl(frame.url))?.frameId ?? 0;
    case 'memoq':
      return frames.find(frame => isMemoqWebTransFrameUrl(frame.url))?.frameId;
    case 'phrase':
      return frames.find(frame => isMemsourceEditorFrameUrl(frame.url))?.frameId;
  }
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

  async prepare(editorPlatform: EditorPlatform | null): Promise<PreparedEditorTab> {
    const platform = requireEditorPlatform(editorPlatform);
    const tab = await this.port.queryActiveTab();

    await this.port.executeScript(tab.id, ['content-script.js'], {
      allFrames: true
    });

    const frames = await this.port.getAllFrames(tab.id);
    const frameId = selectEditorFrameId(platform, tab.url, frames);
    this.port.logInfo('Prepared editor tab for CAT run.', {
      tabId: tab.id,
      url: tab.url,
      platform,
      frameId: frameId ?? null
    });

    return { ...tab, frameId };
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
      tab.frameId !== undefined ? { frameId: tab.frameId } : undefined
    );

    if (!response.ok) {
      throw new Error(response.error);
    }

    return response.data;
  }

  async receiverIsGone(target: EditorRunTarget): Promise<boolean> {
    if (typeof target.tabId !== 'number') return false;
    try {
      await this.port.sendTabMessage(target.tabId, { type: 'CONTENT_PING' },
        typeof target.frameId === 'number' ? { frameId: target.frameId } : undefined);
      return false;
    } catch (error) {
      return error instanceof Error &&
        /Receiving end does not exist|No tab with id|No frame with id|Frame with ID \d+ was removed/i.test(error.message);
    }
  }

  async stop(target: EditorRunTarget, editorPlatform: EditorPlatform | null): Promise<void> {
    const tabId = target.tabId;
    if (typeof tabId !== 'number') {
      const tab = await this.prepare(editorPlatform);
      await this.sendStop(
        tab.id,
        tab.frameId !== undefined ? { frameId: tab.frameId } : undefined
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
