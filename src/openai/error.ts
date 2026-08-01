export interface ErrorDetail {
  message: string;
  type: string;
  param: string | null;
  code: string | null;
}

export interface ErrorBody {
  error: ErrorDetail;
}
