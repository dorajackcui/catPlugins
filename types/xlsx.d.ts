declare module 'xlsx' {
  export interface RowInfo {
    hidden?: boolean;
  }

  export interface WorkSheet {
    '!rows'?: Array<RowInfo | null | undefined>;
  }
  export interface WorkBook {
    SheetNames: string[];
    Sheets: Record<string, WorkSheet>;
  }

  export type WritingOptions = {
    bookType?: string;
    type: 'array';
    cellStyles?: boolean;
  };

  export function read(
    data: ArrayBuffer | Uint8Array,
    options: { type: 'array'; cellStyles?: boolean }
  ): WorkBook;

  export function write(workbook: WorkBook, options: WritingOptions): ArrayBuffer;

  export const utils: {
    aoa_to_sheet(data: unknown[][]): WorkSheet;
    book_new(): WorkBook;
    book_append_sheet(workbook: WorkBook, worksheet: WorkSheet, name: string): void;
    sheet_to_json<T = unknown>(
      sheet: WorkSheet,
      options?: { header?: 1; defval?: unknown; raw?: boolean }
    ): T[];
  };
}
