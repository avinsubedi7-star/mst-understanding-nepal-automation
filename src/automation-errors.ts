export class AutomationPauseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationPauseError";
  }
}
