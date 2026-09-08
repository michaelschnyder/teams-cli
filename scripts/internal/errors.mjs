// Only deliberately sanitized diagnostics may cross the CI logging boundary.
export class PromotionError extends Error {
  constructor(message) {
    super(message);
    this.name = "PromotionError";
  }
}
