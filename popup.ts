import { runtimeSendMessage } from './shared/chrome-api.ts';
import type {
  ApiResponse,
  BackgroundRequest
} from './shared/types.ts';
import { PopupController } from './popup/controller.ts';
import { PopupView } from './popup/view.ts';

const view = new PopupView(document, window);
const controller = new PopupController({
  view,
  async sendMessage<T>(message: BackgroundRequest): Promise<T> {
    const response = await runtimeSendMessage<
      BackgroundRequest,
      ApiResponse<T>
    >(message);
    if (!response.ok) {
      throw new Error(response.error);
    }

    return response.data;
  },
  setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
  clearInterval: (timerId) => window.clearInterval(timerId)
});

controller.start();
