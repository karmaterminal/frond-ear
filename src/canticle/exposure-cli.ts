// `frond-ear exposure` (frond-ear#117). RED stub.

export interface ExposureIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
}

export async function runExposure(
  _argv: string[],
  _io: ExposureIo,
): Promise<number> {
  return 1;
}
