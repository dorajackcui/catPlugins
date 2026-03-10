export async function storageGet<T>(keys: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result: T) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(result);
    });
  });
}

export async function storageSet(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

export async function runtimeSendMessage<TRequest, TResponse>(
  message: TRequest
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: TResponse) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

export async function queryActiveTab(): Promise<{ id: number; url?: string }> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(
      { active: true, currentWindow: true },
      (tabs: Array<{ id?: number; url?: string }>) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        const [tab] = tabs;
        if (!tab?.id) {
          reject(new Error('No active tab found.'));
          return;
        }

        resolve({ id: tab.id, url: tab.url });
      }
    );
  });
}

export async function sendTabMessage<TRequest, TResponse>(
  tabId: number,
  message: TRequest,
  options?: { frameId?: number }
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, options ?? {}, (response: TResponse) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

export async function executeScript(
  tabId: number,
  files: string[],
  options?: { allFrames?: boolean; frameIds?: number[] }
): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: {
          tabId,
          allFrames: options?.allFrames,
          frameIds: options?.frameIds
        },
        files
      },
      () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve();
      }
    );
  });
}

export async function getAllFrames(
  tabId: number
): Promise<Array<{ frameId: number; parentFrameId: number; url?: string }>> {
  return new Promise((resolve, reject) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames: Array<{
      frameId: number;
      parentFrameId: number;
      url?: string;
    }>) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(frames ?? []);
    });
  });
}
