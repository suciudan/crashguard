export type ActionResult<T> =
  | { data: T; error?: never; code?: never }
  | { data?: never; error: string; code?: "UNAUTHENTICATED" };
