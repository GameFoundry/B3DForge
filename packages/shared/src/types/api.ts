/** Paginated response wrapper */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** API error response */
export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

/** Generic success response */
export interface SuccessResponse {
  success: true;
  message?: string;
}
