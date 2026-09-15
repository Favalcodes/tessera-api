/** The error envelope every failed request returns. */
export interface ApiErrorBody {
  statusCode: number;
  /** Stable machine-readable name, e.g. `InsufficientFundsError`. */
  error: string;
  message: string;
  path: string;
  timestamp: string;
}
