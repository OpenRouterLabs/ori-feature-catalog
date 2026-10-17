const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;

export const isOkStatus = (status: number): boolean =>
  status >= HTTP_OK_MIN && status < HTTP_OK_MAX;
