export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
