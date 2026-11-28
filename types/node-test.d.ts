declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    rejects(promise: Promise<unknown>, expected: RegExp): Promise<void>;
  }

  const assert: Assert;
  export default assert;
}

declare module 'node:test' {
  export interface TestContext {
    after(callback: () => void | Promise<void>): void;
  }

  type TestCallback = (context: TestContext) => void | Promise<void>;

  function test(name: string, fn: TestCallback): void;

  export default test;
}
