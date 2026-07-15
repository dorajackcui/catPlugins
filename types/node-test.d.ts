declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  }

  const assert: Assert;
  export default assert;
}

declare module 'node:test' {
  type TestCallback = () => void | Promise<void>;

  function test(name: string, fn: TestCallback): void;

  export default test;
}
