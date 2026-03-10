declare module 'xlsx' {
  export interface WorkSheet {}
  export interface WorkBook {
    SheetNames: string[];
    Sheets: Record<string, WorkSheet>;
  }

  export function read(
    data: ArrayBuffer | Uint8Array,
    options: { type: 'array' }
  ): WorkBook;

  export const utils: {
    sheet_to_json<T = unknown>(
      sheet: WorkSheet,
      options?: { header?: 1; defval?: unknown; raw?: boolean }
    ): T[];
  };
}

